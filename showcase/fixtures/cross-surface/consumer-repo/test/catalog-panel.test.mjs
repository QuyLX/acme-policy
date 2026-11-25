import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPanel } from '../src/catalog-panel.mjs';

test('the partner panel lists catalog names', async () => {
  const cache = { get: () => undefined, set: () => {} };
  assert.equal(await catalogPanel({ tenantId: 'tenant-alpha' }, { items: async () => [{ name: 'b' }, { name: 'a' }] }, cache), 'a, b');
});
