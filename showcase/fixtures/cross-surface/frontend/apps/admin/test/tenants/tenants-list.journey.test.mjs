// @journey:admin/tenants.list @scenario:happy @ac:AC-TN-1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '@platform/server';
import { listTenantUsers } from '../../src/tenants/list.mjs';
import { tenantsApi } from '../support/tenants-api.mjs';

const backend = tenantsApi({ listUsers: async (tenantId) => [{ id: `${tenantId}-user-1`, tenantId }] });

test('two staff sessions in different tenants each see only their own users', async () => {
  const cache = createMemoryCache();
  const alpha = await listTenantUsers({ tenantId: 'tenant-alpha' }, backend, cache);
  const beta = await listTenantUsers({ tenantId: 'tenant-beta' }, backend, cache);
  assert.deepEqual(alpha.map((u) => u.tenantId), ['tenant-alpha']);
  assert.deepEqual(beta.map((u) => u.tenantId), ['tenant-beta']);
});
