import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['scripts/node_modules/**'] },
  {
    files: ['scripts/**/*.{js,mjs}', 'test/**/*.mjs', 'eslint.config.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: [
      'scripts/presets.js', 'scripts/tui.mjs', 'scripts/lib/pick.mjs',
      'scripts/lib/textview.mjs', 'scripts/welcome/**/*.{js,mjs}', 'test/browser.mjs',
    ],
    languageOptions: { globals: globals.browser },
  },
];
