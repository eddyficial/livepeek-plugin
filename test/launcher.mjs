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

// ------------------------------------------------------ c. other agents ----
await test('pane --install-skill writes the skill to ~/.agents/skills with the install path filled in', () => {
  const r = run('pane.mjs', ['--install-skill'], tmpdir('skill-home'));
  eq(r.status, 0, 'exit code\n' + r.out);
  const text = fs.readFileSync(path.join(HOME, '.agents', 'skills', 'livepeek', 'SKILL.md'), 'utf8');
  assert(text.startsWith('---') && /\nname: livepeek\r?\n/.test(text), 'frontmatter missing\n' + text.slice(0, 200));
  assert(!text.includes('node "${CLAUDE_PLUGIN_ROOT}'), 'placeholder left in the launch command');
  assert(text.includes(`node "${ROOT.split(path.sep).join('/')}/scripts/pane.mjs"`), 'install path not filled in');
});

await test('pane --install-skill --project and --to choose the folder', () => {
  const dir = tmpdir('skill-project');
  eq(run('pane.mjs', ['--install-skill', '--project'], dir).status, 0, 'exit code (--project)');
  assert(fs.existsSync(path.join(dir, '.agents', 'skills', 'livepeek', 'SKILL.md')), 'no project skill');
  eq(run('pane.mjs', ['--install-skill', '--to', 'custom'], dir).status, 0, 'exit code (--to)');
  assert(fs.existsSync(path.join(dir, 'custom', 'livepeek', 'SKILL.md')), 'no --to skill');
});

/** Run a bin/ wrapper (the .cmd on Windows) with --dry-run, as a shell would. */
function wrapper(file, cwd, extra = {}) {
  const env = safeEnv({ HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: path.join(HOME, 'no-claude'), ...extra });
  for (const k of ['TMUX', 'ZELLIJ', 'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'WT_SESSION']) delete env[k];
  const r = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file + '.cmd', '--dry-run'], { cwd, env, encoding: 'utf8', timeout: 30000 })
    : spawnSync('sh', [file, '--dry-run'], { cwd, env, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

await test('the bin/ wrapper finds the install it lives in, with no Claude Code plugin registry', () => {
  const dir = tmpdir('wrapper-self');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
  const r = wrapper(path.join(ROOT, 'bin', 'livepeek'), dir);
  eq(r.status, 0, 'exit code\n' + r.out);
  assert(r.out.includes('target  : static'), 'missing "target  : static"\n' + r.out);
});

await test('a wrapper copied away from any install says how to install, and LIVEPEEK_HOME fixes it', () => {
  const dir = tmpdir('wrapper-copy');
  for (const name of ['livepeek', 'livepeek.cmd']) fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(dir, name));
  const r = wrapper(path.join(dir, 'livepeek'), dir);
  eq(r.status, 1, 'exit code\n' + r.out);
  assert(r.out.includes('livepeek is not installed') && r.out.includes('npm install --global'), 'missing install hint\n' + r.out);
  const fixed = wrapper(path.join(dir, 'livepeek'), dir, { LIVEPEEK_HOME: ROOT });
  eq(fixed.status, 0, 'LIVEPEEK_HOME exit code\n' + fixed.out);
});
