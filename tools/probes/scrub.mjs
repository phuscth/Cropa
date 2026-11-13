// Turns a raw event stream from `out/` into a fixture that is safe to commit:
// account emails, ids, session and message ids, signatures, temp folders and
// paths under the user's home are replaced with fixed placeholders. Refuses to
// write if anything that looks like a leftover remains.
//
//   node tools/probes/scrub.mjs <raw file> <fixture file>
//
// A .jsonl output must parse line by line, a .json output as a whole.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node tools/probes/scrub.mjs <raw file> <fixture file>');
  process.exit(2);
}

const home = os.homedir();
const user = path.basename(home);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Paths appear JSON-escaped (`C:\\Users\\x`) inside event strings.
const jsonEscaped = (p) => p.replaceAll('\\', '\\\\');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rules = [
  // Temp turn folders first, before the generic temp folder.
  // Keep the separator as matched, so it stays valid at any escaping depth.
  [/[A-Za-z]:(\\+|\/)(?:[^"\s]*?(?:\\+|\/))?cropa-probe-[\w-]+/g, (_, sep) => `C:${sep}Temp${sep}cropa-turn`],
  // JSON inside a JSON string (Codex error messages) escapes paths twice.
  [new RegExp(escapeRe(jsonEscaped(jsonEscaped(home))), 'gi'), 'C:\\\\\\\\Users\\\\\\\\user'],
  [new RegExp(escapeRe(jsonEscaped(home)), 'gi'), 'C:\\\\Users\\\\user'],
  [new RegExp(escapeRe(home), 'gi'), 'C:\\Users\\user'],
  [new RegExp(escapeRe(home.replaceAll('\\', '/')), 'gi'), 'C:/Users/user'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ZERO_UUID],
  [/"signature":"[^"]*"/g, '"signature":"SIGNATURE"'],
  // API ids are long random strings; short names such as `msg_lifecycle_v1` stay.
  [/\b(msg|toolu|req|srvtoolu)_[A-Za-z0-9]{16,}\b/g, '$1_PLACEHOLDER'],
  [/\b(sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, 'TOKEN_PLACEHOLDER'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'TOKEN_PLACEHOLDER'],
  // Named pipes and other per-machine ids.
  [/\b[0-9a-f]{24,}\b/gi, 'HEX_PLACEHOLDER'],
];

let text = fs.readFileSync(input, 'utf8');
for (const [re, replacement] of rules) text = text.replace(re, replacement);

// The output must still parse: every line of a .jsonl, the whole of a .json.
const mustParse = output.endsWith('.jsonl')
  ? text.split('\n').filter((line) => line.trim())
  : output.endsWith('.json')
    ? [text]
    : [];
for (const [i, part] of mustParse.entries()) {
  try {
    JSON.parse(part);
  } catch {
    console.error(`Part ${i + 1} is not JSON after scrubbing: ${part.slice(0, 120)}`);
    process.exit(1);
  }
}

const leftovers = [
  /\beyJ[A-Za-z0-9_-]{10,}/,new RegExp(`\\b${escapeRe(user)}\\b`, 'i'), /@(?!example\.com)[\w-]+\.[a-z]{2,}/i, /cropa-probe-/];
for (const re of leftovers) {
  const m = text.match(re);
  if (m) {
    console.error(`Refusing to write: "${m[0]}" is still in the output (${re}).`);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, text);
console.log(`Wrote ${output}`);
