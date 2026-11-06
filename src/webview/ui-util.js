'use strict';
// Small pure helpers for the webview UI, kept apart so the tests can run them in Node.
const { fmtNum } = require('../core/tiff');

const MAX_THUMB_PAGES = 300;
const THUMB_MAX_PIXELS = 16e6;

function formatLabel(p) {
  const kind = p.format === 'float' ? 'float' : p.format === 'int' ? 'signed integer' : 'unsigned integer';
  return `${p.bps}-bit ${kind}`;
}

function one(v, nodata) {
  if (v !== v) return 'NaN';
  if (nodata !== null && nodata !== undefined && v === nodata) return `${fmtNum(v)} (nodata)`;
  return Number.isInteger(v) ? String(v) : fmtNum(Math.round(v * 1e6) / 1e6);
}

/** Pixel readout text: "534.72", "R 100  G 157  B 235", "index 3 = rgb(255, 0, 0)". */
function fmtValue(r, names, nodata) {
  if (!r) return '-';
  if (r.rgb) return `index ${r.values[0]} = rgb(${r.rgb.join(', ')})`;
  if (r.values.length === 1) return one(r.values[0], nodata);
  return r.values.map((v, i) => `${short(names[i], i)} ${one(v, nodata)}`).join('  ');
}

function short(name, i) {
  if (!name) return `C${i + 1}`;
  if (/^(Red|Green|Blue|Cyan|Magenta|Yellow|Black)$/.test(name)) return name[0] === 'B' && name === 'Black' ? 'K' : name[0];
  if (name === 'Alpha') return 'A';
  return name.replace(/^Channel /, 'C');
}

/** Map coordinates of the pixel centre, or '' without a GeoTIFF transform. */
function geoText(geo, x, y) {
  if (!geo || !geo.affine) return '';
  const a = geo.affine, px = x + 0.5, py = y + 0.5;
  const X = a[0] * px + a[1] * py + a[2], Y = a[3] * px + a[4] * py + a[5];
  if (geo.units === 'degree' || (!geo.units && Math.abs(X) <= 360 && Math.abs(Y) <= 90 && Math.abs(a[0]) < 1)) return `lon ${X.toFixed(6)}, lat ${Y.toFixed(6)}`;
  const u = geo.units === 'metre' ? ' m' : geo.units ? ` ${geo.units}` : '';
  return `E ${X.toFixed(2)}, N ${Y.toFixed(2)}${u}`;
}

/** Zoom limits in screen pixels per canvas pixel; step is how many image pixels one canvas pixel covers. */
function clampZoom(z, step) {
  const lo = 0.02, hi = 64 * step;
  return Math.min(hi, Math.max(lo, Number.isFinite(z) ? z : 1));
}

module.exports = { formatLabel, fmtValue, geoText, clampZoom, MAX_THUMB_PAGES, THUMB_MAX_PIXELS };
