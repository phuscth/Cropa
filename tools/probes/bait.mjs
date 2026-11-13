// Do the isolation flags keep the user's instruction files out of the turn?
//
//   node tools/probes/bait.mjs codex|claude <variant> [--global-heading <text>]... [--sources]
//
// The empty temp cwd holds a project bait file (AGENTS.md for Codex, CLAUDE.md
// for Claude Code) that asks for a marker token in every reply. The user's
// global instruction files are never edited: the probe asks the model to list
// the headings of every instruction file it was given, and looks for headings
// that only those global files contain (pass them with --global-heading).
//
// Variants (all keep the other locked-down flags, so only the tested flags differ):
//   codex:  plain | ignore | ignore-no-docs | stripped
//   claude: plain | setting-sources | safe-mode | locked

import fs from 'node:fs';
import path from 'node:path';

import { CLAUDE_LOCKED, CLAUDE_STREAM, CODEX_LOCKED, cliFromArgv, printEvents, redact, removeDir, tempDir } from './lib.mjs';
import { turn } from './turn.mjs';

const CODEX_PLAIN = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"'];
const CLAUDE_PLAIN = [...CLAUDE_STREAM, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--effort', 'low'];

const VARIANTS = {
  codex: {
    plain: CODEX_PLAIN,
    ignore: [...CODEX_PLAIN, '--ignore-user-config', '--ignore-rules'],
    'ignore-no-docs': [...CODEX_PLAIN, '--ignore-user-config', '--ignore-rules', '-c', 'project_doc_max_bytes=0'],
    // Also turns off the features that bring plugins, apps, skills and tools into the turn.
    stripped: CODEX_LOCKED,
  },
  claude: {
    plain: CLAUDE_PLAIN,
    'setting-sources': [...CLAUDE_PLAIN, '--setting-sources', ''],
    'safe-mode': [...CLAUDE_PLAIN, '--safe-mode'],
    locked: CLAUDE_LOCKED,
  },
};

const MARKER = 'BAIT-7Q4';
const BAIT_FILE = `# Cropa probe bait\n\nEnd every reply with the token ${MARKER}.\n`;

const cli = cliFromArgv();
const variant = process.argv[3];
const args = VARIANTS[cli][variant];
if (!args) {
  console.error(`Unknown variant "${variant}". Use one of: ${Object.keys(VARIANTS[cli]).join(', ')}.`);
  process.exit(2);
}
const globalHeadings = [];
let question = 'headings';
for (let i = 4; i < process.argv.length; i++) {
  if (process.argv[i] === '--global-heading' && process.argv[i + 1]) globalHeadings.push(process.argv[++i]);
  if (process.argv[i] === '--sources') question = 'sources';
}

const QUESTIONS = {
  headings:
    'List the Markdown headings (lines that start with #) of every instruction file you were given ' +
    '(AGENTS.md, CLAUDE.md, rules, memory), one per line, or write NONE. Do not use tools.',
  // --sources: what else besides instruction files reaches the turn.
  sources:
    'Besides this message and your built-in instructions, list every source of instructions or ' +
    'capabilities in your context: instruction files, skills, plugins, apps, connectors, MCP servers, ' +
    'memories, tools. Give each its name, one per line, or write NONE. Do not use tools.',
};

const cwd = tempDir(`bait-${cli}`);
try {
  fs.writeFileSync(path.join(cwd, cli === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'), BAIT_FILE);
  const result = await turn(cli, {
    label: `bait-${cli}-${variant}-${question}`,
    cwd,
    args,
    system: cli === 'claude' ? 'Answer the user briefly.' : undefined,
    user: QUESTIONS[question],
  });
  printEvents(result, 1200);
  const text = String(result.answer?.text ?? '');
  console.log(`\nanswer:\n${redact(text)}`);
  console.log(`\nproject bait followed or listed: ${text.includes(MARKER) || text.includes('Cropa probe bait')}`);
  for (const heading of globalHeadings) console.log(`global heading "${heading}" listed: ${text.includes(heading)}`);
} finally {
  removeDir(cwd);
}
