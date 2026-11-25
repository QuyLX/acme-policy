// @journey:console/compute.create-instance @scenario:happy — the seed comes from the harness (stress mode or the
// automatic retry); a plain run uses seed 0.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock, pollOperation } from './poller.mjs';

const seed = Number(process.env.ACME_STRESS_SEED ?? '0');

test('LRO polling keeps the newest operation state', () => {
  const clock = createClock();
  const server = (t) => (t < 10 ? 'PENDING' : t < 20 ? 'RUNNING' : 'SUCCEEDED');
  const op = pollOperation({ clock, server, seed });
  clock.run();
  assert.equal(op.state, 'SUCCEEDED', `seed ${seed}: a stale poll response overwrote a newer state`);
});
