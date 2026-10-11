/**
 * Shared test plumbing for livepeek: temp HOME, test()/eq()/assert() harness,
 * result counters, a static-server helper and a raw HTTP GET.
 *
 * Import this module FIRST. It points HOME at a throwaway directory before any
 * livepeek module is loaded: state.mjs reads os.homedir() at load
 * time and must never touch the real one.
 *
 * No child processes or browsers are started here.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(ROOT, 'scripts');

// The real profile locations, captured before the override below, for the
// browser suite (it needs the real profile, not the throwaway one).
export const REAL_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'livepeek-test-'));
export const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

export const lib = (n) => import(pathToFileURL(path.join(SCRIPTS, 'lib', n)).href);
export const tmpdir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

// ------------------------------------------------------------- framework ----
export const results = { ok: 0, FAIL: 0, skip: 0 };
const servers = [];
export async function test(name, fn) {
  try {
    const r = await fn();
    if (r && r.skip) { results.skip++; console.log(`skip  ${name} (${r.skip})`); return; }
    results.ok++; console.log(`ok    ${name}`);
  } catch (e) {
    results.FAIL++;
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n').join('\n      ')}`);
  }
}
export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
export function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/** Start serveStatic on a free port and return its base URL. Closed by cleanup(). */
export async function serve(root, opts = {}) {
  const { serveStatic } = await lib('serve.mjs');
  const { server, port } = await serveStatic({ root, ...opts });
  servers.push(server);
  return `http://127.0.0.1:${port}/`;
}

// Raw request. A high-level client would collapse "/%2e%2e/" before it reached the server.
export const httpGetRaw = (base, rawPath, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: rawPath, headers }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

/** Close every server started by serve() and delete the temp tree. */
export function cleanup() {
  for (const s of servers) { try { s.close(); s.closeAllConnections?.(); } catch { /* ignore */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
