// FE §8.4 cap:import-export, export.csv-injection: a CSV body is built only through toCsv, and every cell only
// through toCsvCell, which neutralizes text cells starting with =, +, -, @, tab or CR and writes numbers as numbers.
// Flags, in CSV context (the file mentions text/csv or .csv, or the row is joined into lines):
//   join      — `cells.join(',' | ';' | '\t')` whose cells are not all toCsvCell(...) calls or constant safe strings;
//   template  — a template literal row `${a},${b}` whose expressions are not toCsvCell(...) calls;
//   response  — a Response / NextResponse with content-type text/csv whose body is not toCsv(...).
// Not enabled in any PROFILE_RULES kind yet: export.csv-injection runs it in shadow (tech-design 13 §5).
const CELL_HELPERS = new Set(['toCsvCell']);
const BODY_HELPERS = new Set(['toCsv']);
const SEPARATORS = new Set([',', ';', '\t']);
const LINE_BREAKS = new Set(['\n', '\r\n']);
const FORMULA_START = /^[=+\-@\t\r]/;

const calleeName = (node) => {
  if (node?.type !== 'CallExpression') return undefined;
  if (node.callee.type === 'Identifier') return node.callee.name;
  if (node.callee.type === 'MemberExpression' && !node.callee.computed) return node.callee.property.name;
  return undefined;
};
const stringValue = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
};
const isJoin = (node, seps) =>
  node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'join' && seps.has(stringValue(node.arguments[0]));
const unwrap = (node) => (node && (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') ? unwrap(node.expression) : node);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'export.csv-injection: CSV bodies only through toCsv, cells only through toCsvCell (FE §8.4 cap:import-export)' },
    messages: {
      join: 'export.csv-injection: CSV row built with join({{sep}}) on raw cells — map every cell through toCsvCell (neutralizes =, +, -, @, tab, CR) or build the body with toCsv.',
      template: 'export.csv-injection: CSV row built with a template literal — map every cell through toCsvCell or build the body with toCsv.',
      response: 'export.csv-injection: text/csv response body is not produced by toCsv(...).',
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const csvFile = /text\/csv|\.csv\b/.test(source.text);

    /** Initializer of a const/let binding the identifier refers to, if any. */
    const initOf = (id) => {
      for (let scope = source.getScope(id); scope; scope = scope.upper) {
        const v = scope.set.get(id.name);
        if (v) return unwrap(v.defs[0]?.node?.init);
      }
      return undefined;
    };
    const safeCell = (node) => {
      const n = unwrap(node);
      if (calleeName(n) && CELL_HELPERS.has(calleeName(n))) return true;
      const s = stringValue(n);
      return s !== undefined && !FORMULA_START.test(s);
    };
    const safeCells = (node, seen = 0) => {
      const n = unwrap(node);
      if (!n || seen > 3) return false;
      if (n.type === 'ArrayExpression') return n.elements.length > 0 && n.elements.every((el) => el && el.type !== 'SpreadElement' && safeCell(el));
      if (n.type === 'Identifier') return safeCells(initOf(n), seen + 1);
      if (calleeName(n) === 'map') {
        const fn = n.arguments[0];
        if (fn?.type === 'Identifier') return CELL_HELPERS.has(fn.name);
        if ((fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') && fn.body.type !== 'BlockStatement') return safeCell(fn.body);
        if (fn?.body?.type === 'BlockStatement') {
          const ret = fn.body.body.find((s) => s.type === 'ReturnStatement');
          return Boolean(ret && safeCell(ret.argument));
        }
      }
      return false;
    };
    const inLineJoin = (node) => source.getAncestors(node).some((a) => isJoin(a, LINE_BREAKS));
    const csvContext = (node) => csvFile || inLineJoin(node);
    const isCsvHeaders = (init) => {
      const headers = unwrap(init)?.type === 'ObjectExpression' ? unwrap(init).properties.find((p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'headers') : undefined;
      if (headers?.value.type !== 'ObjectExpression') return false;
      return headers.value.properties.some(
        (p) => p.type === 'Property' && String(p.key.name ?? p.key.value).toLowerCase() === 'content-type' && /^text\/csv\b/i.test(stringValue(p.value) ?? ''),
      );
    };
    const bodyFromHelper = (node) => {
      const n = unwrap(node);
      if (calleeName(n) && BODY_HELPERS.has(calleeName(n))) return true;
      if (n?.type === 'Identifier') {
        const init = initOf(n);
        return Boolean(calleeName(init) && BODY_HELPERS.has(calleeName(init)));
      }
      return false;
    };
    const checkResponse = (node) => {
      const ctor = node.callee.type === 'Identifier' ? node.callee.name : undefined;
      if (ctor !== 'Response' && ctor !== 'NextResponse') return;
      if (!isCsvHeaders(node.arguments[1])) return;
      if (!bodyFromHelper(node.arguments[0])) context.report({ node, messageId: 'response' });
    };

    return {
      CallExpression(node) {
        if (isJoin(node, SEPARATORS) && csvContext(node) && !safeCells(node.callee.object)) {
          context.report({ node, messageId: 'join', data: { sep: JSON.stringify(stringValue(node.arguments[0])) } });
        }
      },
      NewExpression: checkResponse,
      TemplateLiteral(node) {
        if (node.expressions.length < 2 || !csvContext(node)) return;
        const inner = node.quasis.slice(1, -1).map((q) => q.value.cooked);
        if (!inner.every((q) => SEPARATORS.has(q))) return;
        if (!node.expressions.every(safeCell)) context.report({ node, messageId: 'template' });
      },
    };
  },
};
