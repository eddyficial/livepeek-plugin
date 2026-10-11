// QR encoder for short URLs and pairing payloads without making the terminal
// path depend on a package install. The tables stop at version 10 because the
// resulting 57-module symbol is already wider than most useful terminal panes.

const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Each triple is count, total codewords, data codewords. Keeping the block
// layout explicit avoids a surprisingly large dependency for only ten versions.
const RS_BLOCKS = {
  L: [
    null, [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
    [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116], [2, 86, 68, 2, 87, 69],
  ],
  M: [
    null, [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
    [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37],
    [4, 69, 43, 1, 70, 44],
  ],
  Q: [
    null, [1, 26, 13], [1, 44, 22], [2, 35, 17], [2, 50, 24], [2, 33, 15, 2, 34, 16],
    [4, 43, 19], [2, 32, 14, 4, 33, 15], [4, 40, 18, 2, 41, 19],
    [4, 36, 16, 4, 37, 17], [6, 43, 19, 2, 44, 20],
  ],
  H: [
    null, [1, 26, 9], [1, 44, 16], [2, 35, 13], [4, 25, 9], [2, 33, 11, 2, 34, 12],
    [4, 43, 15], [4, 39, 13, 1, 40, 14], [4, 40, 14, 2, 41, 15],
    [4, 36, 12, 4, 37, 13], [6, 43, 15, 2, 44, 16],
  ],
};

function blocksFor(version, ecl) {
  const row = RS_BLOCKS[ecl][version];
  const blocks = [];
  for (let i = 0; i < row.length; i += 3) {
    for (let n = 0; n < row[i]; n++) blocks.push({ total: row[i + 1], data: row[i + 2] });
  }
  return blocks;
}

function appendBits(out, value, length) {
  for (let i = length - 1; i >= 0; i--) out.push(((value >>> i) & 1) !== 0);
}

function dataCodewords(bytes, version, ecl) {
  const capacity = blocksFor(version, ecl).reduce((n, b) => n + b.data, 0) * 8;
  const bits = [];
  // QR's byte mode carries bytes rather than characters. UTF-8 keeps the API
  // deterministic while remaining compatible with terminal-oriented decoders,
  // several of which reject otherwise valid ECI segments.
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);
  if (bits.length > capacity) return null;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(false);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | +bits[i + j];
    out.push(byte);
  }
  for (let pad = 0; out.length * 8 < capacity; pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return out;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root) ^ (j + 1 < degree ? result[j + 1] : 0);
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return Array.from(result);
}

function interleave(data, version, ecl) {
  const specs = blocksFor(version, ecl);
  const dataBlocks = [], eccBlocks = [];
  let offset = 0;
  for (const spec of specs) {
    const block = data.slice(offset, offset + spec.data);
    offset += spec.data;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, spec.total - spec.data));
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < eccBlocks[0].length; i++) for (const block of eccBlocks) out.push(block[i]);
  return out;
}

function bchRemainder(value, polynomial) {
  const top = 31 - Math.clz32(polynomial);
  while (value && 31 - Math.clz32(value) >= top) value ^= polynomial << (31 - Math.clz32(value) - top);
  return value;
}

function drawFinder(set, cx, cy, size) {
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x >= 0 && y >= 0 && x < size && y < size) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawFormat(set, size, ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  const bits = ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
  const bit = i => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawVersion(set, size, version) {
  if (version < 7) return;
  const bits = (version << 12) | bchRemainder(version << 12, 0x1f25);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3), b = Math.floor(i / 3);
    set(a, b, dark); set(b, a, dark);
  }
}

function functionPattern(version, ecl) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };
  drawFinder(set, 3, 3, size);
  drawFinder(set, size - 4, 3, size);
  drawFinder(set, 3, size - 4, size);
  for (const y of ALIGNMENT[version]) for (const x of ALIGNMENT[version]) {
    if (reserved[y][x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  for (let i = 0; i < size; i++) {
    if (!reserved[i][6]) set(6, i, i % 2 === 0);
    if (!reserved[6][i]) set(i, 6, i % 2 === 0);
  }
  drawFormat(set, size, ecl, 0);
  drawVersion(set, size, version);
  return { size, modules, reserved };
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

function placeData(base, codewords, ecl, mask) {
  const { size, reserved } = base;
  const modules = base.modules.map(row => row.slice());
  let bitIndex = 0, upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        const bit = bitIndex < codewords.length * 8 && ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        modules[y][x] = bit !== maskBit(mask, x, y);
        bitIndex++;
      }
    }
    upward = !upward;
  }
  const set = (x, y, dark) => { modules[y][x] = dark; };
  drawFormat(set, size, ecl, mask);
  drawVersion(set, size, Math.floor((size - 17) / 4));
  return modules;
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const linePenalty = line => {
    let result = 0, run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) result += run - 2; run = 1; }
    }
    if (run >= 5) result += run - 2;
    for (let i = 0; i <= size - 11; i++) {
      const s = line.slice(i, i + 11).map(Number).join('');
      if (s === '10111010000' || s === '00001011101') result += 40;
    }
    return result;
  };
  for (let y = 0; y < size; y++) score += linePenalty(modules[y]);
  for (let x = 0; x < size; x++) score += linePenalty(modules.map(row => row[x]));
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) score += 3;
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/**
 * Returns the bare symbol so terminal and image renderers can choose their own
 * scale and quiet zone. Modules are row-major booleans; true is dark.
 */
export function qrMatrix(text, { ecl = 'M' } = {}) {
  if (typeof text !== 'string') throw new TypeError('QR text must be a string');
  ecl = String(ecl).toUpperCase();
  if (!(ecl in ECL_BITS)) throw new Error(`Unsupported QR error correction level: ${ecl}`);
  const bytes = new TextEncoder().encode(text);
  let version, data;
  for (version = 1; version <= 10; version++) {
    data = dataCodewords(bytes, version, ecl);
    if (data) break;
  }
  if (!data) throw new Error(`QR payload is too large for versions 1-10 at error correction level ${ecl}`);
  const base = functionPattern(version, ecl);
  const codewords = interleave(data, version, ecl);
  let modules, best = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = placeData(base, codewords, ecl, mask);
    const score = penalty(candidate);
    if (score < best) { best = score; modules = candidate; }
  }
  return { size: base.size, modules };
}

/**
 * Draws dark modules with foreground block glyphs, allowing callers to paint a
 * black foreground on a white background. Two modules of quiet zone are kept
 * here because terminal width is scarcer than the four modules used for print.
 */
export function qrHalfBlocks(text, opts) {
  const { size, modules } = qrMatrix(text, opts);
  const quiet = 2, width = size + quiet * 2;
  const rows = [];
  const dark = (x, y) => x >= quiet && x < width - quiet && y >= quiet && y < width - quiet && modules[y - quiet][x - quiet];
  for (let y = 0; y < width; y += 2) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = dark(x, y), bottom = dark(x, y + 1);
      row += top ? (bottom ? '\u2588' : '\u2580') : (bottom ? '\u2584' : ' ');
    }
    rows.push(row);
  }
  return rows;
}
