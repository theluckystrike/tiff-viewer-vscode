'use strict';
// Generates the sample TIFFs used by the tests, the README screenshots and the release check.
// usage: node scripts/make-samples.js [outDir]   (default: samples/). Every file is synthetic and under 5 MB.
const fs = require('fs');
const path = require('path');
const { encodeTiff, bytesOf } = require('../test/tiffwriter');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples'));
fs.mkdirSync(out, { recursive: true });
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };

// 1. Multi-page stack: 6 pages of 8-bit gray "time points" plus one RGB overview page, Deflate.
function multipage() {
  const W = 480, H = 360, pages = [];
  for (let t = 0; t < 6; t++) {
    const d = new Uint8Array(W * H);
    const cx = 120 + t * 50, cy = 180 + Math.sin(t) * 60;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = Math.hypot(x - cx, y - cy);
      const ring = Math.max(0, 1 - Math.abs(r - 40 - t * 6) / 10);
      d[y * W + x] = Math.max(0, Math.min(255, 30 + 200 * Math.exp(-r * r / 1800) + 120 * ring + 8 * gauss()));
    }
    pages.push({ width: W, height: H, bps: 8, compression: 8, predictor: 2, rowsPerStrip: 32, data: d, tags: [[285, 2, `Time point ${t + 1}`], [270, 2, `Synthetic droplet, t = ${t * 5} s`]] });
  }
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    rgb[o] = 255 * x / W; rgb[o + 1] = 255 * y / H; rgb[o + 2] = 128 + 127 * Math.sin((x + y) / 30);
  }
  pages.push({ width: W, height: H, spp: 3, bps: 8, photometric: 2, compression: 8, rowsPerStrip: 16, data: rgb, tags: [[285, 2, 'Overview (RGB)']] });
  return encodeTiff(pages);
}

// 2. 16-bit microscopy-like image: dim cells on a dark background (values 300 to 4000 of 65535), big-endian, PackBits.
function microscopy16() {
  const W = 1024, H = 768, d = new Uint16Array(W * H);
  const cells = Array.from({ length: 70 }, () => ({ x: rnd() * W, y: rnd() * H, r: 10 + rnd() * 26, b: 900 + rnd() * 2600 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 300 + 40 * gauss();
    for (const c of cells) { const q = ((x - c.x) ** 2 + (y - c.y) ** 2) / (c.r * c.r); if (q < 4) v += c.b * Math.exp(-q * 1.6); }
    d[y * W + x] = Math.max(0, Math.min(65535, Math.round(v)));
  }
  return encodeTiff([{ width: W, height: H, bps: 16, compression: 32773, rowsPerStrip: 64, data: bytesOf(d),
    tags: [[270, 2, 'Synthetic fluorescence field, 16-bit'], [305, 2, 'tiff-viewer sample script']] }], { le: false });
}

// 3. Float32 GeoTIFF elevation model with a nodata lake, UTM zone 33N (EPSG:32633), Deflate with the float predictor.
function demFloat32() {
  const W = 900, H = 640, d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    let z = 420 + 900 * Math.exp(-((u - 0.68) ** 2 + (v - 0.32) ** 2) * 9) + 260 * Math.sin(u * 11) * Math.cos(v * 7) + 60 * Math.sin(u * 47 + v * 31);
    if ((u - 0.25) ** 2 / 0.012 + (v - 0.7) ** 2 / 0.02 < 1) z = -9999;
    d[y * W + x] = z;
  }
  const geoKeys = [1, 1, 0, 6, 1024, 0, 1, 1, 1025, 0, 1, 1, 1026, 34737, 22, 0, 3072, 0, 1, 32633, 3076, 0, 1, 9001, 4099, 0, 1, 9001];
  return encodeTiff([{ width: W, height: H, bps: 32, format: 3, compression: 8, predictor: 3, rowsPerStrip: 16, data: bytesOf(d),
    tags: [[33550, 12, [30, 30, 0]], [33922, 12, [0, 0, 0, 500000, 5250000, 0]], [34735, 3, geoKeys], [34737, 2, 'WGS 84 / UTM zone 33N|'],
      [42113, 2, '-9999'], [270, 2, 'Synthetic elevation model in metres']] }]);
}

// 4. RGB photo-like scene, 8-bit, tiled 256 x 256, Deflate.
function rgbTiled() {
  const W = 1200, H = 800, d = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3, sky = y < H * 0.55;
    const hill = H * 0.55 + 60 * Math.sin(x / 140) + 25 * Math.sin(x / 37);
    if (y < hill && sky) { d[o] = 90 + 80 * y / H; d[o + 1] = 150 + 60 * y / H; d[o + 2] = 235; }
    else if (y < hill) { d[o] = 140; d[o + 1] = 180; d[o + 2] = 230; }
    else { const g = 90 + 50 * Math.sin(x / 9) * Math.sin(y / 7) + 20 * gauss(); d[o] = 50 + g / 3; d[o + 1] = 90 + g; d[o + 2] = 40; }
    const sun = Math.hypot(x - 950, y - 140); if (sun < 60) { d[o] = 255; d[o + 1] = 230; d[o + 2] = 120; }
  }
  return encodeTiff([{ width: W, height: H, spp: 3, bps: 8, photometric: 2, compression: 8, tile: [256, 256], data: d,
    tags: [[305, 2, 'tiff-viewer sample script'], [282, 5, [300]], [283, 5, [300]], [296, 3, [2]]] }]);
}

// 5. Three-channel 16-bit planar stack (channel picker), BigTIFF, uncompressed.
function planar3ch() {
  const W = 512, H = 512, d = new Uint16Array(W * H * 3);
  for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = [160, 340, 260][c], cy = [180, 220, 360][c];
    d[c * W * H + y * W + x] = Math.max(0, Math.round(200 + (c + 1) * 900 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 5000) + 30 * gauss()));
  }
  return encodeTiff([{ width: W, height: H, spp: 3, bps: 16, photometric: 1, planar: 2, rowsPerStrip: 128, data: bytesOf(d),
    tags: [[338, 3, [0, 0]], [270, 2, 'DAPI / GFP / mCherry (synthetic)']] }], { big: true });
}

const files = {
  'multipage-stack.tif': multipage(), 'microscopy-16bit.tif': microscopy16(), 'dem-float32-geotiff.tif': demFloat32(),
  'rgb-tiled.tiff': rgbTiled(), 'channels-16bit-bigtiff.tif': planar3ch(),
};
for (const [name, buf] of Object.entries(files)) {
  if (buf.length > 5 * 1048576) throw new Error(`${name} is over 5 MB`);
  fs.writeFileSync(path.join(out, name), buf);
  console.log(name, (buf.length / 1048576).toFixed(2), 'MB');
}
