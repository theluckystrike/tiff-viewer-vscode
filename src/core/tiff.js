'use strict';
// TIFF and BigTIFF directory parser. Works on any source with an async read(offset, length) -> Uint8Array,
// so the extension host can read tags from a 20 GB file with a few small range reads, and the webview
// worker can use the same code on a whole ArrayBuffer. It never throws on bad data: it returns what it
// could read plus a list of problems.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const MAX_PAGES = 10000;
const MAX_TAGS = 4000;

const TAG_NAMES = {
  254: 'NewSubfileType', 255: 'SubfileType', 256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample', 259: 'Compression',
  262: 'PhotometricInterpretation', 263: 'Threshholding', 266: 'FillOrder', 269: 'DocumentName', 270: 'ImageDescription', 271: 'Make', 272: 'Model',
  273: 'StripOffsets', 274: 'Orientation', 277: 'SamplesPerPixel', 278: 'RowsPerStrip', 279: 'StripByteCounts', 280: 'MinSampleValue',
  281: 'MaxSampleValue', 282: 'XResolution', 283: 'YResolution', 284: 'PlanarConfiguration', 285: 'PageName', 286: 'XPosition', 287: 'YPosition',
  292: 'T4Options', 293: 'T6Options', 296: 'ResolutionUnit', 297: 'PageNumber', 305: 'Software', 306: 'DateTime', 315: 'Artist', 316: 'HostComputer',
  317: 'Predictor', 318: 'WhitePoint', 319: 'PrimaryChromaticities', 320: 'ColorMap', 322: 'TileWidth', 323: 'TileLength', 324: 'TileOffsets',
  325: 'TileByteCounts', 330: 'SubIFDs', 338: 'ExtraSamples', 339: 'SampleFormat', 340: 'SMinSampleValue', 341: 'SMaxSampleValue',
  347: 'JPEGTables', 529: 'YCbCrCoefficients', 530: 'YCbCrSubSampling', 531: 'YCbCrPositioning', 532: 'ReferenceBlackWhite', 700: 'XMP',
  32997: 'ImageDepth', 33432: 'Copyright', 33550: 'ModelPixelScale', 33723: 'IPTC', 33922: 'ModelTiepoint', 34264: 'ModelTransformation',
  34377: 'Photoshop', 34665: 'ExifIFD', 34675: 'ICCProfile', 34735: 'GeoKeyDirectory', 34736: 'GeoDoubleParams', 34737: 'GeoAsciiParams',
  34853: 'GPSIFD', 42112: 'GDAL_METADATA', 42113: 'GDAL_NODATA', 50706: 'DNGVersion', 50838: 'ImageJMetaDataByteCounts', 50839: 'ImageJMetaData',
};

const COMPRESSION = { 1: 'None', 2: 'CCITT RLE', 3: 'CCITT Group 3', 4: 'CCITT Group 4', 5: 'LZW', 6: 'JPEG (old)', 7: 'JPEG', 8: 'Deflate', 32946: 'Deflate',
  32773: 'PackBits', 34712: 'JPEG 2000', 34887: 'LERC', 34925: 'LZMA', 50000: 'ZSTD', 50001: 'WebP', 50002: 'JPEG XL', 34676: 'SGI LogLuv' };
const SUPPORTED_COMPRESSION = new Set([1, 2, 3, 4, 5, 6, 7, 8, 32946, 32773]);
const PHOTOMETRIC = { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 4: 'Mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab', 32844: 'LogL', 32845: 'LogLuv' };
const SAMPLE_FORMAT = { 1: 'uint', 2: 'int', 3: 'float', 4: 'void' };

const GEOKEY_NAMES = {
  1024: 'GTModelType', 1025: 'GTRasterType', 1026: 'GTCitation', 2048: 'GeographicType', 2049: 'GeogCitation', 2050: 'GeogGeodeticDatum',
  2051: 'GeogPrimeMeridian', 2052: 'GeogLinearUnits', 2054: 'GeogAngularUnits', 2056: 'GeogEllipsoid', 2057: 'GeogSemiMajorAxis',
  2058: 'GeogSemiMinorAxis', 2059: 'GeogInvFlattening', 3072: 'ProjectedCSType', 3073: 'PCSCitation', 3074: 'Projection', 3075: 'ProjCoordTrans',
  3076: 'ProjLinearUnits', 3078: 'ProjStdParallel1', 3079: 'ProjStdParallel2', 3080: 'ProjNatOriginLong', 3081: 'ProjNatOriginLat',
  3082: 'ProjFalseEasting', 3083: 'ProjFalseNorthing', 3088: 'ProjCenterLong', 3089: 'ProjCenterLat', 3092: 'ProjScaleAtNatOrigin',
  4096: 'VerticalCSType', 4097: 'VerticalCitation', 4098: 'VerticalDatum', 4099: 'VerticalUnits',
};
const MODEL_TYPE = { 1: 'Projected', 2: 'Geographic', 3: 'Geocentric' };
const RASTER_TYPE = { 1: 'PixelIsArea', 2: 'PixelIsPoint' };
const LINEAR_UNITS = { 9001: 'metre', 9002: 'foot', 9003: 'US survey foot' };
const ANGULAR_UNITS = { 9101: 'radian', 9102: 'degree' };

