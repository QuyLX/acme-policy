// FE-NEXT-002: server actions exist only through the @platform/server wrapper (authentication, origin/CSRF,
// validation, audit). In a 'use server' module every export must be `defineMutation(...)`.
const isDirective = (s) => s.type === 'ExpressionStatement' && s.expression.type === 'Literal' && s.expression.value === 'use server';
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-NEXT-002: no bare server actions' },
    messages: { bare: "FE-NEXT-002: bare server action '{{name}}' — export `defineMutation({ input, authorize, handler })` from @platform/server instead." },
    schema: [],
  },
  create(context) {
    return {
      Program(program) {
        if (!program.body.some(isDirective)) return;
        for (const st of program.body) {
          if (st.type !== 'ExportNamedDeclaration' && st.type !== 'ExportDefaultDeclaration') continue;
          const d = st.declaration;
          if (!d) continue;
          if (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') {
            context.report({ node: st, messageId: 'bare', data: { name: d.id?.name ?? 'default' } });
          } else if (d.type === 'VariableDeclaration') {
            for (const v of d.declarations) {
              const init = v.init;
              const wrapped = init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'defineMutation';
              if (!wrapped) context.report({ node: v, messageId: 'bare', data: { name: v.id.name ?? '?' } });
            }
          }
        }
      },
    };
  },
};
