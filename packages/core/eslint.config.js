import { builtinModules } from 'node:module';

import { cropaEslint } from '@cropa/config/eslint';

const boundary =
  '@cropa/core runs in the WebView and in Node: no Tauri, network, DOM beyond Canvas, or Node APIs';

export default [
  ...cropaEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    // The tests live in their own tsconfig (with Node typings), which the
    // project service would not find from tsconfig.json.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({ name, message: boundary })),
          patterns: [{ group: ['node:*', '@tauri-apps/*', '@napi-rs/*'], message: boundary }],
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
