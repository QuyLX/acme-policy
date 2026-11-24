// FE-ARCH-001: do not import another module's private implementation; go through its public index.
import { dirname, normalize, join } from 'node:path';

const MODULE = /\/src\/modules\/([^/]+)\/(.*)$/;
const PUBLIC = /^(?:index(?:\.[cm]?[jt]sx?)?)?$/;

export default {
  meta: {
    type: 'problem',
    docs: { description: "FE-ARCH-001: import another module only through its public index" },
    messages: { private: "FE-ARCH-001: '{{source}}' reaches into module '{{target}}' — import from its public index instead." },
    schema: [],
  },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    const own = MODULE.exec(file)?.[1];
    const check = (node) => {
      const source = node.source?.value;
      if (typeof source !== 'string') return;
      let target = null;
      if (source.startsWith('.')) target = normalize(join(dirname(file), source)).replace(/\\/g, '/');
      else if (source.startsWith('@/modules/')) target = `/src/${source.slice(2)}`;
      if (!target) return;
      const m = MODULE.exec(target.startsWith('/') ? target : `/${target}`);
      if (m && m[1] !== own && !PUBLIC.test(m[2])) context.report({ node, messageId: 'private', data: { source, target: m[1] } });
    };
    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check, ImportExpression: check };
  },
};
