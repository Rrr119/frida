import js from '@eslint/js';
import neostandard from 'neostandard';

export default [
  js.configs.recommended,
  ...neostandard(),
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        Java: 'readonly',
        Interceptor: 'readonly',
        Script: 'readonly',
        send: 'readonly',
        Process: 'readonly',
        NativeCallback: 'readonly',
        NativePointer: 'readonly',
        ptr: 'readonly',
        Memory: 'readonly',
        setTimeout: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    ignores: ['node_modules/', 'build/']
  }
];
