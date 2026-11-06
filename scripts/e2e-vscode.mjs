// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
const shots = [];
const shot = async name => { const f = path.join(shotDir, `tiff-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 500), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 20000);
const open = async file => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const rendered = () => vs.waitFor(() => E(`!!(window.document.querySelector('canvas.img') && document.querySelector('canvas.img').width > 1 && document.querySelector('.notice').hidden)`), 20000, 150);
const hover = async (fx, fy) => { // fraction of the image
  const off = await vs.wvOffset();
  const b = JSON.parse(await E(`JSON.stringify(document.querySelector('canvas.img').getBoundingClientRect())`));
  await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: off.x + b.x + b.width * fx, y: off.y + b.y + b.height * fy }, vs.wb);
  await sleep(400);
  return E(`document.querySelector('.readout').textContent`);
};
const sideText = () => E(`document.querySelector('.side').innerText`);
const select = async (sel, value) => { await E(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(300); await rendered(); };
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('16-bit microscopy opens as default editor, auto contrast p0.5-99.5, pixel value', async () => {
    const ms = await open('microscopy-16bit.tif'); if (!(await rendered())) throw new Error('not rendered');
    const v = await hover(0.42, 0.47);
    const side = await sideText();
    if (!/16-bit unsigned/.test(side) || !/Shown range/.test(side)) throw new Error('side panel: ' + side.slice(0, 300));
    if (!/x \d+, y \d+ {2}· {2}\d+/.test(v)) throw new Error('readout: ' + v);
    await shot('microscopy-16bit');
    return { openMs: ms, readout: v, stretch: await E(`document.querySelector('select[aria-label="Contrast stretch"]').value`), range: side.match(/Shown range\s*([^\n]+)/)[1] };
  });
  await step('stretch min-max and full type range change the frame', async () => {
    await select('select[aria-label="Contrast stretch"]', 'minmax');
    const a = (await sideText()).match(/Shown range\s*([^\n]+)/)[1];
    await select('select[aria-label="Contrast stretch"]', 'type');
    const b = (await sideText()).match(/Shown range\s*([^\n]+)/)[1];
    await select('select[aria-label="Contrast stretch"]', 'auto');
    if (a === b || !/0 to 65535/.test(b)) throw new Error(`${a} / ${b}`);
    return { minmax: a, type: b };
  });
  await step('zoom with the wheel, 1:1 and Fit; drag to pan', async () => {
    const off = await vs.wvOffset();
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: off.x + off.w / 2, y: off.y + off.h / 2, deltaX: 0, deltaY: -600 }, vs.wb); await sleep(300);
    const z1 = await E(`document.querySelector('.zoom').textContent`);
    await vs.wvClick(wv, btn('1:1')); const z2 = await E(`document.querySelector('.zoom').textContent`);
    const t0 = await E(`document.querySelector('canvas.img').style.transform`);
    const cx = off.x + off.w / 2, cy = off.y + off.h / 2;
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, vs.wb);
    for (let i = 1; i <= 5; i++) await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 20, y: cy + i * 10, button: 'left', buttons: 1 }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 100, y: cy + 50, button: 'left', clickCount: 1 }, vs.wb);
    const t1 = await E(`document.querySelector('canvas.img').style.transform`);
    await vs.wvClick(wv, btn('Fit')); const z3 = await E(`document.querySelector('.zoom').textContent`);
    if (z2 !== '100%' || t0 === t1) throw new Error(JSON.stringify({ z1, z2, t0, t1 }));
    return { wheel: z1, actual: z2, fit: z3, panned: t0 !== t1 };
  });
  await step('float32 GeoTIFF: CRS, bounds, nodata transparent, value and map coordinate', async () => {
    await open('dem-float32-geotiff.tif'); if (!(await rendered())) throw new Error('not rendered');
    const v = await hover(0.7, 0.3);
    const lake = await hover(0.25, 0.7);
    const side = await sideText();
    if (!/EPSG:32633/.test(side) || !/Nodata pixels/.test(side) || !/E \d+\.\d+, N \d+\.\d+ m/.test(v) || !/nodata/.test(lake)) throw new Error(JSON.stringify({ v, lake, side: side.slice(0, 400) }));
    await hover(0.7, 0.3);
    await shot('dem-float32-geotiff');
    return { readout: v, lake, geo: side.match(/GEOTIFF[\s\S]{0,200}/i)?.[0] };
  });
  await step('multi-page stack: page strip with thumbnails, PageDown, click page 7 (RGB)', async () => {
    await open('multipage-stack.tif'); if (!(await rendered())) throw new Error('not rendered');
    const thumbs = await vs.waitFor(() => E(`document.querySelectorAll('.page canvas.ready').length === 7 && 7`), 15000);
    await vs.wvClick(wv, `document.querySelector('.stage')`); await vs.key('PageDown', 'PageDown', 0, 34); await sleep(500); await rendered();
    const p2 = await E(`document.querySelector('.pagelabel').textContent`);
    await vs.wvClick(wv, `document.querySelector('.page[data-page="2"]')`); await sleep(400); await rendered();
    await hover(0.5, 0.45);
    await shot('multipage-stack');
    await vs.wvClick(wv, `document.querySelector('.page[data-page="6"]')`); await sleep(400); await rendered();
    const v = await hover(0.3, 0.3);
    const views = await E(`[...document.querySelectorAll('select[aria-label="Channel"] option')].map(o => o.textContent).join('|')`);
    if (thumbs !== 7 || p2 !== 'Page 2 of 7' || !/R \d+ {2}G \d+ {2}B \d+/.test(v)) throw new Error(JSON.stringify({ thumbs, p2, v }));
    return { thumbs, afterPageDown: p2, rgbReadout: v, views };
  });
  await step('planar 3-channel 16-bit BigTIFF: channel picker shows one channel', async () => {
    await open('channels-16bit-bigtiff.tif'); if (!(await rendered())) throw new Error('not rendered');
    const views = await E(`[...document.querySelectorAll('select[aria-label="Channel"] option')].map(o => o.value).join(',')`);
    const v0 = await hover(0.31, 0.35);
    await select('select[aria-label="Channel"]', '1');
    const v1 = await hover(0.31, 0.35);
    await shot('channels-picker');
    if (views !== 'rgb,0,1,2' || !/C1 \d+ {2}C2 \d+ {2}C3 \d+/.test(v1)) throw new Error(JSON.stringify({ views, v0, v1 }));
    return { views, readout: v1, side: (await sideText()).match(/File\s*([^\n]+)/)[1] };
  });
  await step('tiled RGB opens; tags panel lists TileWidth; Tags button hides the panel', async () => {
    await open('rgb-tiled.tiff'); if (!(await rendered())) throw new Error('not rendered');
    const side = await sideText();
    await vs.wvClick(wv, btn('Tags')); const hidden = await E(`document.querySelector('.side').hidden`);
    await shot('rgb-tiled-no-panel');
    await vs.wvClick(wv, btn('Tags'));
    if (!/TileWidth\s*256/.test(side) || !hidden) throw new Error(side.slice(0, 300));
    return { tile: side.match(/TileWidth\s*([^\n]+)/)[1], hidden };
  });
  await step('Copy tags puts TSV on the clipboard', async () => {
    await vs.wvClick(wv, `document.querySelector('.side button.link')`); await sleep(600);
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (!/^NewSubfileType|^ImageWidth\t1200/m.test(clip)) throw new Error(clip.slice(0, 200));
    return clip.split('\n').length + ' lines';
  });
  await step('Export PNG through the save dialog writes a PNG', async () => {
    const target = path.join(work, 'export-check.png'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('Export PNG')); await sleep(1500);
    // the simple save dialog opens while keyboard focus is still in the webview frame, so click into its input first
    const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
    await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(target);
    await sleep(300); await vs.key('Enter', 'Enter'); await sleep(1500);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 8000);
    if (!ok) { await shot('export-dialog'); await vs.key('Escape', 'Escape'); throw new Error('no file'); }
    const head = fs.readFileSync(target).subarray(0, 24);
    const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
    return { bytes: fs.statSync(target).size, width: w, height: h, status: await E(`document.querySelector('.timing').textContent`) };
  });
  await step('over 1 GB (sparse file): clear message, tags still shown, no decode', async () => {
    await open('huge-sparse.tif');
    const t = await vs.waitFor(() => E(`!document.querySelector('.notice').hidden && document.querySelector('.notice').textContent`), 10000);
    await shot('over-1gb-message');
    if (!/1\.1 GB.*up to 1\.0 GB/.test(t)) throw new Error(t);
    return { notice: t, tags: (await sideText()).includes('ImageWidth') };
  });
  await step('not a TIFF (.tif with text) shows an error', async () => {
    await open('not-a-tiff.tif');
    const t = await vs.waitFor(() => E(`(document.querySelector('.notice') || {}).textContent`), 10000);
    if (!/not a TIFF/.test(t)) throw new Error(t);
    return t;
  });
  await step('light theme', async () => {
    await vs.click(700, 17); // title bar: move keyboard focus out of the webview frame
    await vs.command('Preferences: Color Theme'); await sleep(500); await vs.type('Light Modern'); await sleep(500); await vs.key('Enter', 'Enter'); await sleep(1500);
    await open('microscopy-16bit.tif'); await rendered(); await hover(0.42, 0.47);
    await shot('microscopy-light');
    return true;
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /tiff/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
