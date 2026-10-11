#!/usr/bin/env node
/**
 * The viewer itself - a live view of a running dev server, in this pane.
 *
 * Drives a headless Chromium at the chosen viewport, screenshots it on a loop,
 * composites a frame around it (a phone body, or nothing for web and games)
 * and paints the result here.
 *
 * The renderer is probed, not assumed: kitty graphics where available (Kitty,
 * Ghostty, WezTerm), sixel otherwise (Windows Terminal >= 1.22, xterm, foot),
 * and readable text on anything that answers neither. 'b' cycles every mode.
 *
 * Input goes through to the page: click and scroll always, and every keystroke
 * in typing mode ('i'). 'p' switches which project is being viewed, and a new
 * launch elsewhere retargets this pane rather than opening another one.
 *
 *   node tui.mjs [--target http://localhost:5173] [--preset desktop]
 *                [--interval 600] [--render auto|kitty|sixel|blocks] [--list]
 *                [--serve dev --serve-cwd DIR --serve-port 5173]
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { decodePng, resize, sharpen } from './lib/png.mjs';
import { toSixel, toHalfBlocks } from './lib/sixel.mjs';
import { toKitty, tmuxWrap, kittyClearAll } from './lib/kitty.mjs';
import { probeTerminal, pickRenderer } from './lib/caps.mjs';
import * as session from './lib/session.mjs';
import { serveStatic } from './lib/serve.mjs';
import * as projects from './lib/projects.mjs';
import * as intro from './lib/intro.mjs';
import { menuHtml, iconOf, HEAD_ROWS, ROW_H, FOOT_ROWS } from './lib/menuview.mjs';
import { EXTRACT, layoutText } from './lib/textview.mjs';
import { findDriver } from './lib/driver.mjs';
import { encodePng } from './lib/pngenc.mjs';
import { phoneGeometry, composePhone } from './lib/phone.mjs';
import { bareGeometry, composeBare } from './lib/bare.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ESC = '\x1b';
const out = (s) => process.stdout.write(s);

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const TARGET   = arg('--target', process.env.PREVIEW_TARGET || 'http://localhost:8081');
const INTERVAL = parseInt(arg('--interval', '600'), 10);
const HOST = arg('--host', 'none');     // which multiplexer this pane lives in
const RENDER   = arg('--render', 'auto');

// The dev server is started here, inside the pane, rather than by the
// launcher. The launcher usually runs as a child of an agent or shell whose
// whole process tree is torn down when its command returns, taking the dev
// server with it. This process is owned by the terminal, so anything it
// starts outlives the launch.
const SERVE      = arg('--serve', null);            // npm script to run
const SERVE_CWD  = arg('--serve-cwd', process.cwd());
const SERVE_PORT = parseInt(arg('--serve-port', '0'), 10);

// Things with no dev server - a folder of HTML, a markdown document, a single
// page - are served by livepeek itself. See lib/serve.mjs.
const STATIC_DIR  = arg('--static', null);
const STATIC_FILE = arg('--file', null);
// the launcher says which terminal pane this view belongs to (lib/session.mjs)
const SLOT_ARG = arg('--slot', null);
if (SLOT_ARG) {
  if (!session.validSlot(SLOT_ARG)) { console.error('livepeek: bad --slot ' + SLOT_ARG); process.exit(1); }
  session.useSlot(SLOT_ARG);
}

// Write the frame being shown to this PNG on every repaint, so an agent can
// look at the pane. Also requestable after the fact via the session file.
const SNAPSHOT = arg('--snapshot', null);
const WATCH_DIR = arg('--watch-dir', null);   // welcome page: switch when this folder gets content

// -------------------------------------------------------------- presets ----
function loadPresets() {
  const src = fs.readFileSync(path.join(__dirname, 'presets.js'), 'utf8');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.PRESETS;
}

const devices = loadPresets();

/** Entries without an explicit frame are phones - that is the common case. */
const frameOf = (p) => p.frame || 'phone';

if (argv.includes('--list')) {
  let brand = null;
  for (const d of devices) {
    if (d.brand !== brand) { brand = d.brand; console.log(`\n  ${brand}`); }
    console.log(`    ${d.id.padEnd(20)} ${String(d.fit ? 'pane' : d.w + 'x' + d.h).padEnd(10)} ${d.name}`);
  }
  console.log('\n  use:  --preset <id>      or click the name in the header\n');
  process.exit(0);
}

// --device is kept as an alias so phone-era invocations keep working
const wanted = arg('--preset', arg('--device', 'fit'));
let deviceIdx = devices.findIndex(d => d.id === wanted);
if (deviceIdx === -1) {
  // fail loudly rather than silently previewing something else
  console.error(`Unknown preset "${wanted}". Run with --list to see the ids.`);
  process.exit(1);
}

let landscape = false;
/**
 * A 'fit' preset has no fixed size: it takes whatever the pane can show at
 * 1:1, so the page is never scaled down and text stays sharp. Everything else
 * is shrunk to the pane, which is what makes a 1440px page look hazy.
 */
function fitSize() {
  const cols = probedSize?.cols || process.stdout.columns || 80;
  const rows = probedSize?.rows || process.stdout.rows || 24;
  const margin = 3;
  return {
    w: Math.max(320, Math.floor(Math.max(4, cols - 2) * cw) - margin * 2),
    h: Math.max(240, Math.floor(Math.max(4, rows - 4) * ch) - margin * 2),
  };
}
const device = () => {
  const d = devices[deviceIdx];
  return d.fit ? { ...d, ...fitSize() } : d;
};
const vp = () => {
  const d = device();
  return landscape ? { width: d.h, height: d.w } : { width: d.w, height: d.h };
};

// ------------------------------------------------------------- browser ----
/**
 * Find the playwright library.
 *
 * Two separate things are needed to drive a page: the playwright *library*,
 * which has no substitute, and a *browser binary*, which does - see
 * findSystemBrowser below. This resolves the first.
 *
 * Search order is the current project, this script's directory, the plugin
 * root when provided, then configured and common global npm locations.
 * Full playwright, playwright-core and patchright are accepted.
 */
function resolveChromium() {
  return findDriver(__dirname)?.chromium ?? null;
}

// livepeek downloads nothing at run time. The browser driver is one npm package,
// installed once by the user; the message says exactly which command.
export const DRIVER_HINT =
  'The browser driver is not installed. Install it once, then launch livepeek again:\n\n' +
  '  npm add --global playwright-core@1.63.0\n\n' +
  'Or per project:  npm add --save-dev playwright-core@1.63.0\n' +
  '(livepeek --doctor checks for it.)';

/**
 * A Chrome or Edge already on this machine, used as a fallback when
 * playwright is present but its own chromium was never downloaded
 * (a `playwright` dependency without its browser setup step - a very common
 * state to be in). Headless, so no window appears either way.
 */
function findSystemBrowser() {
  const configured = process.env.LIVEPEEK_BROWSER
    || process.env.PEEK_BROWSER;
  const candidates = [configured].filter(Boolean);

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(r, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    );
  }

  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/**
 * Launch headless, preferring playwright's own chromium and falling back to a
 * system browser. The error on total failure has to name the fix - this is the
 * first thing a new user hits, and "browserType.launch failed" is not a fix.
 */
async function launchBrowser(chromium) {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (bundledErr) {
    const exe = findSystemBrowser();
    if (!exe) {
      throw new Error(
        'playwright is installed but has no browser to drive, and no system\n' +
        'Chrome or Edge was found either.\n\nAdd a browser with Playwright\'s own browser setup\n(see playwright.dev, "Browsers"), or put Chrome or Edge on this machine.\n\n' +
        'Original error: ' + (bundledErr.message || bundledErr).split('\n')[0]
      );
    }
    return await chromium.launch({ headless: true, executablePath: exe, args });
  }
}

// ---------------------------------------------------------------- state ----
let browser, page;
let cw = 10, ch = 20, termBg = [12, 12, 12];
let caps = { sixel: false, kitty: false, tmux: false };
let tickTimer = null;
let lastShot = null;
let statusMsg = 'starting';
let errors = [];           // console errors and uncaught exceptions on the page
let lastFrameAt = 0;       // when the browser last answered a screenshot
let colorScheme = null;    // null = page default, 'dark' | 'light' when forced
let zoom = 1;
let textLines = [];        // text renderer: laid-out lines of the current page
let textScroll = 0;        // first line shown
let lastTextClick = { at: 0, col: -1, row: -1 };
let lastTextKey = '';      // JSON of the last extraction, for change detection
let lastStatus = null;
let paused = false;
// half-blocks until the terminal tells us it can do better - the old default
// of 'sixel' painted garbage on terminals that cannot render it
let renderMode = 'blocks';
let dirty = true;
// Bumped whenever the layout changes (device, rotation, pane size, renderer).
// A tick already waiting on a screenshot when that happens holds the old
// layout; painting it after the new one's clear leaves the old, wider picture
// showing around the new one. paint() drops a frame whose generation is stale.
let viewGen = 0;
let lastRefit = 0;        // when paint() last re-applied a viewport Chrome dropped
const SHOT_SCALE = 2;     // device pixels per CSS pixel the page is captured at
let lastLayout = null;

// When typing, every keystroke goes to the page instead of the viewer - which
// necessarily means 'q' no longer quits, so the only ways out are esc and
// ctrl+c. The footer says so loudly while it is on.
let typing = false;

// ------------------------------------------------------------- targets ----
/**
 * Dev servers this machine might be running, so the pane can be pointed at a
 * different project without being torn down and relaunched. You are usually
 * working across several things at once; the view should follow you rather
 * than make you start over.
 */
const KNOWN_PORTS = [
  [8081, 'Expo / Metro',      'iphone-15-pro'],
  [3000, 'Next / CRA / Nuxt', 'desktop'],
  [5173, 'Vite / SvelteKit',  'desktop'],
  [4321, 'Astro',             'desktop'],
  [4200, 'Angular',           'desktop'],
  [8000, 'Gatsby',            'desktop'],
  [8080, 'webpack',           'desktop'],
  [1234, 'Parcel',            'desktop'],
  [19006, 'Expo web',         'desktop'],
];

let currentTarget = TARGET;
let targets = [];

/**
 * Is anything listening on this port?
 *
 * Both address families have to be tried. Vite, and anything else that binds
 * the name "localhost" rather than an explicit address, commonly ends up on
 * [::1] only - so a v4-only probe reports a perfectly healthy dev server as
 * down, and we go start a second copy of it.
 */
function portOpen(port) {
  const attempt = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(300);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
  return Promise.all([attempt('127.0.0.1'), attempt('::1')])
    .then(results => results.some(Boolean));
}

/**
 * Start the project's dev server if nothing is on its port yet.
 *
 * Not detached: on Windows that would force a new console window, and here it
 * is unnecessary anyway - this process belongs to the terminal, so an unref'd
 * child survives on its own.
 */
