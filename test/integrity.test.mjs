// Integrity sensors as separate Standard checks (Standard §7.13 item 38). Behaviour-level tests complementing
// registry-proof.test.mjs (which proves every sensor fires on its violating fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText, policyPath } from '../lib/io.mjs';
import { validate } from '../lib/schema.mjs';
import { runDiffChecks, DIFF_CHECKS } from '../lib/fixture-run.mjs';

const run = (name) => Object.fromEntries(runDiffChecks(readText(policyPath('checks/integrity/fixtures', name))).map((r) => [r.checkId, r]));
const fired = (results) => Object.values(results).filter((r) => r.findings.length).map((r) => r.checkId).sort();

test('clean change: every diff check PASS without findings (no false positive)', () => {
  const r = run('clean.diff');
  assert.ok(Object.values(r).every((c) => c.status === 'PASS' && c.findings.length === 0));
});
test('SC-02 skip marker: skip-focus is blocking in pilot mode → FAIL; not double-counted as a removed test', () => {
  const r = run('skip-focus.diff');
  assert.equal(r['integrity.skip-focus'].status, 'FAIL');
  assert.deepEqual(fired(r), ['integrity.skip-focus']);
});
test('SC-02 --passWithNoTests: vacuous-test (warn) + control-file-change (approval-gated)', () => {
  const r = run('pass-with-no-tests.diff');
  assert.deepEqual(fired(r), ['integrity.control-file-change', 'integrity.vacuous-test']);
  assert.equal(r['integrity.control-file-change'].status, 'PASS');
  assert.deepEqual(r['integrity.control-file-change'].extensions['x-control-files-touched'], ['apps/console/package.json']);
});
test('SC-02 expected value edited: warn with the old/new pair for the approver', () => {
  const f = run('expected-value-edit.diff')['integrity.expected-value-edit'].findings[0];
  assert.match(f.message, /toBe\(1\).*→.*toBe\(3\)/);
});
test('SC-02 verifier-written oracle edited: oracle-lock blocking → FAIL', () => assert.equal(run('oracle-lock.diff')['integrity.oracle-lock'].status, 'FAIL'));
test('suppression directive uses the Standard ID integrity.suppressions', () => assert.deepEqual(fired(run('suppression.diff')), ['integrity.suppressions']));
test('deleted test file → integrity.test-count-delta', () => assert.ok(fired(run('test-deletion.diff')).includes('integrity.test-count-delta')));
test('vacuous tests: an assertion-free case and an always-true assertion are both reported', () => {
  const msgs = run('vacuous-test.diff')['integrity.vacuous-test'].findings.map((f) => f.message).join('\n');
  assert.match(msgs, /without any assertion/);
  assert.match(msgs, /always true/);
});
test('tolerance inflation: raised retries/timeout and a fixed wait', () => {
  const msgs = run('tolerance-inflation.diff')['integrity.tolerance-inflation'].findings.map((f) => f.message).join('\n');
  assert.match(msgs, /retries raised 0 → 3/);
  assert.match(msgs, /timeout raised 30000 → 120000/);
  assert.match(msgs, /waitForTimeout/);
});
test('FE-CODE-001 workaround comment: observe-level (INFO), never FAIL', () => {
  const r = run('broad-catch.diff');
  assert.ok(r['integrity.broad-catch'].findings.length > 0);
  const s = r['integrity.suppressions'];
  assert.equal(s.status, 'PASS');
  assert.ok(s.findings.every((f) => f.severity === 'INFO'));
});
test('every diff check result conforms to the CheckResult schema', () => {
  for (const f of ['clean.diff', 'skip-focus.diff', 'oracle-lock.diff', 'injection.diff', 'secrets.diff']) {
    for (const r of Object.values(run(f))) assert.deepEqual(validate('check-result', r), [], `${f} ${r.checkId}`);
  }
});
test('regression: "thresholds" in Markdown prose is not a threshold change (false positive found 2026-11-24)', () =>
  assert.ok(!fired(run('threshold-in-prose.diff')).includes('integrity.threshold-change')));
test('threshold lowered in a config file: warn', () => assert.ok(fired(run('threshold-in-config.diff')).includes('integrity.threshold-change')));
test('the diff checks cover every Standard integrity sensor except mutation-score (Standard §7.13 item 38)', () => {
  for (const id of ['test-count-delta', 'skip-focus', 'suppressions', 'snapshot-churn', 'threshold-change', 'control-file-change', 'expected-value-edit', 'self-mocking', 'vacuous-test', 'tolerance-inflation', 'broad-catch']) {
    assert.ok(DIFF_CHECKS.includes(`integrity.${id}`), id);
  }
});
