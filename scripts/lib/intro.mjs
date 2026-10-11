// First-run intro: the card that tells a new user what the pane is and that
// the header is a device menu. Shown on launch until the device picker has
// been opened once, or for at most MAX_SHOWS launches, whichever comes first.
//
// State is a convenience, so a file that cannot be read or written is
// ignored rather than allowed to stop the viewer starting.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './state.mjs';

const FILE = path.join(STATE_DIR, 'intro.json');
const MAX_SHOWS = 3;

function read() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}
function write(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch { /* best effort */ }
}

/** Should this launch show the intro? */
export function due() {
  const s = read();
  return !s.picked && (s.shows || 0) < MAX_SHOWS;
}

/** The intro was actually put on screen. */
export function shown() {
  const s = read();
  write({ ...s, shows: (s.shows || 0) + 1 });
}

/** The user found the device picker; the intro has done its job. */
export function picked() {
  const s = read();
  if (!s.picked) write({ ...s, picked: true });
}
