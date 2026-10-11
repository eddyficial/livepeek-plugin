// One shared pane per terminal pane it was launched from, coordinated
// through one small file.
//
// Without this, every launch splits the terminal again and you end up with a
// row of stale panes. The running pane owns this file; a new launch writes
// its request into it and exits instead of splitting, and the pane picks the
// change up on its next tick.
//
// The file belongs to a slot: the terminal pane the launch came from (one
// Claude session, one shell). Two sessions in two tabs each get their own
// livepeek pane instead of fighting over one.
//
// A file rather than a socket because the two processes are started by
// different parents (one by the agent's shell, one by the terminal) and may
// not share anything else.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './state.mjs';

const PANES = path.join(STATE_DIR, 'panes');

/**
 * Which terminal host owns the pane the user is looking at. Order matters:
 * tmux can run inside any of the others, and the innermost wins. A VS Code
 * terminal inherits the environment VS Code was started from, so ZELLIJ or
 * WT_SESSION may be set there with no such pane anywhere near it.
 */
export function detectHost(env = process.env) {
  const vscode = (env.TERM_PROGRAM || '').toLowerCase() === 'vscode';
  if (env.TMUX && !vscode) return 'tmux';
  if (vscode) return null;
  if (env.ZELLIJ) return 'zellij';
  if (env.KITTY_LISTEN_ON || env.KITTY_WINDOW_ID) return 'kitty';
  if (env.WEZTERM_PANE) return 'wezterm';
  if (env.WT_SESSION) return 'wt';
  return null;
}

const SLOT_RE = /^(default|[0-9a-f]{12})$/;
export const validSlot = (slot) => typeof slot === 'string' && SLOT_RE.test(slot);

/**
 * The slot for a launch from this environment: LIVEPEEK_SLOT if set, else the
 * id of the terminal pane the host gives us, hashed so it is safe as a file
 * name. Every launch from the same terminal pane (the same Claude session)
 * lands on the same slot. With no id at all, everything shares 'default'.
 */
export function slotFromEnv(env = process.env) {
  const host = detectHost(env);
  const id = env.LIVEPEEK_SLOT ? 'user\0' + env.LIVEPEEK_SLOT
    : host === 'tmux' && env.TMUX_PANE ? 'tmux\0' + env.TMUX_PANE
    : host === 'zellij' && env.ZELLIJ_PANE_ID ? 'zellij\0' + (env.ZELLIJ_SESSION_NAME || '') + '\0' + env.ZELLIJ_PANE_ID
    : host === 'kitty' && env.KITTY_WINDOW_ID ? 'kitty\0' + env.KITTY_WINDOW_ID
    : host === 'wezterm' ? 'wezterm\0' + env.WEZTERM_PANE
    : host === 'wt' ? 'wt\0' + env.WT_SESSION
    : null;
  return id ? crypto.createHash('sha1').update(id).digest('hex').slice(0, 12) : 'default';
}

const filesFor = (slot) => ({
  file: path.join(PANES, slot + '.json'),
  beat: path.join(PANES, slot + '.alive'),
  lock: path.join(PANES, slot + '.lock'),
});

export let SLOT = slotFromEnv();
export let FILE, BEAT, LOCK;
({ file: FILE, beat: BEAT, lock: LOCK } = filesFor(SLOT));

/**
 * A fresh slot for an extra pane (--new, the second half of --compare), so it
 * never shares files with this terminal's own pane: control commands keep
 * talking to that one, and reach the extra pane only once it is the last left.
 */
export function extraSlot() {
  return crypto.createHash('sha1').update(SLOT + '\0extra\0' + process.pid + '\0' + Date.now() + Math.random()).digest('hex').slice(0, 12);
}

/** Point this process at another slot (the pane is told its slot by the launcher). */
export function useSlot(slot) {
  if (!validSlot(slot)) throw new Error('bad slot: ' + slot);
  SLOT = slot;
  ({ file: FILE, beat: BEAT, lock: LOCK } = filesFor(slot));
}

// BEAT: the pane touches this file every couple of seconds while it runs. A
// pid on its own is not proof of life: once a pane is closed with the X,
// Windows hands its pid to some unrelated process soon after, and
// process.kill(pid, 0) then reports a pane that is long gone as alive.

// LOCK: a launcher takes this lock before it splits. Reading the session file
// and then writing a claim is two steps, and two launchers started in the
// same instant both pass the read; an exclusive create is one step and only
// one of them wins it. The pane deletes the lock when it publishes.
const LOCK_TTL = 20000;

/** Try to become the launcher that splits. False means someone else is. */
export function claim() {
  fs.mkdirSync(PANES, { recursive: true });
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
    fs.mkdirSync(PANES, { recursive: true });
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
function beating(beat = BEAT) {
  try { return Date.now() - fs.statSync(beat).mtimeMs < 10000; } catch { return false; }
}

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The live pane of this slot, or null if the file is stale. */
export function current() {
  const s = read();
  return s && alive(s.pid) && beating() ? s : null;
}

/** Is a launcher in this slot splitting right now? */
function claimed() {
  try { return Date.now() - fs.statSync(LOCK).mtimeMs < LOCK_TTL; } catch { return false; }
}

/**
 * The pane a control command (--snapshot, --eval, --quit, --status) should
 * talk to: the pane showing the project it was run from, else this slot's
 * own, else the only live pane there is - a pane the user started with --here
 * in a split they made by hand belongs to that split's slot, not to the
 * session asking. `dirs` are the folders that count as "this project" (the
 * project root and the working directory). Switches this process to the
 * chosen slot. Returns { pane } or { error } when there is none or several.
 */
export function resolve(dirs = []) {
  const own = current();
  const want = dirs.filter(Boolean).map(sameDir);
  const shows = (st) => !!st?.root && want.includes(sameDir(st.root));
  if (own && (!want.length || shows(own))) return { pane: own };
  // our own pane is on its way up; do not send its requests elsewhere
  if (!own && claimed()) return { error: 'starting' };
  let names = [];
  try { names = fs.readdirSync(PANES).filter(n => n.endsWith('.json')); } catch { /* none yet */ }
  const live = names.map(n => n.slice(0, -5)).filter(validSlot).filter(slot => slot !== SLOT).filter(slot => {
    const p = filesFor(slot);
    const st = readFile(p.file);
    return st && alive(st.pid) && beating(p.beat);
  });
  // A pane another terminal opened on this project is the one meant: Claude
  // working in the project asks about the view of it, not about whatever
  // this terminal's own pane happens to show.
  const onProject = live.filter(slot => shows(readFile(filesFor(slot).file)));
  if (onProject.length === 1) {
    const back = SLOT;
    useSlot(onProject[0]);
    const pane = current();
    if (pane) return { pane };
    useSlot(back);
  }
  if (own) return { pane: own };
  if (live.length === 1) {
    const back = SLOT;
    useSlot(live[0]);
    const pane = current();          // read once more: it may have closed meanwhile
    if (pane) return { pane };
    useSlot(back);
    return { error: 'none' };
  }
  return { error: live.length ? 'several' : 'none' };
}

/** A folder path in a form two spellings of it compare equal in. */
function sameDir(dir) {
  const p = path.resolve(dir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
