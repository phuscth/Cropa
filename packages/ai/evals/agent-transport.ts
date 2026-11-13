// A Node transport for the eval that runs one turn through the real adapters in
// `crates/cropa-agent`, using the user's own Codex or Claude Code CLI. It spends quota.
// The eval builds the `turn` example once and spawns it per turn with fixed arguments
// and no shell; the request goes in on stdin.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AgentError, isAgentErrorKind } from '../src/errors.ts';
import type { Transport, TransportOutput } from '../src/transport.ts';

export type RealProvider = 'codex' | 'claude';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KILL_GRACE_MS = 3000;
// The turn enforces the request's timeout itself; this only catches a stuck process.
const WATCHDOG_MS = 15_000;
// How much of the turn's stderr is kept while it runs, and how much of it a TurnError carries.
const STDERR_KEEP_CHARS = 16 * 1024;
const STDERR_REPORT_CHARS = 4000;

/**
 * A turn that ran and failed. `stderrTail` is the end of what the process wrote to stderr
 * (with the diagnostics feature, a JSON line from the adapter), already scrubbed.
 */
export class TurnError extends AgentError {
  readonly stderrTail: string;

  constructor(kind: AgentError['kind'], message: string | undefined, stderrTail: string) {
    super(kind, message);
    this.name = 'TurnError';
    this.stderrTail = stderrTail;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Makes a stderr tail safe to write to a results file: the home folder becomes `~`, and keys,
 * tokens, email addresses, secret-looking JSON values and long opaque runs are replaced with
 * `[redacted]`. Keeps the last 4000 characters.
 */
export function scrubStderr(text: string, home: string = homedir()): string {
  let out = text;
  if (home !== '') {
    const forward = home.replaceAll('\\', '/');
    const backslash = forward.replaceAll('/', '\\');
    // The adapter's diagnostic is JSON, where each backslash of a path is written twice.
    const spellings = [forward, backslash, backslash.replaceAll('\\', '\\\\')];
    for (const spelling of spellings) {
      out = out.replace(new RegExp(escapeRegExp(spelling), 'gi'), '~');
    }
  }
  out = out
    .replace(
      /"([^"\\]*(?:token|secret|password|api_key|apikey|authorization|cookie|email)[^"\\]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
      '"$1": "[redacted]"',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]');
  return out.slice(-STDERR_REPORT_CHARS);
}

/** Builds the `turn` example once, with its diagnostics, and returns the path of its binary. */
export function buildTurnBinary(): string {
  execFileSync(
    'cargo',
    ['build', '-q', '-p', 'cropa-agent', '--example', 'turn', '--features', 'diagnostics'],
    { cwd: ROOT, stdio: 'inherit' },
  );
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
  message?: unknown;
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
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
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
            settle(() => { reject(new TurnError('Timeout', undefined, scrubStderr(stderr))); });
          }, req.timeoutMs + WATCHDOG_MS),
        );

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-STDERR_KEEP_CHARS);
        });
        child.on('error', () => {
          settle(() => { reject(new AgentError('NotInstalled')); });
        });
        child.on('close', () => {
          settle(() => {
            const reply = parseReply(stdout);
            const tail = scrubStderr(stderr);
            if (reply === null) {
              reject(new TurnError('Protocol', 'the turn produced no result', tail));
            } else if (reply.error !== undefined) {
              const kind = isAgentErrorKind(reply.error) ? reply.error : 'Protocol';
              const message = typeof reply.message === 'string' ? reply.message : undefined;
              reject(new TurnError(kind, message, tail));
            } else if (reply.json === undefined || reply.json === null) {
              reject(new TurnError('Protocol', 'the turn returned no JSON', tail));
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
