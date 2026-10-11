// A dev server belongs to the pane that started it. Keeping process control
// here makes replacement and shutdown use the same process-tree rules.

import { spawn, spawnSync } from 'node:child_process';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function collectLines(stream, lines) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    for (const line of parts) {
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

/** Start npm, returning as soon as its port opens, it exits, or time runs out. */
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
  collectLines(child.stdout, lines);
  collectLines(child.stderr, lines);
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
    if (await portOpen(port)) return { ok: true, child, message: null };
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
