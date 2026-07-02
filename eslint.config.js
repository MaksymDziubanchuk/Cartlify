import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },

  ...compat.config({
    env: {
      es2020: true,
      node: true,
      jest: true,
    },

    parser: '@typescript-eslint/parser',

    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },

    plugins: ['@typescript-eslint', 'import'],

    extends: [
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:import/recommended',
      'plugin:import/typescript',
      'prettier',
    ],

    rules: {
      'no-unused-vars': 'off',

      'import/no-unresolved': 'off',
      'import/order': 'off',

      '@typescript-eslint/no-unused-vars': ['warn'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  }),
];