async function ensureServer() {
  if (STATIC_DIR) {
    statusMsg = 'serving ' + path.basename(STATIC_DIR);
    drawFooter(lastLayout || layout());
    const { port } = await serveFolder({ root: STATIC_DIR, file: STATIC_FILE, port: SERVE_PORT || 0 });
    currentTarget = `http://localhost:${port}/`;
    return;
  }
  if (!SERVE || !SERVE_PORT || await portOpen(SERVE_PORT)) return;
  await startDevServer(SERVE, SERVE_CWD, SERVE_PORT);
}

/**
 * Serve a folder, and stop serving the one before it.
 *
 * Every switch to a document or folder starts a server; without this the old
 * ones stay listening for as long as the pane is open, each still exposing
 * its folder on localhost. The old one is closed only once the new one is up,
 * so a failed switch leaves the current view working.
 */
let staticServer = null;
async function serveFolder(opts) {
  const r = await serveStatic(opts);
  try { staticServer?.close(); } catch { /* already closed */ }
  staticServer = r.server;
  return r;
}

/** Run `npm run <script>` in cwd and wait for its port. Resolves true when up. */
async function startDevServer(script, cwd, port) {
  statusMsg = 'starting dev server';
  drawFooter(lastLayout || layout());

  spawn('npm', ['run', script], {
    cwd, stdio: 'ignore', shell: true, windowsHide: true,
  }).unref();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    if (await portOpen(port)) return true;
  }
  statusMsg = `!dev server never came up on :${port}`;
  return false;
}

// ------------------------------------------------------ shared pane state ----
let myRev = 0;
let snapshotDone = null;     // last snapshot path written, kept across publishes

/** Publish what this pane is showing, so a new launch can find and reuse it. */
/**
 * The welcome page watches the folder it was opened from: the moment an
 * index.html, .html or .md appears there, show it instead of the welcome.
 */
let watchTimer = null;
function watchFolder(dir) {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(async () => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const file = names.find(n => /^index\.html$/i.test(n)) || names.find(n => /\.html?$/i.test(n))
      || names.find(n => /^readme\.md$/i.test(n)) || names.find(n => /\.(md|markdown)$/i.test(n));
    if (!file) return;
    clearInterval(watchTimer); watchTimer = null;
    try {
      const { port } = await serveFolder({ root: dir, file: /^index\.html$/i.test(file) ? null : file });
      currentTarget = `http://localhost:${port}/`;
      shownDir = dir;
      statusMsg = 'found ' + file;
      await page.goto(currentTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
      publish();
      lastShot = null; dirty = true;
    } catch (e) { statusMsg = '!' + (e.message || 'could not serve').slice(0, 40); }
  }, 1500);
}

function publish(extra = {}) {
  session.write({
    pid: process.pid,
    host: HOST,
    target: currentTarget,
    preset: devices[deviceIdx]?.id,
    rev: myRev,
    snapshotDone,
    errors: errors.length,
    ...extra,
  });
}

/**
 * Publish, unless a launcher has written a request this pane has not picked
 * up yet. publish() rewrites the whole file, so an unprompted one - a page
 * error, a navigation - landing between a launcher's write and the next tick
 * would silently throw that request away. The request's own handling
 * publishes the fresh state shortly after.
 */
function publishIfIdle() {
  const s = session.read();
  if (s && s.pid === process.pid && s.rev !== myRev) return;
  publish();
}

/**
 * Has another launch asked this pane to do something?
 *
 * Checked on the render tick rather than with a watcher: the tick is already
 * running, and a sub-second delay on a request the user just typed elsewhere
 * is imperceptible.
 */
async function checkControl() {
  // One request at a time. A retarget can sit in startDevServer for a minute
  // and a half; a newer request waits for the next tick after it finishes.
  // Nor while a frame is being taken: navigating under a screenshot in flight
  // leaves it stuck, and Playwright queues every later one behind it.
  if (controlBusy || ticking) return;
  const s = session.read();
  if (!s || s.pid !== process.pid || s.rev === myRev) return;

  myRev = s.rev;
  // A retarget navigates and resizes; a screenshot landing in the middle of
  // that occasionally captured the new page at the old page's layout size.
  // Hold the render loop off until the whole sequence has settled.
  controlBusy = true;
  try { await controlScope.run(true, () => applyControl(s)); }
  catch (e) { publish({ error: String(e.stack || e.message || e).slice(0, 600) }); }
  finally { controlBusy = false; }
}
let controlBusy = false;
// Marks the paints a control request asks for itself. While one is running,
// only those may take a screenshot: a click or a resize forcing a frame in
// the middle of its navigation would stall that frame for seconds.
const controlScope = new AsyncLocalStorage();

async function applyControl(s) {

  if (s.quit) return shutdown();

  // Asked to show something else: the welcome screen would cover it. A bare
  // eval or snapshot leaves it up; those read the project behind it anyway.
  if (welcomeOn && (s.target !== currentTarget || s.preset !== devices[deviceIdx]?.id || s.static)) dismissWelcome();

  // run a snippet in the page and report back - lets an agent read state
  // (text on screen, a counter, layout size) instead of guessing from pixels
  if (s.eval) {
    let evalResult;
    try { evalResult = { ok: true, value: await page.evaluate(s.eval) }; }
    catch (e) { evalResult = { ok: false, error: String(e.message || e) }; }
    publish({ eval: null, evalResult });
    if (!s.snapshot && s.target === currentTarget && s.preset === devices[deviceIdx]?.id && !s.static) return;
  }

  // a one-off "show me what you're showing" from outside. The previous
  // snapshotDone is forgotten first: the launcher waits for it to name this
  // file, and a retarget publishes several times before the snapshot is taken.
  if (s.snapshot) snapshotDone = null;
  const takeSnapshot = async () => {
    await tick(true);
    writeSnapshot(s.snapshot);
    snapshotDone = s.snapshot;
    publish({ snapshot: null });
  };
  // A bare snapshot request changes nothing else about the view, so take it
  // now. One that came with a retarget waits until the end: taken here it
  // would show the page being navigated away from.
  if (s.snapshot && s.target === currentTarget && s.preset === devices[deviceIdx]?.id && !s.static && !s.serve) {
    return takeSnapshot();
  }

  if (s.preset) {
    const i = devices.findIndex(d => d.id === s.preset);
    if (i !== -1) deviceIdx = i;
  }

  // retargeted at a folder or document rather than a server: serve it here
  if (s.static) {
    try {
      const { port } = await serveFolder({ root: s.static, file: s.file || null });
      s.target = `http://localhost:${port}/`;
    } catch (e) {
      statusMsg = '!' + (e.message || 'could not serve').slice(0, 40);
    }
    publish({ static: null, file: null });
  }

  if (s.serve && s.serve.port && !(await portOpen(s.serve.port))) {
    await startDevServer(s.serve.script, s.serve.cwd, s.serve.port);
  }
  if (s.serve) publish({ serve: null });
  if (s.watch) { watchFolder(s.watch); publish({ watch: null }); }
  // the user has moved on to something real: stop waiting for the welcome
  // folder, or it would yank the view back the moment a file lands there
  // (s.target is always present - every request carries the last published
  // one - so only a different target counts as moving on)
  else if (watchTimer && ((s.target && s.target !== currentTarget) || s.static || s.serve)) {
    clearInterval(watchTimer); watchTimer = null;
  }

  if (s.target && s.target !== currentTarget) {
    currentTarget = s.target;
    statusMsg = 'loading';
    drawFooter(lastLayout || layout());
    try {
      await page.setViewportSize(vp());     // load at the new size, not the old page's
      await page.goto(currentTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      statusMsg = '!no server at ' + currentTarget;
    }
  }

  await applyViewport();
  if (s.snapshot) await takeSnapshot();
}

/** Everything currently listening, probed in parallel so this stays snappy. */
async function scanTargets() {
  // Saved projects come first: those are folders the user can always go back
  // to. A running dev server nobody launched through livepeek is appended so it
  // is still reachable.
  const saved = projects.list();
  const found = await Promise.all(saved.map(async p => {
    const running = p.url ? (p.port ? await portOpen(p.port) : false) : true;
    return {
      label: p.name, sub: `${p.kind}  ${shortDir(p.dir)}`,
      url: p.url, dir: p.dir, file: p.file, script: p.script, port: p.port,
      preset: p.preset, running, static: !p.url,
    };
  }));
  const seen = new Set(found.map(t => t.url).filter(Boolean));
  await Promise.all(KNOWN_PORTS.map(async ([port, label, preset]) => {
    const url = `http://localhost:${port}`;
    if (seen.has(url) || !(await portOpen(port))) return;
    found.push({ label: `localhost:${port}`, sub: label, url, port, preset, running: true, static: false });
  }));
  return found;
}

/** `C:/Users/me/code/app` -> `~/code/app`, so the picker stays narrow. */
function shortDir(dir) {
  const home = os.homedir();
  const d = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return d.split('\\').join('/');
}

let menuMode = 'preset';          // 'preset' | 'target'
let menuOpen = false;
let menuHover = -1;
let menuFirst = -1;      // first entry in view; -1 centres the selection on the next draw
let menuBox = null;      // {top,left,width,height,first,count, rowH,rows,image}
let headerHit = null;    // {row,col0,col1}

const C = {
  dim:   (s) => `${ESC}[38;5;244m${s}${ESC}[0m`,
  bold:  (s) => `${ESC}[1m${s}${ESC}[0m`,
  ok:    (s) => `${ESC}[38;5;41m${s}${ESC}[0m`,
  bad:   (s) => `${ESC}[38;5;203m${s}${ESC}[0m`,
  sel:   (s) => `${ESC}[48;5;24m${ESC}[38;5;231m${s}${ESC}[0m`,
  head:  (s) => `${ESC}[38;5;75m${s}${ESC}[0m`,
  // typing mode is a modal state that changes what every key does, so it gets
  // a reversed badge rather than just a colour
  key:   (s) => `${ESC}[48;5;178m${ESC}[38;5;16m ${s} ${ESC}[0m`,
};

// ---------------------------------------------------------------- paint ----
// A pane Windows Terminal has just split answers every size question with
// the parent window's dimensions for its first moments, and process.stdout
// is not corrected by a resize event afterwards. So the pane asks again,
// shortly after start, where a cursor parked at the far corner ends up; that
// reply is the real pane size and wins over process.stdout until a genuine
// resize event arrives. See askSize() and the 'size' event.
let probedSize = null;
function askSize() { out(`${ESC}[999;999H${ESC}[6n`); }
async function applySize(rows, cols) {
  const L = lastLayout || layout();
  if (rows === L.rows && cols === L.cols) return;
  probedSize = { rows, cols };
  menuKey = null;                   // an in-flight picker render is the old size
  viewGen++;
  dirty = true; lastShot = null; lastTextKey = '';
  if (devices[deviceIdx]?.fit) return applyViewport();   // the page is sized from the pane
  await tick(true);
}
function layout() {
  const cols = probedSize?.cols || process.stdout.columns || 80;
  const rows = probedSize?.rows || process.stdout.rows || 24;

  const geom = frameOf(device()) === 'phone'
    ? phoneGeometry(device(), landscape)
    : bareGeometry(device(), landscape);

  // Row 1 is the header, the last row is the footer. The image starts on row
  // 2, so it must end at least one row short of the footer - if a sixel's
  // bottom reaches the final row the terminal scrolls, which pushes the
  // header off the top of the pane.
  const availCols = Math.max(4, cols - 2);
  const availRows = Math.max(4, rows - 4);
  const availPxW = availCols * cw;
  const availPxH = availRows * ch;

  const margin = 3;
  const scale = Math.min(
    availPxW / (geom.bodyW + margin * 2),
    availPxH / (geom.bodyH + margin * 2),
  );

  const W = Math.round(geom.bodyW * scale) + Math.ceil(margin * scale) * 2;
  const H = Math.round(geom.bodyH * scale) + Math.ceil(margin * scale) * 2;

  const imgCols = Math.max(1, Math.ceil(W / cw));
  const imgRows = Math.max(1, Math.ceil(H / ch));
  const left = Math.max(1, Math.floor((cols - imgCols) / 2) + 1);
  const top = 2;

  return { cols, rows, geom, scale, W, H, imgCols, imgRows, left, top, margin };
}

function drawHeader(L) {
  const d = device();
  const v = vp();
  const label = ` ${d.name} `;
  // dpr only means something for a real device; a web or canvas viewport has
  // no business claiming one
  let meta = frameOf(d) === 'phone'
    ? `${v.width}x${v.height}  @${d.dpr}x  ${d.os}${landscape ? '  landscape' : ''}`
    : `${v.width}x${v.height}  ${d.os}${landscape ? '  landscape' : ''}`;

  // drop the metadata before letting the header wrap
  if (zoom !== 1) meta += `  ×${zoom}`;
  if (colorScheme) meta += `  ${colorScheme}`;
  const budget = L.cols - label.length - 5;
  if (meta.length > budget) meta = budget > 1 ? meta.slice(0, budget - 1) + '…' : '';

  out(`${ESC}[1;1H${ESC}[2K`);
  out(' ' + C.head(label + '▾') + (meta ? '  ' + C.dim(meta) : ''));
  // the clickable region is the name plus its chevron
  headerHit = { row: 1, col0: 2, col1: 2 + label.length };
}

function drawFooter(L) {
  const plainState = typing
    ? 'typing'
    : paused
      ? 'paused'
      : statusMsg.startsWith('!') ? statusMsg.slice(1) : statusMsg;
  const colour = typing
    ? C.key
    : (paused || statusMsg.startsWith('!')) ? C.bad : C.ok;

  // truncate the hint rather than let it wrap - a wrapped footer scrolls the
  // pane and takes the header with it
  //
  // In typing mode 'q' types a q instead of quitting, so the way out has to be
  // on screen: a user who cannot find it has to kill the process. Otherwise,
  // naming the renderer matters on a machine we have never seen - if the view
  // looks like mush, this says which mode produced it and 'b' changes it.
  // The badge is padded by a space on each side, and a line that ends in the
  // last column puts the terminal into pending-wrap: the next byte scrolls
  // the pane up a row. Leave a margin, and switch autowrap off while drawing.
  const budget = L.cols - plainState.length - 8;
  // In a narrow pane, drop the least important items first rather than cut
  // the line off at the end. Quit is the last to go, then the device picker
  // (the header looks like a label until you know it is a menu), then help.
  const sep = '  ·  ';
  const items = typing
    ? ['keys go to the page', 'esc to stop typing', 'ctrl+c quits']
    : [renderMode, 'i type', 'p project', 'space device', 'shift+? help', 'q quit'];
  if (!typing && errors.length) items.unshift(C.bad(`${errors.length} error${errors.length === 1 ? '' : 's'}  e`));
  // most important first; the error badge, when present, is index 0 and wins
  const order = typing ? [2, 1, 0] : errors.length ? [0, 6, 4, 5, 3, 2, 1] : [5, 3, 4, 2, 1, 0];
  let chosen = [];
  for (const i of order) {
    const next = [...chosen, i].sort((x, y) => x - y);
    const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible(next.map(j => items[j]).join(sep)).length > budget) break;
    chosen = next;
  }
  const hint = chosen.map(j => items[j]).join(sep);

  out(`${ESC}[?7l${ESC}[${L.rows};1H${ESC}[2K ${colour(plainState)}  ${C.dim(hint)}${ESC}[?7h`);
  lastStatus = statusMsg + (paused ? ':p' : '') + renderMode + (typing ? ':t' : '') + ':' + errors.length;
}

