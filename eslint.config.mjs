import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typed = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.ts']
}));

export default tseslint.config(
  {
    ignores: [
      '**/.data/**',
      '**/.cache/**',
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/coverage/**',
      'apps/relay/public/**',
      'apps/web/src/lib/generated/**',
      '**/*.svelte',
      '**/*.test.ts',
      '**/*.config.*',
      'script/**'
    ]
  },
  eslint.configs.recommended,
  {
    files: ['deploy/integration/**/*.mjs'],
    languageOptions: { globals: globals.node }
  },
  ...typed,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off'
    }
  },
  {
    files: ['apps/relay/src/server.ts', 'packages/adapters/src/postgres-repository.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off'
    }
  }
);
