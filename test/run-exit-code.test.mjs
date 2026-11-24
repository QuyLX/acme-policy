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

const probe = {
  checkId: 'test.env-probe', checkVersion: '1.0.0', requirement: 'required', enforcement: 'blocking', severity: 'BLOCKER', gate: 'merge',
  command: ['node', '-e', 'process.exit(process.env.NX_SKIP_NX_CACHE === "true" ? 0 : 1)'], timeoutSeconds: 10,
};
test('non-local executor disables build caches (results never replayed from a cache)', () =>
  assert.equal(runCommandCheck(probe, { cwd: '.', env: { PATH: process.env.PATH }, executor: 'ci' }).status, 'PASS'));
test('local executor keeps caches for developer speed', () =>
  assert.equal(runCommandCheck(probe, { cwd: '.', env: { PATH: process.env.PATH }, executor: 'local' }).status, 'FAIL'));
