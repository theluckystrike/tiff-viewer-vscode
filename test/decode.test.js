'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../src/core/tiff');
const D = require('../src/webview/decode');
const { encodeTiff, bytesOf } = require('./tiffwriter');

async function decode(buf, page = 0) {
  const u8 = new Uint8Array(buf);
  const r = await T.parseTiff(new T.BufferReader(u8));
  return D.decodePage(u8, r.le, r.pages[page].tags);
}
function filled(Ctor, n, f) { const a = new Ctor(n); for (let i = 0; i < n; i++) a[i] = f(i); return a; }
const W = 37, H = 23; // odd sizes catch row and tile edge bugs

const cases = [
  ['uint8', Uint8Array, 8, 1, i => (i * 7) & 255],
  ['int8', Int8Array, 8, 2, i => ((i * 5) & 255) - 128],
  ['uint16', Uint16Array, 16, 1, i => (i * 977) & 0xffff],
  ['int16', Int16Array, 16, 2, i => ((i * 611) & 0xffff) - 32768],
  ['uint32', Uint32Array, 32, 1, i => (i * 2654435761) >>> 0],
  ['int32', Int32Array, 32, 2, i => (i * 2654435761) | 0],
  ['float32', Float32Array, 32, 3, i => Math.fround(Math.sin(i) * 1000.5)],
  ['float64', Float64Array, 64, 3, i => Math.cos(i) * 1e6 + 0.123],
];
const layouts = [
  { name: 'strips none LE', compression: 1, rowsPerStrip: 5 },
  { name: 'strips none BE', compression: 1, rowsPerStrip: 4, le: false },
  { name: 'strips deflate', compression: 8, rowsPerStrip: 6 },
  { name: 'strips packbits BE', compression: 32773, rowsPerStrip: 23, le: false },
  { name: 'tiles deflate', compression: 8, tile: [16, 16] },
  { name: 'tiles none BE BigTIFF', compression: 1, tile: [16, 16], le: false, big: true },
];

for (const [name, Ctor, bps, format, f] of cases) for (const L of layouts) {
  test(`decode: ${name}, ${L.name}, values exact`, async () => {
    const src = filled(Ctor, W * H, f);
    const buf = encodeTiff([{ width: W, height: H, bps, format, compression: L.compression, rowsPerStrip: L.rowsPerStrip, tile: L.tile, data: bytesOf(src) }], { le: L.le !== false, big: !!L.big });
    const pg = await decode(buf);
    assert.equal(pg.samples.constructor, Ctor);
    assert.deepEqual(Array.from(pg.samples), Array.from(src));
  });
}

test('decode: predictor 2 (8 and 16-bit, RGB and gray, LE and BE) and predictor 3 (float32, float64)', async () => {
  const cfgs = [
    [Uint8Array, 8, 1, 3, 2, true], [Uint16Array, 16, 1, 1, 2, true], [Uint16Array, 16, 1, 3, 2, false],
    [Float32Array, 32, 3, 1, 3, true], [Float32Array, 32, 3, 1, 3, false], [Float64Array, 64, 3, 1, 3, true],
  ];
  for (const [Ctor, bps, format, spp, predictor, le] of cfgs) {
    const src = filled(Ctor, W * H * spp, i => (format === 3 ? Math.sin(i / 3) * 77.25 : (i * 13) % (bps === 8 ? 256 : 60000)));
    const buf = encodeTiff([{ width: W, height: H, spp, bps, format, photometric: spp === 3 ? 2 : 1, compression: 8, predictor, rowsPerStrip: 7, data: bytesOf(src) }], { le });
    const pg = await decode(buf);
    assert.deepEqual(Array.from(pg.samples), Array.from(src), `${Ctor.name} spp ${spp} predictor ${predictor} le ${le}`);
  }
});

