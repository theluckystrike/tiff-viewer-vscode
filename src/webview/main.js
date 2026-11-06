'use strict';
// TIFF Viewer webview. All file text goes into the page with textContent, never as HTML.
/* global acquireVsCodeApi, __WORKER_SRC__ */
const { fmtNum } = require('../core/tiff');
const { fmtValue, geoText, formatLabel, clampZoom, MAX_THUMB_PAGES, THUMB_MAX_PIXELS } = require('./ui-util');

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const S = {
  init: null, page: 0, view: null, stretch: 'auto', frame: null, req: 0, pending: null, busy: false,
  z: 1, tx: 0, ty: 0, fitMode: true, thumbs: new Map(), thumbQueue: [], thumbBusy: false, pixReq: 0, pixBusy: false, pixNext: null,
  sideOpen: true, loaded: false, lastPixel: null,
};

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

// ---------- worker ----------
const worker = new Worker(URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' })));
worker.onmessage = e => onWorker(e.data);
worker.onerror = e => showNotice('The decoder stopped: ' + (e.message || 'unknown error') + '. Reopen the file to try again.', true);

// ---------- layout ----------
let ui = {};
// The Sponsor and More free viewers line from the host HTML (absent when tiffViewer.showSupportLinks is off).
const supportLine = document.getElementById('zovo-support');
function buildLayout() {
  app.textContent = '';
  const pageSel = el('span', { class: 'pager' },
    el('button', { class: 'icon', title: 'Previous page (PageUp)', 'aria-label': 'Previous page', onclick: () => goPage(S.page - 1) }, '‹'),
    ui.pageLabel = el('span', { class: 'pagelabel' }),
    el('button', { class: 'icon', title: 'Next page (PageDown)', 'aria-label': 'Next page', onclick: () => goPage(S.page + 1) }, '›'));
  ui.viewSel = el('select', { title: 'Channel', 'aria-label': 'Channel', onchange: () => { S.view = ui.viewSel.value; requestFrame(); } });
  ui.stretchSel = el('select', { title: 'Contrast stretch', 'aria-label': 'Contrast stretch', onchange: () => { S.stretch = ui.stretchSel.value; requestFrame(); } });
  for (const [v, t] of [['auto', 'Auto contrast'], ['p05', 'Percentile 0.5 to 99.5'], ['p2', 'Percentile 2 to 98'], ['minmax', 'Min to max'], ['type', 'Full type range']]) ui.stretchSel.append(el('option', { value: v, text: t }));
  ui.zoomLabel = el('span', { class: 'zoom', title: 'Zoom' });
  ui.bar = el('div', { class: 'bar' },
    el('span', { class: 'title', title: S.init.name, text: S.init.name }),
    el('span', { class: 'muted size', text: S.init.sizeText }),
    pageSel,
    el('label', { class: 'ctl' }, el('span', { class: 'muted', text: 'View' }), ui.viewSel),
    el('label', { class: 'ctl' }, ui.stretchSel),
    el('span', { class: 'group' },
      el('button', { title: 'Fit to window (0)', onclick: () => fit() }, 'Fit'),
      el('button', { title: 'Actual pixels (1)', onclick: () => actual() }, '1:1'),
      el('button', { class: 'icon', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.5) }, '−'),
      ui.zoomLabel,
      el('button', { class: 'icon', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.5) }, '+')),
    el('span', { class: 'group' },
      ui.tagsBtn = el('button', { title: 'Show or hide the tags panel (T)', onclick: () => toggleSide() }, 'Tags'),
      ui.exportBtn = el('button', { title: 'Save the current page as PNG, as shown', onclick: () => exportPng() }, 'Export PNG')));
  ui.strip = el('div', { class: 'strip', role: 'listbox', 'aria-label': 'Pages' });
  ui.canvas = el('canvas', { class: 'img' });
  ui.notice = el('div', { class: 'notice', hidden: true });
  ui.stage = el('div', { class: 'stage', tabindex: '0' }, ui.canvas, ui.notice);
  ui.side = el('aside', { class: 'side' });
  ui.status = el('div', { class: 'status' }, ui.readout = el('span', { class: 'readout', text: 'Move the pointer over the image to read pixel values.' }), ui.timing = el('span', { class: 'muted timing' }));
  app.append(ui.bar, el('div', { class: 'main' }, ui.strip, ui.stage, ui.side), ui.status);
  if (supportLine) { supportLine.classList.remove('zovo-support-fixed'); ui.status.append(supportLine); }
  wireStage();
  buildStrip();
}