/** Rows for whichever list the picker is currently showing. */
function menuItems() {
  if (menuMode === 'target') {
    return targets.map((t, i) => ({
      idx: i,
      name: `${t.label}  ${t.sub}`,
      label: t.label, sub: t.sub,
      right: isShowing(t) ? 'showing' : t.running ? 'running' : 'stopped',
      active: isShowing(t),
    }));
  }
  const q = menuFilter.toLowerCase();
  return devices
    .map((d, i) => ({
      name: d.name, right: d.fit ? 'pane size' : `${d.w}x${d.h}`, active: i === deviceIdx, idx: i,
      hay: (d.brand + ' ' + d.name + ' ' + d.os + ' ' + d.id).toLowerCase(),
    }))
    .filter(it => !q || it.hay.includes(q));
}
let menuFilter = '';

/** Is this picker entry the one on screen right now? */
function isShowing(t) {
  if (t.url) return currentTarget.startsWith(t.url);
  return !!shownDir && t.dir === shownDir;
}
let shownDir = STATIC_DIR || null;

function drawMenu(L) {
  if ((renderMode === 'sixel' || renderMode === 'kitty') && browser && menuSlots(L) >= 3) return drawMenuImage(L);
  drawMenuText(L);
}

function drawMenuText(L) {
  const items = menuItems();
  if (!items.length) {
    out(`${ESC}[2;2H${C.head(` no match for "${menuFilter}" - backspace to clear `)}`);
    menuBox = null;
    return;
  }

  const maxName = Math.max(...items.map(it => it.name.length));
  const width = Math.min(L.cols - 2, maxName + 14);
  const maxRows = Math.max(3, L.rows - 4);
  const count = Math.min(items.length, maxRows);

  // Keep the selection in view when the list is taller than the pane. The
  // anchor is the hovered row, not the active entry, so arrowing down past
  // the bottom scrolls the list instead of walking off it.
  const active = items.findIndex(it => it.active);
  const anchor = menuHover >= 0 ? menuHover : Math.max(0, active);
  const first = menuWindow(items.length, count, anchor);

  const left = 2;
  const top = 3;                       // row 2 is the title / filter line
  menuBox = { top, left, width, height: count, first, count, total: items.length };

  const title = menuMode === 'target'
    ? ' p  switch project'
    : ` device  ${menuFilter ? 'filter: ' + menuFilter : 'type to filter'}`;
  out(`${ESC}[2;${left}H${C.head(title.padEnd(width))}`);

  for (let i = 0; i < count; i++) {
    const idx = first + i;
    const it = items[idx];
    const mark = it.active ? '•' : ' ';
    const text = ` ${mark} ${it.name}`.padEnd(width - it.right.length - 2) + it.right + ' ';
    const row = top + i;
    out(`${ESC}[${row};${left}H`);
    out(idx === menuHover ? C.sel(text) : `${ESC}[48;5;236m${ESC}[38;5;252m${text}${ESC}[0m`);
  }
}

// ------------------------------------------------------ picker image ----
// With an image renderer the picker is a picture (see lib/menuview.mjs): laid
// out in a private tab, screenshotted, painted over the page. Rendering is
// async, so draws only record the newest state and one loop renders it; a
// state seen before comes from the cache and paints at once, which keeps
// hover and arrow keys responsive.
let menuTab = null;
let menuTabP = null;
let menuWant = null;          // newest picker state waiting for a render
let menuKey = null;           // the state that should be on screen now
let menuRendering = false;
let menuShownKey = null;      // the state of the picture actually on screen
const menuCache = new Map();  // state -> encoded image sequence

/** Entries that fit: the panel ends where the page image does, clear of the footer. */
function menuSlots(L) {
  return Math.floor((L.rows - 5 - HEAD_ROWS - FOOT_ROWS) / ROW_H);
}

function drawMenuImage(L) {
  const items = menuItems();
  // The panel is sized for the whole list, not the filtered one, so it never
  // shrinks while typing and leaves nothing behind to clean up.
  const all = menuMode === 'target' ? targets : devices;
  const slots = Math.max(1, Math.min(menuSlots(L), all.length));
  const count = Math.min(items.length, slots);
  const active = items.findIndex(it => it.active);
  const anchor = menuHover >= 0 ? menuHover : Math.max(0, active);
  const first = menuWindow(items.length, count, anchor);

  const maxName = Math.max(10, ...all.map(x => (x.label || x.name || '').length));
  const width = Math.min(L.cols - 2, Math.max(36, Math.min(60, Math.ceil(maxName * 0.8) + 24)));
  const rows = HEAD_ROWS + slots * ROW_H + FOOT_ROWS + 1;
  menuBox = { top: 2 + HEAD_ROWS, left: 2, width, height: count * ROW_H, rowH: ROW_H, first, count, total: items.length, rows, image: true };

  const view = {
    cw, ch, bg: termBg,
    title: menuMode === 'target' ? 'Project' : 'Device',
    filter: menuFilter,
    placeholder: menuMode === 'target' ? 'Pick a project' : 'Type to filter',
    first, total: items.length,
    empty: items.length ? '' : menuMode === 'target' ? 'No projects yet' : `No device matches "${menuFilter}"`,
    rows: items.slice(first, first + count).map((it, i) => {
      const d = menuMode === 'target' ? null : devices[it.idx];
      return {
        name: d ? d.name : it.label, sub: d ? (d.brand === d.os ? d.os : `${d.brand} · ${d.os}`) : it.sub,
        right: it.right, active: it.active, hover: first + i === menuHover, icon: iconOf(d),
      };
    }),
  };
  const size = { width: Math.round(width * cw), height: Math.round(rows * ch) };
  const key = JSON.stringify([view, size, renderMode]);
  menuKey = key;
  const seq = menuCache.get(key);
  if (seq) { menuWant = null; paintMenu(seq, key); return; }
  menuWant = { key, view, size, mode: renderMode };
  if (!menuRendering) renderMenuImages();
}

function paintMenu(seq, key) {
  menuShownKey = key;
  out(`${ESC}[2;2H`);
  out(caps.tmux ? tmuxWrap(seq) : seq);
}

function warmMenuTab() {
  menuTabP ||= browser.newPage({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 1 });
  return menuTabP;
}

