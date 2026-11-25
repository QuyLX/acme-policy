// Permission helpers. On the server they enforce (FE-NEXT-003: authorization in the server-side data access layer);
// in client code `can` only reflects what the server enforces (FE-PERM-001), it never replaces it.

export class ForbiddenError extends Error {}

export function can(subject: { permissions: readonly string[] } | null, permission: string): boolean {
  return Boolean(subject && subject.permissions.includes(permission));
}

export function requirePermission(ctx: { permissions: readonly string[] }, permission: string): void {
  if (!can(ctx, permission)) throw new ForbiddenError(`missing permission ${permission}`);
}
