// Prusa binary G-code (.bgcode) decoder.
// Written from the public format spec (libbgcode/doc/specifications.md).
// Supports: no compression, Deflate, Heatshrink 11/4 and 12/4,
// MeatPack and MeatPack-with-comments encodings, PNG/JPG thumbnails.

const MAGIC = 0x45444347; // "GCDE" little-endian

export const BlockType = {
  FileMetadata: 0,
  GCode: 1,
  SlicerMetadata: 2,
  PrinterMetadata: 3,
  PrintMetadata: 4,
  Thumbnail: 5,
};

export function isBgcode(bytes) {
  if (bytes.length < 10) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0, true) === MAGIC;
}

// ---------------------------------------------------------------------------
// Heatshrink (LZSS). Bits are read MSB first. Tag bit 1 = literal byte,
// 0 = back-reference: index (window bits) then count (lookahead bits),
// both stored minus one. Window starts zero-filled.
export function heatshrinkDecode(src, windowBits, lookaheadBits, outSize) {
  const out = new Uint8Array(outSize);
  let o = 0;
  let pos = 0; // byte position
  let bit = 0x80; // current bit mask
  const total = src.length;

  function getBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= total) return -1;
      v = (v << 1) | ((src[pos] & bit) ? 1 : 0);
      bit >>= 1;
      if (bit === 0) { bit = 0x80; pos++; }
    }
    return v;
  }

  while (o < outSize) {
    const tag = getBits(1);
    if (tag < 0) break;
    if (tag === 1) {
      const b = getBits(8);
      if (b < 0) break;
      out[o++] = b;
    } else {
      const idx = getBits(windowBits);
      if (idx < 0) break;
      const cnt = getBits(lookaheadBits);
      if (cnt < 0) break;
      const offset = idx + 1;
      const count = cnt + 1;
      for (let i = 0; i < count && o < outSize; i++) {
        const from = o - offset;
        out[o++] = from >= 0 ? out[from] : 0;
      }
    }
  }
  return o === outSize ? out : out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// MeatPack. Mirrors libbgcode's unbinarize() so output matches the reference
// decoder byte-for-byte (including re-inserted spaces on G lines).
const SIGNAL = 0xff;
const CMD_ENABLE_PACKING = 251;
const CMD_DISABLE_PACKING = 250;
const CMD_RESET_ALL = 249;
const CMD_ENABLE_NO_SPACES = 247;
const CMD_DISABLE_NO_SPACES = 246;

const MP_TABLE = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 46, 32, 10, 71, 88]; // 0-9 . ' ' \n G X
const C_G = 71, C_NL = 10, C_SP = 32, C_E = 69;
// Parameters that get a space re-inserted in front of them on G lines.
const GLINE_PARAM = new Uint8Array(256);
for (const c of 'XYZEFIJRSGPWHCA') GLINE_PARAM[c.charCodeAt(0)] = 1;

export function meatpackDecode(src) {
  let unbinarizing = false;
  let nospace = false;
  let cmdActive = false;
  let cmdCount = 0;
  let fullCharQueue = 0;
  let charBuf = 0;

  let out = new Uint8Array(Math.max(64, src.length * 2));
  let n = 0;
  let addSpace = false;

  function push(c) {
    if (n + 2 >= out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    let newLine = false;
    if (c === C_G && (n === 0 || out[n - 1] === C_NL)) {
      addSpace = true;
      newLine = true;
    } else if (c === C_NL) {
      addSpace = false;
    }
    if (!newLine && addSpace && (n === 0 || out[n - 1] !== C_SP) && GLINE_PARAM[c]) {
      out[n++] = C_SP;
    }
    // collapse empty lines
    if (c !== C_NL || n === 0 || out[n - 1] !== C_NL) out[n++] = c;
  }

  function getChar(v) {
    if (v === 0b1011) return nospace ? C_E : C_SP;
    return MP_TABLE[v];
  }

  function rx(c) {
    if (!unbinarizing) { push(c); return; }
    if (fullCharQueue > 0) {
      push(c);
      if (charBuf > 0) { push(charBuf); charBuf = 0; }
      fullCharQueue--;
      return;
    }
    const lo = c & 0x0f;
    const hi = (c >> 4) & 0x0f;
    const firstLit = lo === 0x0f;
    const secondLit = hi === 0x0f;
    if (firstLit) {
      fullCharQueue++;
      if (secondLit) fullCharQueue++;
      else charBuf = getChar(hi);
    } else {
      const c0 = getChar(lo);
      push(c0);
      if (c0 !== C_NL) {
        if (secondLit) fullCharQueue++;
        else push(getChar(hi));
      }
    }
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === SIGNAL) {
      if (cmdCount > 0) { cmdActive = true; cmdCount = 0; }
      else cmdCount++;
      continue;
    }
    if (cmdActive) {
      switch (c) {
        case CMD_ENABLE_PACKING: unbinarizing = true; break;
        case CMD_DISABLE_PACKING: unbinarizing = false; break;
        case CMD_ENABLE_NO_SPACES: nospace = true; break;
        case CMD_DISABLE_NO_SPACES: nospace = false; break;
        case CMD_RESET_ALL: unbinarizing = false; break;
        default: break;
      }
      cmdActive = false;
      continue;
    }
    if (cmdCount > 0) { rx(SIGNAL); cmdCount = 0; }
    rx(c);
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------------------
async function inflate(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress Deflate blocks (DecompressionStream missing).');
  }
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(fmt);
      const stream = new Blob([data]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) { /* try next */ }
  }
  throw new Error('Deflate block could not be decompressed.');
}

