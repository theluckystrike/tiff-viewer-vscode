'use strict';
// Pixel decoding and display mapping. Runs in the webview worker; pure functions, so the tests run it in Node.
// UTIF (MIT) is used only for its decompressors (LZW, Deflate, PackBits, JPEG, CCITT). Strip and tile layout,
// byte order, predictors and sample types are handled here so 16-bit, 32-bit and float data keep full precision.
const UTIF = require('utif2');
const { pageInfo } = require('../core/tiff');

const MAX_DISPLAY_SIDE = 6000;
const MAX_DISPLAY_PIXELS = 24e6;

function utifImg(tags, info) {
  const img = { isLE: true }; // we fix byte order ourselves, so UTIF must not swap
  for (const [t, e] of tags) img['t' + t] = e.text !== undefined ? [e.text] : e.values;
  delete img.t317; // predictors are applied here, for every bit depth
  img.width = info.width; img.height = info.height;
  if (info.planar === 2) { img.t277 = [1]; img.t258 = [info.bps]; }
  return img;
}

function swapBytes(buf, bytes) {
  if (bytes === 2) for (let i = 0; i + 1 < buf.length; i += 2) { const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t; }
  else if (bytes === 4) for (let i = 0; i + 3 < buf.length; i += 4) { let t = buf[i]; buf[i] = buf[i + 3]; buf[i + 3] = t; t = buf[i + 1]; buf[i + 1] = buf[i + 2]; buf[i + 2] = t; }
  else if (bytes === 8) for (let i = 0; i + 7 < buf.length; i += 8) for (let k = 0; k < 4; k++) { const t = buf[i + k]; buf[i + k] = buf[i + 7 - k]; buf[i + 7 - k] = t; }
}

/** Undo predictor 2 (horizontal differencing) on little-endian samples, row by row. */
function unpredict2(buf, rowBytes, rows, bps, spp) {
  const bytes = bps / 8;
  if (bps < 8) return;
  for (let r = 0; r < rows; r++) {
    const o = r * rowBytes, n = rowBytes / bytes;
    if (bytes === 1) { for (let i = spp; i < n; i++) buf[o + i] = (buf[o + i] + buf[o + i - spp]) & 255; continue; }
    const dv = new DataView(buf.buffer, buf.byteOffset + o, rowBytes);
    for (let i = spp; i < n; i++) {
      if (bytes === 2) dv.setUint16(i * 2, (dv.getUint16(i * 2, true) + dv.getUint16((i - spp) * 2, true)) & 0xffff, true);
      else if (bytes === 4) dv.setUint32(i * 4, (dv.getUint32(i * 4, true) + dv.getUint32((i - spp) * 4, true)) >>> 0, true);
    }
  }
}

/** Undo predictor 3 (floating point): byte differencing, then byte planes (most significant first) back to little-endian. */
function unpredict3(buf, rowBytes, rows, bps, spp) {
  const bytes = bps / 8, tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const o = r * rowBytes;
    for (let i = spp; i < rowBytes; i++) buf[o + i] = (buf[o + i] + buf[o + i - spp]) & 255;
    tmp.set(buf.subarray(o, o + rowBytes));
    const n = rowBytes / bytes;
    for (let k = 0; k < n; k++) for (let b = 0; b < bytes; b++) buf[o + k * bytes + (bytes - 1 - b)] = tmp[b * n + k];
  }
}

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Decodes one page. file: Uint8Array of the whole file. Returns
 * { width, height, spp, bps, format, planar, samples (typed array), photometric, colormap, extraSamples, problems }.
 */
