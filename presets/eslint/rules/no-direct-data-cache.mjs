// FE-NEXT-005: in authenticated rendering, the server data cache is used only through the @platform/server helper
// (keys and tags contain tenant/project/region). No unstable_cache, 'use cache' or fetch cache options directly.
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-NEXT-005: server data cache only through cachedForTenant from @platform/server' },
    messages: {
      direct: 'FE-NEXT-005: {{what}} used directly — use cachedForTenant(ctx, …) from @platform/server so the key is tenant-scoped.',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    if (/\/packages\/server\//.test(file)) return {};
    return {
      ImportSpecifier(node) {
        if (node.imported.name === 'unstable_cache' || node.imported.name === 'unstable_cacheLife') context.report({ node, messageId: 'direct', data: { what: node.imported.name } });
      },
      ExpressionStatement(node) {
        if (node.expression.type === 'Literal' && node.expression.value === 'use cache') context.report({ node, messageId: 'direct', data: { what: "'use cache'" } });
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'fetch') return;
        const opts = node.arguments[1];
        if (opts?.type === 'ObjectExpression' && opts.properties.some((p) => p.key?.name === 'next' || (p.key?.name === 'cache' && p.value?.value === 'force-cache'))) {
          context.report({ node, messageId: 'direct', data: { what: 'fetch cache options' } });
        }
      },
    };
  },
};