class BufferReader {
  constructor(bytes) { this.u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this.size = this.u8.length; }
  async read(offset, length) { const o = Math.max(0, Math.min(offset, this.size)); return this.u8.subarray(o, Math.min(this.size, o + Math.max(0, length))); }
}

function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

function readValues(dv, type, count, le, at) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = at + i * TYPE_SIZE[type];
    switch (type) {
      case 1: case 7: out[i] = dv.getUint8(o); break;
      case 6: out[i] = dv.getInt8(o); break;
      case 3: out[i] = dv.getUint16(o, le); break;
      case 8: out[i] = dv.getInt16(o, le); break;
      case 4: case 13: out[i] = dv.getUint32(o, le); break;
      case 9: out[i] = dv.getInt32(o, le); break;
      case 5: { const n = dv.getUint32(o, le), d = dv.getUint32(o + 4, le); out[i] = d ? n / d : 0; break; }
      case 10: { const n = dv.getInt32(o, le), d = dv.getInt32(o + 4, le); out[i] = d ? n / d : 0; break; }
      case 11: out[i] = dv.getFloat32(o, le); break;
      case 12: out[i] = dv.getFloat64(o, le); break;
      case 16: case 18: out[i] = Number(dv.getBigUint64(o, le)); break;
      case 17: out[i] = Number(dv.getBigInt64(o, le)); break;
      default: out[i] = 0;
    }
  }
  return out;
}

function decodeAscii(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s.replace(/\0+$/, '').replace(/\0/g, '\n');
}

/**
 * Reads the header and every top-level directory (page).
 * opts.maxValues: values kept per tag (default all, which the decoder needs). The count is always kept.
 * Returns { le, big, pages: [{ offset, tags: Map<tag, {type, count, values|text, truncated}> }], problems: [] }.
 */
async function parseTiff(src, opts = {}) {
  const maxValues = opts.maxValues || Infinity;
  const maxPages = opts.maxPages || MAX_PAGES;
  const problems = [];
  const head = await src.read(0, 16);
  if (head.length < 8) throw new Error('This file is too short to be a TIFF image.');
  const order = String.fromCharCode(head[0], head[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('This is not a TIFF file: it does not start with II or MM.');
  const le = order === 'II';
  const hv = view(head);
  const magic = hv.getUint16(2, le);
  let big = false, first;
  if (magic === 42) first = hv.getUint32(4, le);
  else if (magic === 43) {
    if (head.length < 16) throw new Error('This BigTIFF file is cut short.');
    big = true;
    if (hv.getUint16(4, le) !== 8) problems.push('Unusual BigTIFF offset size.');
    first = Number(hv.getBigUint64(8, le));
  } else throw new Error(`This is not a TIFF file (version number ${magic}, expected 42 or 43).`);

  const pages = [];
  const seen = new Set();
  let next = first;
  while (next && pages.length < maxPages) {
    if (seen.has(next)) { problems.push('The page chain loops back on itself; stopped there.'); break; }
    seen.add(next);
    if (next >= src.size) { problems.push(`Page ${pages.length + 1} points past the end of the file.`); break; }
    const ifd = await readIfd(src, next, le, big, maxValues, problems);
    if (!ifd) break;
    pages.push({ offset: next, tags: ifd.tags });
    next = ifd.next;
  }
  if (next && pages.length >= maxPages) problems.push(`Only the first ${maxPages} pages are listed.`);
  return { le, big, size: src.size, pages, problems };
}

async function readIfd(src, offset, le, big, maxValues, problems) {
  const cntSize = big ? 8 : 2, entSize = big ? 20 : 12, ptrSize = big ? 8 : 4;
  const cb = await src.read(offset, cntSize);
  if (cb.length < cntSize) { problems.push('A page directory is cut short.'); return null; }
  let n = big ? Number(view(cb).getBigUint64(0, le)) : view(cb).getUint16(0, le);
  if (n > MAX_TAGS) { problems.push(`A page directory claims ${n} tags; read the first ${MAX_TAGS}.`); n = MAX_TAGS; }
  const body = await src.read(offset + cntSize, n * entSize + ptrSize);
  if (body.length < n * entSize) { problems.push('A page directory is cut short.'); n = Math.floor(body.length / entSize); }
  const dv = view(body);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const e = i * entSize;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le);
    const count = big ? Number(dv.getBigUint64(e + 4, le)) : dv.getUint32(e + 4, le);
    const size = TYPE_SIZE[type];
    if (!size) { tags.set(tag, { type, count, values: [], unknownType: true }); continue; }
    const total = size * count;
    const inline = total <= ptrSize;
    const take = type === 2 ? Math.min(count, 1 << 20) : Math.min(count, maxValues);
    let u8, at = 0;
    if (inline) { u8 = body; at = e + (big ? 12 : 8); }
    else {
      const ptr = big ? Number(dv.getBigUint64(e + 12, le)) : dv.getUint32(e + 8, le);
      if (ptr + total > src.size) problems.push(`Tag ${TAG_NAMES[tag] || tag} points past the end of the file.`);
      u8 = await src.read(ptr, take * size);
    }
    const avail = Math.min(take, Math.floor((u8.length - at) / size));
    const entry = { type, count, truncated: avail < count };
    if (type === 2) entry.text = decodeAscii(u8.subarray(at, at + avail));
    else entry.values = readValues(view(u8), type, avail, le, at);
    tags.set(tag, entry);
  }
  const np = n * entSize;
  let next = 0;
  if (body.length >= np + ptrSize) next = big ? Number(dv.getBigUint64(np, le)) : dv.getUint32(np, le);
  return { tags, next };
}

