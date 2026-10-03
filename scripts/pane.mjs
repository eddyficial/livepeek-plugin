#!/usr/bin/env node
/**
 * Open a live view of whatever this project builds, as a split pane in
 * whatever terminal this is.
 *
 * Every terminal multiplexer can split itself from the command line; they
 * just disagree about how, so this detects which one is hosting us and
 * speaks its dialect. Nothing here opens a window - if there is no
 * multiplexer to split, it says so rather than falling back to a browser.
 *
 *   node pane.mjs [--preset desktop] [--url http://localhost:3000]
 *                 [--size 0.34] [--port 3000] [--interval 600]
 *                 [--horizontal] [--no-serve] [--here] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectFramework, describe } from './targets.mjs';
import * as session from './lib/session.mjs';
import * as projects from './lib/projects.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const SIZE     = parseFloat(arg('--size', '0.34'));
const INTERVAL = parseInt(arg('--interval', '600'), 10);
if (flag('--doctor')) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'doctor.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const URL_ARG  = arg('--url', null);
const PRESET_ARG = arg('--preset', arg('--device', null));   // --device kept as an alias

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

// --------------------------------------------------------------- project ----
/**
 * Walk up from the working directory for a package.json. The plugin runs from
 * wherever the user started their session, which is usually but not always
 * the project root.
 */
function findProjectRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  const home = os.homedir();
  for (;;) {
    // a stray package.json in the home directory would make every empty
    // folder under it look like one giant project
    if (dir === home) return null;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const root = findProjectRoot() || process.cwd();
let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch { /* --url does not need a project at all */ }

const fw = detectFramework(pkg);

// ---------------------------------------------------------- static / docs ----
/**
 * Something to look at that has no dev server: an explicit --file, or a
 * page / document found in the working directory. Served by the pane itself.
 *
 * Checked before giving up on framework detection, because "I have a folder
 * with an index.html" and "I am writing a README" are the most ordinary
 * cases there are, and neither has a package.json worth reading.
 */
const FILE_ARG = arg('--file', null);
function findStatic() {
  const cwd = process.cwd();
  if (FILE_ARG) {
    const abs = path.resolve(cwd, FILE_ARG);
    if (!fs.existsSync(abs)) die(`No such file: ${abs}`);
    return { dir: path.dirname(abs), file: path.basename(abs) };
  }
  if (fs.existsSync(path.join(cwd, 'index.html'))) return { dir: cwd, file: null };
  let names;
  try { names = fs.readdirSync(cwd); } catch { return null; }
  const html = names.find(n => /\.html?$/i.test(n));
  if (html) return { dir: cwd, file: html };
  const md = names.find(n => /^readme\.md$/i.test(n)) || names.find(n => /\.(md|markdown)$/i.test(n));
  if (md) return { dir: cwd, file: md };
  return null;
}

// A URL wins over anything detected; a framework wins over static content
// unless a file was named explicitly.
let STATIC = (!URL_ARG && (FILE_ARG || !fw)) ? findStatic() : null;

// An empty folder is where most people start. Rather than refusing to open,
// show a welcome page that says what to do next; the pane then switches to
// the real thing the moment an index.html or a dev server appears.
let welcome = false;
if (!URL_ARG && !fw && !STATIC) {
  welcome = true;
  STATIC = { dir: path.join(__dirname, 'welcome'), file: 'index.html' };
  const quiet = flag('--quit') || arg('--eval', null) || arg('--snapshot', null);
  if (!quiet) console.log(`Nothing to show in ${process.cwd()} yet - opening the welcome page.`);
  if (!quiet) console.log('Create an index.html or start a dev server here and the pane will pick it up.');
  if (!quiet) console.log('Or name a file or URL:  --file docs/spec.md   --url http://localhost:3000\n');
}

// The static server serves the whole folder a file sits in, not just the
// file. For `--file ~/notes.md` that folder is the home directory, and all of
// it becomes readable on localhost while the pane is open. Allowed, but said.
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
if (STATIC && !welcome && samePath(STATIC.dir, os.homedir())) {
  console.error('warning: this serves your whole home folder on localhost while the pane is open - move the file into a project folder to serve only that.');
}

if (fw && fw.missing?.length && !URL_ARG) {
  console.error(`This project is missing: ${fw.missing.join(', ')}`);
  console.error(`\nThese are needed for the web build the preview renders.\n\nInstall with:\n  ${fw.install}\n`);
  process.exit(2);   // distinct code so the skill can offer to fix it
}

const PORT   = parseInt(arg('--port', String(fw?.port ?? 3000)), 10);
const TARGET = URL_ARG || (STATIC ? 'static' : `http://localhost:${PORT}`);
// Web and document views default to 'fit': rendered at the pane's own pixel
// size, so text is never scaled down. Fixed presets stay one --preset away.
const PRESET = (arg('--compare', null) || '').split(',')[0] || PRESET_ARG
  || (STATIC ? 'fit' : null)
  || (fw?.preset && fw.preset !== 'desktop' ? fw.preset : 'fit');

// Remember what is being shown, so the pane's `p` picker can bring it back
// later even when its dev server is not running. Control calls and the
// welcome page are not projects.
if (!welcome && !flag('--quit') && !flag('--dry-run') && !arg('--eval', null) && !arg('--snapshot', null)) {
  const dir = STATIC ? STATIC.dir : root;
  projects.remember({
    dir,
    name: path.basename(dir),
    kind: STATIC ? (/\.(md|markdown)$/i.test(STATIC.file || '') ? 'document' : 'site') : (fw?.id || 'url'),
    file: STATIC ? STATIC.file : null,
    url: STATIC ? null : TARGET,
    script: !STATIC && !URL_ARG ? (fw?.script || null) : null,
    port: !STATIC && !URL_ARG ? PORT : null,
    preset: PRESET,
  });
}

// ------------------------------------------------------------------ split ----
// The dev server is handed to the pane to start, not started here - see the
// note in tui.mjs. A server spawned from this process dies when whatever
// invoked us (often an agent's shell) tears its process tree down.
const serveArgs = STATIC
  ? ['--static', STATIC.dir, ...(STATIC.file ? ['--file', STATIC.file] : [])]
  : (!flag('--no-serve') && !URL_ARG && fw?.script)
    ? ['--serve', fw.script, '--serve-cwd', root, '--serve-port', String(PORT)]
    : [];

const SNAPSHOT = arg('--snapshot', null);

// a document lives where it lives, not at whatever package.json is above it
const paneCwd = STATIC ? STATIC.dir : root;

const previewCmd = [
  process.execPath,
  path.join(__dirname, 'tui.mjs'),
  '--target', TARGET,
  '--preset', PRESET,
  '--interval', String(INTERVAL),
  '--host', detectHost() || 'none',
  ...(arg('--render', null) ? ['--render', arg('--render', null)] : []),
  ...(welcome ? ['--watch-dir', process.cwd()] : []),
  ...serveArgs,
  ...(SNAPSHOT ? ['--snapshot', path.resolve(SNAPSHOT)] : []),
];

// Quote for the multiplexers that take a shell string rather than argv (tmux
// hands it to sh). Single quotes, because inside them sh expands nothing - a
// folder called "a;b", "$(x)" or "it's" stays a name instead of becoming a
// command. A single quote itself is closed, escaped and reopened: ' -> '\''
const shellQuote = (parts) => parts.map(p => "'" + String(p).replace(/'/g, "'\\''") + "'").join(' ');

/**
 * Which multiplexer is hosting us?
 *
 * Order matters: tmux can run *inside* any of the others, and whichever is
 * innermost owns the pane the user is looking at, so it has to win.
 */
function detectHost() {
  if (process.env.TMUX) return 'tmux';
  if (process.env.ZELLIJ) return 'zellij';
  if (process.env.KITTY_LISTEN_ON) return 'kitty';
  if (process.env.WEZTERM_PANE) return 'wezterm';
  if (process.env.WT_SESSION) return 'wt';
  return null;
}

const splitters = {
  tmux: () => ['tmux', [
    'split-window',
    flag('--horizontal') ? '-v' : '-h',
    '-p', String(Math.round(SIZE * 100)),
    '-c', paneCwd,
    shellQuote(previewCmd),
  ]],

  zellij: () => ['zellij', [
    // Zellij keeps a finished pane on screen ("press enter to re-run")
    // unless told otherwise, which looks like q did nothing.
    'action', 'new-pane', '--close-on-exit', '-d', flag('--horizontal') ? 'down' : 'right',
    '--cwd', paneCwd, '--', ...previewCmd,
  ]],

  kitty: () => ['kitty', [
    '@', 'launch', '--type=window',
    `--location=${flag('--horizontal') ? 'hsplit' : 'vsplit'}`,
    '--cwd', paneCwd, ...previewCmd,
  ]],

  wezterm: () => ['wezterm', [
    'cli', 'split-pane',
    flag('--horizontal') ? '--bottom' : '--right',
    '--percent', String(Math.round(SIZE * 100)),
    '--cwd', paneCwd, '--', ...previewCmd,
  ]],

  // Two wt.exe quirks. It treats ';' as its own argument separator, so the
  // command must not contain one anywhere. And node is invoked directly
  // rather than through `cmd /c`: cmd strips the outer quotes off its
  // argument, which turns "C:\Program Files\nodejs\node.exe" into a request
  // to run C:\Program. wt closes the pane when the command exits either way,
  // which was the only reason cmd was in the chain.
  wt: () => ['wt.exe', [
    '-w', '0', 'split-pane',
    flag('--horizontal') ? '--horizontal' : '--vertical',
    '--size', String(SIZE),
    '--title', 'peek',
    '-d', paneCwd,
    ...previewCmd,
  // wt documents backslash-semicolon as the escape, so a project folder or
  // file called "a; b" does not get split into a second command
  ].map(a => a.replace(/;/g, String.fromCharCode(92) + ';'))],
};

async function main() {
  let open = session.current();
  let weHoldClaim = false;

  // --quit closes the pane cleanly from outside. Killing the process instead
  // makes it exit non-zero, and Windows Terminal keeps a pane open on an
  // abnormal exit - which is how you end up with a row of dead panes.
  if (flag('--quit')) {
    if (!open) return console.log('no peek pane is open.');
    session.write({ ...open, quit: true, rev: (open.rev || 0) + 1 });
    return console.log('asked the open pane to close.');
  }

  // --eval <js>: run a snippet in the page shown by the open pane and print
  // the JSON result. Pairs with --snapshot: look, then read the exact state.
  const EVAL = arg('--eval', null);
  if (EVAL) {
    if (!open) die('no peek pane is open.');
    session.write({ ...open, eval: EVAL, evalResult: null, rev: (open.rev || 0) + 1 });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 120));
      const r = session.read()?.evalResult;
      if (r) { console.log(r.ok ? JSON.stringify(r.value) : 'error: ' + r.error); return; }
    }
    die('the pane did not answer within 8s - is it still running?');
  }

  // --snapshot alone: ask the open pane to write what it is showing, and
  // wait for it. This is how an agent sees the pane.
  if (SNAPSHOT && !open && argv.length <= 2) {
    die('no peek pane is open to snapshot. Run peek first, then --snapshot.');
  }
  /** Wait for the open pane to report the snapshot asked for. */
  const awaitSnapshot = async (file) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (session.read()?.snapshotDone === file && fs.existsSync(file)) {
        return console.log(`snapshot written: ${file}`);
      }
    }
    die('the pane did not answer within 8s - is it still running?');
  };
  if (SNAPSHOT && open && !flag('--new') && argv.length <= 2) {
    const file = path.resolve(SNAPSHOT);
    session.write({ ...open, snapshot: file, snapshotDone: null, rev: (open.rev || 0) + 1 });
    return awaitSnapshot(file);
  }

  // One pane, retargeted. Splitting again for every project would stack up
  // panes you then have to close by hand.
  // A pane left open in another terminal (say Windows Terminal, while the
  // user has since moved into Zellij) cannot be reused from here: retargeting
  // it would change a view the user is no longer looking at. Close it and
  // split a fresh one in the terminal they are in now.
  // Two launches in the same second (two shells, or Claude and the user)
  // would each see no pane and both split. A launcher claims the session
  // file before it splits; a second launcher that finds a fresh claim waits
  // for that pane to come up and reuses it.
  if (!open && !flag('--new') && !flag('--here') && !flag('--dry-run') && !session.claim()) {
    // another launcher is splitting right now: wait for its pane, then reuse
    const until = Date.now() + 20000;
    while (Date.now() < until && !session.current()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  } else if (!open && !flag('--new') && !flag('--here') && !flag('--dry-run')) {
    weHoldClaim = true;
  }

  open = session.current();
  if (open && open.host && open.host !== (detectHost() || 'none') && !flag('--here') && !flag('--dry-run')) {
    console.log(`closing the pane left open in ${open.host}`);
    session.write({ ...open, quit: true, rev: (open.rev || 0) + 1 });
    const until = Date.now() + 6000;
    while (Date.now() < until && session.current()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    open = session.current();
    if (open) console.log('  (it did not answer; opening a new pane here anyway)');
  }

  if (open && !flag('--new') && !flag('--here') && !flag('--dry-run')) {
    session.write({
      ...open,
      target: STATIC ? null : TARGET,
      // a dev-server project: the open pane has to start its server, or the
      // page it navigates to is empty (or someone else's)
      serve: serveArgs[0] === '--serve' ? { script: fw.script, cwd: root, port: PORT } : null,
      watch: welcome ? process.cwd() : null,
      static: STATIC ? STATIC.dir : null,
      file: STATIC ? STATIC.file : null,
      preset: PRESET,
      snapshot: SNAPSHOT ? path.resolve(SNAPSHOT) : null,
      snapshotDone: SNAPSHOT ? null : open.snapshotDone,
      rev: (open.rev || 0) + 1,
    });
    const what = STATIC ? `${STATIC.file || 'index.html'} in ${STATIC.dir}` : TARGET;
    console.log(`reusing the open pane — ${what} at ${PRESET}`);
    console.log('  (--new splits a second pane instead)');
    // a retarget that also asked for a snapshot waits for it, the same as a
    // bare --snapshot does, so the caller can read the file straight away
    if (SNAPSHOT) return awaitSnapshot(path.resolve(SNAPSHOT));
    return;
  }

  // --dry-run must be free of side effects: it used to start the dev server
  // before printing the plan, which is the opposite of what a dry run means.
  if (flag('--dry-run') && !flag('--here')) {
    const host = detectHost();
    const [cmd, args] = host ? splitters[host]() : ['(no multiplexer)', []];
    console.log(`host    : ${host || 'none'}`);
    console.log(`project : ${describe(fw)}`);
    console.log(`root    : ${root}`);
    console.log(`target  : ${TARGET}`);
    console.log(`preset  : ${PRESET}`);
    console.log(`serve   : ${STATIC ? 'built-in static server (' + (STATIC.file || 'index.html') + ')' : serveArgs.length ? `npm run ${fw.script} (started by the pane)` : 'no'}`);
    console.log(`command : ${cmd} ${args.join(' ')}`);
    return;
  }

  // --here runs in this pane instead of splitting, for terminals with no
  // split mechanism (and for debugging the preview itself)
  if (flag('--here')) {
    const r = spawnSync(previewCmd[0], previewCmd.slice(1), { stdio: 'inherit', cwd: paneCwd });
    process.exit(r.status ?? 0);
  }

  const host = detectHost();
  if (!host) {
    die(
      '\nNo terminal multiplexer detected, so there is no pane to split.\n' +
      'Supported: tmux, Zellij, Kitty, WezTerm, Windows Terminal.\n\n' +
      'Run it in this pane instead:\n' +
      `  node ${path.join(__dirname, 'pane.mjs')} --here\n\n` +
      'Or start tmux first (works on every platform):\n  tmux\n',
      3
    );
  }


  const [cmd, args] = splitters[host]();
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: paneCwd });
  if (r.error || (r.status != null && r.status !== 0)) {
    if (weHoldClaim) session.release();
    die(`Could not split the ${host} pane: ${r.error?.message || 'exit ' + r.status}`);
  }

  const compare = arg('--compare', null);
  if (compare) {
    // "--compare desktop,iphone-15-pro": this pane got the first, open a
    // second pane for the other so the two sit side by side
    const second = compare.split(',')[1];
    if (second) {
      const rest = argv.filter((a, i, all) => a !== '--compare' && all[i - 1] !== '--compare'
        && a !== '--preset' && all[i - 1] !== '--preset' && a !== '--new');
      spawnSync(process.execPath, [path.join(__dirname, 'pane.mjs'), ...rest, '--new', '--preset', second], { stdio: 'inherit' });
    }
  }

  console.log(`\npeek opened (${host}) — ${TARGET} at ${PRESET}`);
  console.log('  keys   space device  ·  p project  ·  shift+? help  ·  q quit  ·  mouse works');
  console.log('  close  press q in the pane so the headless browser shuts down cleanly');
}

main().catch(e => die(e.message || String(e)));
