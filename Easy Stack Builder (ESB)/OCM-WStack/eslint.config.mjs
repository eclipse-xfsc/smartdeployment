export default [{
  files: ['runtime/lib/**/*.cjs', 'runtime/nodes/**/*.js', 'ui/src/**/*.js'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: { 'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] }
}];
