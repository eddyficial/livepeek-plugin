import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { eq, runSuites, suiteOutcome, test, tmpdir } from './helpers.mjs';

await test('harness disposes once after a suite import rejects and preserves the error', async () => {
  const events = [];
  const failure = new Error('fixture: suite import rejected');

  await assert.rejects(runSuites(async () => {
    events.push('acquired');
    throw failure;
  }, () => { events.push('disposed'); }), error => error === failure);

  eq(events, ['acquired', 'disposed'], 'acquisition followed by one disposal');
});

await test('harness disposes once after discovery throws and preserves the error', async () => {
  const events = [];
  const failure = new Error('fixture: suite discovery threw');

  await assert.rejects(runSuites(() => {
    events.push('discovery');
    throw failure;
  }, () => { events.push('disposed'); }), error => error === failure);

  eq(events, ['discovery', 'disposed'], 'discovery followed by one disposal');
});

await test('harness waits for loading and then for exactly one disposal on success', async () => {
  const events = [];

  await runSuites(async () => {
    await Promise.resolve();
    events.push('loaded');
  }, async () => {
    await setImmediate();
    events.push('disposed');
  });
  events.push('returned');

  eq(events, ['loaded', 'disposed', 'returned'], 'loading, disposal and return order');
});

// Synthetic counts exercise the same outcome in both modes without a browser.
const outcomeFixtures = [
  { name: 'completed run', ok: 4, failed: 0, skipped: 0, complete: true, defaultExit: 0, strictExit: 0,
    summary: '4 ok, 0 failed, 0 skipped' },
  { name: 'skip-only run', ok: 4, failed: 0, skipped: 1, complete: true, defaultExit: 0, strictExit: 1,
    summary: '4 ok, 0 failed, 1 skipped' },
  { name: 'assertion failure', ok: 4, failed: 1, skipped: 0, complete: true, defaultExit: 1, strictExit: 1,
    summary: '4 ok, 1 failed, 0 skipped' },
  { name: 'aborted import', ok: 2, failed: 0, skipped: 0, complete: false, defaultExit: 1, strictExit: 1,
    summary: '2 ok, 0 failed, 0 skipped' },
];

for (const { name, ok, failed, skipped, complete, defaultExit, strictExit, summary } of outcomeFixtures) {
  await test(`suite outcome for ${name} in both modes`, () => {
    const counts = { ok, FAIL: failed, skip: skipped };
    eq(suiteOutcome(counts, false, complete), { summary, exitCode: defaultExit, evidence: null });

    const strict = suiteOutcome(counts, true, complete);
    eq(strict.exitCode, strictExit);
    eq(strict.summary, summary);
    assert.match(strict.evidence, /^\{[^\r\n]*\}$/);
    assert.deepEqual(JSON.parse(strict.evidence), {
      mode: 'require-browser', ok, failed, skipped, complete, passed: strictExit === 0,
    });
  });
}

await test('successful default runner preserves a suite-set exit code', async () => {
  const directory = tmpdir('runner-exit-code');
  const file = name => path.join(directory, name);
  const helpers = new URL('./helpers.mjs', import.meta.url).href;
  fs.copyFileSync(new URL('./run.mjs', import.meta.url), file('run.mjs'));
  fs.writeFileSync(file('helpers.mjs'), `
    import { runSuites as run, suiteOutcome } from ${JSON.stringify(helpers)};
    export { suiteOutcome };
    export const results = { ok: 1, FAIL: 0, skip: 0 };
    export const runSuites = load => run(load, () => {});
  `);
  fs.writeFileSync(file('unit.mjs'), 'process.exitCode = 7;');
  fs.writeFileSync(file('browser.mjs'), '');

  const { argv, exitCode } = process;
  const { log } = console;
  try {
    process.argv = argv.slice(0, 2);
    console.log = () => {};
    await import(pathToFileURL(file('run.mjs')).href);
    eq(process.exitCode, 7, 'default runner exit code after a passing outcome');
  } finally {
    console.log = log;
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
