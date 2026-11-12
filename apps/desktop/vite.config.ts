import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const host = process.env['TAURI_DEV_HOST'];

// One Vite entry per window (ROADMAP §3.5). The HTML path is also the window URL in tauri.conf.json.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
        editor: resolve(import.meta.dirname, 'src/windows/editor/index.html'),
        settings: resolve(import.meta.dirname, 'src/windows/settings/index.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