function decodePage(file, le, tags) {
  const info = pageInfo(tags);
  if (info.problem) throw new Error(info.problem);
  if (file.byteOffset !== 0 || file.byteLength !== file.buffer.byteLength) file = file.slice(); // UTIF reads data.buffer directly
  const { width: w, height: h, bps, spp } = info;
  const planes = info.planar === 2 ? spp : 1;
  const chunkSpp = info.planar === 2 ? 1 : spp;
  const bitsPx = bps * chunkSpp;
  const rowBytes = Math.ceil(w * bitsPx / 8);
  const planeBytes = rowBytes * h;
  const total = planeBytes * planes;
  if (total > 2 ** 31) throw new Error(`This page needs ${(total / 2 ** 30).toFixed(1)} GB of memory once decoded, more than a webview can hold.`);
  const out = new Uint8Array(total);
  const img = utifImg(tags, info);
  const get = t => (tags.get(t) && tags.get(t).values) || null;
  const offs = info.tiled ? get(324) : get(273);
  let counts = info.tiled ? get(325) : get(279);
  if (!offs || !offs.length) throw new Error('This page has no strip or tile offsets.');
  if (!counts && info.compression === 1) counts = offs.map(() => rowBytes * (info.rowsPerStrip || h));
  if (!counts) throw new Error('This page has no strip or tile byte counts.');
  const fo = (tags.get(266) && tags.get(266).values[0]) || 1;
  const bytesPer = bps / 8;
  const problems = [];
  let failed = 0, missing = 0;

  const decodeChunk = (i, buf, cw, chRows) => {
    const off = offs[i], len = counts[i];
    if (off === undefined || len === undefined) { missing++; return false; }
    if (off + len > file.length) { missing++; if (off >= file.length) return false; }
    try {
      UTIF.decode._decompress(img, [img], file, off, Math.min(len, file.length - off), info.compression, buf, 0, fo, cw, chRows);
    } catch (e) { failed++; return false; }
    const cRowBytes = Math.ceil(cw * bitsPx / 8);
    if (info.predictor === 3) { if (info.format === 'float') unpredict3(buf, cRowBytes, chRows, bps, chunkSpp); }
    else {
      if (!le && bps > 8) swapBytes(buf, bytesPer);
      if (info.predictor === 2) unpredict2(buf, cRowBytes, chRows, bps, chunkSpp);
    }
    return true;
  };

  if (info.tiled) {
    const tw = info.tileWidth, th = info.tileHeight;
    if (!tw || !th) throw new Error('This page has tiles with no size.');
    if (bitsPx % 8) throw new Error('Tiled pages with fewer than 8 bits per pixel are not supported.');
    const across = Math.ceil(w / tw), down = Math.ceil(h / th), per = across * down;
    const tRow = tw * bitsPx / 8;
    const tbuf = new Uint8Array(tRow * th);
    for (let p = 0; p < planes; p++) for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
      tbuf.fill(0);
      if (!decodeChunk(p * per + ty * across + tx, tbuf, tw, th)) continue;
      const x0 = tx * tw * bitsPx / 8, cols = Math.min(tRow, rowBytes - x0);
      for (let r = 0; r < th && ty * th + r < h; r++) out.set(tbuf.subarray(r * tRow, r * tRow + cols), p * planeBytes + (ty * th + r) * rowBytes + x0);
    }
  } else {
    const rps = Math.max(1, Math.min(info.rowsPerStrip || h, h));
    const per = Math.ceil(h / rps);
    const sbuf = new Uint8Array(rowBytes * rps);
    for (let p = 0; p < planes; p++) for (let s = 0; s < per; s++) {
      sbuf.fill(0);
      if (!decodeChunk(p * per + s, sbuf, w, rps)) continue;
      const rows = Math.min(rps, h - s * rps);
      out.set(sbuf.subarray(0, rows * rowBytes), p * planeBytes + s * rps * rowBytes);
    }
  }
  if (missing) problems.push(`${missing} strips or tiles are missing or cut short; they show as empty.`);
  if (failed) problems.push(`${failed} strips or tiles could not be decompressed; they show as empty.`);
  if (failed && failed + missing >= offs.length) throw new Error('No strip or tile of this page could be decompressed. The file may be damaged.');

  return {
    width: w, height: h, spp, bps, format: info.format, planar: planes > 1, photometric: info.photometric, compression: info.compression,
    samples: toSamples(out, info, w, h, rowBytes, planes), extraSamples: info.extraSamples,
    colormap: info.photometric === 3 ? get(320) : null, problems,
  };
}

function toSamples(out, info, w, h, rowBytes, planes) {
  const { bps, format } = info;
  if (bps < 8) { // unpack 1, 2 and 4-bit rows
    const per = info.planar === 2 ? 1 : info.spp, n = w * per, res = new Uint8Array(n * h * planes), mask = (1 << bps) - 1;
    for (let p = 0; p < planes; p++) for (let y = 0; y < h; y++) {
      const ro = p * rowBytes * h + y * rowBytes, wo = p * n * h + y * n;
      for (let i = 0; i < n; i++) { const bit = i * bps; res[wo + i] = (out[ro + (bit >> 3)] >> (8 - bps - (bit & 7))) & mask; }
    }
    return res;
  }
  const buf = out.buffer;
  if (bps === 8) return format === 'int' ? new Int8Array(buf) : out;
  if (bps === 16) {
    if (format === 'float') { const u = new Uint16Array(buf), f = new Float32Array(u.length); for (let i = 0; i < u.length; i++) f[i] = halfToFloat(u[i]); return f; }
    return format === 'int' ? new Int16Array(buf) : new Uint16Array(buf);
  }
  if (bps === 32) return format === 'float' ? new Float32Array(buf) : format === 'int' ? new Int32Array(buf) : new Uint32Array(buf);
  if (bps === 64) {
    if (format === 'float') return new Float64Array(buf);
    const dv = new DataView(buf), f = new Float64Array(buf.byteLength / 8);
    for (let i = 0; i < f.length; i++) f[i] = Number(format === 'int' ? dv.getBigInt64(i * 8, true) : dv.getBigUint64(i * 8, true));
    return f;
  }
  throw new Error(`${bps}-bit samples are not supported.`);
}

