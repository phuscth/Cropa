// Cancel mid-turn: start a long answer, wait for the first event plus a short
// delay, snapshot the process tree, kill, then check which of those processes
// are still alive.
//
//   node tools/probes/cancel.mjs codex|claude tree|root
//
// tree  `taskkill /PID <pid> /T /F`: the root and every descendant
// root  TerminateProcess on the root only (Node's child.kill()), to show what
//       a kill that ignores the tree leaves behind
//
// Survivors are killed at the end, so nothing is left running.

import { performance } from 'node:perf_hooks';

import { descendants, killTree, processTable, removeDir, tempDir } from './lib.mjs';
import { turn } from './turn.mjs';

const cli = process.argv[2];
const mode = process.argv[3];
if (!['codex', 'claude'].includes(cli) || !['tree', 'root'].includes(mode)) {
  console.error('Usage: node tools/probes/cancel.mjs codex|claude tree|root');
  process.exit(2);
}

const DELAY_AFTER_FIRST_EVENT_MS = 2500;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (table, proc) => table.some((p) => p.pid === proc.pid && p.name === proc.name);

const cwd = tempDir(`cancel-${cli}`);
let tree = [];
let killedAtMs;
let scheduled = false;
try {
  const result = await turn(cli, {
    label: `cancel-${cli}-${mode}`,
    cwd,
    user: 'Write the numbers from 1 to 400, one per line, then a 300-word story about a lighthouse.',
    timeoutMs: 120_000,
    onLine(line, child) {
      if (scheduled) return;
      scheduled = true;
      const lineAt = performance.now();
      setTimeout(() => {
        // The turn may already have ended; its PID could then belong to another process.
        if (child.exitCode !== null || child.signalCode !== null) return;
        tree = descendants(processTable(), child.pid);
        if (child.exitCode !== null || child.signalCode !== null) return;
        killedAtMs = Math.round(line.t + performance.now() - lineAt);
        if (mode === 'tree') killTree(child.pid);
        else child.kill();
      }, DELAY_AFTER_FIRST_EVENT_MS);
    },
  });

  await wait(3000);
  const after = processTable();
  // Match PID and name, so a reused PID is not taken for a survivor.
  const survivors = tree.filter((p) => isAlive(after, p));
  console.log(`## cancel ${cli} (${mode})`);
  console.log(`events before kill: ${result.lines.length}, last event type: ${result.events.at(-1)?.event?.type}`);
  console.log(`final event seen: ${result.final !== undefined}`);
  if (killedAtMs === undefined) console.log('the turn ended before the kill: nothing was killed');
  console.log(`kill at ${killedAtMs} ms, root exited at ${result.exitMs} ms, pipes closed at ${result.closeMs} ms, exit code ${result.exitCode}, signal ${result.signal}`);
  console.log(`tree at kill time (${tree.length}): ${tree.map((p) => `${p.name}#${p.pid}`).join(', ')}`);
  console.log(`still running 3 s later (${survivors.length}): ${survivors.map((p) => `${p.name}#${p.pid}`).join(', ') || 'none'}`);
  for (const p of survivors) killTree(p.pid);
} finally {
  removeDir(cwd);
}