async function renderMenuImages() {
  menuRendering = true;
  try {
    while (menuWant) {
      const { key, view, size, mode } = menuWant;
      menuWant = null;
      menuTab ||= await warmMenuTab();
      const v = menuTab.viewportSize();
      if (!v || v.width !== size.width || v.height !== size.height) await menuTab.setViewportSize(size);
      await menuTab.setContent(menuHtml(view));
      const img = decodePng(await menuTab.screenshot({ type: 'png' }));
      const seq = mode === 'kitty' ? toKitty(img, { id: 2 }) : toSixel(img, 256);
      if (menuCache.size > 80) menuCache.clear();
      menuCache.set(key, seq);
      // only if nothing newer was drawn or queued meanwhile, and still open
      if (key === menuKey && menuOpen && menuBox?.image) paintMenu(seq, key);
    }
  } catch {
    // leave the picker as it is; the next draw tries again with a fresh tab
    menuTab = null; menuTabP = null;
  } finally {
    menuRendering = false;
  }
}

/**
 * Which entry the list starts at. The window stays where it is (the wheel and
 * the keys move it) instead of following the pointer, so hovering near the
 * edge does not slide the list out from under the mouse.
 */
function menuWindow(total, count, anchor) {
  if (total <= count) return (menuFirst = 0);
  if (menuFirst < 0) menuFirst = anchor - (count >> 1);
  else if (anchor < menuFirst) menuFirst = anchor;
  else if (anchor >= menuFirst + count) menuFirst = anchor - count + 1;
  return (menuFirst = Math.max(0, Math.min(menuFirst, total - count)));
}

/** Apply row `idx` of whichever list is open. */
async function menuSelect(pos) {
  const item = menuItems()[pos];
  if (!item) { closeMenu(); return tick(true); }
  const idx = item.idx;
  if (menuMode === 'target') {
    // a project picked by hand replaces the welcome page for good
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    const t = targets[idx];
    closeMenu();
    if (!t) return tick(true);

    if (t.static) {
      // a folder or a document: livepeek serves it itself
      statusMsg = 'serving ' + path.basename(t.dir);
      drawFooter(lastLayout || layout());
      try {
        const { port } = await serveFolder({ root: t.dir, file: t.file || null });
        currentTarget = `http://localhost:${port}/`;
        shownDir = t.dir;
      } catch (e) {
        statusMsg = '!' + (e.message || 'could not serve').slice(0, 40);
        return tick(true);
      }
    } else {
      shownDir = null;
      if (!t.running && t.script && t.port) {
        const ok = await startDevServer(t.script, t.dir, t.port);
        if (!ok) return tick(true);
      }
      currentTarget = t.url;
    }
    publish();
    const pi = devices.findIndex(d => d.id === t.preset);
    if (pi !== -1) deviceIdx = pi;

    statusMsg = 'loading';
    drawFooter(lastLayout || layout());
    try {
      await page.goto(currentTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      statusMsg = '!no server at ' + t.label;
    }
    return applyViewport();
  }

  deviceIdx = idx;
  closeMenu();
  return applyViewport();
}

/** Paint the page as text. Rows map to lines; spans remember what is clickable. */
function paintText(L) {
  const width = Math.max(10, L.cols - 4);
  const rows = Math.max(1, L.rows - 3);
  textScroll = Math.max(0, Math.min(textScroll, Math.max(0, textLines.length - rows)));
  for (let r = 0; r < rows; r++) {
    const ln = textLines[textScroll + r];
    out(`${ESC}[${2 + r};1H${ESC}[2K`);
    if (ln) out(`  ${ln.text.slice(0, width + 200)}`);   // ANSI codes are not cells; the layout already fits
  }
  if (textLines.length > rows) {
    const pct = Math.round(100 * Math.min(1, (textScroll + rows) / textLines.length));
    out(`${ESC}[${L.rows - 1};${Math.max(1, L.cols - 6)}H${C.dim(String(pct).padStart(3) + '%')}`);
  }
}

/** Which element sits under a cell, in text mode. */
function textHit(col, row) {
  const ln = textLines[textScroll + (row - 2)];
  if (!ln) return null;
  const c = col - 3;                 // two cells of margin, 1-based columns
  return ln.spans.find(s => c >= s.c0 && c < s.c1) || null;
}

function paintImage(L, composed) {
  if (renderMode === 'text') { paintText(L); return; }
  if (renderMode === 'blocks') {
    const img = resize(composed, L.imgCols, L.imgRows * 2);
    toHalfBlocks(img).forEach((line, i) => {
      out(`${ESC}[${L.top + i};${L.left}H${line}`);
    });
    return;
  }

  const seq = renderMode === 'kitty' ? toKitty(composed) : toSixel(composed, 256);
  out(`${ESC}[${L.top};${L.left}H`);
  // tmux drops graphics sequences it does not recognise unless they are
  // wrapped; half-blocks are plain text and need no wrapping.
  out(caps.tmux ? tmuxWrap(seq) : seq);
}

/**
 * Step through every renderer, not just the ones we detected.
 *
 * Detection is a best guess - a terminal can claim sixel and render it badly,
 * or support kitty graphics through a multiplexer that eats the reply. This
 * key is the escape hatch when the guess is wrong, so it must be able to
 * reach a mode the probe ruled out.
 */
function cycleRenderer() {
  const order = ['kitty', 'sixel', 'text', 'blocks'];
  renderMode = order[(order.indexOf(renderMode) + 1) % order.length];
  lastShot = null; lastTextKey = ''; textScroll = 0;
  menuKey = null;         // an in-flight picker render is in the old renderer
  viewGen++;
  dirty = true;
}

function render(L, shotPng) {
  if (renderMode === 'text') {
    L.screenRect = null;
    paintText(L);
    lastComposed = null;
    if (SNAPSHOT) writeSnapshot(SNAPSHOT);
    return;
  }
  const geom = L.geom;
  const sw = Math.max(1, Math.round(geom.screenW * L.scale));
  const sh = Math.max(1, Math.round(geom.screenH * L.scale));
  let shot = resize(decodePng(shotPng), sw, sh);
  // Sixel only: kitty graphics are drawn at real pixels and stay sharp.
  // Windows Terminal stretches sixels from 10x20 pixel cells to the real
  // ones, so it gets more (see sharpen in lib/png.mjs).
  if (renderMode === 'sixel') shot = sharpen(shot, process.env.WT_SESSION ? 0.9 : 0.4);

  const compose = geom.frame === 'none' ? composeBare : composePhone;
  const composed = compose({
    geom, scale: L.scale, shot, bg: termBg, margin: L.margin,
  });

  L.screenRect = composed.screenRect;
  paintImage(L, composed);
  // Windows Terminal clears the footer row when a sixel lands above it, so
  // the footer is redrawn after every image paint. One line; it is cheap.
  if (renderMode !== 'text') { lastStatus = null; drawFooter(L); }
  lastComposed = composed;
  if (SNAPSHOT) writeSnapshot(SNAPSHOT);
}

let lastComposed = null;

/** Write what the pane is showing - the raw page, not the scaled-down pane
 *  frame, so text is legible when an agent reads it back. */
function writeSnapshot(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });   // e.g. .livepeek/ on first use
    if (lastShot) fs.writeFileSync(file, lastShot);          // page screenshot, full res
    else if (lastComposed) fs.writeFileSync(file, encodePng(lastComposed));
  } catch { /* a snapshot is never worth crashing the view */ }
}

/**
 * Prove this pane is alive: touch the heartbeat file, at most every 2 s.
 * session.current() treats a pane whose heartbeat is older than 10 s as gone,
 * whatever its pid says. Runs before any of tick's early returns, so a
 * paused or busy pane still counts as open.
 */
let lastBeat = 0;
let startBeat = null;        // beats while main() is still starting up
function beat() {
  const now = Date.now();
  if (now - lastBeat < 2000) return;
  lastBeat = now;
  try { const t = new Date(now); fs.utimesSync(session.BEAT, t, t); }
  catch { try { fs.writeFileSync(session.BEAT, ''); } catch { /* not worth failing over */ } }
}

// The timer fires every INTERVAL ms whether or not the last frame has
// finished; a slow screenshot would otherwise stack ticks up behind it.
// Forced ticks (input, control requests) still go through. A count rather
// than a flag, so a forced tick finishing does not clear it for a slow one
// still in flight.
let ticking = 0;
async function tick(force = false) {
  beat();
  if (ticking && !force) return;
  ticking++;
  try { await paint(force); } finally { ticking--; }
}

async function paint(force) {
  if (!page || (paused && !force)) return;
  if (controlBusy && !controlScope.getStore()) return;   // dirty stays set; the request repaints
  const L = layout();
  const gen = viewGen;
  // The screen rect is only computed when a frame is painted. A static page
  // paints rarely, so carry it over - without it clicks map to nothing.
  if (lastLayout?.screenRect && !dirty) L.screenRect = lastLayout.screenRect;
  lastLayout = L;
  try {
    // A page stuck in a tight loop never answers the screenshot; without a
    // timeout the pane would sit on the last good frame looking perfectly live.
    // Playwright's own timeout, not a race: a raced screenshot kept running
    // and every later one queued behind it, so the pane never recovered.
    const shot = await page.screenshot({ type: 'png', timeout: 4000 }).catch((e) => {
      throw e?.name === 'TimeoutError' ? new Error('page not responding') : e;
    });
    lastFrameAt = Date.now();
    // the layout changed while this screenshot was taken: the tick that
    // changed it paints instead (dirty is left set, so one always does)
    if (gen !== viewGen) return;

    // Chrome now and then drops a viewport change (one that lands while the
    // page reloads, say): the page stays laid out for the old size while the
    // header names the new device. The frame's own size gives that away.
    const want = vp();
    if (shot.readUInt32BE(16) !== want.width * SHOT_SCALE || shot.readUInt32BE(20) !== want.height * SHOT_SCALE) {
      if (Date.now() - lastRefit > 1000) {
        lastRefit = Date.now();
        await applyViewport();      // awaited: a snapshot must not get this frame
        return;
      }
    }

    if (welcomeOn) {
      // the project keeps loading behind the welcome screen, and a snapshot
      // asked for meanwhile is of the project
      lastShot = shot;
      if (SNAPSHOT) writeSnapshot(SNAPSHOT);
      if (dirty || !welcomePainted) {
        if (dirty) {
          if (caps.kitty || renderMode === 'kitty') out(caps.tmux ? tmuxWrap(kittyClearAll()) : kittyClearAll());
          out(`${ESC}[2J`);
          drawHeader(L);
          dirty = false;
        }
        const WL = welcomeLayout(L);
        const frame = await welcomeFrame(WL);
        if (gen !== viewGen || !welcomeOn) return;   // resized or dismissed meanwhile
        paintImage(WL, frame);
        welcomePainted = true;
        lastStatus = null;   // Windows Terminal wipes the footer under a new sixel
      }
      statusMsg = 'live';
      if (statusMsg + (paused ? ':p' : '') + renderMode + ':' + errors.length !== lastStatus) drawFooter(L);
      return;
    }

    let changed = !lastShot || Buffer.compare(shot, lastShot) !== 0;

    if (renderMode === 'text') {
      // the picture is only kept for snapshots; what we paint is the DOM
      const ex = await page.evaluate(EXTRACT);
      if (gen !== viewGen) return;
      const key = JSON.stringify(ex.blocks);
      if (key !== lastTextKey || dirty) {
        lastTextKey = key;
        textLines = layoutText(ex.blocks, Math.max(10, L.cols - 4));
        changed = true;
      } else changed = false;
    }

    if (changed || dirty) {
      lastShot = shot;
      if (dirty) {
        // placed images survive ESC[2J, so they have to be deleted explicitly
        if (caps.kitty || renderMode === 'kitty') out(caps.tmux ? tmuxWrap(kittyClearAll()) : kittyClearAll());
        out(`${ESC}[2J`);
        drawHeader(L);
        dirty = false;
      }
      render(L, shot);
      if (menuOpen) drawMenu(L);
      if (overlay) drawOverlay(L);   // a new frame paints over it otherwise
    }
    statusMsg = 'live';
  } catch (e) {
    statusMsg = '!' + (e.message || 'screenshot failed').split('\n')[0].slice(0, 40);
    dirty = true;
  }
  if (statusMsg + (paused ? ':p' : '') + renderMode + ':' + errors.length !== lastStatus) drawFooter(L);
}

