// FE-NEXT-001: contract-generated clients are used only in server-only modules.
export default {
  meta: {
    type: 'problem',
    docs: { description: "FE-NEXT-001: import generated clients only from modules that import 'server-only'" },
    messages: { client: "FE-NEXT-001: '{{source}}' is a generated service client — import it only from a module that starts with import 'server-only'." },
    schema: [],
  },
  create(context) {
    let serverOnly = false;
    const imports = [];
    return {
      ImportDeclaration(node) {
        const s = node.source.value;
        if (s === 'server-only') serverOnly = true;
        else if (/__generated__\/(?:.*\/)?client(?:\.[jt]s)?$/.test(s)) imports.push(node);
      },
      'Program:exit'() {
        if (!serverOnly) for (const node of imports) context.report({ node, messageId: 'client', data: { source: node.source.value } });
      },
    };
  },
};