test('decode: planar 16-bit with 3 channels keeps planes apart', async () => {
  const src = filled(Uint16Array, W * H * 3, i => Math.floor(i / (W * H)) * 1000 + (i % (W * H)));
  const pg = await decode(encodeTiff([{ width: W, height: H, spp: 3, bps: 16, photometric: 1, planar: 2, rowsPerStrip: 8, data: bytesOf(src) }]));
  assert.equal(pg.planar, true);
  assert.deepEqual(D.pixel(pg, 2, 1).values, [W + 2, 1000 + W + 2, 2000 + W + 2]);
  const ch = D.channelsOf(pg);
  assert.deepEqual(ch.views.map(v => v.id), ['rgb', '0', '1', '2']);
});

test('decode: 1-bit WhiteIsZero, 4-bit gray and an 8-bit palette', async () => {
  const bits = new Uint8Array(Math.ceil(W / 8) * H).fill(0b10101010);
  const pg1 = await decode(encodeTiff([{ width: W, height: H, bps: 1, photometric: 0, data: bits }]));
  assert.deepEqual(Array.from(pg1.samples.subarray(0, 4)), [1, 0, 1, 0]);
  const img = D.render(pg1, '0', { lo: 0, hi: 1 }, null, 1);
  assert.deepEqual(Array.from(img.rgba.subarray(0, 8)), [0, 0, 0, 255, 255, 255, 255, 255], 'WhiteIsZero: 1 is black');

  const nib = new Uint8Array(Math.ceil(W / 2) * H).fill(0x3c);
  const pg4 = await decode(encodeTiff([{ width: W, height: H, bps: 4, data: nib }]));
  assert.deepEqual(Array.from(pg4.samples.subarray(0, 3)), [3, 12, 3]);

  const cmap = new Array(768).fill(0); cmap[5] = 65535; cmap[256 + 5] = 32768; // index 5 = (255, 128, 0)
  const pal = new Uint8Array(W * H).fill(5);
  const pgp = await decode(encodeTiff([{ width: W, height: H, bps: 8, photometric: 3, data: pal, tags: [[320, 3, cmap]] }]));
  assert.deepEqual(D.pixel(pgp, 0, 0).rgb, [255, 128, 0]);
  assert.equal(D.channelsOf(pgp).defaultView, 'palette');
  assert.deepEqual(Array.from(D.render(pgp, 'palette', { lo: 0, hi: 255 }, null, 1).rgba.subarray(0, 4)), [255, 128, 0, 255]);
});

test('decode: half floats', () => {
  assert.equal(D.halfToFloat(0x3c00), 1); assert.equal(D.halfToFloat(0xc000), -2); assert.equal(D.halfToFloat(0x7c00), Infinity);
  assert.ok(Number.isNaN(D.halfToFloat(0x7e00))); assert.equal(D.halfToFloat(0x0001), 2 ** -24);
});

test('decode: missing strips show as empty with a note; all strips damaged gives an error', async () => {
  const src = filled(Uint8Array, W * H, i => 200);
  const buf = Buffer.from(encodeTiff([{ width: W, height: H, bps: 8, compression: 8, rowsPerStrip: 12, data: src }]));
  const cut = buf.subarray(0, 60); // first strip only partly there, the directory is gone
  await assert.rejects(decode(cut));
  // corrupt every deflate stream: decoder must not throw a raw error
  const r = await T.parseTiff(new T.BufferReader(new Uint8Array(buf)));
  const offs = r.pages[0].tags.get(273).values;
  const bad = Buffer.from(buf); for (const o of offs) bad.fill(0xff, o, o + 8);
  await assert.rejects(decode(bad), /could be decompressed|damaged/);
  const half = Buffer.from(buf); half.fill(0xff, offs[1], offs[1] + 8);
  const pg = await decode(half);
  assert.match(pg.problems.join(' '), /1 strips or tiles could not be decompressed/);
  assert.equal(pg.samples[0], 200);
});