// ----------------------------------------------------------- page input ----
/** Terminal cell -> page coordinate, or null if the cell isn't over the screen. */
function cellToPage(col, row) {
  const L = lastLayout;
  if (!L || !L.screenRect) return null;

  const pxPerColX = renderMode === 'blocks' ? L.W / L.imgCols : cw;
  const pxPerColY = renderMode === 'blocks' ? L.H / L.imgRows : ch;

  const ix = (col - L.left + 0.5) * pxPerColX;
  const iy = (row - L.top + 0.5) * pxPerColY;

  const x = (ix - L.screenRect.x) / L.scale;
  const y = (iy - L.screenRect.y) / L.scale;
  const v = vp();
  if (x < 0 || y < 0 || x >= v.width || y >= v.height) return null;
  return { x, y };
}

async function handleMouse(code, col, row, press) {
  // Motion arrives as a press too while any-motion reporting is on; only a
  // real click or scroll closes the welcome screen or an overlay.
  if ((welcomeOn || overlay) && (!press || (code & 32))) return;
  if (welcomeOn) {
    // clicking the device name it points at goes straight to the picker
    const onHeader = headerHit && row === headerHit.row && col >= headerHit.col0 && col <= headerHit.col1 && (code & 3) === 0;
    dismissWelcome();
    if (onHeader) openMenu();
    return tick(true);
  }
  if (overlay) { closeOverlay(); await tick(true); return; }
  // menu takes precedence while it's open
  if (menuOpen) {
    const inMenu = menuBox && row >= menuBox.top && row < menuBox.top + menuBox.height
                            && col >= menuBox.left && col < menuBox.left + menuBox.width;
    const rowH = menuBox?.rowH || 1;
    const at = inMenu ? menuBox.first + Math.floor((row - menuBox.top) / rowH) : -1;
    // the picture renders asynchronously; until the new one is up, its rows
    // are not the rows on screen, so hover and clicks on them wait
    const stale = menuBox?.image && menuShownKey !== menuKey;
    // the picture's search field and key hints are part of the menu too
    const inPanel = menuBox?.image && row >= 2 && row < 2 + menuBox.rows
                    && col >= menuBox.left && col < menuBox.left + menuBox.width;
    if (press && (code & 64) && (code & 3) < 2) {   // wheel scrolls the list
      const step = (code & 1 ? 1 : -1) * (menuBox?.image ? 2 : 3);
      const first = menuBox ? menuBox.first : 0;
      menuFirst = Math.max(0, Math.min(first + step, (menuBox?.total || 0) - (menuBox?.count || 0)));
      // keep the highlight on whatever is now under the pointer
      const n = menuBox?.count || 1;
      if (inMenu) menuHover = Math.min(menuItems().length - 1, menuFirst + Math.floor((row - menuBox.top) / rowH));
      else menuHover = Math.max(menuFirst, Math.min(menuHover, menuFirst + n - 1));
      drawMenu(lastLayout || layout());
      return;
    }
    if (code === 35 || code === 32) {           // motion
      if (stale) return;
      const h = at;
      if (h !== menuHover) { menuHover = h; drawMenu(lastLayout); }
      return;
    }
    if (press && code === 0) {
      if (inMenu) {
        if (!stale) await menuSelect(at);
      } else if (!inPanel) {
        closeMenu();
        await tick(true);
      }
    }
    return;
  }

  // Everything below talks to the page as a real pointer would: hover,
  // press/release (so drags and text selection work), right and middle
  // buttons, double-clicks and wheel in both axes. Chromium does the rest.
  const pt = cellToPage(col, row);
  const button = code & 3;                       // 0 left, 1 middle, 2 right
  const moving = (code & 32) !== 0;
  const wheel = (code & 64) !== 0;

  if (wheel && renderMode === 'text') {
    const dir = code & 3;
    textScroll += dir === 0 ? -3 : dir === 1 ? 3 : 0;
    paintText(lastLayout || layout());
    return;
  }
  if (press && renderMode === 'text' && button === 0) {
    if (headerHit && row === headerHit.row && col >= headerHit.col0 && col <= headerHit.col1) { openMenu(); return; }
    const hit = textHit(col, row);
    if (!hit) return;
    // VS Code's terminal has been seen delivering one click as two presses
    // on the same cell a few ms apart; no human clicks twice in 120 ms
    const nowT = Date.now();
    if (nowT - lastTextClick.at < 120 && lastTextClick.col === col && lastTextClick.row === row) return;
    lastTextClick = { at: nowT, col, row };
    try {
      await page.evaluate((id) => {
        const el = document.querySelector('[data-livepeek-id="' + id + '"]');
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        if (el.matches('input,textarea,select')) { el.focus(); if (el.type === 'checkbox' || el.type === 'radio') el.click(); }
        else el.click();
      }, hit.id);
    } catch { /* mid-navigation */ }
    lastTextKey = '';
    await tick(true);
    return;
  }
  if (moving && renderMode === 'text') return;
  if (wheel) {
    if (!pt) return;
    const dir = code & 3;                        // 0 up, 1 down, 2 left, 3 right
    const dx = dir === 2 ? -120 : dir === 3 ? 120 : 0;
    const dy = dir === 0 ? -120 : dir === 1 ? 120 : 0;
    try { await page.mouse.move(pt.x, pt.y); await page.mouse.wheel(dx, dy); } catch { /* mid-navigation */ }
    await tick(true);
    return;
  }

  if (moving) {
    // Hover and drag. Throttled: a touchpad reports hundreds of moves a second
    // and each one is a round trip to the browser.
    if (!pt) return;
    const now = Date.now();
    if (now - lastMoveAt < 30) return;
    lastMoveAt = now;
    try { await page.mouse.move(pt.x, pt.y); } catch { /* ignore */ }
    if (mouseDown) await tick(true);             // show the drag as it happens
    return;
  }

  if (press) {
    if (headerHit && row === headerHit.row && col >= headerHit.col0 && col <= headerHit.col1 && button === 0) {
      openMenu();
      return;
    }
    if (!pt) return;
    const name = button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
    const now = Date.now();
    const dbl = name === 'left' && now - lastClickAt < 400
      && Math.abs(pt.x - lastClickPt.x) < 6 && Math.abs(pt.y - lastClickPt.y) < 6;
    lastClickAt = dbl ? 0 : now;
    lastClickPt = pt;
    mouseDown = name;
    try {
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.down({ button: name, clickCount: dbl ? 2 : 1 });
    } catch { /* ignore */ }
    return;
  }

  // release
  if (mouseDown) {
    const name = mouseDown;
    mouseDown = null;
    try {
      if (pt) await page.mouse.move(pt.x, pt.y);
      await page.mouse.up({ button: name });
    } catch { /* ignore */ }
    await tick(true);
  }
}

let mouseDown = null;
let lastMoveAt = 0;
let lastClickAt = 0;
let lastClickPt = { x: -99, y: -99 };

/** Re-apply zoom and the focus ring to whatever page is now loaded. */
async function applyPageState() {
  try {
    await page.evaluate((z) => { document.documentElement.style.zoom = z === 1 ? '' : String(z); }, zoom);
    // A keyboard user tabs between controls; without a ring there is no way to
    // tell which one has focus from a screenshot. Only shows for keyboard focus.
    await page.addStyleTag({ content: ':focus-visible{outline:3px solid #ff7cc8!important;outline-offset:2px!important}' });
  } catch { /* mid-navigation */ }
}

/** Copy the current page frame to the system clipboard as an image. */
async function copyFrame() {
  if (!lastShot) return;
  // A private folder rather than a fixed name in the shared temp dir, which
  // another user or process could have planted something at.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livepeek-'));
  const tmp = path.join(dir, 'clip.png');
  fs.writeFileSync(tmp, lastShot);
  const { spawnSync } = await import('node:child_process');
  let r;
  if (process.platform === 'win32') {
    // inside a PowerShell single-quoted string, a quote is written twice
    const lit = tmp.replace(/'/g, "''");
    r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $i=[System.Drawing.Image]::FromFile('${lit}'); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`],
      { windowsHide: true, encoding: 'utf8' });
  } else if (process.platform === 'darwin') {
    r = spawnSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)`], { encoding: 'utf8' });
  } else {
    r = spawnSync('sh', ['-c', `wl-copy -t image/png < "${tmp}" 2>/dev/null || xclip -selection clipboard -t image/png -i "${tmp}"`], { encoding: 'utf8' });
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans temp eventually */ }
  statusMsg = r && r.status === 0 ? 'copied to clipboard' : '!could not copy (no clipboard tool)';
  drawFooter(lastLayout || layout());
}

// One overlay at a time: the help table, or the error list.
let overlay = null;        // { title, rows: [[left, right], ...] } | null
let lastSpaceAt = 0;
const HELP = [
  ['space',   'pick a device  (type to filter: "iph", "sam", "pixel")'],
  ['p',       'switch project'],
  ['[  ]',    'previous / next device'],
  ['o',       'rotate'],
  ['i',       'type into the page  (esc to stop)'],
  ['r',       'reload'],
  ['.',       'pause / resume'],
  ['e',       'show page errors'],
  ['d',       'dark / light  (flips prefers-color-scheme)'],
  ['+  -',    'zoom in / out  (0 resets)'],
  ['c',       'copy the frame to the clipboard'],
  ['b',       'change renderer: kitty, sixel, text, half-blocks'],
  ['shift+?', 'this help'],
  ['q',       'quit'],
  ['',        ''],
  ['mouse',   'click, drag, scroll and hover all go to the page'],
];
function drawOverlay(L) {
  if (!overlay) return;
  const width = Math.min(L.cols - 2, 72);
  // title on row 2, the action line under the last row, and the pane's own
  // footer on the bottom row must all survive a short pane
  const lines = overlay.rows.map(([k, d]) => `  ${k.padEnd(7)} ${d}`).slice(0, Math.max(1, L.rows - 4));
  out(`${ESC}[2;2H${C.head((' ' + overlay.title + ' ').padEnd(width).slice(0, width))}`);
  lines.forEach((text, i) => {
    const line = text.padEnd(width).slice(0, width);
    out(`${ESC}[${3 + i};2H${ESC}[48;5;236m${ESC}[38;5;252m${line}${ESC}[0m`);
  });
  out(`${ESC}[${3 + lines.length};2H${ESC}[48;5;236m${ESC}[38;5;245m${'  any key to close'.padEnd(width)}${ESC}[0m`);
  overlay.height = lines.length + 2;   // what closeOverlay has to wipe
}
function openOverlay(title, rows) {
  overlay = { title, rows };
  drawOverlay(lastLayout || layout());
}
function closeOverlay() {
  if (!overlay) return;
  const n = overlay.height || overlay.rows.length + 2;
  overlay = null;
  uncover(n);
}