function buildStrip() {
  const n = S.init.pages.length;
  ui.strip.hidden = n < 2;
  ui.strip.textContent = '';
  S.init.pages.forEach((p, i) => {
    const c = el('canvas', { class: 'thumb', width: 1, height: 1 });
    const label = `${i + 1}${p.reduced ? ' (reduced)' : ''}`;
    const item = el('button', { class: 'page', role: 'option', title: (p.name ? p.name + ' · ' : '') + `${p.width} × ${p.height}, ${formatLabel(p)}`, onclick: () => goPage(i) },
      c, el('span', { class: 'plabel', text: p.name ? `${label} · ${p.name}` : label }));
    item.dataset.page = String(i);
    ui.strip.append(item);
  });
  if (S.init.pages.length > S.init.listedMax - 1) ui.strip.append(el('p', { class: 'muted small', text: `Only the first ${S.init.listedMax} pages are listed.` }));
}

function markStrip() {
  for (const b of ui.strip.querySelectorAll('.page')) b.setAttribute('aria-selected', String(Number(b.dataset.page) === S.page));
  const cur = ui.strip.querySelector(`.page[data-page="${S.page}"]`);
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  ui.pageLabel.textContent = `Page ${S.page + 1} of ${S.init.pages.length}`;
}

// ---------- side panel ----------
function section(title, ...kids) { return el('section', null, el('h3', { text: title }), ...kids); }
function kv(rows) {
  const t = el('table', { class: 'kv' });
  for (const [k, v] of rows) t.append(el('tr', null, el('th', { text: k }), el('td', { text: v })));
  return t;
}

function renderSide() {
  const p = S.init.pages[S.page];
  ui.side.textContent = '';
  ui.side.hidden = !S.sideOpen;
  ui.tagsBtn.setAttribute('aria-pressed', String(S.sideOpen));
  if (!S.sideOpen) return;
  ui.side.append(section('Image', kv([
    ['Size', `${p.width} × ${p.height} px`], ['Samples', `${p.spp} per pixel, ${formatLabel(p)}`], ['Colour', p.photometric],
    ['Compression', p.compression], ['Layout', `${p.tiled ? 'tiles' : 'strips'}${p.planar === 2 ? ', planar' : ''}`],
    ...(p.name ? [['Page name', p.name]] : []), ['File', `${S.init.sizeText}${S.init.big ? ', BigTIFF' : ''}, ${S.init.le ? 'little' : 'big'}-endian`],
  ])));
  const f = S.frame && S.frame.page === S.page ? S.frame : null;
  if (f && f.stats) {
    const st = f.stats;
    const rows = [['Min', fmtNum(round4(st.min))], ['Max', fmtNum(round4(st.max))], ['Mean', st.mean === null ? '-' : fmtNum(Math.round(st.mean * 1000) / 1000)],
      ['Shown range', `${fmtNum(round4(f.range.lo))} to ${fmtNum(round4(f.range.hi))}`]];
    if (st.nodata) rows.push(['Nodata pixels', String(st.nodata)]);
    if (st.nan) rows.push(['NaN or infinite', String(st.nan)]);
    if (f.step > 1) rows.push(['Display', `1 of every ${f.step} pixels per side (large image)`]);
    const hist = el('canvas', { class: 'hist', width: 256, height: 48, title: 'Histogram of the shown channels' });
    drawHist(hist, st, f.range);
    ui.side.append(section('Values', kv(rows), hist));
  }
  if (p.geo) {
    const g = p.geo, rows = [];
    if (g.epsg) rows.push(['CRS', `EPSG:${g.epsg}`]);
    if (g.pixelSize) rows.push(['Pixel size', `${fmtNum(g.pixelSize[0])} × ${fmtNum(g.pixelSize[1])}${g.units ? ' ' + g.units : ''}`]);
    if (g.bounds) rows.push(['West, east', `${fmtNum(round4(g.bounds.minX))}, ${fmtNum(round4(g.bounds.maxX))}`], ['South, north', `${fmtNum(round4(g.bounds.minY))}, ${fmtNum(round4(g.bounds.maxY))}`]);
    if (g.nodataText) rows.push(['Nodata', g.nodataText]);
    for (const [k, v] of g.keys) rows.push([k, v]);
    ui.side.append(section('GeoTIFF', kv(rows)));
  }
  const copy = el('button', { class: 'link', title: 'Copy every tag of this page as tab-separated text', onclick: () => vscode.postMessage({ type: 'copy', text: p.tags.map(([k, v]) => `${k}\t${v.replace(/\s+/g, ' ')}`).join('\n') }) }, 'Copy');
  const tags = el('section', null, el('h3', null, `Tags (${p.tags.length}) `, copy), kv(p.tags.map(([k, v]) => [k, v])));
  ui.side.append(tags);
  if (S.init.problems.length) ui.side.append(section('File notes', ...S.init.problems.map(t => el('p', { class: 'small', text: t }))));
}

