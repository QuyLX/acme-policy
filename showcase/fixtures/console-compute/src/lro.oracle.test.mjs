// Oracle written by the verifier from the approved ACs (FE §9.10); tags link each test to the Journey Registry
// (FE §7.7): @journey, @scenario and @ac.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instanceStatus } from './lro.mjs';

test('@journey:console/compute.create-instance @scenario:happy @ac:AC-CI-1 a finished create operation shows RUNNING', () => {
  assert.equal(instanceStatus({ done: true, response: { status: 'RUNNING' } }), 'RUNNING');
});

test('@journey:console/compute.create-instance @scenario:lro-failure @ac:AC-CI-6 a failed create operation shows FAILED, never RUNNING', () => {
  assert.equal(instanceStatus({ done: true, error: { code: 'QUOTA_EXCEEDED' } }), 'FAILED');
});
