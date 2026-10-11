/** Managed dev-server process tests: fail-fast output and tree shutdown. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { lib, tmpdir, test, assert } from './helpers.mjs';

const canConnect = (port) => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(150);
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.once('timeout', () => done(false));
});

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

await test('dev server reports an immediate npm-script failure without waiting for timeout', async () => {
  const dir = tmpdir('dev-fail');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { fail: 'node fail.mjs' } }));
  fs.writeFileSync(path.join(dir, 'fail.mjs'), "console.error('FAIL_NOW'); process.exit(1);\n");
  const { startManagedDevServer } = await lib('devserver.mjs');
  const began = Date.now();
  const result = await startManagedDevServer({
    script: 'fail', cwd: dir, port: await freePort(), portOpen: canConnect, timeoutMs: 5000,
  });
  assert(!result.ok, 'failing script reported ready');
  assert(Date.now() - began < 4000, 'failure waited for the timeout');
  assert(result.message.includes('!npm run fail exited (1):'), 'missing exit status: ' + result.message);
  assert(result.message.includes('FAIL_NOW'), 'missing last output line: ' + result.message);
});

await test('dev server stop closes a long-running npm child tree', async () => {
  const dir = tmpdir('dev-stop');
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { long: 'node long.mjs' } }));
  fs.writeFileSync(path.join(dir, 'long.mjs'), `import net from 'node:net'; net.createServer(()=>{}).listen(${port}, '127.0.0.1');\n`);
  const { startManagedDevServer, stopManagedDevServer } = await lib('devserver.mjs');
  const result = await startManagedDevServer({ script: 'long', cwd: dir, port, portOpen: canConnect, timeoutMs: 5000 });
  try {
    assert(result.ok && result.child, 'long-running server did not start');
    stopManagedDevServer(result.child);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await canConnect(port)) await new Promise(resolve => setTimeout(resolve, 50));
    assert(!(await canConnect(port)), 'descendant server still owns the port');
  } finally {
    stopManagedDevServer(result.child);
  }
});
