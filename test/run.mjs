#!/usr/bin/env node
/**
 * Test harness for livepeek. No dependencies, no TTY, no terminal multiplexer.
 *
 *   node test/run.mjs
 *
 * Orchestrator only. The suites live next to this file:
 *   helpers.mjs  shared plumbing (temp HOME, harness, static server helper)
 *   unit.mjs     pure unit tests and the static server tests
 *   (others)     child-process suites, run in alphabetical order
 *   browser.mjs  browser tests, run last; they skip without Chromium + playwright-core
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { results, runSuites } from './helpers.mjs';   // must come first: sets the temp HOME

try {
  await runSuites(async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rest = fs.readdirSync(here).filter(f => f.endsWith('.mjs') && !['helpers.mjs', 'run.mjs', 'unit.mjs', 'browser.mjs'].includes(f)).sort();
    for (const f of ['unit.mjs', ...rest, 'browser.mjs']) await import(pathToFileURL(path.join(here, f)).href);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
console.log(`\n${results.ok} ok, ${results.FAIL} failed, ${results.skip} skipped`);
if (results.FAIL) process.exitCode = 1;
