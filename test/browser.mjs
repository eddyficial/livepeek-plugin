/**
 * Browser tests: need a Chromium and playwright-core (LIVEPEEK_BROWSER may point at
 * the executable); otherwise they report "skip". The page URL comes from serve().
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SCRIPTS, REAL_HOME, lib, tmpdir, test, eq, assert, serve } from './helpers.mjs';

// The browser needs profile and temp locations and PATH, not whatever tokens
// the developer happens to have exported in their shell.
const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL'];
function safeEnv(extra = {}) {
  const env = {};
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}
// the browser needs the real profile locations (helpers swapped HOME for a temp one)
const REAL_ENV = safeEnv(Object.fromEntries(Object.entries(REAL_HOME).filter(([, v]) => v !== undefined)));

function browserCandidates() {
  const cands = [];
  const configured = process.env.LIVEPEEK_BROWSER
    || process.env.PEEK_BROWSER;
  if (configured) cands.push(configured);
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
  if (!exes.length) return { skip: 'no Chromium found; set LIVEPEEK_BROWSER' };
  const chromium = findPlaywright();
  if (!chromium) return { skip: 'playwright-core not resolvable' };

  const dir = tmpdir('browser');
  const file = path.join(dir, 'index.html');
  const doc = (h) => `<!doctype html><title>livepeek Test</title><body><h1>${h}</h1></body>`;
  fs.writeFileSync(file, doc('one'));
  const url = await serve(dir);

  // Try each candidate: a machine can have a Chrome that exists but will not
  // start headless under automation. An explicit LIVEPEEK_BROWSER must work, though.
  let browser = null, lastErr = null;
  const configured = process.env.LIVEPEEK_BROWSER
    || process.env.PEEK_BROWSER;
  for (const exe of configured ? exes.slice(0, 1) : exes) {
    try {
      browser = await chromium.launch({
        headless: true, executablePath: exe, env: REAL_ENV, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!browser) {
    if (configured) throw lastErr;
    return { skip: 'no browser could be launched: ' + String(lastErr?.message || lastErr).split('\n')[0] };
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    eq(await page.title(), 'livepeek Test', 'title');
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
  if (!exes.length) return { skip: 'no Chromium found; set LIVEPEEK_BROWSER' };
  const chromium = findPlaywright();
  if (!chromium) return { skip: 'playwright-core not resolvable' };
  const { EXTRACT } = await lib('textview.mjs');

  let browser = null, lastErr = null;
  const configured = process.env.LIVEPEEK_BROWSER
    || process.env.PEEK_BROWSER;
  for (const exe of configured ? exes.slice(0, 1) : exes) {
    try {
      browser = await chromium.launch({
        headless: true, executablePath: exe, env: REAL_ENV, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!browser) {
    if (configured) throw lastErr;
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
    assert(await page.evaluate(() => document.querySelector('[data-livepeek-id]') !== null), 'no data-livepeek-id in DOM');
  } finally {
    await browser.close().catch(() => {});
  }
});
