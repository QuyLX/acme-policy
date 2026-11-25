// Stand-in for defineMutation of @platform/server (FE-NEXT-002): session, input validation, server-side `authorize`
// (FE-NEXT-003), handler. Origin/CSRF and audit are omitted in this fixture.
import { requestContext, type RequestContext } from './session.ts';

export type MutationResult<O> = { ok: true; data: O } | { ok: false; error: { code: 'unauthenticated' | 'forbidden' | 'invalid-input'; message: string } };

export function defineMutation<I, O>(def: {
  name: string;
  input: (raw: unknown) => I | null;
  authorize: (ctx: RequestContext, input: I) => boolean | Promise<boolean>;
  handler: (ctx: RequestContext, input: I) => Promise<O>;
}): (raw: unknown) => Promise<MutationResult<O>> {
  return async (raw) => {
    let ctx: RequestContext;
    try {
      ctx = await requestContext();
    } catch {
      return { ok: false, error: { code: 'unauthenticated', message: 'Sign in again to continue.' } };
    }
    const input = def.input(raw);
    if (input === null) return { ok: false, error: { code: 'invalid-input', message: 'Some fields are invalid.' } };
    if (!(await def.authorize(ctx, input))) return { ok: false, error: { code: 'forbidden', message: 'You are not allowed to do this.' } };
    return { ok: true, data: await def.handler(ctx, input) };
  };
}
