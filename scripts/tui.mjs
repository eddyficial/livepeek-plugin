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
 * and half-blocks on anything that answers neither. 'b' overrides the guess.
 *
 * Input goes through to the page: click and scroll always, and every keystroke
 * in typing mode ('i'). 't' switches which project is being viewed, and a new
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
import { decodePng, resize } from './lib/png.mjs';
import { toSixel, toHalfBlocks } from './lib/sixel.mjs';
import { toKitty, tmuxWrap, kittyClearAll } from './lib/kitty.mjs';
import { probeTerminal, pickRenderer } from './lib/caps.mjs';
import * as session from './lib/session.mjs';
import { serveStatic } from './lib/serve.mjs';
import * as projects from './lib/projects.mjs';
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
// page - are served by peek itself. See lib/serve.mjs.
const STATIC_DIR  = arg('--static', null);
const STATIC_FILE = arg('--file', null);

// Write the frame being shown to this PNG on every repaint, so an agent can
// look at the pane. Also requestable after the fact via the session file.
const SNAPSHOT = arg('--snapshot', null);

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
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
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
 * Search order puts the user's own project first so a project that pins a
 * playwright version gets that version, then the directory this script lives
 * in so the plugin can ship its own, then the global install.
 */
function resolveChromium() {
  const roots = [
    process.cwd() + path.sep,
    __dirname + path.sep,
  ];
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    roots.push(process.env.CLAUDE_PLUGIN_ROOT + path.sep);
  }
  // npm's global root, if there is one on this machine
  for (const g of [process.env.npm_config_prefix, process.env.NODE_PATH]) {
    if (g) roots.push(path.join(g, 'node_modules') + path.sep);
  }

  for (const root of roots) {
    for (const pkg of ['playwright', 'playwright-core', 'patchright']) {
      try {
        const mod = createRequire(root)(pkg);
        const chromium = mod?.chromium ?? mod?.default?.chromium;
        if (chromium) return chromium;
      } catch { /* try the next root */ }
    }
  }
  return null;
}

/**
 * First run on a machine: fetch playwright-core into the plugin's own
 * directory, once, so no project ever needs it as a dependency.
 *
 * It is ~3 MB of JavaScript and downloads no browser - the Chrome or Edge
 * already installed is driven instead. This runs inside the pane, so the
 * user sees a one-line status rather than a stack trace, and a document
 * folder with no package.json works exactly like a Vite project does.
 */
// Pinned: an unpinned install would run whatever version is newest on the day
// someone first launches peek.
async function installDriver() {
  statusMsg = 'first run: fetching browser driver (~3 MB, once)';
  drawFooter(lastLayout || layout());
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npm', ['install', '--prefix', __dirname, '--no-fund', '--no-audit', '--no-save',
    '--silent', 'playwright-core@1.63.0'], { cwd: __dirname, shell: true, windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      'Could not fetch playwright-core automatically.\n' +
      (r.stderr || '').trim().split('\n').slice(-3).join('\n') +
      '\n\nInstall it by hand in your project:\n  npm i -D playwright-core'
    );
  }
}

/**
 * A Chrome or Edge already on this machine, used as a fallback when
 * playwright is present but its own chromium was never downloaded
 * (`npm i playwright` without the `playwright install` step - a very common
 * state to be in). Headless, so no window appears either way.
 */
function findSystemBrowser() {
  const candidates = [];

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
        'Chrome or Edge was found either.\n\nRun:\n  npx playwright install chromium\n\n' +
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
let lastStatus = null;
let paused = false;
// half-blocks until the terminal tells us it can do better - the old default
// of 'sixel' painted garbage on terminals that cannot render it
let renderMode = 'blocks';
let dirty = true;
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
    const { port } = await serveStatic({ root: STATIC_DIR, file: STATIC_FILE, port: SERVE_PORT || 0 });
    currentTarget = `http://localhost:${port}/`;
    return;
  }
  if (!SERVE || !SERVE_PORT || await portOpen(SERVE_PORT)) return;
  await startDevServer(SERVE, SERVE_CWD, SERVE_PORT);
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
function publish(extra = {}) {
  session.write({
    pid: process.pid,
    host: HOST,
    target: currentTarget,
    preset: devices[deviceIdx]?.id,
    rev: myRev,
    snapshotDone,
    ...extra,
  });
}

/**
 * Has another launch asked this pane to do something?
 *
 * Checked on the render tick rather than with a watcher: the tick is already
 * running, and a sub-second delay on a request the user just typed elsewhere
 * is imperceptible.
 */
