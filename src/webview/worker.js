'use strict';
// Webview worker: owns the file bytes and the decoded page, so decoding never blocks the UI thread.
const { parseTiff, BufferReader } = require('../core/tiff');
const D = require('./decode');

console.log = () => {}; // UTIF logs on some files; keep the webview console clean

let file = null, parsed = null;
let cur = null; // { page, pg, statsCache: Map }

function getPage(i) {
  if (cur && cur.page === i) return cur;
  cur = null; // free the old page first
  const pg = D.decodePage(file, parsed.le, parsed.pages[i].tags);
  cur = { page: i, pg, statsCache: new Map(), channels: D.channelsOf(pg) };
  return cur;
}

function chansFor(pg, view) {
  if (view === 'rgb') return pg.photometric === 5 ? [0, 1, 2, 3] : [0, 1, 2];
  if (view === 'palette') return [0];
  return [Number(view)];
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      file = new Uint8Array(m.buf);
      parsed = await parseTiff(new BufferReader(file));
      self.postMessage({ type: 'loaded', pages: parsed.pages.length, req: m.req });
      return;
    }
    if (!parsed) throw new Error('The file is not loaded yet.');
    if (m.type === 'show') {
      const t0 = Date.now();
      const c = getPage(m.page);
      const pg = c.pg;
      let view = m.view;
      if (!c.channels.views.some(v => v.id === view)) view = c.channels.defaultView;
      const key = view + '|' + m.nodata;
      let st = c.statsCache.get(key);
      if (!st) { st = D.stats(pg, chansFor(pg, view), m.nodata); c.statsCache.set(key, st); }
      const range = m.range && m.stretch === 'custom' ? { lo: m.range.lo, hi: m.range.hi, mode: 'custom' } : D.stretchRange(pg, st, m.stretch);
      const img = D.render(pg, view, range, m.nodata);
      self.postMessage({
        type: 'frame', req: m.req, page: m.page, view, views: c.channels.views, width: img.width, height: img.height, step: img.step,
        fullWidth: pg.width, fullHeight: pg.height, rgba: img.rgba.buffer, stats: st, range, problems: pg.problems, ms: Date.now() - t0,
      }, [img.rgba.buffer]);
      return;
    }
    if (m.type === 'pixel') {
      const r = cur && cur.page === m.page ? D.pixel(cur.pg, m.x, m.y) : null;
      self.postMessage({ type: 'pixel', req: m.req, page: m.page, result: r });
      return;
    }
    if (m.type === 'thumb') {
      const tags = parsed.pages[m.page].tags;
      const pg = cur && cur.page === m.page ? cur.pg : D.decodePage(file, parsed.le, tags);
      const ch = D.channelsOf(pg);
      const view = ch.defaultView;
      const st = D.stats(pg, chansFor(pg, view), m.nodata);
      const step = Math.max(1, Math.ceil(Math.max(pg.width, pg.height) / m.size));
      const img = D.render(pg, view, D.stretchRange(pg, st, 'auto'), m.nodata, step);
      self.postMessage({ type: 'thumb', page: m.page, width: img.width, height: img.height, rgba: img.rgba.buffer }, [img.rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', req: m.req, page: m.page, for: m.type, message: String(err && err.message ? err.message : err) });
  }
};