test('stats: min, max, mean, percentiles, nodata and NaN', () => {
  const s = new Float32Array(1000); for (let i = 0; i < 1000; i++) s[i] = i;
  s[0] = NaN; s[1] = -9999;
  const pg = { width: 100, height: 10, spp: 1, planar: false, format: 'float', bps: 32, samples: s, photometric: 1, extraSamples: [] };
  const st = D.stats(pg, [0], -9999);
  assert.equal(st.min, 2); assert.equal(st.max, 999); assert.equal(st.nan, 1); assert.equal(st.nodata, 1); assert.equal(st.count, 998);
  assert.ok(Math.abs(st.pct.p50 - 500) < 2); assert.ok(Math.abs(st.pct.p02 - 22) < 2); assert.ok(Math.abs(st.pct.p98 - 979) < 2);
  const r = D.stretchRange(pg, st, 'p2');
  assert.ok(r.lo > 15 && r.hi < 990);
  assert.deepEqual([D.stretchRange(pg, st, 'minmax').lo, D.stretchRange(pg, st, 'minmax').hi], [2, 999]);
  const img = D.render(pg, '0', r, -9999, 1);
  assert.equal(img.rgba[3], 0, 'NaN is transparent'); assert.equal(img.rgba[7], 0, 'nodata is transparent');
  assert.equal(img.rgba[4 * 999], 255, 'top value is white');
});

test('stats: exact histogram for 16-bit, auto stretch picks percentile, 8-bit keeps 0..255', () => {
  const s = new Uint16Array(10000); for (let i = 0; i < s.length; i++) s[i] = 300 + (i % 100);
  const pg16 = { width: 100, height: 100, spp: 1, planar: false, format: 'uint', bps: 16, samples: s, photometric: 1, extraSamples: [] };
  const st = D.stats(pg16, [0], null);
  assert.equal(st.pct.p005, 300); assert.equal(st.pct.p995, 399);
  assert.equal(D.stretchRange(pg16, st, 'auto').mode, 'p05');
  assert.deepEqual([D.stretchRange(pg16, st, 'type').lo, D.stretchRange(pg16, st, 'type').hi], [0, 65535]);
  const pg8 = { ...pg16, bps: 8, samples: new Uint8Array(10000).fill(7) };
  const r8 = D.stretchRange(pg8, D.stats(pg8, [0], null), 'auto');
  assert.deepEqual([r8.lo, r8.hi, r8.mode], [0, 255, 'type']);
  const flat = D.stretchRange(pg16, D.stats({ ...pg16, samples: new Uint16Array(10000).fill(5) }, [0], null), 'minmax');
  assert.ok(flat.hi > flat.lo, 'flat image still has a range');
});

test('render: large images are shown with a step; pixel() reads full resolution', () => {
  assert.equal(D.displayStep(1000, 800), 1);
  assert.equal(D.displayStep(20000, 1000), 4);
  assert.ok(D.displayStep(5000, 5000) >= 2, 'pixel cap');
  const pg = { width: 9, height: 9, spp: 1, planar: false, format: 'uint', bps: 8, samples: Uint8Array.from({ length: 81 }, (_, i) => i), photometric: 1, extraSamples: [] };
  const img = D.render(pg, '0', { lo: 0, hi: 255 }, null, 3);
  assert.equal(img.width, 3); assert.equal(img.rgba[4], 3);
  assert.deepEqual(D.pixel(pg, 4, 2).values, [22]);
  assert.equal(D.pixel(pg, 9, 0), null);
});

test('samples: every generated sample decodes, under 5 MB, with the expected kinds', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tiffv-'));
  try {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-samples.js'), dir]);
    const seen = {};
    for (const f of fs.readdirSync(dir)) {
      const u8 = new Uint8Array(fs.readFileSync(path.join(dir, f)));
      assert.ok(u8.length < 5 * 1048576, f);
      const r = await T.parseTiff(new T.BufferReader(u8));
      for (const p of r.pages) {
        const pg = D.decodePage(u8, r.le, p.tags);
        assert.equal(pg.problems.length, 0, f);
        seen[f] = (seen[f] || []).concat(`${pg.bps}${pg.format[0]}x${pg.spp}`);
      }
    }
    assert.equal(seen['multipage-stack.tif'].length, 7);
    assert.deepEqual(seen['microscopy-16bit.tif'], ['16ux1']);
    assert.deepEqual(seen['dem-float32-geotiff.tif'], ['32fx1']);
    assert.deepEqual(seen['rgb-tiled.tiff'], ['8ux3']);
    assert.deepEqual(seen['channels-16bit-bigtiff.tif'], ['16ux3']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