/** Channel names and the views the picker offers. */
function channelsOf(pg) {
  const names = [];
  const ph = pg.photometric;
  const colour = ph === 2 || ph === 6 || (ph === 5 && pg.spp >= 4);
  for (let c = 0; c < pg.spp; c++) {
    if (ph === 5 && c < 4) names.push(['Cyan', 'Magenta', 'Yellow', 'Black'][c]);
    else if (colour && c < 3) names.push(['Red', 'Green', 'Blue'][c]);
    else if (pg.spp === 1) names.push(ph === 3 ? 'Index' : 'Gray');
    else {
      const ex = pg.extraSamples[c - (colour ? 3 : 1)];
      names.push(ex === 1 || ex === 2 ? 'Alpha' : `Channel ${c + 1}`);
    }
  }
  const views = [];
  if (ph === 3) views.push({ id: 'palette', label: 'Palette colours' });
  else if (colour || pg.spp >= 3) views.push({ id: 'rgb', label: colour ? (ph === 5 ? 'CMYK as RGB' : 'RGB') : 'Channels 1, 2, 3 as RGB' });
  names.forEach((n, i) => views.push({ id: String(i), label: `${n}${pg.spp > 1 ? ` (channel ${i + 1})` : ''}` }));
  return { names, views, defaultView: views[0].id };
}

const idx = (pg, c, i) => (pg.planar ? c * pg.width * pg.height + i : i * pg.spp + c);
function sampleAt(pg, c, i) { return pg.samples[idx(pg, c, i)]; }

function typeRange(pg) {
  if (pg.format === 'float') return [0, 1];
  if (pg.format === 'int') return [-(2 ** (pg.bps - 1)), 2 ** (pg.bps - 1) - 1];
  return [0, 2 ** pg.bps - 1];
}

/** Statistics over the given channels: min, max, mean, counts and percentiles from a histogram. */
function stats(pg, chans, nodata) {
  const n = pg.width * pg.height;
  let min = Infinity, max = -Infinity, sum = 0, count = 0, nan = 0, nod = 0;
  const hasNodata = nodata !== null && nodata !== undefined && !Number.isNaN(nodata);
  for (const c of chans) for (let i = 0; i < n; i++) {
    const v = pg.samples[idx(pg, c, i)];
    if (v !== v || v === Infinity || v === -Infinity) { nan++; continue; }
    if (hasNodata && v === nodata) { nod++; continue; }
    if (v < min) min = v; if (v > max) max = v; sum += v; count++;
  }
  if (!count) return { min: null, max: null, mean: null, count, nan, nodata: nod, pct: {}, hist: [] };
  const exact = pg.format !== 'float' && max - min + 1 <= 65536;
  const bins = exact ? max - min + 1 : 4096;
  const width = exact ? 1 : (max - min) / bins || 1;
  const hist = new Uint32Array(bins);
  for (const c of chans) for (let i = 0; i < n; i++) {
    const v = pg.samples[idx(pg, c, i)];
    if (v !== v || v === Infinity || v === -Infinity || (hasNodata && v === nodata)) continue;
    let b = exact ? v - min : Math.floor((v - min) / width); if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const at = q => {
    const target = q * (count - 1);
    let acc = 0;
    for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc > target) return exact ? min + b : Math.min(max, min + (b + 0.5) * width); }
    return max;
  };
  const pct = { p005: at(0.005), p995: at(0.995), p02: at(0.02), p98: at(0.98), p50: at(0.5) };
  const small = new Array(64).fill(0);
  for (let b = 0; b < bins; b++) small[Math.min(63, Math.floor(b * 64 / bins))] += hist[b];
  return { min, max, mean: sum / count, count, nan, nodata: nod, pct, hist: small };
}

