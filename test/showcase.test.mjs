import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, runShowcase } from '../lib/showcase.mjs';

test('every runnable showcase case passes; pending cases are NOT_ASSESSED, never PASS', () => {
  const results = runShowcase();
  const broken = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  assert.deepEqual(broken, []);
  assert.ok(results.some((r) => r.status === 'PASS'));
});

// The runner itself must be able to fail: a wrong expectation is reported, not swallowed (mutation proof).
test('runner reports a mismatching expectation', () => {
  const observed = { checks: [{ checkId: 'policy.sod', status: 'PASS', findings: [] }], exitCode: 0, requiredUnmet: [] };
  assert.equal(compare({ status: 'FAIL' }, observed).length, 1);
  assert.equal(compare({ exitCode: 1 }, observed).length, 1);
  assert.equal(compare({ rules: ['integrity.skip-focus'] }, observed).length, 1);
  assert.equal(compare({ statuses: { 'policy.sod': 'NOT_ASSESSED' } }, observed).length, 1);
  assert.equal(compare({ requiredUnmet: ['policy.sod'] }, observed).length, 1);
});
