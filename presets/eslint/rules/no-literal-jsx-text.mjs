// FE-I18N-001: no hard-coded user-facing text in JSX; use the message catalog (next-intl).
// Reports JSX text, string literals in JSX expression containers, and literal values of text props.
const TEXT_PROPS = new Set(['title', 'description', 'label', 'aria-label', 'placeholder', 'alt']);
const HAS_LETTER = /\p{L}/u;
const EXEMPT_FILE = /\.(test|spec|stories)\.[cm]?[jt]sx?$|\/_demo\//;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-I18N-001: user-facing text comes from the message catalog' },
    messages: { literal: "FE-I18N-001: '{{text}}' is hard-coded user-facing text — move it to messages/<locale>.json and use t()." },
    schema: [],
  },
  create(context) {
    if (EXEMPT_FILE.test(context.filename.replace(/\\/g, '/'))) return {};
    const report = (node, text) => {
      const t = text.trim();
      if (t && HAS_LETTER.test(t)) context.report({ node, messageId: 'literal', data: { text: t.slice(0, 40) } });
    };
    return {
      JSXText: (node) => report(node, node.value),
      JSXExpressionContainer: (node) => {
        if (node.parent?.type === 'JSXAttribute') return;
        if (node.expression.type === 'Literal' && typeof node.expression.value === 'string') report(node, node.expression.value);
      },
      JSXAttribute: (node) => {
        const name = node.name?.name;
        if (!TEXT_PROPS.has(name) || !node.value) return;
        if (node.value.type === 'Literal' && typeof node.value.value === 'string') report(node, node.value.value);
        if (node.value.type === 'JSXExpressionContainer' && node.value.expression.type === 'Literal' && typeof node.value.expression.value === 'string') report(node, node.value.expression.value);
      },
    };
  },
};