const first = (tags, t, d) => { const e = tags.get(t); return e && e.values && e.values.length ? e.values[0] : d; };
const all = (tags, t) => { const e = tags.get(t); return e && e.values ? e.values : null; };

/** Plain facts about one page that the viewer and the decoder need. */
function pageInfo(tags) {
  const bpsArr = all(tags, 258) || [1];
  const spp = first(tags, 277, bpsArr.length || 1);
  const fmt = first(tags, 339, 1);
  const cmp = first(tags, 259, 1);
  const tiled = tags.has(322);
  const info = {
    width: first(tags, 256, 0), height: first(tags, 257, 0), spp, bps: bpsArr[0], bpsAll: bpsArr,
    format: SAMPLE_FORMAT[fmt] || 'uint', compression: cmp, compressionName: COMPRESSION[cmp] || `code ${cmp}`,
    photometric: first(tags, 262, spp >= 3 ? 2 : 1), planar: first(tags, 284, 1), predictor: first(tags, 317, 1),
    tiled, tileWidth: first(tags, 322, 0), tileHeight: first(tags, 323, 0), rowsPerStrip: first(tags, 278, 0),
    extraSamples: all(tags, 338) || [], subfile: first(tags, 254, 0), pageName: tags.has(285) ? tags.get(285).text : '',
    description: tags.has(270) ? tags.get(270).text : '',
  };
  info.photometricName = PHOTOMETRIC[info.photometric] || `code ${info.photometric}`;
  info.reduced = (info.subfile & 1) === 1;
  info.problem = decodeProblem(info);
  return info;
}

/** Why a page cannot be decoded, or '' when it can. */
function decodeProblem(p) {
  if (!p.width || !p.height) return 'This page has no width or height.';
  if (!SUPPORTED_COMPRESSION.has(p.compression)) return `Compression ${p.compressionName} is not supported. Supported are none, LZW, Deflate, PackBits, JPEG and CCITT fax.`;
  if (![1, 2, 4, 8, 16, 32, 64].includes(p.bps)) return `${p.bps}-bit samples are not supported.`;
  if (p.bpsAll.some(b => b !== p.bps)) return 'Samples with different bit depths in one pixel are not supported.';
  if (p.format === 'float' && ![16, 32, 64].includes(p.bps)) return `${p.bps}-bit float samples are not supported.`;
  if (p.format === 'void') return 'This page stores samples of an undefined type.';
  if (p.spp < 1 || p.spp > 64) return `${p.spp} samples per pixel is not supported.`;
  if ([32844, 32845, 8].includes(p.photometric)) return `Photometric ${p.photometricName} is not supported.`;
  if (p.photometric === 6 && p.compression !== 7 && p.compression !== 6) return 'Uncompressed YCbCr pages are not supported.';
  if (p.photometric === 3 && (p.spp !== 1 || p.bps > 16)) return 'This palette page has an unusual layout and is not supported.';
  return '';
}

/** Display rows [name, value] for every tag, with long arrays cut. */
function tagRows(tags, maxChars = 400) {
  const rows = [];
  for (const [tag, e] of [...tags.entries()].sort((a, b) => a[0] - b[0])) {
    const name = TAG_NAMES[tag] || `Tag ${tag}`;
    let v;
    if (e.unknownType) v = `(unknown type ${e.type}, ${e.count} values)`;
    else if (e.text !== undefined) v = e.text;
    else if ([700, 33723, 34377, 34675, 347].includes(tag)) v = `(${e.count} bytes)`;
    else {
      const shown = e.values.slice(0, 32).map(fmtNum);
      v = shown.join(', ');
      if (e.count > shown.length) v += ` … (${e.count} values)`;
      if (tag === 259) v += ` (${COMPRESSION[e.values[0]] || 'unknown'})`;
      if (tag === 262) v += ` (${PHOTOMETRIC[e.values[0]] || 'unknown'})`;
      if (tag === 339) v += ` (${e.values.map(x => SAMPLE_FORMAT[x] || '?').join(', ')})`;
    }
    if (v.length > maxChars) v = v.slice(0, maxChars) + ` … (${v.length} characters)`;
    rows.push([name, v, tag]);
  }
  return rows;
}

