// Kitty graphics protocol encoder.
//
// The sixel encoder covers Windows Terminal, xterm, foot and WezTerm. It does
// not cover the terminals most macOS users are on: Kitty and Ghostty speak
// this protocol instead and have no sixel support at all. Without this, every
// mac user falls through to half-blocks, which is the one renderer that makes
// a phone mockup look like a phone mockup rather than a phone.
//
// Unlike sixel there is no quantisation step - the protocol takes raw RGB, so
// frames go out at full colour and the encode is just a base64.

import { deflateSync } from 'node:zlib';

const ESC = '\x1b';

// The spec caps a single escape sequence's payload at 4096 base64 bytes, so
// anything bigger is split across continuation chunks with m=1 ("more to
// come") and a final m=0.
const CHUNK = 4096;

/**
 * Encode an {width, height, data} RGB image as a kitty graphics sequence.
 *
 * Reuses one image id per frame and deletes the previous frame first -
 * otherwise the terminal accumulates every frame we have ever sent in its
 * image store, which at ~2 frames/second is a memory leak with a UI.
 */
export function toKitty(img, { id = 1 } = {}) {
  const raw = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);

  // Raw RGB base64 runs ~1.3 MB for a phone-sized frame, and at a sub-second
  // refresh that is megabytes a second of escape sequences. A phone UI is
  // mostly flat fill, so deflate takes it down by ~50x - the same property
  // the sixel encoder exploits with run-length encoding. o=z tells the
  // terminal the payload is zlib-compressed.
  const payload = deflateSync(raw, { level: 6 });
  const b64 = payload.toString('base64');

  const parts = [`${ESC}_Ga=d,d=i,i=${id}${ESC}\\`];

  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    // a=T transmit and display at the cursor, f=24 raw RGB, q=2 stay quiet
    // (we are in raw mode and would have to parse any reply out of keystrokes)
    const head = i === 0
      ? `a=T,f=24,o=z,s=${img.width},v=${img.height},i=${id},q=2,m=${more}`
      : `m=${more}`;
    parts.push(`${ESC}_G${head};${chunk}${ESC}\\`);
  }

  return parts.join('');
}

/**
 * Delete every image the terminal is holding for us.
 *
 * Needed on a full redraw and when switching away from kitty rendering: ESC[2J
 * clears text but leaves placed images sitting on top of the new frame.
 */
export function kittyClearAll() {
  return `${ESC}_Ga=d,d=A${ESC}\\`;
}

/**
 * Wrap a graphics sequence for tmux.
 *
 * tmux swallows escape sequences it does not understand unless the pane opts
 * into passthrough, which also requires `set -g allow-passthrough on` in the
 * user's config. Inner ESCs have to be doubled.
 */
export function tmuxWrap(seq) {
  return `${ESC}Ptmux;${seq.replace(/\x1b/g, '\x1b\x1b')}${ESC}\\`;
}
