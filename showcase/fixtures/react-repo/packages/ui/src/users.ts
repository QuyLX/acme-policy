// Fixture (synthetic): a tenant-scoped query, the conforming form of FE-CTX-001.
declare function useQuery(o: { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> }): unknown;
declare function tenantQueryKey(scope: { tenantId: string }, ...parts: string[]): readonly unknown[];

export function useUsers(scope: { tenantId: string }, load: () => Promise<unknown>) {
  return useQuery({ queryKey: tenantQueryKey(scope, 'users'), queryFn: load });
}
