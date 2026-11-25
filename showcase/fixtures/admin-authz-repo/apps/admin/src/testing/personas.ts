// Synthetic personas for permission-sensitive tests (FE §8.8; FE §8.4 authz.permission-matrix). Never real identities.
// Permissions mirror `roles` in ../../permissions.yaml (a unit test in acme-policy keeps the two equal).
// noAccess is a signed-in user without permissions: the server must answer `forbidden`, not `unauthenticated`.
import type { Session } from '../platform/session.ts';

export const ROLES = {
  staff: ['tenants.read', 'tenants.suspend', 'tenants.export'],
  support: ['tenants.read'],
  noAccess: [],
} as const satisfies Record<string, readonly string[]>;

export type PersonaName = keyof typeof ROLES;

/** A valid session for the persona that expires one hour after `now`. */
export function sessionFor(name: PersonaName, now: Date = new Date()): Session {
  return {
    actor: { id: `persona:${name}`, kind: 'user' },
    tenantId: '00000000-0000-4000-8000-000000000001',
    permissions: [...ROLES[name]],
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}
