// A dev server belongs to the pane that started it. Keeping process control
// here makes replacement and shutdown use the same process-tree rules.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function collectLines(stream, lines, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    for (const line of parts) {
      onLine?.(line);
      lines.push(line);
      if (lines.length > 20) lines.shift();
    }
  });
  stream.on('end', () => {
    if (pending) lines.push(pending);
    while (lines.length > 20) lines.shift();
  });
}

export function formatDevServerExit(script, code, lines, maxLength = 80) {
  const last = [...lines].reverse().find(line => line.trim())?.trim() || 'no output';
  const prefix = `!npm run ${script} exited (${code ?? 'unknown'}): `;
  const message = prefix + last;
  if (message.length <= maxLength) return message;
  return maxLength <= 3 ? message.slice(0, maxLength) : message.slice(0, maxLength - 3) + '...';
}

/**
 * The port in a local address a dev server prints, e.g. Vite's
 * "Local:   http://localhost:5174/". Vite moves to the next free port when its
 * own is taken, so what it prints is the truth and the configured port a guess.
 *
 * Only a line labelled "Local:" counts (Vite, Next, Nuxt, Astro, CRA all print
 * one): a dev script run through concurrently may start an API server too, and
 * its "listening at http://127.0.0.1:5281" is not the page.
 */
export function announcedPort(line) {
  // eslint-disable-next-line no-control-regex -- strips terminal color escapes.
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const m = plain.match(/\bLocal:\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Is the server on this port another project's Vite? Vite answers a request
 * for a file outside its project with 403 "outside of Vite serving allow
 * list", so asking it for this project's package.json tells the two apart.
 * Any other answer, or any other kind of server, counts as not foreign.
 */
export function servesOtherProject(port, root, timeoutMs = 1500) {
  let abs = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (!abs.startsWith('/')) abs = '/' + abs;
  const urlPath = encodeURI('/@fs' + abs + '/package.json');
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port, path: urlPath, timeout: timeoutMs }, res => {
      if (res.statusCode !== 403) { res.resume(); return resolve(false); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve(/serving allow list/i.test(body)));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Start npm, returning as soon as its server is up, it exits, or time runs
 * out. On success `port` is the port the server actually listens on.
 */
export async function startManagedDevServer({
  script, cwd, port, portOpen, timeoutMs = 90_000, pollMs = 100, maxStatusLength = 80,
}) {
  // .cmd files need cmd.exe on Windows; naming it directly avoids shell:true
  // argument handling while keeping taskkill rooted at the command tree.
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = windows ? ['/d', '/s', '/c', 'npm', 'run', script] : ['run', script];
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const lines = [];
  let announced = null;
  const onLine = line => { announced ??= announcedPort(line); };
  collectLines(child.stdout, lines, onLine);
  collectLines(child.stderr, lines, onLine);
  /** @type {{ exit: { code: number | null, signal: NodeJS.Signals | null } | null }} */
  const state = { exit: null };
  child.once('exit', (code, signal) => { state.exit = { code, signal }; });
  child.once('error', error => { lines.push(error.message); state.exit = { code: null, signal: null }; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exit) {
      killProcessTree(child);
      await delay(0);             // let already-buffered parent output reach the ring
      return { ok: false, child: null, message: formatDevServerExit(script, state.exit.code ?? state.exit.signal, lines, maxStatusLength) };
    }
    const up = announced ?? port;
    if (await portOpen(up)) return { ok: true, child, port: up, message: null };
    await delay(pollMs);
  }
  if (state.exit) {
    killProcessTree(child);
    await delay(0);
    return { ok: false, child: null, message: formatDevServerExit(script, state.exit.code ?? state.exit.signal, lines, maxStatusLength) };
  }
  return { ok: false, child, message: `!dev server never came up on :${port}` };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch { /* already stopped */ }
}

/** Stop only the process tree represented by a child livepeek started. */
export function stopManagedDevServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  killProcessTree(child);
}
