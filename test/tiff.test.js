'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/tiff');
const { encodeTiff } = require('./tiffwriter');

const parse = (buf, o) => T.parseTiff(new T.BufferReader(new Uint8Array(buf)), o);
const gray = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h).map((_, i) => i & 255) });

test('parser: classic little-endian, big-endian and BigTIFF headers', async () => {
  for (const opts of [{}, { le: false }, { big: true }, { big: true, le: false }]) {
    const r = await parse(encodeTiff([gray(10, 7)], opts));
    assert.equal(r.le, opts.le !== false); assert.equal(r.big, !!opts.big);
    assert.equal(r.pages.length, 1);
    const p = T.pageInfo(r.pages[0].tags);
    assert.equal(p.width, 10); assert.equal(p.height, 7); assert.equal(p.bps, 8); assert.equal(p.problem, '');
  }
});

test('parser: follows the page chain and stops at maxPages', async () => {
  const buf = encodeTiff(Array.from({ length: 5 }, () => gray(4, 4)));
  assert.equal((await parse(buf)).pages.length, 5);
  const r = await parse(buf, { maxPages: 3 });
  assert.equal(r.pages.length, 3);
  assert.match(r.problems.join(' '), /first 3 pages/);
});

test('parser: a looping page chain is reported, not followed forever', async () => {
  const buf = Buffer.from(encodeTiff([gray(4, 4)]));
  const first = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(first);
  buf.writeUInt32LE(first, first + 2 + n * 12); // next IFD = itself
  const r = await parse(buf);
  assert.equal(r.pages.length, 1);
  assert.match(r.problems.join(' '), /loops/);
});

test('parser: clear errors for non-TIFF and cut files', async () => {
  await assert.rejects(parse(Buffer.from('%PDF-1.7 hello world')), /not a TIFF/);
  await assert.rejects(parse(Buffer.from([0x49, 0x49, 99, 0, 8, 0, 0, 0])), /version number 99/);
  await assert.rejects(parse(Buffer.from([0x49, 0x49])), /too short/);
  const cut = encodeTiff([gray(30, 30)]).subarray(0, 40);
  const r = await parse(cut);
  assert.equal(r.pages.length, 0);
  assert.ok(r.problems.length >= 1);
});

test('parser: tag rows name known tags, cut long arrays and keep unknown tags', async () => {
  const buf = encodeTiff([{ ...gray(64, 64), rowsPerStrip: 1, tags: [[270, 2, 'A <b>bold</b> description'], [65000, 3, [1, 2, 3]]] }]);
  const r = await parse(buf);
  const rows = T.tagRows(r.pages[0].tags);
  const get = n => rows.find(x => x[0] === n);
  assert.equal(get('ImageDescription')[1], 'A <b>bold</b> description');
  assert.match(get('StripOffsets')[1], /… \(64 values\)/);
  assert.match(get('Compression')[1], /None/);
  assert.equal(get('Tag 65000')[1], '1, 2, 3');
});

test('parser: maxValues keeps the count but reads fewer values', async () => {
  const r = await parse(encodeTiff([{ ...gray(8, 100), rowsPerStrip: 1 }]), { maxValues: 10 });
  const e = r.pages[0].tags.get(273);
  assert.equal(e.count, 100); assert.equal(e.values.length, 10); assert.equal(e.truncated, true);
});

test('parser: unsupported compression and odd layouts give a reason', async () => {
  const base = { width: 4, height: 4, bps: 8, bpsAll: [8], spp: 1, format: 'uint', photometric: 1, compression: 1, compressionName: 'None', photometricName: 'BlackIsZero' };
  assert.equal(T.decodeProblem(base), '');
  assert.match(T.decodeProblem({ ...base, compression: 50000, compressionName: 'ZSTD' }), /ZSTD is not supported/);
  assert.match(T.decodeProblem({ ...base, bps: 12, bpsAll: [12] }), /12-bit/);
  assert.match(T.decodeProblem({ ...base, format: 'float', bps: 8, bpsAll: [8] }), /float/);
  assert.match(T.decodeProblem({ ...base, width: 0 }), /no width/);
});

test('geotiff: keys, EPSG, bounds, nodata and pixel-to-map transform', async () => {
  const keys = [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32633, 3076, 0, 1, 9001];
  const buf = encodeTiff([{ ...gray(100, 50), tags: [[33550, 12, [10, 20, 0]], [33922, 12, [0, 0, 0, 400000, 6000000, 0]], [34735, 3, keys], [42113, 2, '-32768']] }]);
  const r = await parse(buf);
  const g = T.geoInfo(r.pages[0].tags, 100, 50);
  assert.equal(g.epsg, 32633); assert.equal(g.nodata, -32768); assert.equal(g.units, 'metre');
  assert.deepEqual(g.bounds, { minX: 400000, minY: 5999000, maxX: 401000, maxY: 6000000 });
  assert.deepEqual(T.applyAffine(g.affine, 1, 1), [400010, 5999980]);
  assert.deepEqual(g.keys.find(k => k[0] === 'GTModelType'), ['GTModelType', '1 (Projected)']);
  assert.equal(T.geoInfo(new Map(), 1, 1), null);
});

test('geotiff: ModelTransformation and geographic EPSG', async () => {
  const m = [0.001, 0, 0, 10, 0, -0.001, 0, 50, 0, 0, 0, 0, 0, 0, 0, 1];
  const keys = [1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326];
  const r = await parse(encodeTiff([{ ...gray(10, 10), tags: [[34264, 12, m], [34735, 3, keys]] }]));
  const g = T.geoInfo(r.pages[0].tags, 10, 10);
  assert.equal(g.epsg, 4326);
  assert.deepEqual(T.applyAffine(g.affine, 10, 10).map(v => +v.toFixed(6)), [10.01, 49.99]);
});
