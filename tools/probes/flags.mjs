// Are the locked-down flags accepted by the installed versions? Each case runs
// with an empty stdin (one exception below), so the CLI parses its arguments
// and then stops for lack of a prompt: a refused flag fails at parsing, and no
// quota is spent.
//
//   node tools/probes/flags.mjs

import fs from 'node:fs';
import path from 'node:path';

import {
  BACKGROUND_SCHEMA,
  CLAUDE_LOCKED,
  CLAUDE_STREAM,
  CODEX_LOCKED,
  printEvents,
  removeDir,
  resolveCli,
  run,
  tempDir,
} from './lib.mjs';

const codex = resolveCli('codex');
const claude = resolveCli('claude');
const cwd = tempDir('flags');
const schemaFile = path.join(cwd, 'schema.json');
fs.writeFileSync(schemaFile, JSON.stringify(BACKGROUND_SCHEMA));

const codexBase = ['exec', '--json', '--ephemeral', '--skip-git-repo-check'];
const codexCases = [
  ['base', codexBase],
  // Needs a prompt: the git check runs after stdin is read. It refuses before
  // any request because the temp folder is neither a repository nor trusted.
  ['no-skip-git-repo-check', ['exec', '--json', '--ephemeral'], 'Reply with OK.'],
  ['sandbox-read-only', [...codexBase, '--sandbox', 'read-only']],
  ['ignore-user-config', [...codexBase, '--ignore-user-config']],
  ['ignore-rules', [...codexBase, '--ignore-rules']],
  ['output-schema', [...codexBase, '--output-schema', schemaFile]],
  ['approval-policy-config', [...codexBase, '-c', 'approval_policy="never"']],
  ['ask-for-approval-flag', [...codexBase, '--ask-for-approval', 'never']],
  ['reasoning-effort-config', [...codexBase, '-c', 'model_reasoning_effort="low"']],
  ['project-doc-max-bytes-config', [...codexBase, '-c', 'project_doc_max_bytes=0']],
  ['full-locked', [...CODEX_LOCKED, '--output-schema', schemaFile]],
  ['control-unknown-flag', [...codexBase, '--no-such-flag']],
];

const claudeCases = [
  ['stream-json-no-verbose', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']],
  ['stream-json', CLAUDE_STREAM],
  ['tools-empty', [...CLAUDE_STREAM, '--tools', '']],
  ['strict-mcp-config', [...CLAUDE_STREAM, '--strict-mcp-config']],
  ['disable-slash-commands', [...CLAUDE_STREAM, '--disable-slash-commands']],
  ['setting-sources-empty', [...CLAUDE_STREAM, '--setting-sources', '']],
  ['no-session-persistence', [...CLAUDE_STREAM, '--no-session-persistence']],
  ['safe-mode', [...CLAUDE_STREAM, '--safe-mode']],
  ['json-schema', [...CLAUDE_STREAM, '--json-schema', JSON.stringify(BACKGROUND_SCHEMA)]],
  ['system-prompt', [...CLAUDE_STREAM, '--system-prompt', 'You answer in JSON.']],
  ['effort-low', [...CLAUDE_STREAM, '--effort', 'low']],
  ['full-locked', [...CLAUDE_LOCKED, '--json-schema', JSON.stringify(BACKGROUND_SCHEMA)]],
  ['control-unknown-flag', [...CLAUDE_STREAM, '--no-such-flag']],
];

try {
  for (const [name, args, stdin = ''] of codexCases) {
    const result = await run({ label: `flags-codex-${name}`, exe: codex, args, stdin, cwd, timeoutMs: 30_000 });
    console.log(`\n## codex ${name}`);
    printEvents(result);
  }
  for (const [name, args] of claudeCases) {
    const result = await run({ label: `flags-claude-${name}`, exe: claude, args, cwd, timeoutMs: 30_000 });
    console.log(`\n## claude ${name}`);
    printEvents(result);
  }
} finally {
  removeDir(cwd);
}
