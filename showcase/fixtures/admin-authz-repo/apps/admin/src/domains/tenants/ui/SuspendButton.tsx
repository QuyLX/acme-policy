'use client';
// UI gate: hides the button for personas without the permission. It reflects, never replaces, the server-side
// `authorize` of suspendTenant (FE-PERM-001).
import { can } from '../../../platform/authz.ts';
import { suspendTenant } from '../server/suspend.action.ts';

export function SuspendButton({ tenantId, session }: { tenantId: string; session: { permissions: string[] } | null }) {
  if (!can(session, 'tenants.suspend')) return null;
  return <Button onPress={() => suspendTenant({ tenantId })}>Suspend</Button>;
}

declare function Button(props: { onPress: () => void; children: string }): JSX.Element;
