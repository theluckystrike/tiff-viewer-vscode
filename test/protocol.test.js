'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol');
const T = require('../src/core/tiff');
const { buildHtml } = require('../src/html');
const U = require('../src/webview/ui-util');
const { encodeTiff } = require('./tiffwriter');

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

test('protocol: accepts only known webview messages', () => {
  assert.deepEqual(P.validateWebviewMessage({ type: 'ready', extra: 1 }), { ok: true, msg: { type: 'ready' } });
  assert.equal(P.validateWebviewMessage({ type: 'rendered', page: 2 }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'rendered', page: -1 }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'rendered', page: '2' }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: '' }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: 'x'.repeat(200001) }).ok, false);
  for (const bad of [null, 'ready', 42, {}, { type: 'writeFile', path: '/etc/passwd' }, { type: 'openExternal', url: 'https://x' }]) assert.equal(P.validateWebviewMessage(bad).ok, false);
});

test('protocol: export must be a PNG with a page number', () => {
  assert.equal(P.validateWebviewMessage({ type: 'export', page: 0, data: PNG }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'export', page: 0, data: PNG.buffer }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'export', page: 0, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) }).ok, false, 'not a PNG');
  assert.equal(P.validateWebviewMessage({ type: 'export', page: 0, data: 'iVBOR' }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'export', data: PNG }).ok, false);
});

test('protocol: size plan has a clear message over the limit', () => {
  assert.deepEqual(P.sizePlan(500 * P.MB, 1024), { decode: true });
  const p = P.sizePlan(1.5 * 1024 * P.MB, 1024);
  assert.equal(p.decode, false);
  assert.match(p.reason, /1\.5 GB/); assert.match(p.reason, /1\.0 GB/); assert.match(p.reason, /tiffViewer\.maxFileMB/);
  assert.equal(P.fmtSize(1536), '2 KB'); assert.equal(P.fmtSize(5 * P.MB), '5.0 MB');
});

test('protocol: page list carries plain values with capped strings', async () => {
  const long = '<script>alert(1)</script>'.repeat(200);
  const buf = encodeTiff([{ width: 3, height: 2, data: new Uint8Array(6), tags: [[270, 2, long], [285, 2, 'P<1>']] }]);
  const parsed = await T.parseTiff(new T.BufferReader(new Uint8Array(buf)));
  const [p] = P.publicPages(parsed);
  assert.equal(p.width, 3); assert.equal(p.name, 'P<1>'); assert.equal(p.geo, null);
  const desc = p.tags.find(t => t[0] === 'ImageDescription')[1];
  assert.ok(desc.length <= 2000);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(p)));
});

test('html: strict CSP with a nonce, blob worker and no remote sources; title escaped', () => {
  const h = buildHtml({ cspSource: 'https://x.vscode-cdn.net', scriptUri: 'https://x/w.js', styleUri: 'https://x/s.css', title: '"><img src=x onerror=alert(1)>.tif', nonce: 'abc' });
  const csp = h.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-abc'(;|$)/); assert.match(csp, /worker-src blob:/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:\/\/(?!x\.vscode-cdn\.net)/);
  assert.ok(!h.includes('<img src=x'));
  assert.match(h, /<script nonce="abc" src=/);
});

test('webview code: no innerHTML, eval or network calls besides the local file fetch', () => {
  for (const f of ['main.js', 'worker.js', 'decode.js', 'ui-util.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    assert.doesNotMatch(src, /XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//, f);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.equal((main.match(/fetch\(/g) || []).length, 1, 'one fetch: the file itself, from S.init.src');
});

test('extension code: the only file write is the PNG export', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  const writes = src.match(/writeFile|\.delete\(|\.rename\(|unlink|rmSync|appendFile/g) || [];
  assert.deepEqual(writes, ['writeFile']);
  assert.match(src, /target\.toString\(\) === uri\.toString\(\)/, 'refuses to overwrite the TIFF');
});

test('ui: pixel readout text for gray, RGB, palette, nodata and NaN', () => {
  assert.equal(U.fmtValue({ values: [534.72375488] }, ['Gray'], null), '534.723755');
  assert.equal(U.fmtValue({ values: [100, 157, 235] }, ['Red', 'Green', 'Blue'], null), 'R 100  G 157  B 235');
  assert.equal(U.fmtValue({ values: [1, 2, 3, 4] }, ['Cyan', 'Magenta', 'Yellow', 'Black'], null), 'C 1  M 2  Y 3  K 4');
  assert.equal(U.fmtValue({ values: [5], rgb: [255, 128, 0] }, ['Index'], null), 'index 5 = rgb(255, 128, 0)');
  assert.equal(U.fmtValue({ values: [-9999] }, ['Gray'], -9999), '-9999 (nodata)');
  assert.equal(U.fmtValue({ values: [NaN] }, ['Gray'], null), 'NaN');
  assert.equal(U.fmtValue({ values: [1, 2] }, ['Channel 1', 'Alpha'], null), 'C1 1  A 2');
  assert.equal(U.formatLabel({ bps: 32, format: 'float' }), '32-bit float');
});

test('ui: map coordinates for projected and geographic rasters', () => {
  assert.equal(U.geoText({ affine: [30, 0, 500000, 0, -30, 5250000], units: 'metre' }, 0, 0), 'E 500015.00, N 5249985.00 m');
  assert.equal(U.geoText({ affine: [0.001, 0, 10, 0, -0.001, 50], units: 'degree' }, 0, 0), 'lon 10.000500, lat 49.999500');
  assert.equal(U.geoText(null, 1, 1), '');
  assert.equal(U.clampZoom(1e9, 1), 64); assert.equal(U.clampZoom(NaN, 1), 1); assert.equal(U.clampZoom(0, 2), 0.02);
});
