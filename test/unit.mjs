/** Unit tests: image encoders, project list, text layout, static server. */
import fs from 'node:fs';
import path from 'node:path';
import { HOME, TMP, lib, tmpdir, test, eq, assert, serve, httpGetRaw } from './helpers.mjs';

const ESC = '\x1b';

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
