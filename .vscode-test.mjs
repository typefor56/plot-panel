import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.131.0',
  // Built-in extensions stay enabled: the tests rely on the bundled
  // vscode.ipynb extension, which contributes the jupyter-notebook type.
  launchArgs: ['--disable-gpu'],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
