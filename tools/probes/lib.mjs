// Shared helpers for the CLI probes. Each probe spawns the user's installed
// `codex` or `claude` with fixed arguments, records every stdout line with the
// time it arrived, and writes the raw streams to `out/` (gitignored).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');

/** Absolute path of `<name>.exe` from PATH, so nothing goes through a shell. */
export function resolveCli(name) {
  // `$PATH:` keeps where.exe from looking in the current folder first.
  const found = execFileSync('where.exe', [`$PATH:${name}`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('.exe'));
  if (!found) throw new Error(`${name}.exe was not found in PATH`);
  return found;
}

// The variables a Windows process needs to start, find the user's profile and
// write temp files. Everything else (ANTHROPIC_*, CLAUDE_CODE_*, OPENAI_*, the
// parent agent's session variables) is dropped, as the app will do.
const ENV_ALLOWLIST = [
  'APPDATA',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.includes(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * A fresh empty folder under %TEMP%. Refuses when %TEMP% is inside a git
 * repository: Codex would then run instead of refusing without
 * --skip-git-repo-check, and both CLIs could pick up instruction files from
 * the repository, which breaks the "empty folder" premise of every probe.
 */
export function tempDir(prefix) {
  const base = os.tmpdir();
  for (let dir = base; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(`%TEMP% (${base}) is inside the git repository ${dir}. Set TEMP and TMP to a folder outside any repository.`);
    }
    if (path.dirname(dir) === dir) break;
  }
  return fs.mkdtempSync(path.join(base, `cropa-probe-${prefix}-`));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Spawns one process and resolves when it exits (or after `timeoutMs`, when
 * the whole tree is killed). Times are milliseconds since spawn.
 */
export function run({
  label,
  exe,
  args,
  stdin = '',
  cwd,
  env = cleanEnv(),
  timeoutMs = 180_000,
  onLine,
}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `${stamp()}-${label}`);
  const lines = [];
  let stderr = '';
  let partial = '';
  const t0 = performance.now();
  const child = spawn(exe, args, { cwd, env, windowsHide: true });
  const elapsed = () => Math.round(performance.now() - t0);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    partial += chunk;
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const text = partial.slice(0, nl).replace(/\r$/, '');
      partial = partial.slice(nl + 1);
      if (!text) continue;
      const line = { t: elapsed(), text };
      lines.push(line);
      onLine?.(line, child);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);

  const timer = setTimeout(() => {
    killTree(child.pid);
  }, timeoutMs);

  // A descendant that outlives the root can hold the stdout pipe open, and then
  // 'close' never comes. Stop waiting for output 2 s after the root exits.
  let exitMs;
  child.on('exit', () => {
    exitMs = elapsed();
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, 2000).unref();
  });

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (partial.trim()) lines.push({ t: elapsed(), text: partial.trim() });
      const result = {
        label,
        exe: path.basename(exe),
        args,
        cwd,
        pid: child.pid,
        exitCode: code,
        signal,
        exitMs: exitMs ?? elapsed(),
        closeMs: elapsed(),
        lines,
        stderr,
        files: { stdout: `${base}.stdout.jsonl`, stderr: `${base}.stderr.txt`, meta: `${base}.meta.json` },
      };
      fs.writeFileSync(result.files.stdout, lines.map((l) => l.text).join('\n') + (lines.length ? '\n' : ''));
      fs.writeFileSync(result.files.stderr, stderr);
      fs.writeFileSync(
        result.files.meta,
        JSON.stringify(
          { ...result, lines: lines.map((l) => ({ t: l.t, bytes: l.text.length })), stderr: undefined },
          null,
          2,
        ),
      );
      resolve(result);
    });
  });
}

/** Kills a process and every descendant (`taskkill /T /F`). */
export function killTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** Every process on the machine as { pid, ppid, name }. */
export function processTable() {
  const json = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(json).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }));
}

