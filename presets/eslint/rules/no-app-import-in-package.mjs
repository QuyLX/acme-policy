// FE-ARCH-006: @platform/* packages contain no product logic and never depend on apps.
import { dirname, normalize, join } from 'node:path';
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-ARCH-006: shared packages never import from apps' },
    messages: { app: "FE-ARCH-006: shared package imports app code '{{source}}' — move the shared part into a package." },
    schema: [],
  },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    if (!/\/packages\//.test(file)) return {};
    const check = (node) => {
      const source = node.source?.value;
      if (typeof source !== 'string') return;
      const resolved = source.startsWith('.') ? normalize(join(dirname(file), source)).replace(/\\/g, '/') : source;
      if (/(?:^|\/)apps\//.test(resolved)) context.report({ node, messageId: 'app', data: { source } });
    };
    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check, ImportExpression: check };
  },
};
