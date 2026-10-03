// Draws the phone itself into the pixel buffer.
//
// The frame used to be box-drawing characters around the screenshot, which
// meant hard square corners and a body only as precise as the character grid.
// Compositing the body into the image instead gives real rounded corners, a
// cutout punched out of the screen, and a home indicator that sits on top of
// the app - all anti-aliased, all at pixel resolution.

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  r = Math.min(r, hw, hh);
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function blend(buf, i, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 1) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; return; }
  buf[i]     = buf[i]     + (r - buf[i])     * a;
  buf[i + 1] = buf[i + 1] + (g - buf[i + 1]) * a;
  buf[i + 2] = buf[i + 2] + (b - buf[i + 2]) * a;
}

/**
 * Phone geometry in the device's own logical pixels.
 *
 * Returned rects are what the compositor draws and what the caller uses to
 * map a mouse click back into page coordinates, so there is exactly one
 * definition of where the screen is.
 */
export function phoneGeometry(device, landscape = false) {
  const w = device.w, h = device.h;

  // chin devices (home button) have a real forehead and chin; modern ones
  // are near-uniform slivers
  const side = device.chin ? 14 : 12;
  const top = device.chin ? 86 : 12;
  const bottom = device.chin ? 96 : 12;

  const bodyW = w + side * 2;
  const bodyH = h + top + bottom;
  const screenR = device.r;
  const bodyR = device.chin ? 24 : screenR + side;

  const g = {
    bodyW, bodyH, bodyR,
    screenX: side, screenY: top, screenW: w, screenH: h, screenR,
    cut: null,
    home: null,
    camera: null,
    speaker: null,
    buttons: [],
  };

  // camera cutout, positioned relative to the screen
  if (device.cut === 'island') {
    g.cut = { type: 'rect', x: side + w / 2 - 51, y: top + 11, w: 102, h: 26, r: 13 };
  } else if (device.cut === 'notch') {
    g.cut = { type: 'rect', x: side + w / 2 - 75, y: top - 1, w: 150, h: 27, r: 14 };
  } else if (device.cut === 'hole') {
    g.cut = { type: 'rect', x: side + w / 2 - 6.5, y: top + 12, w: 13, h: 13, r: 6.5 };
  }

  if (device.chin) {
    // home button and earpiece live in the bezel, not over the screen
    g.home = { type: 'button', x: bodyW / 2 - 21, y: top + h + 16, w: 42, h: 42, r: 21 };
    g.speaker = { x: bodyW / 2 - 26, y: top / 2 - 3, w: 52, h: 6, r: 3 };
    g.camera = { x: bodyW / 2 - 30, y: top / 2 - 4, w: 8, h: 8, r: 4 };
  } else {
    g.home = { type: 'bar', x: side + w * 0.32, y: top + h - 9, w: w * 0.36, h: 5, r: 2.5 };
  }

  // volume pair and power, drawn just outside the body edge
  g.buttons = [
    { x: -2.5, y: bodyH * 0.20, w: 3, h: bodyH * 0.055, r: 1.5 },
    { x: -2.5, y: bodyH * 0.28, w: 3, h: bodyH * 0.055, r: 1.5 },
    { x: bodyW - 0.5, y: bodyH * 0.24, w: 3, h: bodyH * 0.085, r: 1.5 },
  ];

  if (!landscape) return g;

  // transpose every rect for landscape; the cutout lands on the left edge,
  // which is where it belongs on a phone turned counter-clockwise
  const t = (r) => r && { ...r, x: r.y, y: r.x, w: r.h, h: r.w };
  return {
    ...g,
    bodyW: g.bodyH, bodyH: g.bodyW,
    screenX: g.screenY, screenY: g.screenX,
    screenW: g.screenH, screenH: g.screenW,
    cut: t(g.cut),
    home: g.home && { ...t(g.home), type: g.home.type },
    camera: t(g.camera),
    speaker: t(g.speaker),
    buttons: g.buttons.map(t),
  };
}

/**
 * Composite the phone at `scale`.
 *
 * `shot` must already be resized to the scaled screen size - it is pasted,
 * not resampled, so the app pixels stay as sharp as the terminal allows.
 */
