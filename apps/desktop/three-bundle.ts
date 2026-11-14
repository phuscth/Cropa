import { resolve } from 'node:path';

import { build, type Rolldown } from 'vite';

/** The entry the sandbox bundle is built from: three.js and the fixed set of addons. */
export const THREE_ENTRY = resolve(import.meta.dirname, 'src/features/code-sandbox/three-entry.js');

/**
 * three ships no classic build and the sandbox worker needs a classic script, so bundle the entry
 * as an IIFE that defines the global `THREE`. The desktop build and the eval both use this.
 */
export async function bundleThreeIife(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false,
      minify: true,
      lib: { entry: THREE_ENTRY, formats: ['iife'], name: 'THREE', fileName: () => 'three.js' },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result) as Rolldown.RolldownOutput | undefined;
  const chunk = output && 'output' in output ? output.output.find((o) => o.type === 'chunk') : undefined;
  if (!chunk) throw new Error('Bundling three.js as a classic script produced no output');
  return chunk.code;
}
