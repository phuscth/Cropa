// A Node transport for the eval that runs one turn through the real adapters in
// `crates/cropa-agent`, using the user's own Codex or Claude Code CLI. It spends quota.
// The eval builds the `turn` example once and spawns it per turn with fixed arguments
// and no shell; the request goes in on stdin.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AgentError, isAgentErrorKind } from '../src/errors.ts';
import type { Transport, TransportOutput } from '../src/transport.ts';

export type RealProvider = 'codex' | 'claude';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KILL_GRACE_MS = 3000;
// The turn enforces the request's timeout itself; this only catches a stuck process.
const WATCHDOG_MS = 15_000;

/** Builds the `turn` example once and returns the path of its binary. */
export function buildTurnBinary(): string {
  execFileSync('cargo', ['build', '-q', '-p', 'cropa-agent', '--example', 'turn'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const name = process.platform === 'win32' ? 'turn.exe' : 'turn';
  const binary = fileURLToPath(new URL(`../../../target/debug/examples/${name}`, import.meta.url));
  if (!existsSync(binary)) throw new Error(`The turn example was not built at ${binary}`);
  return binary;
}

/**
 * Stops the turn process and the CLI under it. On Windows `child.kill()` would leave the CLI
 * running, so the tree is killed with the system's own taskkill (fixed path, no shell).
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const root = process.env['SystemRoot'] ?? 'C:' + String.fromCharCode(92) + 'Windows';
    const sep = String.fromCharCode(92);
    const taskkill = spawn(root + sep + 'System32' + sep + 'taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.on('error', () => { child.kill(); });
    return;
  }
  child.kill();
}

interface TurnReply {
  json?: unknown;
  error?: unknown;
}

function parseReply(stdout: string): TurnReply | null {
  const last = stdout.trim().split('\n').at(-1);
  if (last === undefined || last === '') return null;
  try {
    const value: unknown = JSON.parse(last);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

export function createAgentTransport(provider: RealProvider, binary: string): Transport {
  return {
    run(req, { signal }) {
      if (signal?.aborted) return Promise.reject(new AgentError('Cancelled'));
      return new Promise<TransportOutput>((resolve, reject) => {
        const child = spawn(binary, [], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let stdout = '';
        let settled = false;
        const timers: NodeJS.Timeout[] = [];

        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          for (const timer of timers) clearTimeout(timer);
          finish();
        };
        // Closing stdin cancels the turn inside the process, which stops the CLI's own
        // process tree; the kill is the fallback.
        function onAbort() {
          child.stdin.end();
          // Outlives `settle`, which clears the other timers: the kill must still happen.
          setTimeout(() => { killTree(child); }, KILL_GRACE_MS);
          settle(() => { reject(new AgentError('Cancelled')); });
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timers.push(
          setTimeout(() => {
            killTree(child);
            settle(() => { reject(new AgentError('Timeout')); });
          }, req.timeoutMs + WATCHDOG_MS),
        );

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.on('error', () => {
          settle(() => { reject(new AgentError('NotInstalled')); });
        });
        child.on('close', () => {
          settle(() => {
            const reply = parseReply(stdout);
            if (reply === null) {
              reject(new AgentError('Protocol', 'the turn produced no result'));
            } else if (reply.error !== undefined) {
              reject(new AgentError(isAgentErrorKind(reply.error) ? reply.error : 'Protocol'));
            } else if (reply.json === undefined || reply.json === null) {
              reject(new AgentError('Protocol', 'the turn returned no JSON'));
            } else {
              resolve({ json: reply.json });
            }
          });
        });

        child.stdin.on('error', () => undefined);
        child.stdin.write(
          `${JSON.stringify({
            provider,
            system: req.system,
            prompt: req.prompt,
            schema: req.schema,
            timeoutMs: req.timeoutMs,
            effort: req.effort ?? 'low',
          })}\n`,
        );
      });
    },
  };
}
