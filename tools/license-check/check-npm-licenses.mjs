#!/usr/bin/env node
// Fails when a production npm dependency uses a licence outside the allowlist
// (blocks GPL/AGPL). Usage: node tools/license-check/check-npm-licenses.mjs
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Zlib',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'Python-2.0',
  'CC-BY-4.0',
  'OFL-1.1',
]);

/** Workspace packages are ours (MIT); pnpm reports them as `private`. */
const OWN_SCOPE = '@cropa/';

/** Accept SPDX `OR` expressions when at least one branch is allowed. */
function isAllowed(expression) {
  const cleaned = expression.replace(/[()]/g, '').trim();
  if (cleaned.includes(' AND ')) return cleaned.split(' AND ').every((part) => isAllowed(part));
  return cleaned.split(' OR ').some((part) => ALLOWED.has(part.trim()));
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod', '--recursive'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);

const violations = [];
let count = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    count += 1;
    if (pkg.name.startsWith(OWN_SCOPE)) continue;
    if (!isAllowed(license)) {
      violations.push(`${pkg.name}@${pkg.versions.join(',')}: ${license}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Disallowed npm licences (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`npm licences OK (${count} production packages checked).`);
