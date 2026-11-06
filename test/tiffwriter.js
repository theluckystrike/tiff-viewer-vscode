'use strict';
// Small TIFF / BigTIFF writer used by the sample script and the tests. Not shipped in the extension.
// page: { width, height, spp=1, bps=8, format=1 (1 uint, 2 int, 3 float), photometric, planar=1,
//         compression=1 (1 none, 8 deflate, 32773 packbits), predictor=1 (2 or 3), tile: [tw, th] | null,
//         rowsPerStrip, data: Uint8Array of little-endian samples (chunky, or planar when planar=2), tags: [[tag, type, values|string]] }
const zlib = require('zlib');

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };

function swap(buf, bytes) {
  const b = Buffer.from(buf);
  if (bytes === 2) b.swap16(); else if (bytes === 4) b.swap32(); else if (bytes === 8) b.swap64();
  return new Uint8Array(b);
}

function packbits(u8) {
  const out = [];
  for (let i = 0; i < u8.length; i += 128) { const n = Math.min(128, u8.length - i); out.push(n - 1); for (let k = 0; k < n; k++) out.push(u8[i + k]); }
  return Uint8Array.from(out);
}

function predict2(rows, rowBytes, nrows, bytes, spp) { // on little-endian samples
  const b = Buffer.from(rows);
  for (let r = 0; r < nrows; r++) {
    const o = r * rowBytes, n = rowBytes / bytes;
    for (let i = n - 1; i >= spp; i--) {
      if (bytes === 1) b[o + i] = (b[o + i] - b[o + i - spp]) & 255;
      else b.writeUInt16LE((b.readUInt16LE(o + i * 2) - b.readUInt16LE(o + (i - spp) * 2)) & 0xffff, o + i * 2);
    }
  }
  return new Uint8Array(b);
}

function predict3(rows, rowBytes, nrows, bytes, spp) { // little-endian floats -> byte planes MSB first, then byte differences
  const out = new Uint8Array(rows.length), n = rowBytes / bytes;
  for (let r = 0; r < nrows; r++) {
    const o = r * rowBytes;
    for (let k = 0; k < n; k++) for (let b = 0; b < bytes; b++) out[o + b * n + k] = rows[o + k * bytes + (bytes - 1 - b)];
    for (let i = rowBytes - 1; i >= spp; i--) out[o + i] = (out[o + i] - out[o + i - spp]) & 255;
  }
  return out;
}