const round4 = x => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

function drawHist(c, st, range) {
  const g = c.getContext('2d'), h = st.hist || [];
  if (!h.length) return;
  const css = getComputedStyle(document.body);
  const max = Math.max(...h.map(v => Math.log1p(v))) || 1;
  g.fillStyle = css.getPropertyValue('--vscode-charts-blue') || '#3794ff';
  const bw = c.width / h.length;
  h.forEach((v, i) => { const hh = (Math.log1p(v) / max) * (c.height - 4); g.fillRect(i * bw, c.height - hh, Math.max(1, bw - 1), hh); });
  if (st.max > st.min) {
    g.fillStyle = css.getPropertyValue('--vscode-charts-orange') || '#d18616';
    for (const x of [range.lo, range.hi]) { const px = ((x - st.min) / (st.max - st.min)) * c.width; if (px >= 0 && px <= c.width) g.fillRect(Math.min(c.width - 2, Math.max(0, px - 1)), 0, 2, c.height); }
  }
}

function toggleSide() { S.sideOpen = !S.sideOpen; renderSide(); vscode.setState({ ...(vscode.getState() || {}), sideOpen: S.sideOpen }); if (S.fitMode) fit(); }

// ---------- controls ----------
function fillViews(views, current) {
  ui.viewSel.textContent = '';
  for (const v of views) ui.viewSel.append(el('option', { value: v.id, text: v.label }));
  ui.viewSel.value = current;
  ui.viewSel.disabled = views.length < 2;
}

function goPage(i) {
  if (!S.init || i < 0 || i >= S.init.pages.length || i === S.page && S.frame && S.frame.page === i) return;
  S.page = i; S.view = null; S.fitMode = true; S.lastPixel = null;
  markStrip(); renderSide();
  if (S.loaded) requestFrame();
}

function nodataOf(i) { const g = S.init.pages[i].geo; return g && g.nodata !== null && g.nodata !== undefined ? g.nodata : null; }

function requestFrame() {
  const p = S.init.pages[S.page];
  if (p.problem) { showNotice(`Page ${S.page + 1} cannot be shown. ${p.problem} Its tags are listed on the right.`, false); clearCanvas(); return; }
  const msg = { type: 'show', page: S.page, view: S.view, stretch: S.stretch, nodata: nodataOf(S.page), req: ++S.req };
  if (S.busy) { S.pending = msg; return; }
  S.busy = true;
  if (!S.frame || S.frame.page !== S.page) showNotice(`Decoding page ${S.page + 1}...`, false, true);
  worker.postMessage(msg);
}

function clearCanvas() { ui.canvas.width = 1; ui.canvas.height = 1; S.frame = null; }

function onWorker(m) {
  if (m.type === 'loaded') { S.loaded = true; requestFrame(); return; }
  if (m.type === 'frame') {
    S.busy = false;
    if (S.pending) { const p = S.pending; S.pending = null; S.busy = true; worker.postMessage(p); }
    if (m.page !== S.page) return;
    const first = !S.frame;
    S.frame = m; S.view = m.view;
    ui.canvas.width = m.width; ui.canvas.height = m.height;
    ui.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
    fillViews(m.views, m.view);
    ui.stretchSel.value = S.stretch;
    hideNotice();
    if (m.problems && m.problems.length) showNotice(m.problems.join(' '), false, true);
    if (S.fitMode) fit(); else applyTransform();
    renderSide();
    ui.timing.textContent = `decoded in ${m.ms} ms`;
    vscode.postMessage({ type: 'rendered', page: m.page, ms: m.ms });
    if (first) queueThumbs();
    if (S.lastPixel) askPixel(S.lastPixel.x, S.lastPixel.y);
    return;
  }
  if (m.type === 'pixel') { S.pixBusy = false; if (m.page === S.page) showPixel(m.result); if (S.pixNext) { const n = S.pixNext; S.pixNext = null; askPixel(n.x, n.y); } return; }
  if (m.type === 'thumb') { drawThumb(m); S.thumbBusy = false; nextThumb(); return; }
  if (m.type === 'error') {
    if (m.for === 'thumb') { S.thumbBusy = false; markThumbError(m.page); nextThumb(); return; }
    if (m.for === 'pixel') { S.pixBusy = false; return; }
    S.busy = false;
    if (S.pending) { const p = S.pending; S.pending = null; S.busy = true; worker.postMessage(p); return; }
    if (m.for === 'load') { showNotice('This file could not be read as a TIFF image. ' + m.message, true); return; }
    showNotice(`Page ${(m.page ?? S.page) + 1} could not be decoded. ${m.message}`, false);
    clearCanvas(); renderSide();
  }
}

