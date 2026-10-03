// Frameless compositor: the viewport on a flat matte, no device body.
//
// What a web page or a game canvas is being built *as* is the viewport
// itself, so drawing a phone bezel around it would misrepresent the thing.
// This is the counterpart to composePhone - same inputs, same outputs, so
// the renderer can swap between them without knowing which it has.
//
// A single-pixel border is the only chrome: without it a page with a white
// background bleeds into a light terminal and you cannot see where the
// viewport ends.

/** Geometry for an unframed viewport - the body *is* the screen. */
export function bareGeometry(preset, landscape = false) {
  const w = landscape ? preset.h : preset.w;
  const h = landscape ? preset.w : preset.h;
  return {
    bodyW: w, bodyH: h, bodyR: 0,
    screenX: 0, screenY: 0, screenW: w, screenH: h, screenR: 0,
    frame: 'none',
  };
}

export function composeBare({ geom, scale, shot, bg = [12, 12, 12], margin = 3 }) {
  const pad = Math.ceil(margin * scale);
  const sw = Math.max(1, Math.round(geom.screenW * scale));
  const sh = Math.max(1, Math.round(geom.screenH * scale));
  const W = sw + pad * 2;
  const H = sh + pad * 2;

  const data = new Uint8Array(W * H * 3);

  // matte
  for (let i = 0; i < data.length; i += 3) {
    data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2];
  }

  // a border just light enough to read against either a dark or light matte
  const edge = bg[0] + bg[1] + bg[2] > 382 ? [168, 172, 178] : [86, 90, 96];
  const line = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 3;
        data[i] = edge[0]; data[i + 1] = edge[1]; data[i + 2] = edge[2];
      }
    }
  };
  line(pad - 1, pad - 1, pad + sw, pad - 1);       // top
  line(pad - 1, pad + sh, pad + sw, pad + sh);     // bottom
  line(pad - 1, pad - 1, pad - 1, pad + sh);       // left
  line(pad + sw, pad - 1, pad + sw, pad + sh);     // right

  // blit the screenshot
  const { width: shotW, height: shotH, data: src } = shot;
  const rows = Math.min(sh, shotH);
  const cols = Math.min(sw, shotW);
  for (let y = 0; y < rows; y++) {
    const srcRow = y * shotW * 3;
    const dstRow = ((y + pad) * W + pad) * 3;
    data.set(src.subarray(srcRow, srcRow + cols * 3), dstRow);
  }

  return {
    width: W, height: H, data,
    screenRect: { x: pad, y: pad, w: sw, h: sh },
  };
}
