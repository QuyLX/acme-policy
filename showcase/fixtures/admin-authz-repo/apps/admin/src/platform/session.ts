// Stand-in for the session part of @platform/server (SessionProvider, createTestSessionProvider, contextFromSession).
// No IdP (D-03 open): `permissions` on the session is the IAM stand-in, filled from permissions.yaml `roles` by the
// test personas. Synthetic identities only.

export interface Session {
  actor: { id: string; kind: 'user' | 'service' };
  tenantId: string;
  permissions: string[];
  expiresAt: string;
}

export interface RequestContext {
  tenantId: string;
  actor: Session['actor'];
  permissions: readonly string[];
}

export interface SessionProvider {
  getSession(): Promise<Session | null>;
}

export class UnauthenticatedError extends Error {}

/** Test double: always returns the given session (or none). Never use outside tests and local mocks. */
export function createTestSessionProvider(session: Session | null): SessionProvider {
  return { getSession: async () => session };
}

let current: SessionProvider = createTestSessionProvider(null);

/** Test seam: selects the provider the server entries read the session from. */
export function useSessionProvider(provider: SessionProvider): void {
  current = provider;
}

/** The current request's context; throws when there is no valid session (unauthenticated, not forbidden). */
export async function requestContext(now: Date = new Date()): Promise<RequestContext> {
  const session = await current.getSession();
  if (!session || new Date(session.expiresAt) <= now) throw new UnauthenticatedError('no session');
  return { tenantId: session.tenantId, actor: session.actor, permissions: session.permissions };
}
