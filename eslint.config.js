// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '.claude/', // agent worktrees and local settings
      'packages/api/src/schema.d.ts',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each package's src/ and test/ has its own tsconfig.json; the root
        // tsconfig.json covers vitest.config.ts. Plain JS is linted untyped.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Import rules. Package boundaries are enforced by dependency-cruiser.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@multitap/[^/]+/|([.][.]/)+packages/)',
              message:
                'Import workspace packages by their package name only, never by deep or relative path.',
            },
            {
              regex: '(^|/)dist(/|$)',
              message: 'Import sources, not build output.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Repository scripts run on Node.
    files: ['scripts/**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  prettier,
);
