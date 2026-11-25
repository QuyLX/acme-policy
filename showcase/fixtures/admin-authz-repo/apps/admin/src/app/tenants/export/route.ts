// Route entry `tenants.export`: CSV download of the tenant list. The body is built only through toCsv.
import { ForbiddenError, requirePermission } from '../../../platform/authz.ts';
import { requestContext, UnauthenticatedError } from '../../../platform/session.ts';
import { toCsv } from '../../../platform/csv.ts';
import { allTenants } from '../../../domains/tenants/server/data.ts';

export async function GET(): Promise<Response> {
  try {
    const ctx = await requestContext();
    requirePermission(ctx, 'tenants.export');
  } catch (err) {
    if (err instanceof UnauthenticatedError) return new Response(null, { status: 401 });
    if (err instanceof ForbiddenError) return new Response(null, { status: 403 });
    throw err;
  }
  const rows = allTenants();
  return new Response(toCsv(rows, ['id', 'name', 'status', 'balance']), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="tenants.csv"' },
  });
}
