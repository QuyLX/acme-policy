import { cachedForTenant } from '@platform/server';

/** Users of the session's tenant, cached per tenant. */
export function listTenantUsers(ctx, backend, cache) {
  return cachedForTenant(ctx, ['tenant-users'], () => backend.listUsers(ctx.tenantId), cache);
}
