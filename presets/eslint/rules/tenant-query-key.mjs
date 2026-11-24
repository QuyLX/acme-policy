// FE-CTX-001: client query cache keys contain tenant, project and region — built only with tenantQueryKey(...).
const HOOKS = new Set(['useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useSuspenseInfiniteQuery', 'queryOptions', 'infiniteQueryOptions', 'prefetchQuery', 'fetchQuery']);
const name = (callee) => (callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : null);
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-CTX-001: query keys are tenant-scoped via tenantQueryKey' },
    messages: { key: 'FE-CTX-001: queryKey must be built with tenantQueryKey(ctx, …) so it contains tenant, project and region.' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!HOOKS.has(name(node.callee))) return;
        const opts = node.arguments[0];
        if (opts?.type !== 'ObjectExpression') return;
        const key = opts.properties.find((p) => p.type === 'Property' && p.key?.name === 'queryKey');
        if (!key) return;
        const v = key.value;
        const ok = v.type === 'CallExpression' && name(v.callee) === 'tenantQueryKey';
        if (!ok) context.report({ node: key, messageId: 'key' });
      },
    };
  },
};
