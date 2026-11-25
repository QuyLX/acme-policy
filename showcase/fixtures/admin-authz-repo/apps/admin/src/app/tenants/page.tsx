// Page entry `tenants.list` (server component). The permission is enforced by readTenantList (data access layer).
import { requestContext } from '../../platform/session.ts';
import { readTenantList } from '../../domains/tenants/server/read.ts';
import { SuspendButton } from '../../domains/tenants/ui/SuspendButton.tsx';

export default async function TenantsPage() {
  const ctx = await requestContext();
  const tenants = readTenantList(ctx);
  return (
    <ul>
      {tenants.map((t) => (
        <li key={t.id}>
          {t.name} <SuspendButton tenantId={t.id} session={{ permissions: [...ctx.permissions] }} />
        </li>
      ))}
    </ul>
  );
}
