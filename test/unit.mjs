/** Unit tests: image encoders, project list, text layout, static server. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, TMP, SCRIPTS, lib, tmpdir, test, eq, assert, serve, httpGetRaw } from './helpers.mjs';

const ESC = '\x1b';

await test('frame settler bounds a hung evaluate and keeps only one in flight', async () => {
  const { createFrameSettler } = await lib('frame.mjs');
  const settle = createFrameSettler(30);
  let calls = 0;
  const page = { evaluate() { calls++; return new Promise(() => {}); } };

  const started = Date.now();
  await settle(page);
  const firstElapsed = Date.now() - started;
  assert(firstElapsed >= 15 && firstElapsed < 300, `first settle took ${firstElapsed}ms`);

  const secondStarted = Date.now();
  await settle(page);
  const secondElapsed = Date.now() - secondStarted;
  assert(secondElapsed >= 15 && secondElapsed < 300, `second settle took ${secondElapsed}ms`);
  eq(calls, 1, 'evaluate calls while the first is still pending');
});

await test('qr chooses the smallest fitting version and draws three finders', async () => {
  const { qrMatrix } = await lib('qr.mjs');
  const { size, modules } = qrMatrix('http://192.168.1.23:5173/', { ecl: 'M' });
  eq(size, 25, '25-byte level-M URL fits version 2');
  eq(modules.length, size, 'matrix height');
  assert(modules.every(row => row.length === size && row.every(v => typeof v === 'boolean')), 'matrix is not boolean and square');
  const finder = [
    '1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111',
  ];
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    eq(modules.slice(y0, y0 + 7).map(row => row.slice(x0, x0 + 7).map(Number).join('')), finder, `finder at ${x0},${y0}`);
  }
});

await test('qr.halfBlocks includes a two-module quiet zone and packs two rows', async () => {
  const { qrMatrix, qrHalfBlocks } = await lib('qr.mjs');
  const text = 'http://192.168.1.23:5173/';
  const { size } = qrMatrix(text);
  const rows = qrHalfBlocks(text);
  eq(rows.length, Math.ceil((size + 4) / 2), 'terminal row count');
  assert(rows.every(row => row.length === size + 4), 'terminal row width');
  assert(rows.every(row => /^[ ▀▄█]+$/.test(row)), 'unexpected terminal glyph');
  assert(rows[0] === ' '.repeat(size + 4), 'top quiet zone missing');
});
await test('lan: Wi-Fi addresses first, virtual adapters and link-local left out', async () => {
  const { lanAddresses, phoneUrl } = await lib('lan.mjs');
  const got = lanAddresses({
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.48.1', internal: false }],
    'Ethernet 2': [{ family: 'IPv4', address: '10.0.0.7', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.4.76', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Local Area Connection': [{ family: 'IPv4', address: '169.254.10.2', internal: false }],
  });
  eq(got.map(a => a.address), ['192.168.4.76', '10.0.0.7'], 'ranked, filtered');
  eq(phoneUrl('http://localhost:5173/settings?tab=1', '192.168.4.76'), 'http://192.168.4.76:5173/settings?tab=1', 'loopback swapped');
  eq(phoneUrl('http://127.0.0.1:8080/', '10.0.0.7'), 'http://10.0.0.7:8080/', '127.0.0.1 swapped');
  eq(phoneUrl('https://example.com/x', '10.0.0.7'), 'https://example.com/x', 'a real host is left alone');
});

await test('pick: the clipboard reference is one plain-ASCII line', async () => {
  const { pickReference } = await lib('pick.mjs');
  const line = pickReference({ tag: 'button', text: 'Start 16:8 fast', selector: 'button.btn.primary', component: 'StartCard', url: 'http://localhost:5173/' });
  eq(line, '[livepeek pick] <button> | "Start 16:8 fast" | button.btn.primary | in <StartCard> | on http://localhost:5173/', 'reference');
  const long = pickReference({ tag: 'p', text: 'x'.repeat(100), selector: 'p', component: null, url: '' });
  assert(/^[\x20-\x7e]+$/.test(long) && long.includes('x'.repeat(57) + '...'), 'long text is cut with ASCII dots');
});


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

await test('state migrates the legacy directory under the temp HOME', async () => {
  const legacy = path.join(HOME, '.peek');
  const current = path.join(HOME, '.livepeek');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'legacy-marker'), 'migrated');
  const { STATE_DIR } = await lib('state.mjs');
  eq(STATE_DIR, current, 'state directory');
  assert(fs.existsSync(path.join(current, 'legacy-marker')), 'legacy state was not migrated');
  assert(!fs.existsSync(legacy), 'legacy state directory still exists');
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
  assert(fs.existsSync(path.join(HOME, '.livepeek', 'projects.json')), 'file not written under temp HOME');
});

await test('serveStatic serves index.html with live-reload script', async () => {
  const dir = tmpdir('serve-html');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Hello livepeek</title><body><h1>hi</h1></body>');
  const url = await serve(dir);
  const res = await httpGetRaw(url, '/');
  eq(res.status, 200, 'status');
  const text = res.body;
  assert(text.includes('<h1>hi</h1>'), 'index.html content missing');
  assert(text.includes('/__livepeek/stamp'), 'live-reload script missing');
});

await test('serveStatic renders README.md with an h1 and live reload', async () => {
  const dir = tmpdir('serve-md');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Big Title\n\nsome text\n');
  const url = await serve(dir, { file: 'README.md' });
  const text = (await httpGetRaw(url, '/')).body;
  assert(/<h1[^>]*>\s*Big Title\s*<\/h1>/.test(text), 'no rendered h1: ' + text.slice(0, 300));
  assert(text.includes('/__livepeek/stamp'), 'live-reload script missing');
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

await test('serveStatic refuses links out of the root, and dot-files', async () => {
  const base = tmpdir('serve-links');
  let server;
  try {
    fs.mkdirSync(path.join(base, 'site'));
    fs.mkdirSync(path.join(base, 'private'));
    fs.writeFileSync(path.join(base, 'site', 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(base, 'site', '.env'), 'TOKEN=SECRET');
    fs.writeFileSync(path.join(base, 'private', 'secret.txt'), 'SECRET');
    // a junction needs no admin rights on Windows; a plain symlink elsewhere
    fs.symlinkSync(path.join(base, 'private'), path.join(base, 'site', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const { serveStatic } = await lib('serve.mjs');
    let port;
    ({ server, port } = await serveStatic({ root: path.join(base, 'site') }));
    const url = `http://127.0.0.1:${port}/`;
    for (const p of ['/escape/secret.txt', '/escape/', '/.env']) {
      const r = await httpGetRaw(url, p);
      assert(r.status === 403 || r.status === 404, `${p}: status ${r.status}, want 403 or 404`);
      assert(!r.body.includes('SECRET'), `${p}: leaked file contents`);
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

await test('session detects Kitty from either Kitty environment variable', async () => {
  const { detectHost } = await lib('session.mjs');
  eq(detectHost({ KITTY_LISTEN_ON: 'unix:/tmp/kitty' }), 'kitty', 'listen socket');
  eq(detectHost({ KITTY_WINDOW_ID: '7' }), 'kitty', 'window id');
  eq(detectHost({ TMUX: '1', KITTY_WINDOW_ID: '7' }), 'tmux', 'tmux keeps precedence');
});

await test('LAN gate exchanges its token for a cookie and strips it from the URL', async () => {
  const dir = tmpdir('serve-lan-gate');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>LAN</h1>');
  const { gateLanRequest, serveStatic } = await lib('serve.mjs');
  const token = 'abcdefghijklmnopqrstuvwx';
  const local = await serveStatic({ root: dir });
  const lan = http.createServer(gateLanRequest(token, (req, res) => local.server.emit('request', req, res)));
  await new Promise((resolve, reject) => { lan.once('error', reject); lan.listen(0, '127.0.0.1', () => resolve()); });
  const address = lan.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/`;
  const cookieName = `lp_t_${port}`;
  try {
    eq((await httpGetRaw(base, '/')).status, 403, 'missing token');
    eq((await httpGetRaw(base, '/?t=bad')).status, 403, 'bad token');
    eq((await httpGetRaw(base, '/?t=x')).status, 403, 'wrong-length token does not throw');
    const accepted = await httpGetRaw(base, '/docs?keep=1&t=' + token);
    eq(accepted.status, 302, 'good token');
    eq(accepted.headers.location, '/docs?keep=1', 'token stripped, other query kept');
    assert(String(accepted.headers['set-cookie']).includes(`${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/`), 'per-port cookie missing');
    eq((await httpGetRaw(base, '/', { cookie: `lp_t_1=${token}` })).status, 403, 'another port cookie is rejected');
    const served = await httpGetRaw(base, '/', { cookie: `${cookieName}=bad; ${cookieName}=${token}` });
    eq(served.status, 200, 'cookie reaches static server');
    assert(served.body.includes('<h1>LAN</h1>'), 'static response missing');
    const safe = await httpGetRaw(base, '/.//evil.com?t=' + token);
    eq(safe.status, 302, 'dot-segment token accepted');
    eq(safe.headers.location, '/evil.com', 'redirect remains origin-relative');
  } finally {
    lan.close(); lan.closeAllConnections?.();
    local.server.close(); local.server.closeAllConnections?.();
  }
});

await test('textview.layoutText wraps, keeps spans, bullets and rules', async () => {
  const { layoutText } = await lib('textview.mjs');
  const width = 40;
  const blocks = [
    { kind: 'h1', parts: [{ text: 'Title' }] },
    { kind: 'p', parts: [{ text: 'Read the ' }, { text: 'docs', id: '1', role: 'link' }, { text: ' now and keep going with more words so the line wraps around the width' }] },
    { kind: 'li', parts: [{ text: 'one' }] },
    { kind: 'hr', parts: [{ text: '-' }] },
  ];
  const lines = layoutText(blocks, width);
  // eslint-disable-next-line no-control-regex -- strips terminal color escapes.
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

await test('portFromConfig reads server.port and ignores hmr, proxies and comments', async () => {
  const { portFromConfig } = await import(pathToFileURL(path.join(SCRIPTS, 'targets.mjs')).href);
  const vite = `export default defineConfig({
    // server: { port: 1111 },
    server: {
      proxy: { '/api': 'http://127.0.0.1:5281', '/ws': { target: 'ws://x:9999', port: 2222 } },
      hmr: { port: 24678 },
      port: 5280,
      strictPort: true,
    },
  });`;
  eq(portFromConfig(vite, 'server'), 5280, 'vite server.port');
  eq(portFromConfig('export default { server: { hmr: { port: 24678 } } }', 'server'), null, 'hmr only');
  eq(portFromConfig('export default { server: { port: Number(process.env.PORT) || 4000 } }', 'server'), 4000, 'computed port');
  eq(portFromConfig('export default { devServer: { port: 3100 } }', 'devServer'), 3100, 'nuxt devServer');
  eq(portFromConfig('export default { preview: { port: 4173 } }', 'server'), null, 'preview is not server');
});

await test('detectFramework takes the port from the script, then the config, then the default', async () => {
  const { detectFramework } = await import(pathToFileURL(path.join(SCRIPTS, 'targets.mjs')).href);
  const dir = tmpdir('fw-config-port');
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), "export default { server: { port: 5280 } };\n");
  const pkg = { devDependencies: { vite: '^7' }, scripts: { dev: 'vite' } };
  let fw = detectFramework(pkg, dir);
  eq([fw.port, fw.portFrom], [5280, 'config'], 'config port');
  assert(!('config' in fw), 'internal config spec leaked into the result');
  fw = detectFramework({ ...pkg, scripts: { dev: 'vite --port 6000' } }, dir);
  eq([fw.port, fw.portFrom], [6000, 'script'], 'script flag beats config');
  fw = detectFramework(pkg, tmpdir('fw-no-config'));
  eq([fw.port, fw.portFrom], [5173, 'default'], 'default without a config');
});

await test('portFromScript follows npm:x and npm run x, but only into framework scripts', async () => {
  const { portFromScript } = await import(pathToFileURL(path.join(SCRIPTS, 'targets.mjs')).href);
  const scripts = {
    dev: 'concurrently "npm:dev:api" "npm:dev:web"',
    'dev:api': 'PORT=4000 node server.js',
    'dev:web': 'vite --port 5280',
    start: 'npm run dev:web',
    loop: 'npm run loop',
  };
  eq(portFromScript(scripts, 'dev'), 5280, 'concurrently npm: refs');
  eq(portFromScript(scripts, 'start'), 5280, 'npm run ref');
  eq(portFromScript({ dev: 'npm:dev:api', 'dev:api': 'PORT=4000 node s.js' }, 'dev'), null, 'API port ignored');
  eq(portFromScript(scripts, 'loop'), null, 'self reference');
  eq(portFromScript({ dev: 'next dev -p 3100' }, 'dev'), 3100, 'own flag');
});

await test('announcedPort reads the Local: address a dev server prints', async () => {
  const { announcedPort } = await lib('devserver.mjs');
  eq(announcedPort('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m'), 5174, 'vite, coloured');
  eq(announcedPort('[web]   ➜  Local:   http://localhost:5280/'), 5280, 'concurrently prefix');
  eq(announcedPort('   - Local:        http://localhost:3001'), 3001, 'next');
  eq(announcedPort('{"msg":"Server listening at http://127.0.0.1:5281"}'), null, 'API log line');
  eq(announcedPort('  ➜  Network: http://192.168.1.4:5173/'), null, 'network address');
});

await test('servesOtherProject spots another project\'s Vite by its 403', async () => {
  const { servesOtherProject } = await lib('devserver.mjs');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(decodeURI(req.url));
    if (req.url.includes('mine')) { res.end('{}'); return; }
    res.statusCode = 403;
    res.end('<p>The request id "x" is outside of Vite serving allow list.</p>');
  });
  await new Promise(r => server.listen(0, 'localhost', () => r(null)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    eq(await servesOtherProject(port, path.join(TMP, 'other proj')), true, 'foreign 403');
    eq(await servesOtherProject(port, path.join(TMP, 'mine')), false, 'own 200');
    assert(seen[0].startsWith('/@fs/') && seen[0].endsWith('/other proj/package.json') && !seen[0].includes('\\'), 'bad probe path ' + seen[0]);
  } finally { server.close(); }
  eq(await servesOtherProject(port, TMP), false, 'nothing listening');
});
