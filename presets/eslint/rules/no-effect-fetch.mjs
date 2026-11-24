// FE-STATE-002: no raw useEffect for fetching/synchronizing data, and no setTimeout/requestAnimationFrame inside an
// effect to mask ordering problems — use the platform's data and timing wrappers.
import { walk } from './walk.mjs';

const isUseEffect = (callee) =>
  (callee.type === 'Identifier' && (callee.name === 'useEffect' || callee.name === 'useLayoutEffect')) ||
  (callee.type === 'MemberExpression' && ['useEffect', 'useLayoutEffect'].includes(callee.property?.name));

export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-STATE-002: data fetching and timing tricks only through platform-approved wrappers' },
    messages: {
      fetch: 'FE-STATE-002: data fetching inside useEffect — use the platform data layer (server components or the query wrapper).',
      timing: 'FE-STATE-002: {{name}} inside useEffect masks an ordering problem — fix the ordering or use the approved wrapper.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isUseEffect(node.callee)) return;
        const fn = node.arguments[0];
        if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return;
        walk(fn.body, (n) => {
          if (n.type !== 'CallExpression') return;
          const c = n.callee;
          if (c.type === 'Identifier' && c.name === 'fetch') context.report({ node: n, messageId: 'fetch' });
          else if (c.type === 'MemberExpression' && c.property?.name === 'then') context.report({ node: n, messageId: 'fetch' });
          else if (c.type === 'Identifier' && (c.name === 'setTimeout' || c.name === 'requestAnimationFrame')) context.report({ node: n, messageId: 'timing', data: { name: c.name } });
        });
      },
    };
  },
};
