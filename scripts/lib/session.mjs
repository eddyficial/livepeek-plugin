// A single shared pane, coordinated through one small file.
//
// Without this, every launch splits the terminal again and you end up with a
// row of stale panes. The running pane owns this file; a new launch writes
// its request into it and exits instead of splitting, and the pane picks the
// change up on its next tick.
//
// A file rather than a socket because the two processes are started by
// different parents (one by the agent's shell, one by the terminal) and may
// not share anything else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.peek');
export const FILE = path.join(DIR, 'session.json');

export function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

export function write(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 1));
  } catch { /* a preview is not worth failing over */ }
}

export function clear() {
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
}

/** Is that pid still running? Signal 0 tests without actually signalling. */
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The live pane, or null if the file is stale. */
export function current() {
  const s = read();
  return s && alive(s.pid) ? s : null;
}
