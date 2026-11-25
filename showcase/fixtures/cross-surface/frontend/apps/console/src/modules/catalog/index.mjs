import { cachedForTenant } from '@platform/server';

/** Catalog items visible to the session's tenant, sorted by name. */
export async function listCatalog(ctx, source, cache) {
  const items = await cachedForTenant(ctx, ['catalog'], () => source.items(ctx.tenantId), cache);
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
