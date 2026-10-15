import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { importX } from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// native flat config: eslint 10 has no eslintrc and no FlatCompat any more;
// eslint-plugin-import does not support eslint 10, eslint-plugin-import-x is its fork that does
export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'tests/coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.es2020,
        ...globals.node,
      },
    },

    rules: {
      'no-unused-vars': 'off',

      'import-x/no-unresolved': 'off',
      'import-x/order': 'off',

      // typescript checks default and named imports of .ts files; these rules misread
      // packages with `export =` types (fastify, bcrypt, ws) and a default import of a
      // commonjs package in .mjs, which node allows
      'import-x/default': 'off',
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',

      '@typescript-eslint/no-unused-vars': ['warn'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
];
