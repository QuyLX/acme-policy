// test/headers-csp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyPath } from '../lib/io.mjs';
import { headersCspFindings } from '../checks/sec/headers-csp.mjs';

test('clean app has no findings', () => {
  assert.deepEqual(headersCspFindings(policyPath('checks/sec/fixtures/headers-clean')), []);
});
test('missing proxy and headers are reported', () => {
  const f = headersCspFindings(policyPath('checks/sec/fixtures/headers-missing')).map((x) => x.message).join('\n');
  assert.match(f, /Content-Security-Policy/);
  assert.match(f, /Strict-Transport-Security/);
  assert.match(f, /X-Robots-Tag/);
});
test('unsafe-inline and production unsafe-eval are reported', () => {
  const f = headersCspFindings(policyPath('checks/sec/fixtures/headers-unsafe')).map((x) => x.message).join('\n');
  assert.match(f, /unsafe-inline/);
  assert.match(f, /unsafe-eval/);
});
