import { builtinModules } from 'node:module';

import { cropaEslint } from '@cropa/config/eslint';

const boundary =
  '@cropa/ai runs in the WebView: no Tauri, no Node APIs, no process spawning, no network';

export default [
  ...cropaEslint({ tsconfigRootDir: import.meta.dirname }),
  {
    // The evals run in Node and have their own tsconfig with Node typings.
    files: ['evals/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.eval.json'],
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
          patterns: [{ group: ['node:*', '@tauri-apps/*'], message: boundary }],
        },
      ],
    },
  },
];
