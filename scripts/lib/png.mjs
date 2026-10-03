// Minimal PNG decoder — just enough for Chromium screenshots.
//
// Chromium emits 8-bit non-interlaced RGBA (colour type 6) or RGB (type 2),
// so those are the only cases handled. Anything else throws loudly rather
// than silently producing garbage pixels.
import zlib from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // len + type + data + crc
  }

  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.allocUnsafe(width * height * 3);

  let prev = Buffer.alloc(stride);
  let rp = 0, op = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;

    // undo the per-scanline filter (PNG spec §9.2)
    switch (filter) {
      case 0: break;
      case 1:
        for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? line[i - channels] : 0;
          line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? line[i - channels] : 0;
          const b = prev[i];
          const c = i >= channels ? prev[i - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          line[i] = (line[i] + pred) & 0xff;
        }
        break;
      default:
        throw new Error(`bad PNG filter ${filter}`);
    }

    // drop alpha; screenshots are already composited against the page
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      out[op++] = line[s];
      out[op++] = line[s + 1];
      out[op++] = line[s + 2];
    }
    prev = line;
  }

  return { width, height, data: out };
}

/**
 * Box-filter downscale. Averaging rather than nearest-neighbour matters a
 * lot here: text in a UI screenshot shrunk by nearest-neighbour turns into
 * speckle, while averaging keeps it legible as grey mass.
 */
export function resize(img, dw, dh) {
  const { width: sw, height: sh, data: src } = img;
  const out = Buffer.allocUnsafe(dw * dh * 3);

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));

    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));

      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * sw + x0) * 3;
        for (let xx = x0; xx < x1; xx++) {
          r += src[p++]; g += src[p++]; b += src[p++];
          n++;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
    }
  }
  return { width: dw, height: dh, data: out };
}
