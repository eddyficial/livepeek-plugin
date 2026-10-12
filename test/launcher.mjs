/** Launcher tests: scripts/pane.mjs and scripts/tui.mjs run as child processes. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, SCRIPTS, HOME, tmpdir, test, eq, assert } from './helpers.mjs';

// Child processes get an allowlist, never a copy of the whole environment.
const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL'];
function safeEnv(extra = {}) {
  const env = {};
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Run a livepeek script as a child with a clean, multiplexer-free environment. */
function run(script, args, cwd) {
  const env = safeEnv({ HOME, USERPROFILE: HOME });
  for (const k of ['TMUX', 'ZELLIJ', 'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'WT_SESSION']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

// ---------------------------------------------------------- b. launcher ----
await test('pane --dry-run in a folder with index.html -> static', () => {
  const dir = tmpdir('dry-static');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
  const r = run('pane.mjs', ['--dry-run'], dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('target  : static'), 'missing "target  : static"\n' + r.out);
});

await test('pane --dry-run in a vite project -> project : vite', () => {
  const dir = tmpdir('dry-vite');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'v', devDependencies: { vite: '^5.0.0' } }));
  const r = run('pane.mjs', ['--dry-run'], dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('project : vite'), 'missing "project : vite"\n' + r.out);
});

await test('pane --dry-run targets the port set in vite.config, not 5173', () => {
  const dir = tmpdir('dry-vite-config');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'v', scripts: { dev: 'vite' }, devDependencies: { vite: '^7.0.0' } }));
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), "export default { server: { port: 5280, proxy: { '/api': 'http://127.0.0.1:5281' } } };\n");
  const r = run('pane.mjs', ['--dry-run'], dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('target  : http://localhost:5280'), 'missing config port\n' + r.out);
});

await test('pane --dry-run reuses the port a project was last shown on', async () => {
  const dir = tmpdir('dry-vite-remembered');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'v', scripts: { dev: 'vite' }, devDependencies: { vite: '^7.0.0' } }));
  const projects = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'projects.mjs')).href);
  projects.remember({ dir, name: 'v', kind: 'vite', file: null, url: 'http://localhost:4444', script: 'dev', port: 4444, preset: 'fit' });
  const r = run('pane.mjs', ['--dry-run'], dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('target  : http://localhost:4444'), 'missing remembered port\n' + r.out);
});

await test('pane --dry-run in an empty folder shows the welcome notice', () => {
  const dir = tmpdir('dry-empty');
  const r = run('pane.mjs', ['--dry-run'], dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('opening the welcome page'), 'missing welcome notice\n' + r.out);
});

await test('tui --list prints a fit preset', () => {
  const r = run('tui.mjs', ['--list'], ROOT);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes(' fit '), 'no line containing " fit "\n' + r.out.slice(0, 400));
});

await test('tui --preset nope exits 1', () => {
  const r = run('tui.mjs', ['--preset', 'nope'], ROOT);
  eq(r.status, 1, 'exit code\n' + r.out);
});
