// @journey:admin/audit.view @scenario:happy @ac:AC-AU-1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLine } from '../../src/audit/view.mjs';

test('an audit line shows time, actor and action', () => {
  assert.equal(auditLine({ at: '2026-01-01T00:00:00Z', actor: 'staff-1', action: 'tenant.read' }), '2026-01-01T00:00:00Z staff-1 tenant.read');
});
