// @journey:console/status.overview @scenario:happy @ac:AC-ST-1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overall } from '../../src/status/overview.mjs';

test('the status overview is degraded when one service is not ok', () => {
  assert.equal(overall([{ ok: true }, { ok: false }]), 'degraded');
});
