// FE-DS-001: tokens through the typed API — no hard-coded color or spacing values, no dynamic token-name concatenation.
const COLOR_LITERAL = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(.*\))$/i;
const LENGTH_LITERAL = /^-?\d+(?:\.\d+)?(?:px|rem|em)$/;
const TW_COLOR = /(?:^|\s|:)!?(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide|placeholder)-\[(?:#|rgb|hsl|oklch|color:)/;
const TW_SPACE = /(?:^|\s|:)!?-?(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy]|w|h|min-[wh]|max-[wh]|top|left|right|bottom|inset(?:-[xy])?|rounded(?:-[a-z]+)?|leading|tracking)-\[-?\d/;

const strings = (node) => {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '');
  if (node.type === 'JSXExpressionContainer') return strings(node.expression);
  if (node.type === 'CallExpression') return node.arguments.flatMap(strings);
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') return [...strings(node.left), ...strings(node.right)];
  if (node.type === 'ConditionalExpression') return [...strings(node.consequent), ...strings(node.alternate)];
  return [];
};

export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-DS-001: use design tokens, not hard-coded color/spacing values or concatenated token names' },
    messages: {
      arbitrary: 'FE-DS-001: arbitrary Tailwind value "{{value}}" — use a token utility from @platform/ds-tokens.',
      style: 'FE-DS-001: hard-coded {{kind}} "{{value}}" in style — use a CSS variable from @platform/ds-tokens.',
      concat: 'FE-DS-001: token names must not be built dynamically — reference the token through the typed API.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        const name = node.name?.name;
        if (name === 'className' || name === 'class') {
          for (const s of strings(node.value)) {
            const m = s.match(TW_COLOR) ?? s.match(TW_SPACE);
            if (m) context.report({ node, messageId: 'arbitrary', data: { value: s.trim().slice(0, 60) } });
          }
        }
        if (name === 'style' && node.value?.expression?.type === 'ObjectExpression') {
          for (const prop of node.value.expression.properties) {
            const v = prop.value;
            if (v?.type !== 'Literal' || typeof v.value !== 'string') continue;
            if (COLOR_LITERAL.test(v.value.trim())) context.report({ node: v, messageId: 'style', data: { kind: 'color', value: v.value } });
            else if (LENGTH_LITERAL.test(v.value.trim())) context.report({ node: v, messageId: 'style', data: { kind: 'length', value: v.value } });
          }
        }
      },
      TemplateLiteral(node) {
        if (node.expressions.length && node.quasis.some((q) => /var\(--[\w-]*$/.test(q.value.cooked ?? ''))) context.report({ node, messageId: 'concat' });
      },
      BinaryExpression(node) {
        if (node.operator === '+' && [node.left, node.right].some((n) => n.type === 'Literal' && typeof n.value === 'string' && /var\(--[\w-]*$/.test(n.value))) {
          context.report({ node, messageId: 'concat' });
        }
      },
    };
  },
};
