'use strict';
// The extension host on a mocked VS Code API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { encodeTiff } = require('./tiffwriter');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiffv-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const state = { config: { maxFileMB: 1024, askForRating: true }, saveTarget: null, clipboard: '', infos: [] };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: { stat: async u => ({ size: fs.statSync(u.fsPath).size }), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d) },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showSaveDialog: async () => state.saveTarget, showInformationMessage: async (...a) => { state.infos.push(a); },
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async () => {} },
  env: { clipboard: { writeText: async t => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: h => { dispose = h; },
  };
  return { panel, sent, send: m => handler(m), close: () => dispose() };
}

async function open(file) {
  const ctx = { extensionUri: uriOf('/ext'), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } };
  const prov = new ext.TiffEditorProvider(ctx);
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return f;
}

test('activate registers the custom editor and the commands', () => {
  const ctx = { subscriptions: [], extensionUri: uriOf('/ext'), globalState: { get() {}, async update() {} } };
  ext.activate(ctx);
  assert.equal(vscodeMock.window.registered[0][0], 'tiffViewer.preview');
  assert.deepEqual(vscodeMock.commands.list.sort(), ['tiffViewer.moreViewers', 'tiffViewer.openWalkthrough', 'tiffViewer.openWith', 'tiffViewer.supportDeveloper']);
  const pkg = require('../package.json');
  assert.equal(pkg.contributes.customEditors[0].viewType, ext.VIEW_TYPE);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern), ['*.tif', '*.tiff']);
  assert.ok(pkg.displayName.toLowerCase().startsWith('tiff viewer') && pkg.displayName.length <= 45);
  assert.ok(pkg.keywords.length <= 30);
});

test('ready sends init with pages, tags and the file URL; webview HTML has the CSP', async () => {
  const file = path.join(tmp, 'two.tif');
  fs.writeFileSync(file, encodeTiff([{ width: 5, height: 4, data: new Uint8Array(20), tags: [[285, 2, 'first']] }, { width: 6, height: 2, bps: 16, data: new Uint8Array(24) }]));
  const f = await open(file);
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
  assert.equal(f.panel.webview.options.enableScripts, true);
  await f.send({ type: 'ready' });
  const init = f.sent.find(m => m.type === 'init');
  assert.equal(init.pages.length, 2); assert.equal(init.pages[0].name, 'first'); assert.equal(init.pages[1].bps, 16);
  assert.equal(init.plan.decode, true); assert.equal(init.src, 'https://res' + file);
  await f.send({ type: 'needBytes' });
  assert.equal(f.sent.find(m => m.type === 'bytes').data.length, fs.statSync(file).size);
});

test('over the size limit: no decode, a clear reason, tags still listed', async () => {
  const file = path.join(tmp, 'big.tif');
  fs.writeFileSync(file, encodeTiff([{ width: 1100, height: 1000, data: new Uint8Array(1100 * 1000) }]));
  state.config.maxFileMB = 1;
  try {
    const f = await open(file);
    await f.send({ type: 'ready' });
    const init = f.sent.find(m => m.type === 'init');
    assert.equal(init.plan.decode, false);
    assert.match(init.plan.reason, /This file is 1\.0 MB\. TIFF Viewer decodes files up to 1\.0 MB/);
    assert.equal(init.pages[0].width, 1100);
  } finally { state.config.maxFileMB = 1024; }
});

test('a non-TIFF file gives an error message, not a crash', async () => {
  const file = path.join(tmp, 'fake.tif');
  fs.writeFileSync(file, 'hello, I am text');
  const f = await open(file);
  await f.send({ type: 'ready' });
  assert.match(f.sent.find(m => m.type === 'error').message, /not a TIFF/);
});

test('export writes the PNG to the chosen path and refuses the TIFF itself', async () => {
  const file = path.join(tmp, 'one.tif');
  fs.writeFileSync(file, encodeTiff([{ width: 2, height: 2, data: new Uint8Array(4) }]));
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const f = await open(file);
  state.saveTarget = uriOf(path.join(tmp, 'out.png'));
  await f.send({ type: 'export', page: 0, data: png });
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(tmp, 'out.png'))), png);
  assert.equal(f.sent.at(-1).type, 'exported');
  const before = fs.readFileSync(file);
  state.saveTarget = uriOf(file);
  await f.send({ type: 'export', page: 0, data: png });
  assert.equal(f.sent.at(-1).type, 'error');
  assert.deepEqual(fs.readFileSync(file), before, 'TIFF untouched');
  state.saveTarget = null;
  await f.send({ type: 'export', page: 0, data: png });
  assert.equal(f.sent.at(-1).cancelled, true);
  await f.send({ type: 'export', page: 0, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  assert.equal(f.sent.at(-1).cancelled, true, 'a non-PNG export message is dropped');
});

test('copy goes to the clipboard; unknown messages are dropped; rendered counts once per tab', async () => {
  const file = path.join(tmp, 'c.tif');
  fs.writeFileSync(file, encodeTiff([{ width: 2, height: 2, data: new Uint8Array(4) }]));
  const f = await open(file);
  await f.send({ type: 'copy', text: 'ImageWidth\t2' });
  assert.equal(state.clipboard, 'ImageWidth\t2');
  const n = f.sent.length;
  await f.send({ type: 'writeFile', path: '/tmp/x' }); await f.send(null);
  assert.equal(f.sent.length, n);
  await f.send({ type: 'rendered', page: 0 }); await f.send({ type: 'rendered', page: 1 });
  f.close();
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, n, 'nothing is posted after the panel closed');
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('tiffViewer.supportDeveloper') && ids.includes('tiffViewer.moreViewers'));
  const cfg = [].concat(pkg.contributes.configuration);
  const prop = cfg.map(c => c.properties['tiffViewer.showSupportLinks']).find(Boolean);
  assert.equal(prop.default, true);
  assert.ok(support.otherProducts('zovo.tiff-viewer').every(p => p.id !== 'zovo.tiff-viewer'));
});

test('support: the footer shows by default and tiffViewer.showSupportLinks=false hides it', async () => {
  const file = path.join(tmp, 'sup.tif');
  fs.writeFileSync(file, encodeTiff([{ width: 2, height: 2, data: new Uint8Array(4) }]));
  try {
    for (const [val, shown] of [[undefined, true], [false, false]]) {
      if (val === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = val;
      const f = await open(file);
      const html = f.panel.webview.html;
      assert.equal(/id="zovo-support"/.test(html), shown, String(val));
      assert.equal(html.includes('command:tiffViewer.supportDeveloper'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['tiffViewer.supportDeveloper', 'tiffViewer.moreViewers', 'workbench.action.openSettings']);
    }
  } finally { delete state.config.showSupportLinks; }
});
