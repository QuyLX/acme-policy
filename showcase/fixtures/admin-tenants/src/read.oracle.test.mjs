import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tenantName } from './read.mjs';

test('AC-TN-1 staff sees Northwind Synthetic', () => {
  assert.equal(tenantName(), 'Northwind Synthetic');
});
