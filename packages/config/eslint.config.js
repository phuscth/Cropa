// Shared ESLint flat config for every Cropa package.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @param {{ tsconfigRootDir: string, react?: boolean }} options
 */
export function cropaEslint({ tsconfigRootDir, react = false }) {
  return tseslint.config(
    { ignores: ['dist/**', 'src-tauri/**', 'src/lib/bindings.ts'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.browser },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs'],
      ...tseslint.configs.disableTypeChecked,
    },
    ...(react ? [reactHooks.configs.flat.recommended] : []),
  );
}