export function composePhone({ geom, scale, shot, bg = [12, 12, 12], margin = 3 }) {
  const pad = Math.ceil(margin * scale);
  const W = Math.round(geom.bodyW * scale) + pad * 2;
  const H = Math.round(geom.bodyH * scale) + pad * 2;
  const buf = new Float32Array(W * H * 3);

  // background: whatever the terminal is, so the rounded corners melt into it
  for (let i = 0; i < W * H; i++) {
    buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2];
  }

  const S = (v) => v * scale;
  const bodyX = pad, bodyY = pad;
  const bw = geom.bodyW * scale, bh = geom.bodyH * scale;
  const bodyR = geom.bodyR * scale;

  // ---- side buttons, under the body so they read as attached --------------
  for (const b of geom.buttons) {
    const x = bodyX + S(b.x), y = bodyY + S(b.y), w = S(b.w), h = S(b.h);
    const cx = x + w / 2, cy = y + h / 2;
    const x0 = Math.max(0, Math.floor(x - 1)), x1 = Math.min(W, Math.ceil(x + w + 1));
    const y0 = Math.max(0, Math.floor(y - 1)), y1 = Math.min(H, Math.ceil(y + h + 1));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = sdRoundRect(px + 0.5, py + 0.5, cx, cy, w / 2, h / 2, S(b.r));
        const a = Math.max(0, Math.min(1, 0.5 - d));
        blend(buf, (py * W + px) * 3, 46, 50, 58, a);
      }
    }
  }

  // ---- body ---------------------------------------------------------------
  const bcx = bodyX + bw / 2, bcy = bodyY + bh / 2;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, bcx, bcy, bw / 2, bh / 2, bodyR);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a <= 0) continue;

      // soft vertical gradient so the body doesn't look like flat cardboard
      const t = (py - bodyY) / Math.max(1, bh);
      const shade = 1 - 0.28 * Math.min(1, Math.max(0, t));
      let r = 52 * shade, g = 56 * shade, b = 64 * shade;

      // 1px rim highlight just inside the edge
      if (d > -1.6) { r += 26; g += 28; b += 32; }
      blend(buf, (py * W + px) * 3, r, g, b, a);
    }
  }

  // ---- screen -------------------------------------------------------------
  const sx = bodyX + S(geom.screenX), sy = bodyY + S(geom.screenY);
  const sw = S(geom.screenW), sh = S(geom.screenH);
  const scx = sx + sw / 2, scy = sy + sh / 2;
  const sr = S(geom.screenR);

  const sx0 = Math.max(0, Math.floor(sx - 1)), sx1 = Math.min(W, Math.ceil(sx + sw + 1));
  const sy0 = Math.max(0, Math.floor(sy - 1)), sy1 = Math.min(H, Math.ceil(sy + sh + 1));

  for (let py = sy0; py < sy1; py++) {
    for (let px = sx0; px < sx1; px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, scx, scy, sw / 2, sh / 2, sr);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a <= 0) continue;

      // sample the screenshot; outside it (rounding slop) fall back to black
      const ix = Math.min(shot.width - 1, Math.max(0, Math.round(px - sx)));
      const iy = Math.min(shot.height - 1, Math.max(0, Math.round(py - sy)));
      const si = (iy * shot.width + ix) * 3;
      blend(buf, (py * W + px) * 3, shot.data[si], shot.data[si + 1], shot.data[si + 2], a);
    }
  }

  // ---- camera cutout ------------------------------------------------------
  const drawRect = (rect, r, g, b, alpha = 1) => {
    if (!rect) return;
    const x = bodyX + S(rect.x), y = bodyY + S(rect.y), w = S(rect.w), h = S(rect.h);
    const cx = x + w / 2, cy = y + h / 2, rr = S(rect.r ?? 0);
    const x0 = Math.max(0, Math.floor(x - 1)), x1 = Math.min(W, Math.ceil(x + w + 1));
    const y0 = Math.max(0, Math.floor(y - 1)), y1 = Math.min(H, Math.ceil(y + h + 1));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = sdRoundRect(px + 0.5, py + 0.5, cx, cy, w / 2, h / 2, rr);
        const a = Math.max(0, Math.min(1, 0.5 - d)) * alpha;
        blend(buf, (py * W + px) * 3, r, g, b, a);
      }
    }
  };

  drawRect(geom.cut, 8, 8, 10);
  drawRect(geom.speaker, 26, 28, 33);
  drawRect(geom.camera, 30, 44, 60);

  // ---- home indicator -----------------------------------------------------
  if (geom.home?.type === 'bar') {
    // pick black or white by what the app is actually showing underneath, so
    // the indicator stays visible on both light and dark screens
    const hx = bodyX + S(geom.home.x), hy = bodyY + S(geom.home.y);
    const hw = S(geom.home.w), hh = S(geom.home.h);
    let lum = 0, n = 0;
    for (let py = Math.floor(hy); py < Math.ceil(hy + hh); py++) {
      for (let px = Math.floor(hx); px < Math.ceil(hx + hw); px++) {
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const i = (py * W + px) * 3;
        lum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        n++;
      }
    }
    const light = n && (lum / n) > 128;
    const v = light ? 30 : 235;
    drawRect(geom.home, v, v, v, 0.7);
  } else if (geom.home?.type === 'button') {
    drawRect(geom.home, 34, 37, 43);
    const inner = { ...geom.home, x: geom.home.x + 3, y: geom.home.y + 3, w: geom.home.w - 6, h: geom.home.h - 6, r: (geom.home.r ?? 0) - 3 };
    drawRect(inner, 22, 24, 29);
  }

  // Float32 -> bytes
  const data = Buffer.allocUnsafe(W * H * 3);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  return {
    width: W, height: H, data,
    // where the live screen ended up, for mapping mouse input back to the page
    screenRect: { x: sx, y: sy, w: sw, h: sh },
  };
}
