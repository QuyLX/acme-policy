// @journey:console/catalog.browse @scenario:happy @ac:AC-CA-1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '@platform/server';
import { listCatalog } from '../../src/modules/catalog/index.mjs';

test('an owner browses the catalog of the project tenant', async () => {
  const source = { items: async (tenantId) => [{ name: `${tenantId}-standard` }, { name: `${tenantId}-basic` }] };
  const cache = createMemoryCache();
  const first = await listCatalog({ tenantId: 'tenant-alpha' }, source, cache);
  const again = await listCatalog({ tenantId: 'tenant-alpha' }, source, cache);
  assert.deepEqual(first.map((i) => i.name), ['tenant-alpha-basic', 'tenant-alpha-standard']);
  assert.deepEqual(again, first);
});
