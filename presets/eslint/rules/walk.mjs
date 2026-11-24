// Minimal AST walker for rules that inspect a subtree (skips `parent` links).
export function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}
