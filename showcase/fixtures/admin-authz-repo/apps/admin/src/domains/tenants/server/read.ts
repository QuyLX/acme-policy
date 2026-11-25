// Server-side data access for tenants (FE-NEXT-003: authorization happens here, not in middleware or the UI).
import { requirePermission } from '../../../platform/authz.ts';
import type { RequestContext } from '../../../platform/session.ts';
import { allTenants, type TenantRow } from './data.ts';

export function readTenantList(ctx: RequestContext): TenantRow[] {
  requirePermission(ctx, 'tenants.read');
  return allTenants();
}
