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
 * Height of the status bar above the page, in logical px. On a real phone the
 * camera cutout sits in this strip and the page starts below it; without it
 * the island lands on top of the page's own header.
 */
export function statusBarOf(device) {
  if (device.chin) return 20;
  return { island: 54, notch: 47, hole: 36 }[device.cut] ?? 24;
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
  const bar = statusBarOf(device);
  const bodyH = h + bar + top + bottom;
  const screenR = device.r;
  const bodyR = device.chin ? 24 : screenR + side;

  const g = {
    bodyW, bodyH, bodyR,
    // screen* is the page itself; glass is the whole lit display, the status
    // bar strip included
    screenX: side, screenY: top + bar, screenW: w, screenH: h, screenR,
    glass: { x: side, y: top, w, h: h + bar, r: screenR },
    status: { x: side, y: top, w, h: bar, cut: device.cut || 'none', chin: !!device.chin, landscape },
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
    g.home = { type: 'button', x: bodyW / 2 - 21, y: top + bar + h + 16, w: 42, h: 42, r: 21 };
    g.speaker = { x: bodyW / 2 - 26, y: top / 2 - 3, w: 52, h: 6, r: 3 };
    g.camera = { x: bodyW / 2 - 30, y: top / 2 - 4, w: 8, h: 8, r: 4 };
  } else {
    g.home = { type: 'bar', x: side + w * 0.32, y: top + bar + h - 9, w: w * 0.36, h: 5, r: 2.5 };
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
    glass: t(g.glass),
    status: { ...t(g.status), cut: g.status.cut, chin: g.status.chin, landscape },
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
  // the glass is the rounded shape; the page is a plain rect inside it
  const gl = geom.glass || { x: geom.screenX, y: geom.screenY, w: geom.screenW, h: geom.screenH, r: geom.screenR };
  const gx = bodyX + S(gl.x), gy = bodyY + S(gl.y), gw = S(gl.w), gh = S(gl.h);
  const gcx = gx + gw / 2, gcy = gy + gh / 2, gr = S(gl.r);

  // The status bar takes the colour of the top of the page, the way Safari
  // and Chrome tint it, with dark or light icons to suit.
  let tint = [0, 0, 0];
  {
    let n = 0; const acc = [0, 0, 0];
    const vertical = !geom.status?.landscape;
    const edge = vertical ? shot.width : shot.height;
    for (let k = 0; k < edge; k += 2) for (let j = 0; j < 2; j++) {
      const ix = vertical ? k : Math.min(shot.width - 1, j), iy = vertical ? Math.min(shot.height - 1, j) : k;
      const i = (iy * shot.width + ix) * 3;
      acc[0] += shot.data[i]; acc[1] += shot.data[i + 1]; acc[2] += shot.data[i + 2]; n++;
    }
    if (n) tint = acc.map(v => v / n);
  }
  const gx0 = Math.max(0, Math.floor(gx - 1)), gx1 = Math.min(W, Math.ceil(gx + gw + 1));
  const gy0 = Math.max(0, Math.floor(gy - 1)), gy1 = Math.min(H, Math.ceil(gy + gh + 1));
  const px0 = Math.floor(sx), px1 = Math.ceil(sx + sw), py0 = Math.floor(sy), py1 = Math.ceil(sy + sh);
  for (let py = gy0; py < gy1; py++) {
    for (let px = gx0; px < gx1; px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, gcx, gcy, gw / 2, gh / 2, gr);
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a <= 0) continue;
      if (px < px0 || px >= px1 || py < py0 || py >= py1) { blend(buf, (py * W + px) * 3, tint[0], tint[1], tint[2], a); continue; }

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

  // ---- status bar: time, signal, battery ----------------------------------
  const st = geom.status;
  if (st && !st.landscape && st.h > 0) {
    const lumT = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
    const ink = lumT > 140 ? 18 : 245;
    const cy = st.y + Math.min(st.h / 2, 24);
    const u = st.chin ? 1.2 : 1.7;                 // one font pixel, in logical px
    const glyphs = {
      9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
      4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
      1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
      ':': ['0', '0', '1', '0', '1', '0', '0'],
    };
    const text = '9:41';
    const adv = (c) => (glyphs[c][0].length + 1) * u;
    const textW = [...text].reduce((t, c) => t + adv(c), -u);
    // half the cutout's width: the time and icons sit centred in the "ears"
    const ear = st.cut === 'island' ? 51 : st.cut === 'notch' ? 75 : 0;
    let tx = st.chin ? st.x + st.w / 2 - textW / 2
      : ear ? st.x + (st.w / 2 - ear) / 2 - textW / 2 + 6
      : st.x + 18;
    for (const c of text) {
      glyphs[c].forEach((bits, ry) => [...bits].forEach((bit, rx) => {
        if (bit === '1') drawRect({ x: tx + rx * u, y: cy - 3.5 * u + ry * u, w: u + 0.15, h: u + 0.15, r: 0 }, ink, ink, ink);
      }));
      tx += adv(c);
    }
    // battery on the right, signal bars to its left
    const bw = st.chin ? 20 : 24, bh = st.chin ? 9 : 11.5;
    const right = ear ? st.x + st.w - (st.w / 2 - ear) / 2 + 14 : st.x + st.w - 16;
    const bx = right - bw, by = cy - bh / 2;
    drawRect({ x: bx, y: by, w: bw, h: bh, r: 3 }, ink, ink, ink, 0.45);
    drawRect({ x: bx + 1.6, y: by + 1.6, w: (bw - 3.2) * 0.8, h: bh - 3.2, r: 1.6 }, ink, ink, ink);
    drawRect({ x: bx + bw + 0.8, y: cy - 2, w: 1.6, h: 4, r: 0.8 }, ink, ink, ink, 0.45);
    for (let k = 0; k < 4; k++) {
      const hh = bh * (0.35 + 0.22 * k);
      drawRect({ x: bx - 24 + k * 5, y: by + bh - hh, w: 3.2, h: hh, r: 0.9 }, ink, ink, ink);
    }
  }

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