// ---------- thumbnails ----------
function queueThumbs() {
  const pages = S.init.pages;
  if (pages.length < 2) return;
  S.thumbQueue = pages.map((p, i) => i).filter(i => i < MAX_THUMB_PAGES && !pages[i].problem && pages[i].width * pages[i].height <= THUMB_MAX_PIXELS);
  nextThumb();
}
function nextThumb() {
  if (S.thumbBusy || !S.thumbQueue.length) return;
  if (S.busy) { setTimeout(nextThumb, 100); return; }
  const i = S.thumbQueue.shift();
  S.thumbBusy = true;
  worker.postMessage({ type: 'thumb', page: i, size: 88, nodata: nodataOf(i) });
}
function drawThumb(m) {
  const c = ui.strip.querySelector(`.page[data-page="${m.page}"] canvas`);
  if (!c) return;
  c.width = m.width; c.height = m.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
  c.classList.add('ready');
}
function markThumbError(i) { const b = ui.strip.querySelector(`.page[data-page="${i}"]`); if (b) b.classList.add('bad'); }

// ---------- zoom and pan ----------
function stageSize() { const r = ui.stage.getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; }
function applyTransform() {
  ui.canvas.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.z})`;
  const f = S.frame, real = f ? S.z / f.step : S.z;
  ui.canvas.classList.toggle('pixelated', S.z >= 2);
  ui.zoomLabel.textContent = `${real >= 10 ? Math.round(real * 100) : Math.round(real * 1000) / 10}%`;
}
function fit() {
  const f = S.frame; if (!f) return;
  const { w, h } = stageSize();
  S.z = clampZoom(Math.min((w - 16) / f.width, (h - 16) / f.height, 8 * f.step), f.step);
  S.tx = (w - f.width * S.z) / 2; S.ty = (h - f.height * S.z) / 2; S.fitMode = true;
  applyTransform();
}
function actual() {
  const f = S.frame; if (!f) return;
  const { w, h } = stageSize();
  S.z = f.step; S.fitMode = false;
  S.tx = (w - f.width * S.z) / 2; S.ty = (h - f.height * S.z) / 2;
  applyTransform();
}
function zoomAt(factor, cx, cy) {
  const f = S.frame; if (!f) return;
  const nz = clampZoom(S.z * factor, f.step);
  S.tx = cx - (cx - S.tx) * (nz / S.z); S.ty = cy - (cy - S.ty) * (nz / S.z); S.z = nz; S.fitMode = false;
  applyTransform();
}
function zoomBy(factor) { const { w, h } = stageSize(); zoomAt(factor, w / 2, h / 2); }

function wireStage() {
  let drag = null;
  ui.stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = ui.stage.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  ui.stage.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty }; ui.stage.setPointerCapture(e.pointerId); ui.stage.classList.add('dragging'); ui.stage.focus(); });
  ui.stage.addEventListener('pointerup', e => { drag = null; ui.stage.releasePointerCapture(e.pointerId); ui.stage.classList.remove('dragging'); });
  ui.stage.addEventListener('pointermove', e => {
    const r = ui.stage.getBoundingClientRect();
    if (drag) { S.tx = drag.tx + e.clientX - drag.x; S.ty = drag.ty + e.clientY - drag.y; S.fitMode = false; applyTransform(); }
    const f = S.frame; if (!f) return;
    const x = Math.floor(((e.clientX - r.left - S.tx) / S.z) * f.step), y = Math.floor(((e.clientY - r.top - S.ty) / S.z) * f.step);
    if (x < 0 || y < 0 || x >= f.fullWidth || y >= f.fullHeight) { ui.readout.textContent = '-'; S.lastPixel = null; return; }
    S.lastPixel = { x, y };
    askPixel(x, y);
  });
  ui.stage.addEventListener('dblclick', () => (S.fitMode ? actual() : fit()));
  new ResizeObserver(() => { if (S.fitMode) fit(); }).observe(ui.stage);
}

function askPixel(x, y) {
  if (S.pixBusy) { S.pixNext = { x, y }; return; }
  S.pixBusy = true;
  worker.postMessage({ type: 'pixel', page: S.page, x, y, req: ++S.pixReq });
}

function showPixel(r) {
  if (!r) { ui.readout.textContent = '-'; return; }
  const p = S.init.pages[S.page], f = S.frame;
  const names = f ? f.views.filter(v => /^\d+$/.test(v.id)).map(v => v.label.replace(/ \(channel \d+\)$/, '')) : [];
  let t = `x ${r.x}, y ${r.y}  ·  ${fmtValue(r, names, p.geo ? p.geo.nodata : null)}`;
  const geo = geoText(p.geo, r.x, r.y);
  if (geo) t += `  ·  ${geo}`;
  ui.readout.textContent = t;
}

// ---------- notices and export ----------
function showNotice(text, error, soft) {
  ui.notice.hidden = false; ui.notice.textContent = text;
  ui.notice.classList.toggle('error', !!error); ui.notice.classList.toggle('soft', !!soft);
}
function hideNotice() { ui.notice.hidden = true; }

function exportPng() {
  if (!S.frame) return;
  ui.exportBtn.disabled = true;
  ui.canvas.toBlob(async b => {
    try { const buf = new Uint8Array(await b.arrayBuffer()); vscode.postMessage({ type: 'export', page: S.page, data: buf }); }
    catch (e) { ui.exportBtn.disabled = false; showNotice('Export failed: ' + e.message, false, true); }
  }, 'image/png');
}

// ---------- keyboard ----------
window.addEventListener('keydown', e => {
  if (!S.init || e.target instanceof HTMLSelectElement) return;
  const k = e.key;
  if (k === 'PageDown' || (k === 'ArrowRight' && e.altKey) || k === 'j') { goPage(S.page + 1); e.preventDefault(); }
  else if (k === 'PageUp' || (k === 'ArrowLeft' && e.altKey) || k === 'k') { goPage(S.page - 1); e.preventDefault(); }
  else if (k === '+' || k === '=') zoomBy(1.5);
  else if (k === '-') zoomBy(1 / 1.5);
  else if (k === '0') fit();
  else if (k === '1') actual();
  else if (k === 't' || k === 'T') toggleSide();
});

// ---------- host messages ----------
async function loadBytes() {
  showNotice(`Reading ${S.init.sizeText}...`, false, true);
  let buf;
  try {
    const r = await fetch(S.init.src);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = await r.arrayBuffer();
  } catch { vscode.postMessage({ type: 'needBytes' }); return; }
  sendToWorker(buf);
}
function sendToWorker(buf) {
  showNotice('Decoding page 1...', false, true);
  worker.postMessage({ type: 'load', buf, req: 0 }, [buf]);
}

window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'init') {
    S.init = m;
    const st = vscode.getState() || {};
    if (st.sideOpen === false) S.sideOpen = false;
    buildLayout(); markStrip(); renderSide();
    if (!m.pages.length) { showNotice('This TIFF file has no pages.', true); return; }
    if (!m.plan.decode) { showNotice(m.plan.reason, false); for (const c of [ui.exportBtn, ui.viewSel, ui.stretchSel]) c.disabled = true; return; }
    loadBytes();
    return;
  }
  if (m.type === 'bytes') {
    const d = m.data;
    const buf = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d.buffer : d.slice().buffer;
    sendToWorker(buf);
    return;
  }
  if (m.type === 'exported') { ui.exportBtn.disabled = false; if (!m.cancelled) ui.timing.textContent = `saved ${m.path}`; return; }
  if (m.type === 'copied') { ui.timing.textContent = 'tags copied'; return; }
  if (m.type === 'error') {
    if (ui.exportBtn) ui.exportBtn.disabled = false;
    if (!S.init) { app.textContent = ''; app.append(el('div', { class: 'notice error', text: m.message })); return; }
    showNotice(m.message, !m.soft, !!m.soft);
  }
});

vscode.postMessage({ type: 'ready' });
