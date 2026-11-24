// FE-UX-001: interactive controls in apps come from the Design System (built on the headless a11y library).
const RAW = new Set(['button', 'input', 'select', 'textarea', 'dialog']);
export default {
  meta: {
    type: 'problem',
    docs: { description: 'FE-UX-001: use @platform/ds-react controls instead of raw interactive elements in apps' },
    messages: { raw: 'FE-UX-001: raw <{{name}}> in an app — use the @platform/ds-react control (keyboard and a11y baseline).' },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && RAW.has(node.name.name)) context.report({ node, messageId: 'raw', data: { name: node.name.name } });
      },
    };
  },
};
