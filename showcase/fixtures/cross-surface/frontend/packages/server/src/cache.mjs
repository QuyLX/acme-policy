// Tenant-scoped server cache (synthetic, modelled on FE §3.5 and FE-CTX-001): every key starts with the tenant, so two
// tenants never share an entry.
export function createMemoryCache() {
  const entries = new Map();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
  };
}

export function tenantKey(ctx, ...parts) {
  if (!ctx?.tenantId) throw new Error('tenantKey: tenantId is required');
  return JSON.stringify(['tenant', ctx.tenantId, ...parts]);
}

export async function cachedForTenant(ctx, parts, load, cache) {
  const key = tenantKey(ctx, ...parts);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await load();
  cache.set(key, value);
  return value;
}