function encodeTiff(pages, opts = {}) {
  const le = opts.le !== false, big = !!opts.big;
  const chunks = []; let pos = big ? 16 : 8;
  const push = u8 => { const at = pos; chunks.push(u8); pos += u8.length; if (pos & 1) { chunks.push(new Uint8Array(1)); pos++; } return at; };
  const ifdTags = [];
  for (const pg of pages) {
    const spp = pg.spp || 1, bps = pg.bps || 8, bytes = bps / 8, planar = pg.planar || 1, cmp = pg.compression || 1, pred = pg.predictor || 1;
    const planes = planar === 2 ? spp : 1, cs = planar === 2 ? 1 : spp;
    const rowBytes = pg.width * cs * bytes, planeBytes = rowBytes * pg.height;
    const offs = [], counts = [];
    const emit = (raw, cw, nrows) => {
      let d = raw; const rb = cw * cs * bytes;
      if (pred === 2) d = predict2(d, rb, nrows, bytes, cs);
      if (pred === 3) d = predict3(d, rb, nrows, bytes, cs);
      else if (!le && bytes > 1) d = swap(d, bytes);
      if (cmp === 8) d = new Uint8Array(zlib.deflateSync(Buffer.from(d)));
      if (cmp === 32773) d = packbits(d);
      offs.push(push(d)); counts.push(d.length);
    };
    if (pg.tile) {
      const [tw, th] = pg.tile, across = Math.ceil(pg.width / tw), down = Math.ceil(pg.height / th), tRow = tw * cs * bytes;
      for (let p = 0; p < planes; p++) for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
        const t = new Uint8Array(tRow * th);
        for (let r = 0; r < th && ty * th + r < pg.height; r++) {
          const src = p * planeBytes + (ty * th + r) * rowBytes + tx * tRow;
          t.set(pg.data.subarray(src, src + Math.min(tRow, rowBytes - tx * tRow)), r * tRow);
        }
        emit(t, tw, th);
      }
    } else {
      const rps = pg.rowsPerStrip || pg.height;
      for (let p = 0; p < planes; p++) for (let y = 0; y < pg.height; y += rps) {
        const n = Math.min(rps, pg.height - y), o = p * planeBytes + y * rowBytes;
        emit(pg.data.slice(o, o + n * rowBytes), pg.width, n);
      }
    }
    const L = big ? 16 : 4;
    const t = [[256, 4, [pg.width]], [257, 4, [pg.height]], [258, 3, new Array(spp).fill(bps)], [259, 3, [cmp]],
      [262, 3, [pg.photometric !== undefined ? pg.photometric : spp >= 3 ? 2 : 1]], [277, 3, [spp]], [284, 3, [planar]],
      [339, 3, new Array(spp).fill(pg.format || 1)]];
    if (pred !== 1) t.push([317, 3, [pred]]);
    if (pg.tile) t.push([322, 3, [pg.tile[0]]], [323, 3, [pg.tile[1]]], [324, L, offs], [325, L, counts]);
    else t.push([273, L, offs], [278, 4, [pg.rowsPerStrip || pg.height]], [279, L, counts]);
    for (const x of pg.tags || []) t.push(x);
    ifdTags.push(t.sort((a, b) => a[0] - b[0]));
  }
  // directories after the pixel data
  const ifdOffsets = [];
  const enc = (type, vals) => {
    if (type === 2) { const s = Buffer.from(String(vals) + '\0', 'latin1'); return new Uint8Array(s); }
    const sz = TYPE_SIZE[type], b = Buffer.alloc(sz * vals.length);
    vals.forEach((v, i) => {
      const o = i * sz;
      if (type === 1 || type === 7) b.writeUInt8(v, o);
      else if (type === 3) le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
      else if (type === 8) le ? b.writeInt16LE(v, o) : b.writeInt16BE(v, o);
      else if (type === 4) le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
      else if (type === 9) le ? b.writeInt32LE(v, o) : b.writeInt32BE(v, o);
      else if (type === 11) le ? b.writeFloatLE(v, o) : b.writeFloatBE(v, o);
      else if (type === 12) le ? b.writeDoubleLE(v, o) : b.writeDoubleBE(v, o);
      else if (type === 16) le ? b.writeBigUInt64LE(BigInt(v), o) : b.writeBigUInt64BE(BigInt(v), o);
      else if (type === 5) { le ? b.writeUInt32LE(Math.round(v * 1000), o) : b.writeUInt32BE(Math.round(v * 1000), o); le ? b.writeUInt32LE(1000, o + 4) : b.writeUInt32BE(1000, o + 4); }
    });
    return new Uint8Array(b);
  };
  const entSize = big ? 20 : 12, ptr = big ? 8 : 4, cnt = big ? 8 : 2;
  const ifdBlobs = [];
  for (const t of ifdTags) {
    // write out-of-line values first
    const ents = t.map(([tag, type, vals]) => {
      const data = enc(type, vals); const count = type === 2 ? data.length : vals.length;
      return { tag, type, count, data, at: data.length > ptr ? push(data) : -1 };
    });
    const blob = Buffer.alloc(cnt + ents.length * entSize + ptr);
    const w16 = (v, o) => (le ? blob.writeUInt16LE(v, o) : blob.writeUInt16BE(v, o));
    const w32 = (v, o) => (le ? blob.writeUInt32LE(v, o) : blob.writeUInt32BE(v, o));
    const w64 = (v, o) => (le ? blob.writeBigUInt64LE(BigInt(v), o) : blob.writeBigUInt64BE(BigInt(v), o));
    if (big) w64(ents.length, 0); else w16(ents.length, 0);
    ents.forEach((e, i) => {
      const o = cnt + i * entSize;
      w16(e.tag, o); w16(e.type, o + 2);
      if (big) w64(e.count, o + 4); else w32(e.count, o + 4);
      const vo = o + (big ? 12 : 8);
      if (e.at >= 0) { if (big) w64(e.at, vo); else w32(e.at, vo); } else Buffer.from(e.data).copy(blob, vo);
    });
    ifdOffsets.push(pos); ifdBlobs.push(blob); push(new Uint8Array(blob));
  }
  const all = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  // next-IFD pointers
  ifdOffsets.forEach((o, i) => {
    const at = o - (big ? 16 : 8) + cnt + ifdTags[i].length * entSize, next = ifdOffsets[i + 1] || 0;
    if (big) (le ? all.writeBigUInt64LE(BigInt(next), at) : all.writeBigUInt64BE(BigInt(next), at)); else (le ? all.writeUInt32LE(next, at) : all.writeUInt32BE(next, at));
  });
  const head = Buffer.alloc(big ? 16 : 8);
  head.write(le ? 'II' : 'MM', 0, 'latin1');
  if (big) { le ? head.writeUInt16LE(43, 2) : head.writeUInt16BE(43, 2); le ? head.writeUInt16LE(8, 4) : head.writeUInt16BE(8, 4); le ? head.writeBigUInt64LE(BigInt(ifdOffsets[0]), 8) : head.writeBigUInt64BE(BigInt(ifdOffsets[0]), 8); }
  else { le ? head.writeUInt16LE(42, 2) : head.writeUInt16BE(42, 2); le ? head.writeUInt32LE(ifdOffsets[0], 4) : head.writeUInt32BE(ifdOffsets[0], 4); }
  return Buffer.concat([head, all]);
}

/** Typed array -> little-endian bytes. */
const bytesOf = ta => new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);

module.exports = { encodeTiff, bytesOf };
