// Negative tests for the matrix entry `tenants.export` (FE-PERM-001) and the CSV body (export.csv-injection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSessionProvider, useSessionProvider } from '../../../platform/session.ts';
import { sessionFor } from '../../../testing/personas.ts';
import { GET } from './route.ts';

test('@authz:tenants.export @persona:noAccess a signed-in user without permissions is forbidden (403)', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('noAccess')));
  assert.equal((await GET()).status, 403);
});

test('@authz:tenants.export @persona:support support is forbidden to export (403)', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('support')));
  assert.equal((await GET()).status, 403);
});

test('staff gets a CSV whose formula-like text cells are neutralized and numbers stay numbers', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('staff')));
  const res = await GET();
  assert.equal(res.status, 200);
  const lines = (await res.text()).split('\r\n');
  assert.equal(lines[0], 'id,name,status,balance');
  assert.equal(lines[2], `t-002,"'=HYPERLINK(""https://attacker.invalid"",""open"")",active,-42.5`);
  assert.equal(lines[3], "t-003,'@SUM(1+1),suspended,0");
});
