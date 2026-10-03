// Sixel encoder (DEC VT340 graphics), plus a half-block fallback for
// terminals without sixel support.
//
// Sixel packs six vertical pixels of one column into a single character, so
// the image is emitted in horizontal bands of six rows. Within a band each
// colour gets its own pass over the row, separated by '$' (carriage return);
// '-' ends the band.

const ESC = '\x1b';

/**
 * Quantise to at most `max` colours.
 *
 * UI screenshots are mostly large flat regions, so a frequency histogram over
 * 5-bit-per-channel buckets captures almost everything exactly; the nearest-
 * colour search only runs for the rare leftover shades, and is memoised.
 */
function quantise(img, max = 128) {
  const { data } = img;
  const counts = new Map();

  for (let i = 0; i < data.length; i += 3) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => [
      ((key >> 10) & 31) << 3,
      ((key >> 5) & 31) << 3,
      (key & 31) << 3,
    ]);

  if (!palette.length) palette.push([0, 0, 0]);

  const cache = new Map();
  const lookup = (key) => {
    let idx = cache.get(key);
    if (idx !== undefined) return idx;

    const r = ((key >> 10) & 31) << 3;
    const g = ((key >> 5) & 31) << 3;
    const b = (key & 31) << 3;

    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };

  // index every pixel once
  const indexed = new Uint8Array(data.length / 3);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    indexed[p] = lookup(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
  }

  return { palette, indexed };
}

export function toSixel(img, maxColors = 128) {
  const { width: w, height: h } = img;
  const { palette, indexed } = quantise(img, maxColors);

  // P1=9 asks for square pixels. Left out, some terminals (Windows Terminal
  // among them) assume the DEC default of 2:1 and draw every row twice as tall.
  const out = [`${ESC}P9;0;0q"1;1;${w};${h}`];

  // sixel colour registers are 0-100 per channel, not 0-255
  palette.forEach((c, i) => {
    out.push(`#${i};2;${Math.round(c[0] * 100 / 255)};${Math.round(c[1] * 100 / 255)};${Math.round(c[2] * 100 / 255)}`);
  });

  const bands = Math.ceil(h / 6);
  const row = new Uint8Array(w);

  for (let band = 0; band < bands; band++) {
    const y0 = band * 6;
    const rows = Math.min(6, h - y0);

    // which colours actually appear in this band
    const present = new Set();
    for (let dy = 0; dy < rows; dy++) {
      const base = (y0 + dy) * w;
      for (let x = 0; x < w; x++) present.add(indexed[base + x]);
    }

    let first = true;
    for (const colour of present) {
      if (!first) out.push('$');
      first = false;
      out.push(`#${colour}`);

      // build this colour's six-bit column mask across the row
      row.fill(0);
      for (let dy = 0; dy < rows; dy++) {
        const base = (y0 + dy) * w;
        const bit = 1 << dy;
        for (let x = 0; x < w; x++) {
          if (indexed[base + x] === colour) row[x] |= bit;
        }
      }

      // run-length encode: a flat UI compresses enormously here
      let runChar = -1, runLen = 0;
      const flush = () => {
        if (runLen === 0) return;
        const ch = String.fromCharCode(0x3f + runChar);
        out.push(runLen > 3 ? `!${runLen}${ch}` : ch.repeat(runLen));
        runLen = 0;
      };
      for (let x = 0; x < w; x++) {
        if (row[x] === runChar) { runLen++; }
        else { flush(); runChar = row[x]; runLen = 1; }
      }
      flush();
    }
    out.push('-');
  }

  out.push(`${ESC}\\`);
  return out.join('');
}

/**
 * Fallback for terminals without sixel: one character cell carries two
 * vertically stacked pixels via the upper-half block, foreground = top pixel,
 * background = bottom. Needs truecolor, which every modern terminal has.
 */
export function toHalfBlocks(img) {
  const { width: w, height: h, data } = img;
  const lines = [];

  for (let y = 0; y < h; y += 2) {
    let line = '';
    let lastTop = -1, lastBot = -1;
    for (let x = 0; x < w; x++) {
      const t = (y * w + x) * 3;
      const b = ((y + 1 < h ? y + 1 : y) * w + x) * 3;
      const tk = (data[t] << 16) | (data[t + 1] << 8) | data[t + 2];
      const bk = (data[b] << 16) | (data[b + 1] << 8) | data[b + 2];

      if (tk !== lastTop) { line += `${ESC}[38;2;${data[t]};${data[t + 1]};${data[t + 2]}m`; lastTop = tk; }
      if (bk !== lastBot) { line += `${ESC}[48;2;${data[b]};${data[b + 1]};${data[b + 2]}m`; lastBot = bk; }
      line += '▀';
    }
    lines.push(line + `${ESC}[0m`);
  }
  return lines;
}
