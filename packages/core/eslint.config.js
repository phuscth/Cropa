import { cropaEslint } from '@cropa/config/eslint';

const boundary =
  '@cropa/core runs in the WebView and in Node: no Tauri, network, DOM beyond Canvas, or Node APIs';

export default [
  ...cropaEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', '@tauri-apps/*', '@napi-rs/*'], message: boundary },
            {
              group: ['fs', 'path', 'os', 'child_process', 'http', 'https', 'net'],
              message: boundary,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'navigator',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
          'process',
          'Buffer',
          'require',
          'OffscreenCanvas',
          'Image',
          'HTMLCanvasElement',
        ].map((name) => ({ name, message: boundary })),
      ],
    },
  },
];
