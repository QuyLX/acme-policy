// Token Usage Index and ds.consumer-verification (FE §5.5; SC-09 in-repo form). A token change lists every consumer
// file; each consumer must belong to a declared workspace project, so the same run verifies it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../../lib/files.mjs';
import { checkResult } from '../../lib/result.mjs';

const COLOR_UTILS = ['bg', 'text', 'border', 'border-t', 'border-b', 'border-l', 'border-r', 'border-x', 'border-y', 'ring', 'ring-offset', 'fill', 'stroke', 'outline', 'divide', 'placeholder', 'from', 'to', 'via', 'decoration', 'accent', 'caret', 'shadow'];
const PREFIX = { color: COLOR_UTILS, radius: ['rounded', 'rounded-t', 'rounded-b', 'rounded-l', 'rounded-r'], shadow: ['shadow'], text: ['text'], font: ['font'] };
const SOURCE = /\.(?:tsx?|jsx?|mjs|css|mdx)$/;

/** Finds the token package: a project with tokens/*.json and dist/theme.css. */
export function tokenPackage(projects) {
  return projects.find((p) => existsSync(join(p.abs, 'dist', 'theme.css')) && existsSync(join(p.abs, 'tokens')));
}

/** theme.css → [{ themeVar, dsVar, utilities: string[] }] */
export function themeMap(themeCss) {
  const out = [];
  for (const m of themeCss.matchAll(/--(color|radius|shadow|text|font)-([\w-]+):\s*var\(--ds-([\w-]+)\)/g)) {
    out.push({ themeVar: `--${m[1]}-${m[2]}`, dsVar: `--ds-${m[3]}`, utilities: PREFIX[m[1]].map((pre) => `${pre}-${m[2]}`) });
  }
  return out;
}

export function tokenUsage(repo, projects) {
  const pkg = tokenPackage(projects);
  if (!pkg) return null;
  const map = themeMap(readFileSync(join(pkg.abs, 'dist', 'theme.css'), 'utf8'));
  const files = listFiles(repo).filter((f) => SOURCE.test(f) && !f.startsWith(`${pkg.dir}/`));
  const index = Object.fromEntries(map.map((t) => [t.dsVar, { themeVar: t.themeVar, files: [] }]));
  for (const f of files) {
    const text = readFileSync(join(repo, f), 'utf8');
    for (const t of map) {
      const used = text.includes(`var(${t.dsVar})`) || t.utilities.some((u) => new RegExp(`(?:^|[\\s"'\`:!])${u.replace(/[-]/g, '\\-')}(?![\\w-])`).test(text));
      if (used) index[t.dsVar].files.push(f);
    }
  }
  return { tokenPackage: pkg.dir, index };
}

const flatten = (o, prefix = '') =>
  Object.entries(o ?? {}).flatMap(([k, v]) => (v && typeof v === 'object' && !('$value' in v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, JSON.stringify(v)]]));

/** Changed token paths between two DTCG JSON texts, expanded through aliases to the semantic tokens that use them. */
export function changedTokens(baseText, headText, semanticTexts) {
  const b = Object.fromEntries(flatten(JSON.parse(baseText ?? '{}')));
  const h = Object.fromEntries(flatten(JSON.parse(headText ?? '{}')));
  const changed = new Set([...new Set([...Object.keys(b), ...Object.keys(h)])].filter((k) => b[k] !== h[k]));
  for (const text of semanticTexts) {
    for (const [path, value] of flatten(JSON.parse(text))) {
      if ([...changed].some((c) => value.includes(`{${c}}`))) changed.add(path);
    }
  }
  return [...changed];
}

const dsVarOf = (path) => `--ds-${path.replace(/\./g, '-')}`;

export function consumerVerificationCheck(def, ctx) {
  const pkg = tokenPackage(ctx.projects);
  const tokenFiles = pkg ? ctx.changed.filter((f) => f.startsWith(`${pkg.dir}/tokens/`) && f.endsWith('.json')) : [];
  if (!tokenFiles.length) return checkResult(def, { status: 'PASS', extensions: { 'x-note': 'no token change' } });
  const semantic = ['semantic.light.json', 'semantic.dark.json'].map((f) => ctx.readFile('head', `${pkg.dir}/tokens/${f}`)).filter(Boolean);
  const paths = tokenFiles.flatMap((f) => changedTokens(ctx.readFile('base', f), ctx.readFile('head', f), semantic));
  const usage = tokenUsage(ctx.repo, ctx.projects);
  const affected = new Set();
  for (const p of paths) {
    const vars = [dsVarOf(p), dsVarOf(p).replace(/-default$/, '')];
    for (const v of vars) for (const f of usage.index[v]?.files ?? []) affected.add(f);
  }
  const owner = (f) => ctx.projects.find((p) => f.startsWith(`${p.dir}/`) && ctx.config?.projects[p.name]);
  const consumers = [...new Set([...affected].map((f) => owner(f)?.name).filter(Boolean))].sort();
  const orphans = [...affected].filter((f) => !owner(f));
  return checkResult(def, {
    status: orphans.length ? 'FAIL' : 'PASS',
    reason: orphans.length ? `${orphans.length} consumer file(s) of the changed tokens belong to no verified project` : undefined,
    findings: [
      ...orphans.map((f) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', location: f, message: 'uses a changed token but is not part of any declared project: it would ship unverified', state: 'open' })),
      ...consumers.map((c) => ({ source: 'check', ruleId: def.checkId, severity: 'INFO', location: c, message: `consumer of changed tokens (${paths.slice(0, 5).join(', ')}) — verified in this run`, state: 'open' })),
    ],
    extensions: { 'x-changed-tokens': paths, 'x-consumers': consumers, 'x-files': [...affected].sort() },
  });
}
