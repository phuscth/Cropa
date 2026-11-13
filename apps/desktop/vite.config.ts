import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type Plugin, type Rolldown } from 'vite';
import { defineConfig } from 'vitest/config';

const host = process.env['TAURI_DEV_HOST'];

// three ships no classic build and the sandbox worker needs a classic script, so bundle it as an IIFE.
function threeIife(): Plugin {
  const id = 'virtual:cropa-three';
  return {
    name: 'cropa-three-iife',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(loadId) {
      if (loadId !== `\0${id}`) return undefined;
      const result = await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          write: false,
          minify: true,
          lib: {
            entry: resolve(import.meta.dirname, 'node_modules/three/build/three.module.js'),
            formats: ['iife'],
            name: 'THREE',
            fileName: () => 'three.js',
          },
        },
      });
      const output = (Array.isArray(result) ? result[0] : result) as Rolldown.RolldownOutput | undefined;
      const chunk = output && 'output' in output ? output.output.find((o) => o.type === 'chunk') : undefined;
      if (!chunk) throw new Error('Bundling three.js as a classic script produced no output');
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

// One Vite entry per window. The HTML path is also the window URL in tauri.conf.json.
export default defineConfig({
  plugins: [react(), tailwindcss(), threeIife()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    ...(host ? { hmr: { protocol: 'ws', host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome120',
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/windows/main/index.html'),
        onboarding: resolve(import.meta.dirname, 'src/windows/onboarding/index.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
