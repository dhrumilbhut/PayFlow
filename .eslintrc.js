module.exports = {
  env: { node: true, es2022: true, jest: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 2022 },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'warn',
    'prefer-const': 'error',
    'no-var': 'error',
  },
};
