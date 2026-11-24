// Public API extraction for Design System packages (FE §5.2 SemVer; FE §8.4 design-system: ds.api-compat,
// ds.semver-changelog, ds.docs-api-sync). Uses the kit's TypeScript compiler API, so the result never depends on
// the product's own TypeScript version.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyPath } from '../../lib/io.mjs';

const ts = createRequire(import.meta.url)(policyPath('presets', 'node_modules', 'typescript'));

/** { [exportName]: { kind: 'value' } | { kind: 'type', props?: { [name]: { optional, type } } } } */
export function extractApi(entry) {
  const program = ts.createProgram([entry], {
    jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2023, strict: true, skipLibCheck: true, noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  const mod = checker.getSymbolAtLocation(sf);
  const api = {};
  for (const exp of checker.getExportsOfModule(mod).sort((a, b) => a.name.localeCompare(b.name))) {
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    if (sym.flags & (ts.SymbolFlags.Value)) {
      api[exp.name] = { kind: 'value' };
      continue;
    }
    const type = checker.getDeclaredTypeOfSymbol(sym);
    const entryApi = { kind: 'type' };
    if (exp.name.endsWith('Props')) {
      entryApi.props = {};
      for (const p of checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name))) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const ptype = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        entryApi.props[p.name] = { optional: Boolean(p.flags & ts.SymbolFlags.Optional), type: checker.typeToString(ptype, undefined, ts.TypeFormatFlags.NoTruncation) };
      }
    } else entryApi.type = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
    api[exp.name] = entryApi;
  }
  return api;
}

/** Classifies an API change: breaking (major) | additive (minor) | none. Unclassifiable changes count as breaking. */
export function compareApi(base, head) {
  const breaking = [];
  const additive = [];
  for (const [name, b] of Object.entries(base)) {
    const h = head[name];
    if (!h) { breaking.push(`export ${name} removed`); continue; }
    if (b.kind !== h.kind) { breaking.push(`export ${name} changed kind ${b.kind} → ${h.kind}`); continue; }
    if (b.type !== undefined && b.type !== h.type) breaking.push(`type ${name} changed: ${b.type} → ${h.type}`);
    for (const [p, bp] of Object.entries(b.props ?? {})) {
      const hp = h.props?.[p];
      if (!hp) breaking.push(`${name}.${p} removed`);
      else if (bp.optional && !hp.optional) breaking.push(`${name}.${p} became required`);
      else if (bp.type !== hp.type) breaking.push(`${name}.${p} type changed: ${bp.type} → ${hp.type}`);
    }
    for (const [p, hp] of Object.entries(h.props ?? {})) {
      if (!(b.props ?? {})[p]) (hp.optional ? additive : breaking).push(`${name}.${p} added${hp.optional ? '' : ' as required'}`);
    }
  }
  for (const name of Object.keys(head)) if (!base[name]) additive.push(`export ${name} added`);
  return { level: breaking.length ? 'major' : additive.length ? 'minor' : 'none', breaking, additive };
}

/** Own (not inherited) props declared in `interface XProps` and the keys documented in X.doc.ts, per component. */
export function docsGaps(packageDir) {
  const gaps = [];
  const src = join(packageDir, 'src');
  for (const dir of readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const files = readdirSync(join(src, dir.name));
    const doc = files.find((f) => f.endsWith('.doc.ts'));
    if (!doc) continue;
    const name = doc.replace('.doc.ts', '');
    const compPath = join(src, dir.name, `${name}.tsx`);
    if (!existsSync(compPath)) continue;
    const own = new Set();
    const comp = ts.createSourceFile(compPath, readFileSync(compPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    comp.forEachChild((n) => {
      if (ts.isInterfaceDeclaration(n) && n.name.text === `${name}Props`) for (const m of n.members) if (m.name && ts.isIdentifier(m.name)) own.add(m.name.text);
    });
    const docSrc = ts.createSourceFile(doc, readFileSync(join(src, dir.name, doc), 'utf8'), ts.ScriptTarget.Latest, true);
    const documented = new Set();
    const visit = (n) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'props' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) documented.add(p.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(docSrc);
    for (const p of own) if (!documented.has(p)) gaps.push({ component: name, prop: p });
  }
  return gaps;
}
