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

// The pane touches this file every couple of seconds while it runs. A pid on
// its own is not proof of life: once a pane is closed with the X, Windows
// hands its pid to some unrelated process soon after, and process.kill(pid, 0)
// then reports a pane that is long gone as alive.
export const BEAT = path.join(DIR, 'alive');

// A launcher takes this lock before it splits. Reading the session file and
// then writing a claim is two steps, and two launchers started in the same
// instant both pass the read; an exclusive create is one step and only one
// of them wins it. The pane deletes the lock when it publishes.
export const LOCK = path.join(DIR, 'claim.lock');
const LOCK_TTL = 20000;

/** Try to become the launcher that splits. False means someone else is. */
export function claim() {
  fs.mkdirSync(DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;        // odd filesystem: do not block the launch
      let age = 0;
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
      if (age < LOCK_TTL) return false;
      try { fs.unlinkSync(LOCK); } catch { /* the other side cleaned it */ }
    }
  }
  return true;
}

export function release() {
  try { fs.unlinkSync(LOCK); } catch { /* already gone */ }
}

export function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

/**
 * Write to a temporary file and rename it into place, so a reader never sees
 * half a file - the pane and a launcher can both be writing at once. Rename
 * over an existing file works on every platform we run on, but if it throws
 * anyway, a direct write is still better than nothing.
 */
export function write(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (state.pid) release();      // a real pane is up; the launch claim is over
    const data = JSON.stringify(state, null, 1);
    const tmp = FILE + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, FILE);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      fs.writeFileSync(FILE, data);
    }
  } catch { /* a preview is not worth failing over */ }
}

export function clear() {
  release();
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
  try { fs.unlinkSync(BEAT); } catch { /* already gone */ }
}

/** Is that pid still running? Signal 0 tests without actually signalling. */
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Has the pane touched the heartbeat file in the last ten seconds? */
function beating() {
  try { return Date.now() - fs.statSync(BEAT).mtimeMs < 10000; } catch { return false; }
}

/** The live pane, or null if the file is stale. */
export function current() {
  const s = read();
  return s && alive(s.pid) && beating() ? s : null;
}
