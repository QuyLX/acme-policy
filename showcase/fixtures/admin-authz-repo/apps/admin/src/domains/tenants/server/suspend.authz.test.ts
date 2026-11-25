// Negative tests for the matrix entry `tenants.suspend` (FE-PERM-001, FE-NEXT-003). Tag format read by authz.negative:
// `@authz:<entry-id> @persona:<persona>` in the test title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSessionProvider, useSessionProvider } from '../../../platform/session.ts';
import { sessionFor } from '../../../testing/personas.ts';
import { suspendTenant } from './suspend.action.ts';

test('@authz:tenants.suspend @persona:noAccess a signed-in user without permissions is forbidden', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('noAccess')));
  const result = await suspendTenant({ tenantId: 't-001' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'forbidden');
});

test('@authz:tenants.suspend @persona:support support can read tenants but is forbidden to suspend them', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('support')));
  const result = await suspendTenant({ tenantId: 't-001' });
  assert.equal(!result.ok && result.error.code, 'forbidden');
});

test('staff may suspend a tenant', async () => {
  useSessionProvider(createTestSessionProvider(sessionFor('staff')));
  assert.deepEqual(await suspendTenant({ tenantId: 't-001' }), { ok: true, data: { tenantId: 't-001', status: 'suspended' } });
});

test('a missing session is unauthenticated, which is not the same as forbidden', async () => {
  useSessionProvider(createTestSessionProvider(null));
  const result = await suspendTenant({ tenantId: 't-001' });
  assert.equal(!result.ok && result.error.code, 'unauthenticated');
});
