// @journey:admin/tenants.detail @scenario:happy @ac:AC-TN-4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTenantName } from '../../src/tenants/format.mjs';

test('the tenant detail title shows the name and the id', () => {
  assert.equal(formatTenantName({ id: 'tenant-alpha', name: 'Alpha' }), 'Alpha (tenant-alpha)');
});
