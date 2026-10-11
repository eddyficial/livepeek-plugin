// Tiny animated-GIF writer: PNG files in, looping GIF89a out. No dependencies.
//
// Exists so the README demo can be built from the plain PNG snapshots the pane
// already produces. Every frame shares one global palette, which keeps the file
// small and stops colours flickering between frames.
//
// Usage: node test/tools/gif.mjs out.gif a.png b.png ... [--delay 120] [--width 800]
//   --delay is milliseconds per frame (GIF stores 1/100 s), --width downscales.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodePng, resize } from '../../scripts/lib/png.mjs';

/**
 * Build one palette (<= 256 colours) for all frames. Same idea as the sixel
 * quantiser: count 5-bit-per-channel buckets, keep the most common ones, and
 * map everything else to its nearest survivor (memoised).
 */
function quantiseAll(frames) {
  const counts = new Map();
  for (const { data } of frames) {
    for (let i = 0; i < data.length; i += 3) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256)
    .map(([k]) => [((k >> 10) & 31) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3]);

  const cache = new Map();
  const nearest = (key) => {
    let idx = cache.get(key);
    if (idx !== undefined) return idx;
    const r = ((key >> 10) & 31) << 3, g = ((key >> 5) & 31) << 3, b = (key & 31) << 3;
    let bestD = Infinity; idx = 0;
    palette.forEach((p, i) => {
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bestD) { bestD = d; idx = i; }
    });
    cache.set(key, idx);
    return idx;
  };

  const indexed = frames.map(({ data }) => {
    const out = new Uint8Array(data.length / 3);
    for (let i = 0, p = 0; i < data.length; i += 3, p++) {
      out[p] = nearest(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
    }
    return out;
  });
  return { palette, indexed };
}

/**
 * GIF flavour of LZW with 8-bit symbols. Codes 256 and 257 are "clear" and
 * "end of data"; new dictionary entries start at 258. Code width starts at 9
 * bits and grows to 12, and the table is reset with a clear code once full.
 */
function lzw(pixels) {
  const CLEAR = 256, EOI = 257;
  const bytes = [];
  let acc = 0, nbits = 0, size = 9;
  const emit = (code) => {            // pack codes least-significant bit first
    acc |= code << nbits; nbits += size;
    while (nbits >= 8) { bytes.push(acc & 0xff); acc >>>= 8; nbits -= 8; }
  };

  let dict = new Map(), next = 258;
  emit(CLEAR);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const key = (prefix << 8) | pixels[i];
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // the decoder runs one entry behind us, so widen one step late
      if (next > (1 << size) && size < 12) size++;
    } else {                          // table full: start over
      emit(CLEAR); dict = new Map(); next = 258; size = 9;
    }
    prefix = pixels[i];
  }
  emit(prefix);
  emit(EOI);
  if (nbits > 0) bytes.push(acc & 0xff);
  return bytes;
}

/** Wrap bytes in GIF sub-blocks: a length byte (max 255) then data, 0 to end. */
function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const part = bytes.slice(i, i + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

export function encodeGif(frames, delayMs = 120) {
  const { width: w, height: h } = frames[0];
  const { palette, indexed } = quantiseAll(frames);
  const u16 = (n) => [n & 0xff, n >> 8];
  const out = [...Buffer.from('GIF89a'), ...u16(w), ...u16(h), 0xf7, 0, 0]; // 256-entry global table

  for (let i = 0; i < 256; i++) out.push(...(palette[i] || [0, 0, 0]));

  // NETSCAPE2.0 extension: loop count 0 means forever
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);

  for (const px of indexed) {
    // graphic control: delay in 1/100 s, no transparency, leave frame in place
    out.push(0x21, 0xf9, 4, 0x04, ...u16(Math.max(1, Math.round(delayMs / 10))), 0, 0);
    out.push(0x2c, ...u16(0), ...u16(0), ...u16(w), ...u16(h), 0); // image descriptor
    out.push(8, ...subBlocks(lzw(px)));                            // min code size 8
  }
  out.push(0x3b);                                                  // trailer
  return Buffer.from(out);
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), files = [];
  let delay = 120, width = 800;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay') delay = Number(args[++i]);
    else if (args[i] === '--width') width = Number(args[++i]);
    else files.push(args[i]);
  }
  const [outPath, ...pngs] = files;
  if (!outPath || !pngs.length) {
    console.error('usage: node gif.mjs out.gif a.png b.png ... [--delay 120] [--width 800]');
    process.exit(1);
  }
  // scale every frame to the first frame's shape so the canvas is consistent
  // Frames can have different shapes (a desktop page, then a phone). Fit each
  // one inside a common canvas on a dark matte rather than stretching it.
  const decoded = pngs.map((f) => decodePng(readFileSync(f)));
  const w = Math.min(width, Math.max(...decoded.map(d => d.width)));
  // a tall phone frame must not set the canvas height for everyone; cap it
  // so portrait frames shrink to fit beside landscape ones
  const h = Math.min(Math.round(w * 0.7), Math.max(...decoded.map(d => Math.round(d.height * Math.min(1, w / d.width)))));
  const frames = decoded.map((d) => {
    const s = Math.min(w / d.width, h / d.height);
    const fw = Math.max(1, Math.round(d.width * s)), fh = Math.max(1, Math.round(d.height * s));
    const fit = resize(d, fw, fh);
    const data = Buffer.alloc(w * h * 3);
    for (let i = 0; i < data.length; i += 3) { data[i] = 15; data[i + 1] = 18; data[i + 2] = 32; }
    const ox = (w - fw) >> 1, oy = (h - fh) >> 1;
    for (let y = 0; y < fh; y++) fit.data.copy(data, ((y + oy) * w + ox) * 3, y * fw * 3, (y + 1) * fw * 3);
    return { width: w, height: h, data };
  });
  writeFileSync(outPath, encodeGif(frames, delay));
  console.log(`wrote ${outPath}: ${frames.length} frames, ${w}x${h}`);
}
