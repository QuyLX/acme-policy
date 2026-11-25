import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '@platform/server';
import { listCatalog } from '../../src/modules/catalog/index.mjs';

test('catalog items are sorted by name', async () => {
  const source = { items: async () => [{ name: 'b' }, { name: 'a' }] };
  assert.deepEqual((await listCatalog({ tenantId: 'tenant-alpha' }, source, createMemoryCache())).map((i) => i.name), ['a', 'b']);
});
