import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { eq, runSuites, test } from './helpers.mjs';

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
