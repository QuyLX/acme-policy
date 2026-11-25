'use server';
// Server action (FE-NEXT-002) for the matrix entry `tenants.suspend`. The UI gate in ../ui/SuspendButton.tsx only
// reflects this check (FE-PERM-001).
import { can } from '../../../platform/authz.ts';
import { defineMutation } from '../../../platform/mutation.ts';

export const suspendTenant = defineMutation({
  name: 'tenants.suspend',
  input: (raw: unknown) => (typeof raw === 'object' && raw !== null && typeof (raw as { tenantId?: unknown }).tenantId === 'string' ? { tenantId: (raw as { tenantId: string }).tenantId } : null),
  authorize: (ctx) => can(ctx, 'tenants.suspend'),
  handler: async (_ctx, input) => ({ tenantId: input.tenantId, status: 'suspended' }),
});