async function checkControl() {
  const s = session.read();
  if (!s || s.pid !== process.pid || s.rev === myRev) return;

  myRev = s.rev;
  // A retarget navigates and resizes; a screenshot landing in the middle of
  // that occasionally captured the new page at the old page's layout size.
  // Hold the render loop off until the whole sequence has settled.
  controlBusy = true;
  try { await applyControl(s); }
  catch (e) { publish({ error: String(e.stack || e.message || e).slice(0, 600) }); }
  finally { controlBusy = false; }
}
let controlBusy = false;

async function applyControl(s) {

  if (s.quit) return shutdown();

  // run a snippet in the page and report back - lets an agent read state
  // (text on screen, a counter, layout size) instead of guessing from pixels
  if (s.eval) {
    let evalResult;
    try { evalResult = { ok: true, value: await page.evaluate(s.eval) }; }
    catch (e) { evalResult = { ok: false, error: String(e.message || e) }; }
    publish({ eval: null, evalResult });
    if (!s.snapshot && s.target === currentTarget && s.preset === devices[deviceIdx]?.id && !s.static) return;
  }

  // a one-off "show me what you're showing" from outside
  if (s.snapshot) {
    await tick(true);
    writeSnapshot(s.snapshot);
    snapshotDone = s.snapshot;
    publish({ snapshot: null });
    // a bare snapshot request changes nothing else about the view
    if (s.target === currentTarget && s.preset === devices[deviceIdx]?.id && !s.static) return;
  }

  if (s.preset) {
    const i = devices.findIndex(d => d.id === s.preset);
    if (i !== -1) deviceIdx = i;
  }

  // retargeted at a folder or document rather than a server: serve it here
  if (s.static) {
    try {
      const { port } = await serveStatic({ root: s.static, file: s.file || null });
      s.target = `http://localhost:${port}/`;
    } catch (e) {
      statusMsg = '!' + (e.message || 'could not serve').slice(0, 40);
    }
    publish({ static: null, file: null });
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
}

/** Everything currently listening, probed in parallel so this stays snappy. */
async function scanTargets() {
  // Saved projects come first: those are folders the user can always go back
  // to. A running dev server nobody launched through peek is appended so it
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
let menuBox = null;      // {top,left,width,height,first,count}
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
function layout() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

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
  // the line off at the end - help and quit are the two a user cannot do
  // without, so they are the last to go.
  const sep = '  ·  ';
  const items = typing
    ? ['keys go to the page', 'esc to stop typing', 'ctrl+c quits']
    : [renderMode, 'i type', 'p project', 'space device', 'shift+? help', 'q quit'];
  const order = typing ? [2, 1, 0] : [5, 4, 3, 2, 1, 0];   // most important first
  let chosen = [];
  for (const i of order) {
    const next = [...chosen, i].sort((x, y) => x - y);
    if (next.map(j => items[j]).join(sep).length > budget) break;
    chosen = next;
  }
  const hint = chosen.map(j => items[j]).join(sep);

  out(`${ESC}[?7l${ESC}[${L.rows};1H${ESC}[2K ${colour(plainState)}  ${C.dim(hint)}${ESC}[?7h`);
  lastStatus = statusMsg + (paused ? ':p' : '') + renderMode + (typing ? ':t' : '');
}

/** Rows for whichever list the picker is currently showing. */
function menuItems() {
  if (menuMode === 'target') {
    return targets.map((t, i) => ({
      idx: i,
      name: `${t.label}  ${t.sub}`,
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
  let first = 0;
  if (items.length > count) {
    first = Math.min(Math.max(0, anchor - (count >> 1)), items.length - count);
  }

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

/** Apply row `idx` of whichever list is open. */
async function menuSelect(pos) {
  const item = menuItems()[pos];
  if (!item) { closeMenu(); return tick(true); }
  const idx = item.idx;
  if (menuMode === 'target') {
    const t = targets[idx];
    closeMenu();
    if (!t) return tick(true);

    if (t.static) {
      // a folder or a document: peek serves it itself
      statusMsg = 'serving ' + path.basename(t.dir);
      drawFooter(lastLayout || layout());
      try {
        const { port } = await serveStatic({ root: t.dir, file: t.file || null });
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

function paintImage(L, composed) {
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
  const order = ['kitty', 'sixel', 'blocks'];
  renderMode = order[(order.indexOf(renderMode) + 1) % order.length];
  lastShot = null;
  dirty = true;
}

function render(L, shotPng) {
  const geom = L.geom;
  const sw = Math.max(1, Math.round(geom.screenW * L.scale));
  const sh = Math.max(1, Math.round(geom.screenH * L.scale));
  const shot = resize(decodePng(shotPng), sw, sh);

  const compose = geom.frame === 'none' ? composeBare : composePhone;
  const composed = compose({
    geom, scale: L.scale, shot, bg: termBg, margin: L.margin,
  });

  L.screenRect = composed.screenRect;
  paintImage(L, composed);
  lastComposed = composed;
  if (SNAPSHOT) writeSnapshot(SNAPSHOT);
}

let lastComposed = null;

/** Write what the pane is showing - the raw page, not the scaled-down pane
 *  frame, so text is legible when an agent reads it back. */
function writeSnapshot(file) {
  try {
    if (lastShot) fs.writeFileSync(file, lastShot);          // page screenshot, full res
    else if (lastComposed) fs.writeFileSync(file, encodePng(lastComposed));
  } catch { /* a snapshot is never worth crashing the view */ }
}

async function tick(force = false) {
  if (!page || (paused && !force) || (controlBusy && !force)) return;
  const L = layout();
  // The screen rect is only computed when a frame is painted. A static page
  // paints rarely, so carry it over - without it clicks map to nothing.
  if (lastLayout?.screenRect && !dirty) L.screenRect = lastLayout.screenRect;
  lastLayout = L;
  try {
    const shot = await page.screenshot({ type: 'png' });
    const changed = !lastShot || Buffer.compare(shot, lastShot) !== 0;

    if (changed || dirty) {
      lastShot = shot;
      if (dirty) {
        // placed images survive ESC[2J, so they have to be deleted explicitly
        if (caps.kitty) out(caps.tmux ? tmuxWrap(kittyClearAll()) : kittyClearAll());
        out(`${ESC}[2J`);
        drawHeader(L);
        dirty = false;
      }
      render(L, shot);
      if (menuOpen) drawMenu(L);
    }
    statusMsg = 'live';
  } catch (e) {
    statusMsg = '!' + (e.message || 'screenshot failed').split('\n')[0].slice(0, 40);
    dirty = true;
  }
  if (statusMsg + (paused ? ':p' : '') + renderMode !== lastStatus) drawFooter(L);
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
  if (helpOpen) { if (press) { helpOpen = false; uncover(HELP.length + 2); await tick(true); } return; }
  // menu takes precedence while it's open
  if (menuOpen) {
    const inMenu = menuBox && row >= menuBox.top && row < menuBox.top + menuBox.height
                            && col >= menuBox.left && col < menuBox.left + menuBox.width;
    if (code === 35 || code === 32) {           // motion
      const h = inMenu ? menuBox.first + (row - menuBox.top) : -1;
      if (h !== menuHover) { menuHover = h; drawMenu(lastLayout); }
      return;
    }
    if (press && code === 0) {
      if (inMenu) {
        await menuSelect(menuBox.first + (row - menuBox.top));
      } else {
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

let helpOpen = false;
let lastSpaceAt = 0;
const HELP = [
  ['space',   'pick a device  (type to filter: "iph", "sam", "pixel")'],
  ['p',       'switch project'],
  ['[  ]',    'previous / next device'],
  ['o',       'rotate'],
  ['i',       'type into the page  (esc to stop)'],
  ['r',       'reload'],
  ['.',       'pause / resume'],
  ['b',       'change renderer if the picture looks wrong'],
  ['shift+?', 'this help'],
  ['q',       'quit'],
  ['',        ''],
  ['mouse',   'click, drag, scroll and hover all go to the page'],
];
function drawHelp(L) {
  const width = Math.min(L.cols - 2, 62);
  out(`${ESC}[2;2H${C.head(' peek keys '.padEnd(width))}`);
  HELP.forEach(([k, d], i) => {
    const line = `  ${k.padEnd(7)} ${d}`.padEnd(width).slice(0, width);
    out(`${ESC}[${3 + i};2H${ESC}[48;5;236m${ESC}[38;5;252m${line}${ESC}[0m`);
  });
  out(`${ESC}[${3 + HELP.length};2H${ESC}[48;5;236m${ESC}[38;5;245m${'  any key to close'.padEnd(width)}${ESC}[0m`);
}

function openMenu(mode = 'preset') {
  menuMode = mode;
  menuOpen = true;
  // start on whatever is currently active in this list
  menuHover = Math.max(0, menuItems().findIndex(it => it.active));
  out(`${ESC}[?1003h`);   // report motion even with no button, for hover
  drawMenu(lastLayout || layout());
}

/** Move the picker selection, clamped to the ends of the list. */
function menuMove(delta) {
  const items = menuItems();
  if (!items.length) return;
  const from = menuHover >= 0 ? menuHover : Math.max(0, items.findIndex(it => it.active));
  menuHover = Math.max(0, Math.min(items.length - 1, from + delta));
  drawMenu(lastLayout || layout());
}

function closeMenu() {
  menuOpen = false;
  menuHover = -1;
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
  const n = rows || (menuBox ? menuBox.height + 1 : 0) || HELP.length + 2;
  // Only rows below the image need wiping: the repaint covers the rest, and
  // erasing cells under a sixel shows as a black band until the next frame.
  const imgBottom = L.top + L.imgRows;
  for (let r = Math.max(2, imgBottom); r < 2 + n && r < L.rows - 1; r++) out(`${ESC}[${r};1H${ESC}[2K`);
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
  await page.setViewportSize(vp());
  // Chrome occasionally reports the old innerWidth for a beat after a resize
  // that coincides with a navigation; ask, and resize again if it disagrees.
  try {
    const want = vp();
    const got = await page.evaluate(() => [innerWidth, innerHeight]);
    if (got[0] !== want.width || got[1] !== want.height) {
      await new Promise(r => setTimeout(r, 150));
      await page.setViewportSize(want);
    }
  } catch { /* mid-navigation */ }
  lastShot = null;
  dirty = true;
  publish();              // keep the shared state in step with what is shown
  await tick(true);
}

async function main() {
  out(`${ESC}[?1049h${ESC}[?25l`);          // alt screen, hide cursor
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  caps = await probeTerminal();
  cw = caps.cw; ch = caps.ch; termBg = caps.bg;
  renderMode = pickRenderer(caps, RENDER);

  out(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`);   // mouse: clicks, drag, hover, SGR coords

  lastLayout = layout();
  drawHeader(lastLayout);

  let chromium = resolveChromium();
  if (!chromium) {
    await installDriver();
    chromium = resolveChromium();
    if (!chromium) throw new Error('playwright-core was installed but could not be loaded from ' + __dirname);
  }

  statusMsg = 'launching browser';
  drawFooter(lastLayout);
  browser = await launchBrowser(chromium);
  // 2x then downsampled in render(): text and edges come out anti-aliased
  // instead of jagged. Snapshots are written at this 2x size too.
  const ctx = await browser.newContext({ viewport: vp(), deviceScaleFactor: 2 });
  page = await ctx.newPage();

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

  // one loop drives both the repaint and the shared-pane check
  tickTimer = setInterval(() => { tick(); checkControl(); }, INTERVAL);
  process.stdout.on('resize', () => {
    dirty = true; lastShot = null;
    if (devices[deviceIdx]?.fit) applyViewport();   // re-render at the new pane size
  });

  /** Route one event to the page or to the viewer, depending on mode. */
  async function dispatch(ev) {
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

    // Named keys drive the picker, so it is not mouse-only. Outside the
    // picker they are ignored rather than falling through - alt+arrow in
    // particular belongs to the terminal, not to us.
    if (ev.t === 'key') {
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

    if (helpOpen) { helpOpen = false; uncover(HELP.length + 2); return tick(true); }

    // while the device picker is open, letters narrow the list
    if (menuOpen && menuMode === 'preset' && k !== '\r' && k !== '\n' && k !== ESC && k !== ' ') {
      if (k === '\x7f' || k === '\b') menuFilter = menuFilter.slice(0, -1);
      else if (k >= ' ' && k.length === 1) menuFilter += k;
      else return;
      menuHover = 0;
      dirty = true; await tick(true);   // repaint under the shorter/longer list
      drawMenu(lastLayout || layout());
      return;
    }

    // enter picks whatever the picker is sitting on
    if (menuOpen && (k === '\r' || k === '\n')) {
      return menuHover >= 0 ? menuSelect(menuHover) : closeMenu();
    }

    if (k === 'q') return shutdown();
    if (k === ESC) { if (menuOpen) { closeMenu(); await tick(true); } return; }

    if (k === 'i') { typing = true; drawFooter(lastLayout || layout()); }
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
    else if (k === '?') { helpOpen = true; drawHelp(lastLayout || layout()); }
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
  }

  process.stdin.on('data', (chunk) => {
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

function shutdown() {
  if (tickTimer) clearInterval(tickTimer);
  session.clear();              // stop advertising a pane that is going away
  out(`${ESC}[?1003l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`);  // mouse off
  out(`${ESC}[?25h${ESC}[?1049l`);                              // cursor, main screen
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  browser?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

main().catch((e) => {
  out(`${ESC}[?1003l${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  session.clear();
  console.error('\npeek could not start:\n\n' + (e.message || e) + '\n');
  // Exit 0 after a keypress rather than 1 immediately. A non-zero exit makes
  // the terminal keep this pane open as a corpse; a zero exit on a key gives
  // the user time to read the error and then takes the pane away cleanly.
  if (process.stdin.isTTY) {
    console.error('press any key to close this pane');
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
  } else process.exit(1);
});
