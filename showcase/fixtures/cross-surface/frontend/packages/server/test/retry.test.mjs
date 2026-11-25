import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.mjs';

test('withRetry returns the first successful result', async () => {
  let n = 0;
  assert.equal(await withRetry(async () => { n++; if (n < 2) throw new Error('flaky'); return 'ok'; }), 'ok');
});