/** The process `rootPid` and all its descendants, from one snapshot. */
export function descendants(table, rootPid) {
  const found = table.filter((p) => p.pid === rootPid);
  for (let i = 0; i < found.length; i++) {
    for (const p of table) {
      if (p.ppid === found[i].pid && !found.some((f) => f.pid === p.pid)) found.push(p);
    }
  }
  return found;
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Nearest-rank percentile. */
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Masks emails, UUIDs and the user's home folder before printing to the console. */
export function redact(text) {
  const home = os.homedir();
  return String(text)
    .replaceAll(home, '<HOME>')
    .replaceAll(home.replaceAll('\\', '\\\\'), '<HOME>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<EMAIL>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
}

// --- The request every model probe sends: about the size of a background request.

export const BACKGROUND_SYSTEM =
  'You design backgrounds for app screenshots. Answer only with JSON that matches the given schema. ' +
  'Use at most 3 layers. Colours are 6-digit hex. Prefer calm gradients that keep the screenshot readable.';

export const BACKGROUND_USER =
  'Screenshot palette: #1e293b (60%), #38bdf8 (25%), #f8fafc (15%). Frame: 16:9 with rounded corners and a soft shadow. ' +
  'The user asks for: "a calm background for a dark code editor, a bit of blue". Return the layers.';

export const BACKGROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layers'],
  properties: {
    layers: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'colors', 'angle'],
        properties: {
          kind: { type: 'string', enum: ['solid', 'linear', 'radial'] },
          colors: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } },
          angle: { type: 'number', minimum: 0, maximum: 360 },
        },
      },
    },
  },
};

// --- Locked-down argument sets. The prompt always goes through stdin.

// The first flag set tried: read-only sandbox and no user config or rules.
export const CODEX_MINIMAL = [
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  '--ignore-user-config',
  '--ignore-rules',
  '-c',
  'model_reasoning_effort="low"',
];

// Features that still bring the user's plugins, apps, skills and agent tools
// into a turn when only the flags above are given.
export const CODEX_DISABLED_FEATURES = [
  'apps',
  'plugins',
  'skill_search',
  'tool_suggest',
  'multi_agent',
  'goals',
  'hooks',
  'image_generation',
  'browser_use',
  'computer_use',
  'shell_tool',
  'unified_exec',
  'view_image',
  'sleep_tool',
];

export const CODEX_LOCKED = [
  ...CODEX_MINIMAL,
  '-c',
  'project_doc_max_bytes=0',
  '-c',
  'web_search="disabled"',
  ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
];

export const CLAUDE_STREAM = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

export const CLAUDE_LOCKED = [
  ...CLAUDE_STREAM,
  '--tools',
  '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--safe-mode',
  '--effort',
  'low',
];

/** One stream-json user message for `claude -p --input-format stream-json`. */
export function claudeUserMessage(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n';
}

/** True for the event that ends a turn. */
export function isFinal(cli, event) {
  if (!event) return false;
  if (cli === 'claude') return event.type === 'result';
  return event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error';
}

export function cliFromArgv() {
  const cli = process.argv[2];
  if (cli !== 'codex' && cli !== 'claude') {
    console.error('First argument must be "codex" or "claude".');
    process.exit(2);
  }
  return cli;
}

/** A small RGB PNG: left half red, right half blue. */
export function twoColourPng(width = 256, height = 128) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      const [r, g, b] = x < width / 2 ? [220, 30, 30] : [30, 60, 220];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Prints a run's events, one per line, shortened and redacted. */
export function printEvents(result, max = 400) {
  for (const { t, text } of result.lines) {
    console.log(`  +${String(t).padStart(6)} ms  ${redact(text.length > max ? `${text.slice(0, max)}…` : text)}`);
  }
  if (result.stderr.trim()) console.log(`  stderr: ${redact(result.stderr.trim().slice(0, 2000))}`);
  console.log(`  exit ${result.exitCode} after ${result.exitMs} ms  (raw: ${path.basename(result.files.stdout)})`);
}
