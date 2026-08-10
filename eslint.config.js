export default [
  {
    ignores: ['node_modules/**', 'data/**', 'dist/**'],
  },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {jsx: true},
      },
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-constant-condition': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['web/**/*.{js,mjs,jsx}'],
    languageOptions: {
      globals: {
        clearInterval: 'readonly',
        document: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
];
