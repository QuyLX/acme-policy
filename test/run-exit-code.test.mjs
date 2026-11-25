import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExitCode } from '../lib/result.mjs';
import { runCommandCheck } from '../adapters/command-adapter.mjs';

const check = (status, { requirement = 'required', enforcement = 'blocking' } = {}) => ({ status, requirement, enforcement });

test('all PASS → 0', () => assert.equal(runExitCode([check('PASS'), check('PASS')]), 0));
test('blocking FAIL → 1', () => assert.equal(runExitCode([check('PASS'), check('FAIL')]), 1));
test('warn FAIL does not block → 0', () => assert.equal(runExitCode([check('FAIL', { enforcement: 'warn' })]), 0));
test('ERROR → 2, even next to a FAIL', () => assert.equal(runExitCode([check('FAIL'), check('ERROR')]), 2));

// Regression (audit 2026-11-24): `factory verify` exited 0 while policy.sod — required, blocking — was NOT_ASSESSED.
test('regression: required blocking NOT_ASSESSED → 1 (VER-03: NOT_ASSESSED is never PASS)', () =>
  assert.equal(runExitCode([check('PASS'), check('NOT_ASSESSED')]), 1));
test('optional NOT_ASSESSED does not block → 0', () =>
  assert.equal(runExitCode([check('NOT_ASSESSED', { requirement: 'optional' })]), 0));

// Review finding (2026-11-25): any `assessed-elsewhere` disposition used to exempt any required check.
const ae = { type: 'assessed-elsewhere', decidedBy: 'policy', decidedAt: '2026-11-20T12:00:00Z', policyRef: 'Standard §7.5 item 7', assessedElsewhere: { runId: 'r', providerVersion: '1.4.0', validUntil: '2030-01-01T00:00:00Z' } };
const na = (checkId, disposition) => ({ ...check('NOT_ASSESSED'), checkId, disposition });
const at = { now: Date.parse('2029-01-01T00:00:00Z') };
test('assessed-elsewhere exempts a required NOT_ASSESSED only for a registry cross-team-contract check → 0', () =>
  assert.equal(runExitCode([na('admin.step-up-auth', ae)], at), 0));
test('assessed-elsewhere on a non-contract required check (policy.sod) still blocks → 1', () =>
  assert.equal(runExitCode([na('policy.sod', ae)], at), 1));
test('assessed-elsewhere not decided by policy, or without policyRef, blocks → 1', () => {
  assert.equal(runExitCode([na('admin.step-up-auth', { ...ae, decidedBy: 'user:someone' })], at), 1);
  assert.equal(runExitCode([na('admin.step-up-auth', { ...ae, policyRef: undefined })], at), 1);
});

const probe = {
  checkId: 'test.env-probe', checkVersion: '1.0.0', requirement: 'required', enforcement: 'blocking', severity: 'BLOCKER', gate: 'merge',
  command: ['node', '-e', 'process.exit(process.env.NX_SKIP_NX_CACHE === "true" ? 0 : 1)'], timeoutSeconds: 10,
};
test('non-local executor disables build caches (results never replayed from a cache)', () =>
  assert.equal(runCommandCheck(probe, { cwd: '.', env: { PATH: process.env.PATH }, executor: 'ci' }).status, 'PASS'));
test('local executor keeps caches for developer speed', () =>
  assert.equal(runCommandCheck(probe, { cwd: '.', env: { PATH: process.env.PATH }, executor: 'local' }).status, 'FAIL'));