// ------------------------------------------------------------- welcome ----
// A new user gets a welcome screen in place of the page: what the pane is,
// and that the device name above it is a menu. It is drawn by a second,
// private browser tab and painted over the whole image area, so the project
// keeps loading behind it and snapshots still show the project. Any key or
// click puts the project on screen. lib/intro.mjs decides when it is due.
let welcomeOn = false;
let welcomePainted = false;
let welcomeTab = null;
let welcomeImg = null;          // { key, img } decoded at the current pane size

const WELCOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{color:#d4d7de;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;overflow:hidden;
  background:radial-gradient(120% 70% at 20% -10%,#24344a 0%,#151a23 45%,#0b0d11 100%);
  display:flex;flex-direction:column;padding:clamp(10px,3.5vw,28px);font-size:clamp(13px,3.4vw,18px);line-height:1.45}
body::after{content:'';position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 12vmin rgba(0,0,0,.55)}
.pick{position:relative;align-self:flex-start;display:flex;gap:.6em;align-items:center;padding:.5em .95em .5em .6em;
  border-radius:.8em;background:linear-gradient(180deg,rgba(60,90,130,.55),rgba(25,38,56,.75));
  border:1px solid rgba(140,190,240,.35);box-shadow:0 .5em 1.4em rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.18)}
