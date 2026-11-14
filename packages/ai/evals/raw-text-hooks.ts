// Lets plain Node load `import text from './file.md?raw'`, which Vite does in the app and in
// vitest: a specifier ending in `?raw` becomes a module whose default export is the file's text.
// Run it with `node --import ./evals/raw-text-hooks.ts`.

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const SUFFIX = '?raw';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(SUFFIX)) return nextResolve(specifier, context);
    const resolved = nextResolve(specifier.slice(0, -SUFFIX.length), context);
    return { ...resolved, url: `${resolved.url}${SUFFIX}`, format: 'module', shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(SUFFIX)) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url.slice(0, -SUFFIX.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
