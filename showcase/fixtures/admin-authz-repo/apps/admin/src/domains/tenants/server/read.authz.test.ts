// Negative test for the matrix entry `tenants.list` (FE-PERM-001, FE-NEXT-003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError } from '../../../platform/authz.ts';
import { sessionFor } from '../../../testing/personas.ts';
import { readTenantList } from './read.ts';

const ctxOf = (name: 'staff' | 'support' | 'noAccess') => {
  const s = sessionFor(name);
  return { tenantId: s.tenantId, actor: s.actor, permissions: s.permissions };
};

test('@authz:tenants.list @persona:noAccess a signed-in user without tenants.read is forbidden', () => {
  assert.throws(() => readTenantList(ctxOf('noAccess')), ForbiddenError);
});

test('support may list tenants', () => {
  assert.equal(readTenantList(ctxOf('support')).length, 3);
});
