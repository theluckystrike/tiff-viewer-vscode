'use strict';
// Messages between the extension host and the webview, the size plan, and the metadata sent to the webview.
const { pageInfo, tagRows, geoInfo } = require('./tiff');

const MB = 1048576;
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG = 1024 * MB;

function asBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (d && ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}

/** Accepts only known webview messages with valid fields. Anything else is dropped. */
function validateWebviewMessage(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return { ok: false };
  switch (raw.type) {
    case 'ready': return { ok: true, msg: { type: 'ready' } };
    case 'needBytes': return { ok: true, msg: { type: 'needBytes' } };
    case 'rendered':
      if (!Number.isInteger(raw.page) || raw.page < 0) return { ok: false };
      return { ok: true, msg: { type: 'rendered', page: raw.page, ms: Number(raw.ms) || 0 } };
    case 'copy':
      if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > 200000) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: raw.text } };
    case 'export': {
      const data = asBytes(raw.data);
      if (!data || data.length < 8 || data.length > MAX_PNG || PNG_SIG.some((b, i) => data[i] !== b)) return { ok: false };
      if (!Number.isInteger(raw.page) || raw.page < 0) return { ok: false };
      return { ok: true, msg: { type: 'export', page: raw.page, data } };
    }
    default: return { ok: false };
  }
}

/** Decides whether the file is decoded or only its tags are shown. */
function sizePlan(size, maxFileMB) {
  const limit = Math.max(1, Number(maxFileMB) || 1024);
  if (size > limit * MB) {
    return { decode: false, reason: `This file is ${fmtSize(size)}. TIFF Viewer decodes files up to ${fmtSize(limit * MB)} so VS Code stays responsive (setting tiffViewer.maxFileMB). The tags of every page are listed on the right.` };
  }
  return { decode: true };
}

function fmtSize(n) {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(n >= 10 * 1024 * MB ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Page list for the webview: plain values only, strings capped. */
function publicPages(parsed) {
  return parsed.pages.map(p => {
    const info = pageInfo(p.tags);
    const geo = geoInfo(p.tags, info.width, info.height);
    return {
      width: info.width, height: info.height, spp: info.spp, bps: info.bps, format: info.format, compression: info.compressionName,
      photometric: info.photometricName, planar: info.planar, tiled: info.tiled, reduced: info.reduced, problem: info.problem,
      name: String(info.pageName || '').slice(0, 200),
      tags: tagRows(p.tags).map(([k, v, t]) => [String(k).slice(0, 80), String(v).slice(0, 2000), t]),
      geo: geo && {
        keys: geo.keys.slice(0, 100).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 500)]),
        epsg: geo.epsg, nodata: geo.nodata, nodataText: geo.nodataText ? String(geo.nodataText).slice(0, 60) : null, bounds: geo.bounds,
        pixelSize: geo.pixelSize || null, units: geo.units, affine: geo.affine,
      },
    };
  });
}

module.exports = { validateWebviewMessage, sizePlan, fmtSize, publicPages, MB };