.pick::before{content:'';position:absolute;left:1.05em;top:-.42em;width:.8em;height:.8em;transform:rotate(45deg);
  background:#3a5677;border-left:1px solid rgba(140,190,240,.35);border-top:1px solid rgba(140,190,240,.35)}
.pick .ar{width:1.5em;height:1.5em;border-radius:50%;display:grid;place-items:center;color:#0b1a2b;font-weight:800;
  background:radial-gradient(circle at 35% 30%,#d6ecff,#6fb6f5 60%,#3b82c4);box-shadow:0 2px 5px rgba(0,0,0,.45)}
.pick b{color:#e6f2ff;font-weight:600;font-size:.95em}
.body{flex:1;display:flex;flex-direction:column;min-height:0}
.stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:1em 0 1.6em}
.rig{position:relative;display:flex;align-items:flex-end}
.rig::after{content:'';position:absolute;left:-14%;right:-6%;bottom:-12%;height:14%;border-radius:50%;
  background:radial-gradient(closest-side,rgba(0,0,0,.6),transparent);filter:blur(4px)}
.dev{position:relative;z-index:1;background:linear-gradient(145deg,#3b3f47,#15171b 55%,#2a2d33);
  box-shadow:0 1.2em 2em rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.12),inset 0 1px 1px rgba(255,255,255,.25)}
.scr{position:absolute;overflow:hidden;background:#f4f6fa}
.scr::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.35) 0%,rgba(255,255,255,.06) 32%,transparent 33%)}
.scr i{display:block;margin:7% 8% 0;height:6%;border-radius:2px;background:#d7dce5}
.scr .hero{margin:0;height:34%;border-radius:0;background:linear-gradient(135deg,#4f7cff,#9b5cff 60%,#ff7aa8)}
.scr .w6{width:55%} .scr .w8{width:72%}
.scr .card{height:18%;background:#e3e7ef;border-radius:4px}
.laptop{width:min(50vw,38vh);height:calc(min(50vw,38vh)*.64);border-radius:3% 3% 0 0}
.laptop .scr{inset:4% 3.5% 6%;border-radius:2px}
.laptop::after{content:'';position:absolute;left:-9%;right:-9%;bottom:-6%;height:6%;border-radius:0 0 40% 40%/0 0 100% 100%;
  background:linear-gradient(180deg,#c9ced6,#7d838c 60%,#4a4e55);box-shadow:0 .4em .8em rgba(0,0,0,.5)}
.tablet{width:min(25vw,20vh);height:calc(min(25vw,20vh)*1.36);border-radius:8%/6%;margin-left:-4%;margin-bottom:-1%}
.tablet .scr{inset:5% 6%;border-radius:3%/2%}
.phone{width:min(12.5vw,10vh);height:calc(min(12.5vw,10vh)*2.05);border-radius:18%/9%;margin-left:-3%;margin-bottom:-1.5%}
.phone .scr{inset:4% 5.5%;border-radius:14%/7%}
.phone .scr::before{content:'';position:absolute;z-index:2;top:2.5%;left:34%;right:34%;height:4.5%;border-radius:99px;background:#0b0c0f}
main{display:flex;flex-direction:column;gap:.55em;max-width:34em;position:relative;z-index:1}
h1{font-size:1.75em;line-height:1.12;font-weight:700;letter-spacing:-.01em;
  background:linear-gradient(180deg,#ffffff,#b9c6d8);-webkit-background-clip:text;color:transparent}
p{color:#a9b1be}
kbd{font-family:inherit;font-size:.8em;color:#e8ebf0;padding:.05em .45em .12em;border-radius:.35em;
  background:linear-gradient(180deg,#4a505b,#2b2f37);border:1px solid #1a1d22;
  box-shadow:0 2px 0 #121418,inset 0 1px 0 rgba(255,255,255,.2)}
.go{align-self:flex-start;margin-top:.35em;padding:.5em 1.25em;border-radius:999px;font-size:.92em;font-weight:600;color:#fff;
  background:linear-gradient(180deg,#5b93ff,#2563eb 55%,#1d4fc4);border:1px solid #1a3f9a;
  box-shadow:0 .5em 1.1em rgba(37,99,235,.45),inset 0 1px 0 rgba(255,255,255,.4),inset 0 -2px 0 rgba(0,0,0,.2)}
@media (min-aspect-ratio:3/2){.body{flex-direction:row-reverse;align-items:center;gap:4vw}.stage{padding:0}main{flex:0 1 26em}
.laptop{width:min(34vw,52vh);height:calc(min(34vw,52vh)*.64)}.tablet{width:min(17.5vw,27vh);height:calc(min(17.5vw,27vh)*1.36)}.phone{width:min(8.8vw,13.5vh);height:calc(min(8.8vw,13.5vh)*2.05)}}
</style></head><body>
<div class="pick"><div class="ar">&#8593;</div><b>Pick a device up here</b></div>
<div class="body"><div class="stage"><div class="rig">
 <div class="dev laptop"><div class="scr"><i class="hero"></i><i class="w8"></i><i class="w6"></i><i class="card"></i></div></div>
 <div class="dev tablet"><div class="scr"><i class="hero"></i><i class="w8"></i><i class="w6"></i><i class="card"></i></div></div>
 <div class="dev phone"><div class="scr"><i class="hero"></i><i class="w8"></i><i class="w6"></i><i class="card"></i></div></div>
</div></div>
<main><h1>Welcome to livepeek</h1>
<p>This pane shows your project, live. Save a file and it updates here.</p>
<p>Click and scroll go to the page. <kbd>space</kbd> opens the device list, <kbd>shift</kbd>+<kbd>?</kbd> lists every key.</p>
<div class="go">Click anywhere to start</div></main></div>
</body></html>`;

/** The whole area below the header, rather than the device's aspect ratio. */
function welcomeLayout(L) {
  const imgCols = Math.max(4, L.cols - 2);
  const imgRows = Math.max(4, L.rows - 4);
  return { ...L, left: 2, top: 2, imgCols, imgRows, W: Math.round(imgCols * cw), H: Math.round(imgRows * ch) };
}

async function welcomeFrame(WL) {
  const key = `${WL.W}x${WL.H}`;
  if (welcomeImg?.key === key) return welcomeImg.img;
  const size = { width: WL.W, height: WL.H };
  if (!welcomeTab) {
    welcomeTab = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    await welcomeTab.setContent(WELCOME_HTML);
  } else {
    await welcomeTab.setViewportSize(size);
  }
  welcomeImg = { key, img: decodePng(await welcomeTab.screenshot({ type: 'png' })) };
  return welcomeImg.img;
}

function dismissWelcome() {
  welcomeOn = false;
  welcomeImg = null;
  // the welcome screen is wider than a phone frame, so clear it all away
  viewGen++;
  dirty = true; lastShot = null;
  if (welcomeTab) { welcomeTab.context().close().catch(() => {}); welcomeTab = null; }
}

function openMenu(mode = 'preset') {
  if (mode === 'preset') intro.picked();
  menuMode = mode;
  menuOpen = true;
  // start on whatever is currently active in this list
  menuHover = Math.max(0, menuItems().findIndex(it => it.active));
  menuFirst = -1;
  menuShownKey = null;
  out(`${ESC}[?1003h`);   // report motion even with no button, for hover
  drawMenu(lastLayout || layout());
}

/** Move the picker selection, clamped to the ends of the list. */
function menuMove(delta) {
  const items = menuItems();
  if (!items.length) return;
  const from = menuHover >= 0 ? menuHover : Math.max(0, items.findIndex(it => it.active));
  menuHover = Math.max(0, Math.min(items.length - 1, from + delta));
  // scroll just enough to keep the selection in view
  const n = menuBox?.count || 1;
  if (menuFirst < 0 || menuHover < menuFirst) menuFirst = menuHover;
  else if (menuHover >= menuFirst + n) menuFirst = menuHover - n + 1;
  drawMenu(lastLayout || layout());
}

function closeMenu() {
  menuOpen = false;
  menuHover = -1;
  menuFirst = -1;
  menuShownKey = null;
  menuMode = 'preset';
  menuFilter = '';
  // motion reporting stays on - the page uses it for hover
  uncover();
}

/**
 * Take an overlay (menu or help) off the screen without a full redraw.
 *
 * Setting `dirty` would clear the whole pane and repaint header, image and
 * footer, which reads as the app reloading. Instead wipe just the rows the
 * overlay used and ask for the image to be painted again on the next tick;
 * the image lands on top of whatever text is left underneath.
 */
function uncover(rows = 0) {
  const L = lastLayout || layout();
  const n = rows || (menuBox ? menuBox.rows || menuBox.height + 1 : 0) || 4;
  // the picker picture is its own kitty image; erasing cells does not remove it
  if (menuBox?.image && renderMode === 'kitty') {
    const del = `${ESC}_Ga=d,d=I,i=2,q=2${ESC}\\`;
    out(caps.tmux ? tmuxWrap(del) : del);
  }
  // Cells under the image are left alone: the repaint covers them, and
  // erasing cells under a sixel shows as a black band until the next frame.
  // Everything else the overlay touched is wiped. Text mode has no image, and
  // its text does not follow the image geometry, so whole rows go there.
  const imgBottom = L.top + L.imgRows;
  const imgRight = L.left + L.imgCols;          // first column past the image
  for (let r = 2; r < 2 + n && r < L.rows - 1; r++) {
    if (r >= imgBottom || renderMode === 'text') { out(`${ESC}[${r};1H${ESC}[2K`); continue; }
    // Beside a narrower image (a phone, a portrait preset) the overlay sticks
    // out and the repaint never covers it. Those cells are not under the
    // image, so they can be erased without a black band.
    if (L.left > 1) out(`${ESC}[${r};1H${ESC}[${L.left - 1}X`);
    if (imgRight <= L.cols) out(`${ESC}[${r};${imgRight}H${ESC}[K`);
  }
  menuBox = null;
  lastShot = null;        // image repaints on the next tick, without a clear
}

// ------------------------------------------------------ keyboard to page ----
/**
 * CSI sequences, parsed structurally rather than matched against a list of
 * literals.
 *
 * A literal table cannot express modifiers: alt+left is '\x1b[1;3D', which no
 * fixed string matches, so it used to fall through and be read one byte at a
 * time - and one of those bytes is '[', which is the previous-preset key. So
 * alt+left changed the device. Anything unrecognised is now consumed and
 * discarded rather than leaking into the keymap.
 */
const CSI_FINAL = {
  A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft',
  H: 'Home', F: 'End',
  P: 'F1', Q: 'F2', R: 'F3', S: 'F4',
};

// CSI <number> ~
const CSI_TILDE = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7',
  19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12',
};

const CSI_RE = /^\x1b\[([0-9;:]*)([@-~])/;
const SS3_RE = /^\x1bO([A-Za-z])/;

/**
 * @returns null if the sequence is still arriving, otherwise how many bytes
 * it occupies plus the key it means (or a null key for "recognised shape,
 * nothing we map" - still consumed).
 */
function parseEscape(buf) {
  const ss3 = SS3_RE.exec(buf);
  if (ss3) {
    const name = CSI_FINAL[ss3[1]];
    return { len: ss3[0].length, key: name ? { name, shift: false, alt: false, ctrl: false } : null };
  }

  const m = CSI_RE.exec(buf);
  if (!m) return null;                       // incomplete, wait for more bytes

  const params = m[1] ? m[1].split(';') : [];
  const name = m[2] === '~'
    ? CSI_TILDE[parseInt(params[0], 10)]
    : CSI_FINAL[m[2]];

  // xterm encodes modifiers in the second parameter, offset by one:
  // 1 none, 2 shift, 3 alt, 5 ctrl, and the sums in between.
  const code = parseInt(params[1], 10);
  const mod = Number.isFinite(code) ? code - 1 : 0;

  return {
    len: m[0].length,
    key: name ? { name, shift: !!(mod & 1), alt: !!(mod & 2), ctrl: !!(mod & 4) } : null,
  };
}

// Control characters that mean a named key rather than ctrl+letter. These
// must be checked before the ctrl+letter range, which they fall inside.
const CTRLKEY = {
  '\r': 'Enter', '\n': 'Enter', '\t': 'Tab',
  '\x7f': 'Backspace', '\b': 'Backspace',
};

/**
 * Forward one input event to the page.
 *
 * `type` rather than `insertText` for printable characters: it fires real
 * keydown/keypress/keyup, which is what a game listening for 'w' needs. A
 * held key arrives as the terminal's own repeat, so movement works, but there
 * is no true key-held state - see the README.
 */
// How long a key is held down when the page is not a text field.
//
// A terminal reports keystrokes, never "still held", so a press is otherwise
// instantaneous - and a game sampling input once per animation frame simply
// misses most of them. Holding briefly lets a handful of frames observe the
// key, which is the difference between WASD moving and WASD doing nothing.
const HOLD_MS = 90;

/**
 * Is the caret in something that takes text?
 *
 * Decides between "type this character" and "hold this key down": holding is
 * right for a game, wrong for a form, where it would feel sluggish and could
 * trigger the browser's own key repeat.
 */
async function editableFocused() {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
    });
  } catch { return true; }      // on doubt, behave like a text field
}

async function sendToPage(ev) {
  if (!page) return;
  try {
    // playwright wants modifiers as a prefixed chord: 'Control+Shift+Home'
    const mods = [ev.ctrl && 'Control', ev.alt && 'Alt', ev.shift && 'Shift'].filter(Boolean);

    if (ev.t === 'key') {
      const chord = [...mods, ev.name].join('+');
      if (mods.length || await editableFocused()) {
        await page.keyboard.press(chord);
      } else {
        await page.keyboard.down(ev.name);
        await new Promise(r => setTimeout(r, HOLD_MS));
        await page.keyboard.up(ev.name);
      }
      return await tick(true);
    }

    const ch = ev.ch;
    if (ev.alt && ch >= ' ') await page.keyboard.press('Alt+' + ch);
    else if (CTRLKEY[ch]) await page.keyboard.press(CTRLKEY[ch]);
    else if (ch >= '\x01' && ch <= '\x1a') {
      await page.keyboard.press('Control+' + String.fromCharCode(ch.charCodeAt(0) + 96));
    } else if (ch >= ' ') {
      if (await editableFocused()) {
        await page.keyboard.type(ch);
      } else {
        await page.keyboard.down(ch);
        await new Promise(r => setTimeout(r, HOLD_MS));
        await page.keyboard.up(ch);
      }
    }
  } catch { /* page may be mid-navigation */ }
  await tick(true);
}

// ---------------------------------------------------------- input parse ----
let inbuf = '';
let escTimer = null;

/** Split whatever arrived into discrete events, leaving partials buffered. */
function parseInput(chunk) {
  inbuf += chunk.toString('latin1');
  const events = [];

  while (inbuf.length) {
    if (inbuf.startsWith(`${ESC}[<`)) {
      const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(inbuf);
      if (!m) {
        if (inbuf.length < 24) break;       // incomplete, wait for more
        inbuf = inbuf.slice(1);             // malformed, resync
        continue;
      }
      const b = parseInt(m[1], 10);
      events.push({
        t: 'mouse',
        code: b & ~28,                      // strip shift/alt/ctrl bits
        col: parseInt(m[2], 10),
        row: parseInt(m[3], 10),
        press: m[4] === 'M',
      });
      inbuf = inbuf.slice(m[0].length);
      continue;
    }

    // cursor position report, the answer to askSize(): ESC [ rows ; cols R
    const cpr = /^\x1b\[(\d+);(\d+)R/.exec(inbuf);
    if (cpr) {
      events.push({ t: 'size', rows: parseInt(cpr[1], 10), cols: parseInt(cpr[2], 10) });
      inbuf = inbuf.slice(cpr[0].length);
      continue;
    }

    if (inbuf[0] === ESC) {
      // A lone ESC is ambiguous: the user pressing escape, or the first byte
      // of a sequence still in flight. Hold it and let the timer below decide.
      if (inbuf.length === 1) break;

      if (inbuf[1] === '[' || inbuf[1] === 'O') {
        const esc = parseEscape(inbuf);
        if (!esc) break;                     // still arriving
        if (esc.key) events.push({ t: 'key', ...esc.key });
        inbuf = inbuf.slice(esc.len);
        continue;
      }

      // ESC followed by an ordinary character is alt+that character
      const alted = inbuf[1];
      inbuf = inbuf.slice(2);
      events.push({ t: 'char', ch: alted, alt: true });
      continue;
    }

    const ch = inbuf[0];
    inbuf = inbuf.slice(1);
    events.push({ t: 'char', ch });
  }

  return events;
}

// Events are dispatched through a promise chain rather than fired off in
// parallel - typing fast would otherwise deliver keystrokes out of order.
let queue = Promise.resolve();
const enqueue = (events, dispatch) => {
  const at = Date.now();     // arrival, not processing time - see the space handler
  for (const ev of events) { ev.at = at; queue = queue.then(() => dispatch(ev)).catch(() => {}); }
};

// ----------------------------------------------------------------- main ----
async function applyViewport() {
  viewGen++;              // a frame already in flight is for the old viewport
  // Inside the try too: a resize landing mid-navigation, or after the browser
  // has gone, throws here, and nothing upstream of a resize event catches it.
  try {
    await page.setViewportSize(vp());
    // Chrome occasionally reports the old innerWidth for a beat after a resize
    // that coincides with a navigation; ask, and resize again if it disagrees.
    const want = vp();
    const got = await page.evaluate(() => [innerWidth, innerHeight]);
    if (got[0] !== want.width || got[1] !== want.height) {
      await new Promise(r => setTimeout(r, 150));
      await page.setViewportSize(vp());   // not want: the device may have changed meanwhile
    }
  } catch { /* mid-navigation */ }
  lastShot = null;
  dirty = true;
  publish();              // keep the shared state in step with what is shown
  await tick(true);
}

async function main() {
  // Heartbeat from the first moment, not the first tick: installing the
  // driver, launching the browser and starting a dev server can each take
  // longer than the 10 s after which a launcher decides this pane is dead.
  try { fs.mkdirSync(path.dirname(session.BEAT), { recursive: true }); fs.writeFileSync(session.BEAT, ''); }
  catch { /* not worth failing over */ }
  lastBeat = Date.now();
  startBeat = setInterval(beat, 2000);

  out(`${ESC}[?1049h${ESC}[?25l`);          // alt screen, hide cursor
  out(`${ESC}]0;livepeek${String.fromCharCode(7)}`);   // tab title: VS Code otherwise names it after the browser child
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  caps = await probeTerminal();
  cw = caps.cw; ch = caps.ch; termBg = caps.bg;
  renderMode = pickRenderer(caps, RENDER);
  if (caps.note && RENDER === 'auto') statusMsg = caps.note;

  out(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`);   // mouse: clicks, drag, hover, SGR coords

  lastLayout = layout();
  drawHeader(lastLayout);

  const chromium = resolveChromium();
  if (!chromium) throw new Error(DRIVER_HINT);

  statusMsg = 'launching browser';
  drawFooter(lastLayout);
  browser = await launchBrowser(chromium);
  // 2x then downsampled in render(): text and edges come out anti-aliased
  // instead of jagged. Snapshots are written at this 2x size too.
  const ctx = await browser.newContext({ viewport: vp(), deviceScaleFactor: SHOT_SCALE });
  page = await ctx.newPage();
  if (renderMode === 'sixel' || renderMode === 'kitty') warmMenuTab().catch(() => { menuTabP = null; });

  // Text mode has no picture to paint a welcome screen with.
  if (renderMode !== 'text' && intro.due()) {
    welcomeOn = true;
    intro.shown();
    try {
      paintImage(welcomeLayout(lastLayout), await welcomeFrame(welcomeLayout(lastLayout)));
      welcomePainted = true;
    } catch { /* the render loop tries again */ }
  }

  // Errors are the first thing a user wants to know and the one thing a
  // screenshot cannot show. Keep the last few; a navigation starts afresh.
  // The count is published too, so an agent reading the session file sees it.
  // A page that logs in a loop would rewrite that file hundreds of times a
  // second, so publishing is batched: at most once per 500 ms, once at the end.
  let errorPublish = null;
  const noteError = (text) => {
    errors.push(String(text).split('\n')[0].slice(0, 200));
    if (errors.length > 20) errors.shift();
    drawFooter(lastLayout || layout());
    if (!errorPublish) errorPublish = setTimeout(() => { errorPublish = null; publishIfIdle(); }, 500);
  };
  page.on('pageerror', e => noteError(e.message || e));
  // an uncaught exception also arrives as an "Uncaught ..." console entry;
  // count it once, from pageerror
  page.on('console', m => {
    if (m.type() !== 'error' || /^Uncaught /.test(m.text())) return;
    // a missing favicon is not the user's bug, whatever server is behind it
    if (/favicon\.ico$/.test(m.location()?.url || '')) return;
    noteError(m.text());
  });
  page.on('framenavigated', f => {
    if (f !== page.mainFrame()) return;
    errors = [];
    publishIfIdle();         // the count on file starts afresh too
    lastTextKey = ''; textScroll = 0;
    applyPageState();        // zoom and focus ring do not survive a navigation
  });

  publish();            // claim the pane before anything slow happens, so a
                        // launch racing us reuses this one instead of splitting
  await ensureServer();

  statusMsg = 'loading app';
  drawFooter(lastLayout);

  try {
    await page.goto(currentTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    statusMsg = '!no dev server at ' + currentTarget;
  }
  publish();          // the static server may have picked its own port

  if (WATCH_DIR) watchFolder(WATCH_DIR);

  for (const ms of [700, 1500, 3000, 6000]) setTimeout(askSize, ms);

  // one loop drives both the repaint and the shared-pane check
  // control first, so a request claims the page before an ordinary tick does
  tickTimer = setInterval(() => { checkControl(); tick(); }, INTERVAL);
  clearInterval(startBeat);       // tick keeps the heartbeat from here on
  // Dragging a pane border fires resize dozens of times; only the size it
  // settles on is worth a viewport change. A failure here has nobody above it
  // to catch it, so it is dropped - the next resize or tick tries again.
  let resizeTimer = null;
  process.stdout.on('resize', () => {
    probedSize = null;              // from here on process.stdout is current
    viewGen++;
    dirty = true; lastShot = null;
    menuKey = null;                 // an in-flight picker render is the old size
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (devices[deviceIdx]?.fit) applyViewport().catch(() => {});   // re-render at the new pane size
    }, 120);
  });

  /** Route one event to the page or to the viewer, depending on mode. */
  async function dispatch(ev) {
    if (ev.t === 'size') return applySize(ev.rows, ev.cols);
    if (ev.t === 'mouse') {
      // clicking and scrolling work in both modes - only keys are switched
      return handleMouse(ev.code, ev.col, ev.row, ev.press);
    }

    // ctrl+c always quits, whatever the mode. Without a mode-independent
    // escape there is no way out of typing if the page swallows esc.
    if (ev.t === 'char' && ev.ch === '\x03') return shutdown();

    if (typing) {
      if (ev.t === 'char' && ev.ch === ESC) {
        typing = false;
        drawFooter(lastLayout || layout());
        return;
      }
      return sendToPage(ev);
    }

    // Any key takes the welcome screen away; space goes on to the device
    // list the screen points at. Alt and ctrl chords belong to the terminal.
    if (welcomeOn && !ev.alt && !ev.ctrl) {
      dismissWelcome();
      if (ev.t === 'char' && ev.ch === ' ') { lastSpaceAt = ev.at || Date.now(); openMenu('preset'); }
      return tick(true);
    }

    // Named keys drive the picker, so it is not mouse-only. Outside the
    // picker they are ignored rather than falling through - alt+arrow in
    // particular belongs to the terminal, not to us.
    if (ev.t === 'key') {
      if (overlay && !ev.alt && !ev.ctrl) { closeOverlay(); return tick(true); }   // "any key"
      if (!menuOpen || ev.alt || ev.ctrl) return;
      const step = menuBox?.count || 5;   // not `page` - that is the browser page
      if (ev.name === 'ArrowDown') return menuMove(1);
      if (ev.name === 'ArrowUp') return menuMove(-1);
      if (ev.name === 'PageDown') return menuMove(step);
      if (ev.name === 'PageUp') return menuMove(-step);
      if (ev.name === 'Home') return menuMove(-devices.length);
      if (ev.name === 'End') return menuMove(devices.length);
      return;
    }

    const k = ev.ch;
    if (ev.alt) return;                 // alt+letter is not one of our bindings

    if (overlay) { closeOverlay(); return tick(true); }

    // while the device picker is open, letters narrow the list. Space still
    // closes an untouched picker, but once a filter is started it is part of
    // the query: device names have spaces in them ("iphone 15").
    if (menuOpen && menuMode === 'preset' && k !== '\r' && k !== '\n' && k !== ESC && (k !== ' ' || menuFilter)) {
      if (k === ' ' && menuFilter.endsWith(' ')) return;   // held space: one is enough
      if (k === '\x7f' || k === '\b') menuFilter = menuFilter.slice(0, -1);
      else if (k >= ' ' && k.length === 1) menuFilter += k;
      else return;
      menuHover = 0;
      menuFirst = 0;
      // the text list changes length and needs the page repainted under it;
      // the picture keeps its size
      if (!menuBox?.image) { dirty = true; await tick(true); }
      drawMenu(lastLayout || layout());
      return;
    }

    // enter picks whatever the picker is sitting on
    if (menuOpen && (k === '\r' || k === '\n')) {
      return menuHover >= 0 ? menuSelect(menuHover) : closeMenu();
    }

    if (k === 'q') return shutdown();
    if (k === ESC) { if (menuOpen) { closeMenu(); await tick(true); } return; }

    if (k === 'i') { typing = true; await applyPageState(); drawFooter(lastLayout || layout()); }
    else if (k === ']') { deviceIdx = (deviceIdx + 1) % devices.length; await applyViewport(); }
    else if (k === '[') { deviceIdx = (deviceIdx - 1 + devices.length) % devices.length; await applyViewport(); }
    else if (k === 'o' || k === 'l') { landscape = !landscape; await applyViewport(); }
    else if (k === ' ') {
      // Holding space autorepeats, which would toggle the picker open and
      // shut many times a second and keep going after the key is released.
      // Only the first press in a burst counts.
      // Compare arrival times, not Date.now(): repeats queue up behind the
      // slow repaint that the first press triggers, and by the time they are
      // handled the clock has moved on enough to look like a fresh press.
      const at = ev.at || Date.now();
      if (at - lastSpaceAt < 350) { lastSpaceAt = at; return; }
      lastSpaceAt = at;
      menuOpen ? closeMenu() : openMenu('preset');
      if (!menuOpen) await tick(true);
    }
    else if (k === '?') { openOverlay('livepeek keys', HELP); }
    else if (k === 'p') {
      // switch which project the pane is looking at, without restarting it
      if (menuOpen) closeMenu();
      statusMsg = 'scanning';
      drawFooter(lastLayout || layout());
      targets = await scanTargets();
      if (!targets.length) {
        statusMsg = '!no dev servers found';
        drawFooter(lastLayout || layout());
        return;
      }
      openMenu('target');
    }
    else if (k === 'r') { lastShot = null; dirty = true; try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {} }
    else if (k === '.') { paused = !paused; drawFooter(lastLayout || layout()); }
    else if (k === 'b') { cycleRenderer(); }
    else if (k === 'e') {
      const rows = errors.length
        ? errors.slice(-12).map((m, i) => [String(i + 1), m.slice(0, 64)])
        : [['', 'no errors on this page']];
      openOverlay(`page errors (${errors.length})`, rows);
    }
    else if (k === 'd') {
      colorScheme = colorScheme === 'dark' ? 'light' : 'dark';
      try { await page.emulateMedia({ colorScheme }); } catch {}
      statusMsg = colorScheme; lastShot = null; await tick(true);
    }
    else if (k === '+' || k === '=' || k === '-' || k === '0') {
      zoom = k === '0' ? 1 : Math.min(4, Math.max(0.25, +(zoom * (k === '-' ? 1 / 1.25 : 1.25)).toFixed(3)));
      await applyPageState();
      dirty = true; lastShot = null; await tick(true);
    }
    else if (k === 'c') { await copyFrame(); }
  }

  process.stdin.on('data', (chunk) => {
    // ctrl+c skips the queue. Events are handled one at a time, and one of
    // them can be waiting up to 90 s for a dev server to come up - a ctrl+c
    // queued behind it would look like the pane ignoring the user.
    if (chunk.includes(0x03)) return shutdown();

    if (escTimer) { clearTimeout(escTimer); escTimer = null; }

    enqueue(parseInput(chunk), dispatch);

    // A held-back lone ESC with nothing following it was the user pressing
    // escape, not a truncated sequence. Without this, esc only registers once
    // the *next* key arrives, which makes leaving typing mode feel broken.
    if (inbuf === ESC) {
      escTimer = setTimeout(() => {
        inbuf = '';
        escTimer = null;
        enqueue([{ t: 'char', ch: ESC }], dispatch);
      }, 40);
    }
  });
}

/**
 * Stop advertising this pane - but only if the session file is still ours.
 * A pane that was replaced in its slot (it stopped answering and a new one
 * took over) must not make its successor look closed.
 */
function releaseSession() {
  // a launcher's claim (no pid yet) is cleared too: it was for this pane, and
  // left behind it would make the next launch wait for a pane that never comes
  const s = session.read();
  if (s && (s.pid === process.pid || s.claiming)) session.clear();   // also removes the heartbeat
}

/** Put the terminal back the way it was found. Safe to call more than once. */
function restore() {
  out(`${ESC}[?1003l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`);  // mouse off
  out(`${ESC}[?25h${ESC}[?1049l`);                              // cursor, main screen
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* stdin already gone */ }
}

function shutdown() {
  if (tickTimer) clearInterval(tickTimer);
  releaseSession();             // stop advertising a pane that is going away
  restore();
  browser?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

// A last resort for anything that slips past the handlers above - an event
// callback that throws, a promise nobody awaited. Without it the process dies
// with the terminal still in raw mode, on the alternate screen, with mouse
// reporting on: the user's shell is left unusable, and the headless browser
// is orphaned.
const crash = (e) => {
  restore();
  try { releaseSession(); } catch { /* exiting anyway */ }
  try { browser?.close().catch(() => {}); } catch { /* exiting anyway */ }
  console.error(e);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

main().catch((e) => {
  clearInterval(startBeat);
  out(`${ESC}[?1003l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  releaseSession();
  console.error('\nlivepeek could not start:\n\n' + (e.message || e) + '\n');
  // Exit 0 after a keypress rather than 1 immediately. A non-zero exit makes
  // the terminal keep this pane open as a corpse; a zero exit on a key gives
  // the user time to read the error and then takes the pane away cleanly.
  if (process.stdin.isTTY) {
    console.error('press any key to close this pane');
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
  } else process.exit(1);
});
