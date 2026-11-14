import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { bundleThreeIife } from './three-bundle.ts';

const host = process.env['TAURI_DEV_HOST'];

// The sandbox worker needs three.js (with its addons) as a classic script; see three-bundle.ts.
function threeIife(): Plugin {
  const id = 'virtual:cropa-three';
  return {
    name: 'cropa-three-iife',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(loadId) {
      if (loadId !== `\0${id}`) return undefined;
      return `export default ${JSON.stringify(await bundleThreeIife())};`;
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
