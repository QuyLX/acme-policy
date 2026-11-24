// FE-API-001: call services only through contract-generated clients (@platform/api-codegen) — no raw fetch of an
// absolute service URL from app code.
const ABSOLUTE = /^https?:\/\//i;
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i;
const textOf = (n) =>
  n?.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n?.type === 'TemplateLiteral' ? (n.quasis[0]?.value.cooked ?? '')
  : '';
const literalUrl = (n) => ABSOLUTE.test(textOf(n)) && !LOOPBACK.test(textOf(n));
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-API-001: services are called only through contract-generated clients' },
    messages: { raw: 'FE-API-001: raw fetch of a service URL — call the generated client from @platform/api-codegen instead.' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch' && literalUrl(node.arguments[0])) context.report({ node, messageId: 'raw' });
      },
    };
  },
};
