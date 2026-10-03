#!/usr/bin/env node
/**
 * Test harness for peek. No dependencies, no TTY, no terminal multiplexer.
 *
 *   node test/run.mjs
 *
 * Browser tests run only when a Chromium and playwright-core can be found
 * (PEEK_BROWSER may point at the executable); otherwise they print "skip".
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const ESC = '\x1b';

// A throwaway HOME, set before any peek module is imported: projects.mjs and
// session.mjs read os.homedir() at load time and must never touch the real one.
// Child processes get an allowlist, never a copy of the whole environment:
// the browser needs profile and temp locations and PATH, not whatever tokens
// the developer happens to have exported in their shell.
const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL'];
function safeEnv(extra = {}) {
  const env = {};
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}
const REAL_ENV = safeEnv();             // the browser needs the real profile locations
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-test-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const lib = (n) => import(pathToFileURL(path.join(SCRIPTS, 'lib', n)).href);
const tmpdir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

// ------------------------------------------------------------- framework ----
const results = { ok: 0, FAIL: 0, skip: 0 };
const servers = [];
async function test(name, fn) {
  try {
    const r = await fn();
    if (r && r.skip) { results.skip++; console.log(`skip  ${name} (${r.skip})`); return; }
    results.ok++; console.log(`ok    ${name}`);
  } catch (e) {
    results.FAIL++;
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/** Run a peek script as a child with a clean, multiplexer-free environment. */
function run(script, args, cwd) {
  const env = safeEnv({ HOME, USERPROFILE: HOME });
  for (const k of ['TMUX', 'ZELLIJ', 'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'WT_SESSION']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

async function serve(root, opts = {}) {
  const { serveStatic } = await lib('serve.mjs');
  const { server, port } = await serveStatic({ root, ...opts });
  servers.push(server);
  return `http://127.0.0.1:${port}/`;
}

// ------------------------------------------------------------ a. unit ----
await test('png.resize averages a 4x4 image to 2x2', async () => {
  const { resize } = await lib('png.mjs');
  const data = Buffer.alloc(4 * 4 * 3);
  // three flat 2x2 blocks, and block (0,0) holding 0,0,0,0 + one bright pixel
  const flat = { 1: [100, 110, 120], 2: [200, 210, 220], 3: [4, 8, 12] };
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const b = (y >> 1) * 2 + (x >> 1);
    if (b) data.set(flat[b], (y * 4 + x) * 3);
  }
  data.set([40, 80, 120], (1 * 4 + 1) * 3);      // block (0,0) averages to 10,20,30
  const out = resize({ width: 4, height: 4, data }, 2, 2);
  eq([out.width, out.height], [2, 2], 'size');
  eq(Array.from(out.data), [10, 20, 30, 100, 110, 120, 200, 210, 220, 4, 8, 12], 'pixels');
});

await test('sixel.toSixel starts with ESC P9;0;0q and ends with ESC \\', async () => {
  const { toSixel } = await lib('sixel.mjs');
  const w = 4, h = 6, data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(i % 2 ? [255, 0, 0] : [0, 0, 255], i * 3);
  const s = toSixel({ width: w, height: h, data }, 16);
  assert(s.startsWith(`${ESC}P9;0;0q`), 'bad prefix: ' + JSON.stringify(s.slice(0, 12)));
  assert(s.endsWith(`${ESC}\\`), 'bad suffix: ' + JSON.stringify(s.slice(-6)));
});

await test('kitty.toKitty starts with the delete sequence', async () => {
  const { toKitty } = await lib('kitty.mjs');
  const s = toKitty({ width: 2, height: 2, data: Buffer.alloc(12, 7) });
  assert(s.startsWith(`${ESC}_Ga=d,d=i,i=1${ESC}\\`), 'bad prefix: ' + JSON.stringify(s.slice(0, 24)));
});

await test('projects remember()/list() round-trip in a temp HOME', async () => {
  const projects = await lib('projects.mjs');
  const a = tmpdir('proj-a'), b = tmpdir('proj-b');
  eq(projects.list(), [], 'starts empty');
  projects.remember({ dir: a, name: 'a', kind: 'site', file: null, url: null, script: null, port: null, preset: 'fit' });
  projects.remember({ dir: b, name: 'b', kind: 'vite', file: null, url: 'http://localhost:5173', script: 'dev', port: 5173, preset: 'desktop' });
  let l = projects.list();
  eq(l.map(p => p.name), ['b', 'a'], 'most recent first');
  projects.remember({ dir: a, name: 'a', kind: 'document', file: 'x.md', url: null, script: null, port: null, preset: 'fit' });
  l = projects.list();
  eq(l.map(p => p.name), ['a', 'b'], 're-remembering moves to top without duplicating');
  eq(l[0].kind, 'document', 'updated entry wins');
  assert(fs.existsSync(path.join(HOME, '.peek', 'projects.json')), 'file not written under temp HOME');
});

await test('serveStatic serves index.html with live-reload script', async () => {
  const dir = tmpdir('serve-html');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Hello Peek</title><body><h1>hi</h1></body>');
  const url = await serve(dir);
  const res = await fetch(url);
  eq(res.status, 200, 'status');
  const text = await res.text();
  assert(text.includes('<h1>hi</h1>'), 'index.html content missing');
  assert(text.includes('/__peek/stamp'), 'live-reload script missing');
});

await test('serveStatic renders README.md with an h1 and live reload', async () => {
  const dir = tmpdir('serve-md');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Big Title\n\nsome text\n');
  const url = await serve(dir, { file: 'README.md' });
  const text = await (await fetch(url)).text();
  assert(/<h1[^>]*>\s*Big Title\s*<\/h1>/.test(text), 'no rendered h1: ' + text.slice(0, 300));
  assert(text.includes('/__peek/stamp'), 'live-reload script missing');
});

// Raw request: fetch() would collapse "/%2e%2e/" before it reached the server.
const httpGetRaw = (base, rawPath) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

await test('serveStatic refuses path traversal, including sibling dirs sharing the root prefix', async () => {
  const base = fs.mkdtempSync(path.join(TMP, 'trav-'));
  let server;
  try {
    fs.mkdirSync(path.join(base, 'site'));
    fs.mkdirSync(path.join(base, 'site2'));
    fs.writeFileSync(path.join(base, 'site', 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(base, 'site2', 'secret.txt'), 'SECRET');
    fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE');
    const { serveStatic } = await lib('serve.mjs');
    let port;
    ({ server, port } = await serveStatic({ root: path.join(base, 'site') }));
    const url = `http://127.0.0.1:${port}/`;
    for (const p of ['/..%2fsite2%2fsecret.txt', '/%2e%2e/outside.txt', '/..%5coutside.txt', '/..%2foutside.txt']) {
      const r = await httpGetRaw(url, p);
      assert(r.status === 403 || r.status === 404, `${p}: status ${r.status}, want 403 or 404`);
      assert(!r.body.includes('SECRET') && !r.body.includes('OUTSIDE'), `${p}: leaked file contents`);
    }
    eq((await httpGetRaw(url, '/index.html')).status, 200, 'legit file still served');
  } finally {
    if (server) { server.close(); server.closeAllConnections?.(); }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

await test('serveStatic answers malformed percent-encoding with 400 and keeps serving', async () => {
  const dir = tmpdir('serve-badpct');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
  const url = await serve(dir);
  eq((await httpGetRaw(url, '/%E0%A4%A')).status, 400, 'malformed escape');
  eq((await httpGetRaw(url, '/index.html')).status, 200, 'server still alive');
});

await test('serveStatic returns 204 for /favicon.ico when the root has none', async () => {
  const dir = tmpdir('serve-favicon');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
  const url = await serve(dir);
  eq((await httpGetRaw(url, '/favicon.ico')).status, 204, 'favicon status');
});

await test('textview.layoutText wraps, keeps spans, bullets and rules', async () => {
  const { layoutText } = await lib('textview.mjs');
  const width = 40;
  const blocks = [
    { kind: 'h1', parts: [{ text: 'Title' }] },
    { kind: 'p', parts: [{ text: 'Read the ' }, { text: 'docs', id: '1', role: 'link' }, { text: ' now and keep going with more words so the line wraps around the width' }] },
    { kind: 'li', parts: [{ text: 'one' }] },
    { kind: 'hr', parts: [{ text: '—' }] },
  ];
  const lines = layoutText(blocks, width);
  const plain = (l) => l.text.replace(/\x1b\[[0-9;]*m/g, '');
  eq(plain(lines[0]), 'Title', 'first line');
  for (const l of lines) assert(plain(l).length <= width, 'line too wide: ' + JSON.stringify(plain(l)));
  const linked = lines.find(l => l.spans.some(sp => sp.id === '1' && sp.role === 'link'));
  assert(linked, 'no line with link span id 1');
  const sp = linked.spans.find(x => x.id === '1' && x.role === 'link');
  eq(plain(linked).slice(sp.c0, sp.c1), 'docs', 'span range text');
  assert(lines.some(l => plain(l).startsWith('  • one')), 'no bullet line');
  assert(lines.some(l => /^─+$/.test(plain(l))), 'no hr line');
});

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

// ----------------------------------------------------------- c. browser ----
function browserCandidates() {
  const cands = [];
  if (process.env.PEEK_BROWSER) cands.push(process.env.PEEK_BROWSER);
  // same list as findSystemBrowser() in scripts/tui.mjs
  if (process.platform === 'win32') {
    for (const r of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)) {
      cands.push(path.join(r, 'Google/Chrome/Application/chrome.exe'));
      cands.push(path.join(r, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return cands.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
}

function findPlaywright() {
  for (const base of [SCRIPTS + path.sep, process.cwd() + path.sep]) {
    try {
      const mod = createRequire(base)('playwright-core');
      const chromium = mod?.chromium ?? mod?.default?.chromium;
      if (chromium) return chromium;
    } catch { /* next */ }
  }
  return null;
}

await test('browser: title, live reload, screenshot', async () => {
  const exes = browserCandidates();
  if (!exes.length) return { skip: 'no Chromium found; set PEEK_BROWSER' };
  const chromium = findPlaywright();
  if (!chromium) return { skip: 'playwright-core not resolvable' };

  const dir = tmpdir('browser');
  const file = path.join(dir, 'index.html');
  const doc = (h) => `<!doctype html><title>Peek Test</title><body><h1>${h}</h1></body>`;
  fs.writeFileSync(file, doc('one'));
  const url = await serve(dir);

  // Try each candidate: a machine can have a Chrome that exists but will not
  // start headless under automation. An explicit PEEK_BROWSER must work, though.
  let browser = null, lastErr = null;
  for (const exe of process.env.PEEK_BROWSER ? exes.slice(0, 1) : exes) {
    try {
      browser = await chromium.launch({
        headless: true, executablePath: exe, env: REAL_ENV, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!browser) {
    if (process.env.PEEK_BROWSER) throw lastErr;
    return { skip: 'no browser could be launched: ' + String(lastErr?.message || lastErr).split('\n')[0] };
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    eq(await page.title(), 'Peek Test', 'title');
    eq(await page.textContent('h1'), 'one', 'initial h1');

    // let the poller record its first stamp, then change the file
    await new Promise(r => setTimeout(r, 1200));
    fs.writeFileSync(file, doc('two'));
    const future = new Date(Date.now() + 5000);   // guarantee a newer mtime on coarse filesystems
    fs.utimesSync(file, future, future);

    let h1 = 'one';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && h1 !== 'two') {
      await new Promise(r => setTimeout(r, 250));
      try { h1 = await page.textContent('h1', { timeout: 1000 }); } catch { /* mid-reload */ }
    }
    eq(h1, 'two', 'h1 after live reload');

    const png = await page.screenshot();
    assert(png.length > 1024, `screenshot too small: ${png.length} bytes`);
    eq(Array.from(png.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  } finally {
    await browser.close().catch(() => {});
  }
});

await test('browser: textview EXTRACT finds blocks, links, buttons, inputs', async () => {
  const exes = browserCandidates();
  if (!exes.length) return { skip: 'no Chromium found; set PEEK_BROWSER' };
  const chromium = findPlaywright();
  if (!chromium) return { skip: 'playwright-core not resolvable' };
  const { EXTRACT } = await lib('textview.mjs');

  let browser = null, lastErr = null;
  for (const exe of process.env.PEEK_BROWSER ? exes.slice(0, 1) : exes) {
    try {
      browser = await chromium.launch({
        headless: true, executablePath: exe, env: REAL_ENV, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!browser) {
    if (process.env.PEEK_BROWSER) throw lastErr;
    return { skip: 'no browser could be launched: ' + String(lastErr?.message || lastErr).split('\n')[0] };
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.setContent('<h1>Hi</h1><p>para</p><a href="#x">link</a><button>Go</button><input placeholder="name">');
    const result = await page.evaluate(EXTRACT);
    const text = (b) => b.parts.map(p => p.text).join('');
    assert(result.blocks.some(b => b.kind === 'h1' && text(b) === 'Hi'), 'no h1 block "Hi": ' + JSON.stringify(result.blocks));
    const parts = result.blocks.flatMap(b => b.parts);
    assert(parts.some(p => p.role === 'link' && p.id), 'no link part with id');
    assert(parts.some(p => p.role === 'button'), 'no button part');
    assert(parts.some(p => p.role === 'input'), 'no input part');
    assert(await page.evaluate(() => document.querySelector('[data-peek-id]') !== null), 'no data-peek-id in DOM');
  } finally {
    await browser.close().catch(() => {});
  }
});

// -------------------------------------------------------------- summary ----
for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch { /* ignore */ } }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${results.ok} ok, ${results.FAIL} failed, ${results.skip} skipped`);
process.exit(results.FAIL ? 1 : 0);