async function decompress(type, data, uncompressedSize) {
  switch (type) {
    case 0: return data;
    case 1: return inflate(data);
    case 2: return heatshrinkDecode(data, 11, 4, uncompressedSize);
    case 3: return heatshrinkDecode(data, 12, 4, uncompressedSize);
    default: throw new Error(`Unknown compression type ${type}`);
  }
}

function parseIni(bytes) {
  const text = new TextDecoder().decode(bytes);
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Decode a .bgcode file.
 * @returns {Promise<{gcode: Uint8Array, metadata: object, thumbnails: Array}>}
 */
export async function decodeBgcode(bytes, onProgress) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a .bgcode file (bad magic number).');
  const version = dv.getUint32(4, true);
  if (version !== 1) console.warn(`bgcode version ${version}; attempting anyway`);
  const checksumType = dv.getUint16(8, true);
  const checksumSize = checksumType === 1 ? 4 : 0;

  let p = 10;
  const metadata = { file: {}, printer: {}, print: {}, slicer: {} };
  const thumbnails = [];
  const gcodeChunks = [];
  let gcodeLen = 0;

  while (p + 8 <= bytes.length) {
    const type = dv.getUint16(p, true);
    const compression = dv.getUint16(p + 2, true);
    const uncompressedSize = dv.getUint32(p + 4, true);
    let headerSize = 8;
    let dataSize = uncompressedSize;
    if (compression !== 0) {
      dataSize = dv.getUint32(p + 8, true);
      headerSize = 12;
    }
    const paramsSize = type === BlockType.Thumbnail ? 6 : 2;
    const paramsAt = p + headerSize;
    const dataAt = paramsAt + paramsSize;
    const end = dataAt + dataSize + checksumSize;
    if (end > bytes.length) throw new Error('Truncated .bgcode file.');
    const raw = bytes.subarray(dataAt, dataAt + dataSize);

    if (type === BlockType.GCode) {
      const encoding = dv.getUint16(paramsAt, true);
      let data = await decompress(compression, raw, uncompressedSize);
      if (encoding === 1 || encoding === 2) data = meatpackDecode(data);
      else data = data.slice();
      gcodeChunks.push(data);
      gcodeLen += data.length;
    } else if (type === BlockType.Thumbnail) {
      const format = dv.getUint16(paramsAt, true);
      const width = dv.getUint16(paramsAt + 2, true);
      const height = dv.getUint16(paramsAt + 4, true);
      const data = await decompress(compression, raw, uncompressedSize);
      thumbnails.push({ format: ['png', 'jpg', 'qoi'][format] || 'unknown', width, height, data: data.slice() });
    } else {
      const data = await decompress(compression, raw, uncompressedSize);
      const ini = parseIni(data);
      const key = { 0: 'file', 2: 'slicer', 3: 'printer', 4: 'print' }[type];
      if (key) Object.assign(metadata[key], ini);
    }
    p = end;
    if (onProgress) onProgress(p / bytes.length);
  }

  // Join gcode chunks. Each block ends on a line boundary.
  const gcode = new Uint8Array(gcodeLen);
  let o = 0;
  for (const c of gcodeChunks) { gcode.set(c, o); o += c.length; }
  return { gcode, metadata, thumbnails };
}
