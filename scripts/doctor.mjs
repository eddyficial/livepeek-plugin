#!/usr/bin/env node
/**
 * Check that this machine can run peek, and say what to fix if it can't.
 *
 *   node doctor.mjs
 *
 * One line per check: "ok", "warn" (peek runs, but something is degraded) or
 * "FAIL" (peek cannot run until it is fixed). Exits 1 only on a FAIL, so it
 * is safe to use in a script.
 *
 * The browser list and the multiplexer detection are copied from tui.mjs and
 * pane.mjs rather than imported: importing either one would start it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeTerminal, pickRenderer } from './lib/caps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0, warned = 0;
const report = (level, thing, detail, hint) => {
  if (level === 'FAIL') failed++;
  if (level === 'warn') warned++;
  // levels are padded to the width of "FAIL" so the details line up
  console.log(`${level.padEnd(4)} ${thing}: ${detail}`);
  if (hint && level !== 'ok') console.log(`       fix: ${hint}`);
};

// ----------------------------------------------------------------- node ----
function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) return report('ok', 'node', `v${process.versions.node}`);
  report('FAIL', 'node', `v${process.versions.node} is too old (need 18 or newer)`,
    'install a current Node.js (18 or newer) from the Node.js download page');
}

// -------------------------------------------------------------- browser ----
// Same list as findSystemBrowser in tui.mjs. Keep the two in step.
function findSystemBrowser() {
  const candidates = [];

  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      'C:/Program Files (x86)',
      process.env.LOCALAPPDATA,
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

function checkBrowser() {
  const exe = findSystemBrowser();
  if (exe) return report('ok', 'browser', exe);
  report('FAIL', 'browser', 'no Chrome, Chromium or Edge found in the usual places',
    'install Chrome or Edge (Windows already ships with Edge)');
}

// --------------------------------------------------------------- driver ----
// The copy peek fetches for itself lives next to this script.
const BUNDLED_DRIVER = path.join(__dirname, 'node_modules', 'playwright-core');

function checkDriver() {
  let where = fs.existsSync(path.join(BUNDLED_DRIVER, 'package.json'))
    ? path.join(BUNDLED_DRIVER, 'package.json')
    : null;
  // otherwise one a project already has, found the way tui.mjs looks
  if (!where) {
    try { where = createRequire(process.cwd() + path.sep).resolve('playwright-core/package.json'); }
    catch { /* not resolvable from here */ }
  }
  if (!where) return report('ok', 'driver', 'will be fetched on first run (needs network once)');

  let version = 'unknown version';
  try { version = JSON.parse(fs.readFileSync(where, 'utf8')).version; } catch { /* keep default */ }
  report('ok', 'driver', `playwright-core ${version} (${path.dirname(where)})`);
}

// ---------------------------------------------------------- multiplexer ----
// Same order as detectHost in pane.mjs: tmux can run inside the others, so it wins.
function detectHost() {
  // A VS Code terminal inherits the environment VS Code was launched from,
  // so ZELLIJ or WT_SESSION may be set while no such pane is anywhere near
  // this terminal. TERM_PROGRAM is set by the innermost program: VS Code
  // says vscode, and tmux overrides it with tmux when it is really inside.
  const vscode = (process.env.TERM_PROGRAM || '').toLowerCase() === 'vscode';
  if (process.env.TMUX && !vscode) return 'tmux';
  if (vscode) return null;
  if (process.env.ZELLIJ) return 'zellij';
  if (process.env.KITTY_LISTEN_ON) return 'kitty';
  if (process.env.WEZTERM_PANE) return 'wezterm';
  if (process.env.WT_SESSION) return 'wt';
  return null;
}

function checkHost() {
  const host = detectHost();
  if (host) return report('ok', 'multiplexer', host);
  if ((process.env.TERM_PROGRAM || '').toLowerCase() === 'vscode') {
    report('warn', 'multiplexer', 'VS Code terminal: split it by hand and run `peek --here` in the new half',
      'or run tmux inside it; for pictures enable terminal.integrated.enableImages');
  } else
  report('FAIL', 'multiplexer', 'none detected, so there is no pane to split',
    'start tmux first (works everywhere), or run peek with --here to use this pane');
}

// ------------------------------------------------------------- graphics ----
async function checkGraphics() {
  if (!process.stdin.isTTY) return report('ok', 'graphics', 'skipped (not a terminal)');

  // the terminal's replies arrive on stdin, so it has to be raw or they get
  // echoed onto the screen and held back until enter
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const caps = await probeTerminal();
  process.stdin.setRawMode?.(false);
  process.stdin.pause();

  const renderer = pickRenderer(caps);
  const support = [caps.kitty && 'kitty', caps.sixel && 'sixel'].filter(Boolean).join(' + ') || 'no kitty or sixel';
  const cell = `${caps.cw}x${caps.ch}px cells${caps.cellFrom ? ` (from ${caps.cellFrom})` : ' (guessed)'}`;
  const detail = `${support}; ${cell}; would use ${renderer}`;

  if (renderer === 'blocks') {
    return report('warn', 'graphics', detail,
      'half-blocks work but are coarse; try Windows Terminal 1.22+, Kitty, WezTerm or Ghostty' +
      (caps.tmux ? ', and set -g allow-passthrough on in tmux' : ''));
  }
  report('ok', 'graphics', detail);
}

// ------------------------------------------------------------------ npm ----
function checkNpm() {
  // shell: true so Windows finds npm.cmd
  const r = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8', windowsHide: true });
  const version = (r.stdout || '').trim();
  if (r.status === 0 && version) return report('ok', 'npm', `v${version}`);
  // with the driver already in place, npm only matters for starting dev servers
  const haveDriver = fs.existsSync(BUNDLED_DRIVER);
  report(haveDriver ? 'warn' : 'FAIL', 'npm', 'not found on PATH',
    'install Node.js with npm included; peek needs it to fetch the driver and start dev servers');
}

// ----------------------------------------------------------------- home ----
function checkHome() {
  const dir = path.join(os.homedir(), '.peek');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    report('ok', '~/.peek', `writable (${dir})`);
  } catch (e) {
    report('FAIL', '~/.peek', `cannot write to ${dir}: ${e.code || e.message}`,
      'make that folder writable; peek keeps its pane state and project list there');
  }
}

// ----------------------------------------------------------------- main ----
checkNode();
checkBrowser();
checkDriver();
checkHost();
await checkGraphics();
checkNpm();
checkHome();

const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
console.log('');
if (failed) console.log(`${plural(failed, 'blocking problem')}${warned ? `, ${plural(warned, 'warning')}` : ''}: peek cannot run yet.`);
else if (warned) console.log(`peek can run, with ${plural(warned, 'warning')}.`);
else console.log('all good: peek can run here.');
process.exit(failed ? 1 : 0);