function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  return a !== 0 && (a < 1e-4 || a >= 1e9) ? x.toExponential(6) : String(Math.round(x * 1e9) / 1e9);
}

/** GeoTIFF facts, or null when the page has no GeoTIFF tags. */
function geoInfo(tags, width, height) {
  const scale = all(tags, 33550), tie = all(tags, 33922), xform = all(tags, 34264), dir = all(tags, 34735);
  const nodataTag = tags.get(42113);
  if (!scale && !tie && !xform && !dir) return null;
  const g = { keys: [], scale, tiepoint: tie, transform: xform, epsg: null, nodata: null, bounds: null, units: '' };
  if (nodataTag && nodataTag.text !== undefined) { const v = parseFloat(nodataTag.text); g.nodata = Number.isNaN(v) ? null : v; g.nodataText = nodataTag.text.trim(); }
  const dbl = all(tags, 34736) || [];
  const asc = tags.has(34737) ? tags.get(34737).text : '';
  if (dir && dir.length >= 4) {
    const n = Math.min(dir[3], (dir.length - 4) / 4);
    for (let i = 0; i < n; i++) {
      const [id, loc, cnt, off] = dir.slice(4 + i * 4, 8 + i * 4);
      let val;
      if (loc === 0) val = off;
      else if (loc === 34736) val = dbl.slice(off, off + cnt).map(fmtNum).join(', ');
      else if (loc === 34737) val = asc.slice(off, off + cnt).replace(/\|$/, '');
      else val = `(in tag ${loc})`;
      let label = String(val);
      if (id === 1024) label = `${val} (${MODEL_TYPE[val] || 'user defined'})`;
      if (id === 1025) label = `${val} (${RASTER_TYPE[val] || 'user defined'})`;
      if ((id === 3076 || id === 2052 || id === 4099) && LINEAR_UNITS[val]) label = `${val} (${LINEAR_UNITS[val]})`;
      if (id === 2054 && ANGULAR_UNITS[val]) label = `${val} (${ANGULAR_UNITS[val]})`;
      if ((id === 3072 || id === 2048) && typeof val === 'number' && val > 1000 && val < 32767) label = `EPSG:${val}`;
      if (id === 3076 && LINEAR_UNITS[val]) g.units = LINEAR_UNITS[val];
      if (id === 2054 && ANGULAR_UNITS[val] && !g.units) g.units = ANGULAR_UNITS[val];
      g.keys.push([GEOKEY_NAMES[id] || `GeoKey ${id}`, label]);
    }
    const proj = g.keys.find(k => k[0] === 'ProjectedCSType');
    const geog = g.keys.find(k => k[0] === 'GeographicType');
    const pick = proj && /^EPSG:/.test(proj[1]) ? proj : geog && /^EPSG:/.test(geog[1]) ? geog : null;
    g.epsg = pick ? Number(pick[1].slice(5)) : null;
  }
  const a = affine(g);
  if (a && width && height) {
    const pts = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => applyAffine(a, x, y));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    g.bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    g.pixelSize = scale ? [scale[0], scale[1]] : null;
  }
  g.affine = a;
  return g;
}

/** Pixel (x, y) to model coordinates: [a, b, c, d, e, f] with X = a*x + b*y + c, Y = d*x + e*y + f. */
function affine(g) {
  if (g.transform && g.transform.length >= 16) { const m = g.transform; return [m[0], m[1], m[3], m[4], m[5], m[7]]; }
  if (g.scale && g.scale.length >= 2 && g.tiepoint && g.tiepoint.length >= 6) {
    const [i, j, , X, Y] = g.tiepoint, sx = g.scale[0], sy = g.scale[1];
    return [sx, 0, X - i * sx, 0, -sy, Y + j * sy];
  }
  return null;
}
function applyAffine(a, x, y) { return [a[0] * x + a[1] * y + a[2], a[3] * x + a[4] * y + a[5]]; }

module.exports = {
  parseTiff, pageInfo, tagRows, geoInfo, applyAffine, decodeProblem, fmtNum, BufferReader,
  TAG_NAMES, COMPRESSION, PHOTOMETRIC, SAMPLE_FORMAT, SUPPORTED_COMPRESSION,
};
