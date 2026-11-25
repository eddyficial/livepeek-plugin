#!/usr/bin/env node
/**
 * Check that this machine can run livepeek, and say what to fix if it can't.
 *
 *   node doctor.mjs
 *
 * One line per check: "ok", "warn" (livepeek runs, but something is degraded) or
 * "FAIL" (livepeek cannot run until it is fixed). Exits 1 only on a FAIL, so it
 * is safe to use in a script.
 *
 * The browser list and the multiplexer detection are copied from tui.mjs and
 * pane.mjs rather than imported: importing either one would start it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeTerminal, pickRenderer } from './lib/caps.mjs';
import { locateDriver } from './lib/driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const driverInstall = 'npm add --global playwright-core@1.63.0';
const recheck = 'livepeek --doctor';

function formatCheck(level, thing, detail, hint) {
  const line = `${level.padEnd(4)} ${thing}: ${detail}`;
  return hint && level !== 'ok' ? [line, `       fix: ${hint}`] : [line];
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Evaluate the collected facts without I/O. */
export function doctorVerdict({ nodeVersion, browser, driver, env, graphics, npmVersion, home }) {
  const lines = [];
  let failed = 0, warned = 0;
  const report = (level, thing, detail, hint) => {
    if (level === 'FAIL') failed++;
    if (level === 'warn') warned++;
    lines.push(...formatCheck(level, thing, detail, hint));
  };

  const nodeSupported = parseInt(nodeVersion.split('.')[0], 10) >= 20;
  if (nodeSupported) report('ok', 'node', `v${nodeVersion}`);
  else report('FAIL', 'node', `v${nodeVersion} is too old (need 20 or newer)`,
    'install a current Node.js (20 or newer) from the Node.js download page');

  if (browser) report('ok', 'browser', browser);
  else report('FAIL', 'browser', 'no Chrome, Chromium or Edge found in the usual places',
    'install Chrome or Edge (Windows already ships with Edge)');

  if (driver) report('ok', 'driver', `playwright-core ${driver.version} (${driver.directory})`);
  else report('FAIL', 'driver', `not installed. Run: ${driverInstall}`);

  const vscode = (env.TERM_PROGRAM || '').toLowerCase() === 'vscode';
  const host = detectHost(env, vscode);
  if (host) report('ok', 'multiplexer', host);
  else if (vscode) report('warn', 'multiplexer', 'VS Code terminal: split it by hand and run `livepeek --here` in the new half',
    'or run tmux inside it; for pictures enable terminal.integrated.enableImages');
  else report('warn', 'multiplexer', 'none detected, so there is no pane to split',
    'start tmux first (works everywhere), or run livepeek with --here to use this pane');

  if (!graphics) report('warn', 'graphics', 'not tested (stdin is not a terminal)',
    'rerun livepeek --doctor in an interactive terminal');
  else {
    const renderer = pickRenderer(graphics);
    const support = [graphics.kitty && 'kitty', graphics.sixel && 'sixel'].filter(Boolean).join(' + ') || 'no kitty or sixel';
    const cell = `${graphics.cw}x${graphics.ch}px cells${graphics.cellFrom ? ` (from ${graphics.cellFrom})` : ' (guessed)'}`;
    const detail = `${support}; ${cell}; would use ${renderer}`;
    if (renderer === 'blocks') report('warn', 'graphics', detail,
      'half-blocks work but are coarse; try Windows Terminal 1.22+, Kitty, WezTerm or Ghostty' +
      (graphics.tmux ? ', and set -g allow-passthrough on in tmux' : ''));
    else report('ok', 'graphics', detail);
  }

  if (npmVersion) report('ok', 'npm', `v${npmVersion}`);
  else report(driver ? 'warn' : 'FAIL', 'npm', 'not found on PATH',
    'install Node.js with npm included; livepeek needs it to start dev servers');

  if (home.error) report('FAIL', '~/.livepeek', `cannot write to ${home.directory}: ${home.error}`,
    'make that folder writable; livepeek keeps its pane state and project list there');
  else report('ok', '~/.livepeek', `writable (${home.directory})`);

  let next = recheck;
  if (nodeSupported && npmVersion) {
    if (!driver) next = driverInstall;
    else if (!failed && graphics) next = host ? 'livepeek' : 'livepeek --here';
  }
  lines.push(`next: ${next}`, '');
  if (failed) lines.push(`${plural(failed, 'blocking problem')}${warned ? `, ${plural(warned, 'warning')}` : ''}: livepeek cannot run yet.`);
  else if (!graphics) lines.push(`${plural(warned, 'warning')}: interactive graphics not tested.`);
  else if (warned) lines.push(`livepeek can run, with ${plural(warned, 'warning')}.`);
  else lines.push('all good: livepeek can run here.');
  return { lines, exitCode: failed ? 1 : 0 };
}

// Same list as findSystemBrowser in tui.mjs. Keep the two in step.
function findSystemBrowser() {
  const configured = process.env.LIVEPEEK_BROWSER
    || process.env.PEEK_BROWSER;
  const candidates = [configured].filter(Boolean);

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

// Found the way tui.mjs finds it: project, next to the scripts, or a global
// npm global folder, so the two never disagree.
function findDriver() {
  const where = locateDriver(__dirname);
  if (!where) return null;

  let version = 'unknown version';
  try { version = JSON.parse(fs.readFileSync(where, 'utf8')).version; } catch { /* keep default */ }
  return { version, directory: path.dirname(where) };
}

// Same order as detectHost in pane.mjs: tmux can run inside the others, so it wins.
function detectHost(env, vscode) {
  // A VS Code terminal inherits the environment VS Code was launched from,
  // so ZELLIJ or WT_SESSION may be set while no such pane is anywhere near
  // this terminal. TERM_PROGRAM is set by the innermost program: VS Code
  // says vscode, and tmux overrides it with tmux when it is really inside.
  if (env.TMUX && !vscode) return 'tmux';
  if (vscode) return null;
  if (env.ZELLIJ) return 'zellij';
  if (env.KITTY_LISTEN_ON) return 'kitty';
  if (env.WEZTERM_PANE) return 'wezterm';
  if (env.WT_SESSION) return 'wt';
  return null;
}

// Ask the terminal only when its replies can arrive on stdin.
export async function collectGraphics(isTTY, probe) {
  if (!isTTY) return null;
  return probe();
}

async function probeGraphics() {
  const { stdin } = process;
  const wasRaw = !!stdin.isRaw;
  try {
    stdin.setRawMode?.(true);
    stdin.resume();
    return await probeTerminal();
  } finally {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  }
}

function findNpmVersion() {
  // shell: true so Windows finds npm.cmd
  const result = spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function checkHome(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { directory, error: null };
  } catch (error) {
    return { directory, error: error.code || error.message };
  }
}

async function main() {
  const { STATE_DIR } = await import('./lib/state.mjs');
  const facts = {
    nodeVersion: process.versions.node,
    browser: findSystemBrowser(),
    driver: findDriver(),
    env: process.env,
    graphics: await collectGraphics(process.stdin.isTTY, probeGraphics),
    npmVersion: findNpmVersion(),
    home: checkHome(STATE_DIR),
  };
  const { lines, exitCode } = doctorVerdict(facts);
  console.log(lines.join('\n'));
  process.exitCode = exitCode;
}

function isEntryPoint(entry) {
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync.native(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) await main();
