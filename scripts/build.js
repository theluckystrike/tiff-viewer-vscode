'use strict';
// Bundles the extension host, the webview and the decoder worker with esbuild.
// The worker is built first and inlined as a string, so the webview can start it from a blob URL under its CSP.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
(async () => {
  const w = await esbuild.build({ ...common, entryPoints: ['src/webview/worker.js'], write: false, platform: 'browser', format: 'iife', target: 'chrome110', define: { 'process.env.NODE_ENV': '"production"' } });
  const workerSrc = w.outputFiles[0].text;
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110', define: { __WORKER_SRC__: JSON.stringify(workerSrc) } }),
  ]);
  console.log(`built: worker ${(workerSrc.length / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
