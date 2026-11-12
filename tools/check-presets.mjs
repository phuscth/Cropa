// Checks every file in presets/: size, file name, JSON, schema, and that the id
// matches the file name. Prints one line per problem and exits 1 if there is any.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESET_MAX_BYTES, importPreset } from '../packages/core/src/presets/file.ts';

const dir = fileURLToPath(new URL('../presets/', import.meta.url));
const problems = [];
let count = 0;

for (const name of readdirSync(dir).sort()) {
  if (name === 'README.md') continue;
  const label = `presets/${name}`;
  const path = join(dir, name);
  if (!statSync(path).isFile() || !name.endsWith('.json')) {
    problems.push(`${label}: only .json files are allowed in presets/`);
    continue;
  }
  count += 1;
  const id = name.slice(0, -'.json'.length);
  const bytes = statSync(path).size;
  if (bytes > PRESET_MAX_BYTES) {
    problems.push(`${label}: ${bytes} bytes, over the ${PRESET_MAX_BYTES} byte limit`);
    continue;
  }
  const result = importPreset(readFileSync(path, 'utf8'));
  if (!result.ok) {
    const { error } = result;
    if (error.kind === 'invalid') {
      for (const issue of error.issues) problems.push(`${label}: ${issue}`);
    } else if (error.kind === 'too-new') {
      problems.push(`${label}: version ${error.version} is newer than the supported ${error.supported}`);
    } else if (error.kind === 'not-json') {
      problems.push(`${label}: not valid JSON`);
    } else {
      problems.push(`${label}: ${error.bytes} bytes, over the ${error.limit} byte limit`);
    }
    continue;
  }
  if (result.value.id !== id) {
    problems.push(`${label}: id "${result.value.id}" must equal the file name "${id}"`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`${count} presets OK`);
