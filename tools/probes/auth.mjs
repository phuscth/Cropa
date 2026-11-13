// Detection without spending quota: version and login status of both CLIs,
// once with the user's own config folders and once with empty ones (the
// not-logged-in case, shown without logging the user out).
//
//   node tools/probes/auth.mjs

import { cleanEnv, printEvents, removeDir, resolveCli, run, tempDir } from './lib.mjs';

const codex = resolveCli('codex');
const claude = resolveCli('claude');
const cwd = tempDir('auth');
const emptyCodexHome = tempDir('codex-home');
const emptyClaudeDir = tempDir('claude-config');

const cases = [
  { label: 'codex-version', exe: codex, args: ['--version'] },
  { label: 'claude-version', exe: claude, args: ['--version'] },
  { label: 'codex-login-status', exe: codex, args: ['login', 'status'] },
  { label: 'claude-auth-status', exe: claude, args: ['auth', 'status'] },
  { label: 'claude-auth-status-text', exe: claude, args: ['auth', 'status', '--text'] },
  {
    label: 'codex-login-status-empty-home',
    exe: codex,
    args: ['login', 'status'],
    env: cleanEnv({ CODEX_HOME: emptyCodexHome }),
  },
  {
    label: 'claude-auth-status-empty-config',
    exe: claude,
    args: ['auth', 'status'],
    env: cleanEnv({ CLAUDE_CONFIG_DIR: emptyClaudeDir }),
  },
  {
    label: 'claude-auth-status-text-empty-config',
    exe: claude,
    args: ['auth', 'status', '--text'],
    env: cleanEnv({ CLAUDE_CONFIG_DIR: emptyClaudeDir }),
  },
];

try {
  for (const c of cases) {
    const result = await run({ ...c, cwd, timeoutMs: 30_000 });
    console.log(`\n## ${c.label}: ${c.args.join(' ')}`);
    printEvents(result);
  }
} finally {
  for (const dir of [cwd, emptyCodexHome, emptyClaudeDir]) removeDir(dir);
}