/** Low and high display values for a stretch mode. */
function stretchRange(pg, st, mode) {
  if (mode === 'auto') mode = pg.bps <= 8 && pg.format === 'uint' ? 'type' : 'p05';
  if (mode === 'type' || st.min === null) return { lo: typeRange(pg)[0], hi: typeRange(pg)[1], mode: st.min === null ? 'type' : mode };
  let lo = st.min, hi = st.max;
  if (mode === 'p05') { lo = st.pct.p005; hi = st.pct.p995; }
  if (mode === 'p2') { lo = st.pct.p02; hi = st.pct.p98; }
  if (!(hi > lo)) { lo = st.min; hi = st.max; }
  if (!(hi > lo)) hi = lo + 1;
  return { lo, hi, mode };
}

function displayStep(w, h, maxSide = MAX_DISPLAY_SIDE, maxPixels = MAX_DISPLAY_PIXELS) {
  let s = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  while ((w / s) * (h / s) > maxPixels) s++;
  return s;
}

/**
 * Renders a page to RGBA. view: 'rgb' | 'palette' | channel index as a string.
 * range: { lo, hi } for stretched views. Returns { rgba: Uint8ClampedArray, width, height, step }.
 */
function render(pg, view, range, nodata, step = displayStep(pg.width, pg.height)) {
  const ow = Math.max(1, Math.floor(pg.width / step)), oh = Math.max(1, Math.floor(pg.height / step));
  const rgba = new Uint8ClampedArray(ow * oh * 4);
  const { lo, hi } = range;
  const k = 255 / (hi - lo);
  const hasNodata = nodata !== null && nodata !== undefined && !Number.isNaN(nodata);
  const invert = pg.photometric === 0;
  const map = v => (v - lo) * k;
  const cmap = pg.colormap, cn = cmap ? cmap.length / 3 : 0;
  const alphaC = view === 'rgb' && pg.spp >= 4 && pg.photometric !== 5 ? pg.spp - 1 : -1;
  const aMax = typeRange(pg)[1] || 1;
  const ch = view === 'rgb' || view === 'palette' ? -1 : Number(view);
  for (let oy = 0; oy < oh; oy++) {
    const y = oy * step;
    for (let ox = 0; ox < ow; ox++) {
      const i = y * pg.width + ox * step, o = (oy * ow + ox) * 4;
      if (view === 'palette') {
        const v = sampleAt(pg, 0, i);
        rgba[o] = cmap[v] >> 8; rgba[o + 1] = cmap[cn + v] >> 8; rgba[o + 2] = cmap[2 * cn + v] >> 8; rgba[o + 3] = 255;
        continue;
      }
      if (ch >= 0) {
        const v = sampleAt(pg, ch, i);
        if (v !== v || (hasNodata && v === nodata)) { rgba[o + 3] = 0; continue; }
        let g = map(v); if (invert) g = 255 - g;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255;
        continue;
      }
      const r = sampleAt(pg, 0, i), gg = sampleAt(pg, 1, i), b = sampleAt(pg, 2, i);
      if (r !== r || (hasNodata && r === nodata && gg === nodata && b === nodata)) { rgba[o + 3] = 0; continue; }
      if (pg.photometric === 5) {
        const kk = 1 - map(sampleAt(pg, 3, i)) / 255;
        rgba[o] = 255 * (1 - map(r) / 255) * kk; rgba[o + 1] = 255 * (1 - map(gg) / 255) * kk; rgba[o + 2] = 255 * (1 - map(b) / 255) * kk;
      } else { rgba[o] = map(r); rgba[o + 1] = map(gg); rgba[o + 2] = map(b); }
      rgba[o + 3] = alphaC >= 0 && pg.extraSamples.length && (pg.extraSamples[0] === 1 || pg.extraSamples[0] === 2) ? sampleAt(pg, alphaC, i) * 255 / aMax : 255;
    }
  }
  return { rgba, width: ow, height: oh, step };
}

/** Values of every channel at one pixel, plus the palette colour for palette images. */
function pixel(pg, x, y) {
  if (x < 0 || y < 0 || x >= pg.width || y >= pg.height) return null;
  const i = y * pg.width + x;
  const values = [];
  for (let c = 0; c < pg.spp; c++) values.push(sampleAt(pg, c, i));
  const res = { x, y, values };
  if (pg.colormap) { const cn = pg.colormap.length / 3, v = values[0]; res.rgb = [pg.colormap[v] >> 8, pg.colormap[cn + v] >> 8, pg.colormap[2 * cn + v] >> 8]; }
  return res;
}

module.exports = { decodePage, channelsOf, stats, stretchRange, render, pixel, displayStep, typeRange, halfToFloat, unpredict2, unpredict3, MAX_DISPLAY_SIDE };
