// Test Planner v0 (FE §8.10; Standard §7.3 item 5; CORE-VER-01). Deterministic: the same inputs give the same TestPlan
// and the same digest. It only reads files: the project graph comes from package.json dependencies plus an import scan,
// never from nx or repo scripts (DV-05). It selects tests and records a reason for each; it never runs them.
//
// Floor (FE §8.10 rule 1): tests that reach a changed file, tests of `critical` journeys of affected surfaces, and the
// sentinel set when a shared asset changes. A changed file the graph cannot map runs the full suite of its surface
// (rule 2: run wider, never narrower). R2 adds `high` journeys, R3 the full suite of affected surfaces (rule 3).
// Affected surfaces = direct + via the dependency graph + portfolio consumers + sentinel set (Standard §7.3 item 5).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listFiles } from './files.mjs';
import { matchesAny } from './glob.mjs';
import { discoverProjects } from './workspace.mjs';

const SOURCE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx|mts|js|jsx|mjs)$/;
// Same shape as checks/arch/cycles.mjs, but any specifier (relative or bare); `import type` is erased and ignored.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const JOURNEY_TAG = /@journey:([A-Za-z0-9_./-]+)/g;

/** Canonical JSON (sorted keys, no whitespace): the digest input of TestPlan and environment manifests. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const digestOf = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

const readJsonFile = (p) => JSON.parse(readFileSync(p, 'utf8'));

function packageEntry(abs) {
  const pkg = readJsonFile(join(abs, 'package.json'));
  const exp = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
  const entry = (typeof exp === 'object' ? exp.import ?? exp.default : exp) ?? pkg.main ?? 'index.mjs';
  return normalize(entry);
}

/**
 * Project graph of one repo: workspace projects (pnpm-workspace.yaml) or the repo root as a single project, file-level
 * import edges, and package-level edges (package.json dependencies ∪ bare imports of workspace packages).
 * @param {string} root
 * @param {{ external?: string[] }} [o] package names published by other repos (portfolio index); imports of them become
 *        edges to the node `ext:<name>`.
 */
export function projectGraph(root, { external = [] } = {}) {
  const discovered = discoverProjects(root);
  const projects = discovered.length
    ? discovered.map((p) => ({ name: p.name, dir: p.dir }))
    : [{ name: existsSync(join(root, 'package.json')) ? readJsonFile(join(root, 'package.json')).name : relative(dirname(root), root), dir: '' }];
  const byName = new Map(projects.map((p) => [p.name, p]));
  const files = listFiles(root).sort();
  const fileSet = new Set(files);
  const ownerOf = (file) => projects.filter((p) => !p.dir || file === p.dir || file.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
  const resolveFile = (base) => {
    const stripped = base.replace(/\.(?:js|mjs|jsx)$/, '');
    for (const cand of [...EXTS.map((e) => base + e), ...EXTS.map((e) => stripped + e)]) if (fileSet.has(cand)) return cand;
    return null;
  };
  const resolveBare = (spec) => {
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (external.includes(name)) return { node: `ext:${name}`, pkg: name };
    const p = byName.get(name);
    if (!p || !p.dir) return null;
    const sub = spec.slice(name.length).replace(/^\//, '');
    const target = sub ? resolveFile(normalize(join(p.dir, sub))) ?? resolveFile(normalize(join(p.dir, 'src', sub))) : resolveFile(normalize(join(p.dir, packageEntry(join(root, p.dir)))));
    return target ? { node: target, pkg: name } : null;
  };
  const imports = new Map(); // file → [{ node, pkg? }]
  for (const file of files.filter((f) => SOURCE.test(f))) {
    const text = readFileSync(join(root, file), 'utf8');
    const out = [];
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = resolveFile(normalize(join(dirname(file), spec)));
        if (target) out.push({ node: target });
      } else {
        const r = resolveBare(spec);
        if (r) out.push(r);
      }
    }
    imports.set(file, out);
  }
  const deps = new Map(projects.map((p) => [p.name, new Set()]));
  for (const p of projects.filter((x) => x.dir)) {
    const pkg = readJsonFile(join(root, p.dir, 'package.json'));
    for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) if (byName.has(d) && d !== p.name) deps.get(p.name).add(d);
  }
  for (const [file, list] of imports) for (const i of list) if (i.pkg && byName.has(i.pkg) && ownerOf(file)?.name !== i.pkg) deps.get(ownerOf(file).name).add(i.pkg);
  const importers = new Map(); // node → Set(file)
  for (const [file, list] of imports) for (const i of list) {
    if (!importers.has(i.node)) importers.set(i.node, new Set());
    importers.get(i.node).add(file);
  }
  return { root, projects, files, imports, importers, ownerOf, deps: Object.fromEntries([...deps].map(([k, v]) => [k, [...v].sort()])) };
}

/** Files that reach `node` through imports (transitively), excluding the node itself. */
function reverseReach(graph, node) {
  const seen = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    for (const f of graph.importers.get(n) ?? []) if (!seen.has(f)) { seen.add(f); stack.push(f); }
  }
  seen.delete(node);
  return seen;
}

/** Surfaces declared in apps/<app>/factory.yaml (FE §7.2), plus the Journey Registry (FE §7.7). */
export function surfaceMap(root) {
  const surfaces = [];
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const app of readdirSync(apps).sort()) {
      const f = join(apps, app, 'factory.yaml');
      if (!statSync(join(apps, app)).isDirectory() || !existsSync(f)) continue;
      for (const s of parseYaml(readFileSync(f, 'utf8'))?.surfaces ?? []) surfaces.push({ id: s.id, paths: s.paths ?? [], archetypes: s.archetypes ?? [], criticality: s.criticality });
    }
  }
  const jf = join(root, 'journeys.yaml');
  const journeys = existsSync(jf) ? parseYaml(readFileSync(jf, 'utf8')) ?? [] : [];
  return { surfaces, journeys };
}

/** Matches a semver version against a range: `1.4.0`, `2.x`, `^2.1.0`, `~2.1.0`, `>=3 <4` (space = AND). */
export function satisfies(version, range) {
  const v = String(version).replace(/^[^\d]*/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
  const parse = (s) => s.split('.').map((n) => (n === 'x' || n === '*' ? null : Number.parseInt(n, 10)));
  return String(range).trim().split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(term);
    const op = m[1] ?? '';
    const p = parse(m[2]);
    const base = p.map((n) => n ?? 0);
    if (op === '>=') return cmp(v, base) >= 0;
    if (op === '>') return cmp(v, base) > 0;
    if (op === '<=') return cmp(v, base) <= 0;
    if (op === '<') return cmp(v, base) < 0;
    if (op === '^') return v[0] === base[0] && cmp(v, base) >= 0;
    if (op === '~') return v[0] === base[0] && v[1] === base[1] && cmp(v, base) >= 0;
    return p.every((n, i) => n === null || Number.isNaN(n) || n === v[i]); // exact or x-range
  });
}

const testsIn = (graph) => graph.files.filter((f) => TEST.test(f));
function journeyTags(root, file) {
  return [...new Set([...readFileSync(join(root, file), 'utf8').matchAll(JOURNEY_TAG)].map((m) => m[1]))].sort();
}

/**
 * @param {{
 *   repos: Record<string, string>,  // repo id → root directory
 *   primary: string,                // repo id of the change
 *   changed: string[],              // changed paths in the primary repo
 *   portfolio?: { repos: Array<{ id: string, publishes?: Array<{ package: string, paths: string[] }>, consumes?: string[] }> },
 *   tier?: 'R0'|'R1'|'R2'|'R3',
 *   config?: { sharedAssetGlobs?: string[] },
 *   include?: string[],             // "<repo>:<test path>" added by an agent or human (rule 5)
 *   environment?: { id: string, kind: string },
 * }} input
 * @returns {object} TestPlan (schemas/test-plan.schema.json)
 */
export function planTests({ repos, primary, changed, portfolio, tier = 'R1', config = {}, include = [], environment }) {
  const root = repos[primary];
  const graph = projectGraph(root);
  const { surfaces, journeys } = surfaceMap(root);
  const journeyById = new Map(journeys.map((j) => [j.id, j]));
  const surfaceOf = (file) => surfaces.filter((s) => matchesAny(file, s.paths)).map((s) => s.id);
  const selections = new Map(); // "<repo>:<test>" → selection
  const select = (repo, test, reason, repoRoot = root) => {
    const key = `${repo}:${test}`;
    if (!selections.has(key)) {
      const tags = journeyTags(repoRoot, test);
      const surface = repo === primary ? surfaceOf(test)[0] ?? journeyById.get(tags[0])?.surface : undefined;
      selections.set(key, { repo, test, ...(surface ? { surface } : {}), journeys: tags, reasons: new Set() });
    }
    selections.get(key).reasons.add(reason);
  };
  const tests = testsIn(graph);
  const testsOfSurface = (sid) => tests.filter((t) => surfaceOf(t).includes(sid) || journeyTags(root, t).some((j) => journeyById.get(j)?.surface === sid));
  const testsOfJourney = (jid) => tests.filter((t) => journeyTags(root, t).includes(jid));

  const direct = new Set();
  const viaGraph = new Set();
  const unmapped = [];
  const reachedAll = new Set();
  const sorted = [...new Set(changed)].sort();
  for (const file of sorted) {
    for (const s of surfaceOf(file)) direct.add(s);
    if (TEST.test(file) && existsSync(join(root, file))) select(primary, file, 'direct');
    const reach = reverseReach(graph, file);
    for (const f of reach) reachedAll.add(f);
    const owner = graph.ownerOf(file);
    for (const t of tests.filter((x) => reach.has(x))) {
      const tOwner = graph.ownerOf(t);
      select(primary, t, !owner || tOwner?.name === owner.name ? 'direct' : `import-graph:${owner.name}`);
    }
    const mapped = TEST.test(file) || (SOURCE.test(file) && (graph.importers.get(file)?.size ?? 0) > 0);
    if (!mapped) {
      // Rule 2: the surface that owns the file; for a package file, every surface that depends on that package.
      let owners = surfaceOf(file);
      if (!owners.length && owner) {
        const dependents = graph.projects.filter((p) => p.name === owner.name || graph.deps[p.name]?.includes(owner.name));
        owners = surfaces.filter((s) => dependents.some((p) => s.paths.some((g) => p.dir && g.startsWith(`${p.dir}/`)))).map((s) => s.id);
      }
      if (!owners.length) owners = surfaces.map((s) => s.id);
      unmapped.push({ file, surfaces: owners });
      for (const sid of owners) for (const t of testsOfSurface(sid)) select(primary, t, `unmapped→full-suite:${sid}`);
    }
  }
  for (const f of reachedAll) for (const s of surfaceOf(f)) if (!direct.has(s)) viaGraph.add(s);
  for (const u of unmapped) for (const s of u.surfaces) if (!direct.has(s)) viaGraph.add(s);
  const affected = [...new Set([...direct, ...viaGraph])].sort();

  // Sentinel set (FE §5.5): the top critical journey per archetype, when a shared asset changed.
  const sharedChanged = sorted.some((f) => matchesAny(f, config.sharedAssetGlobs ?? ['packages/**']));
  const sentinel = [];
  if (sharedChanged) {
    const byArchetype = new Map();
    for (const j of [...journeys].filter((x) => x.criticality === 'critical').sort((a, b) => a.id.localeCompare(b.id))) {
      const s = surfaces.find((x) => x.id === j.surface);
      for (const a of s?.archetypes ?? []) if (!byArchetype.has(a)) byArchetype.set(a, j);
    }
    for (const j of new Set(byArchetype.values())) {
      if (!affected.includes(j.surface)) {
        if (!sentinel.includes(j.surface)) sentinel.push(j.surface);
        for (const t of testsOfJourney(j.id)) select(primary, t, 'sentinel');
      }
    }
    sentinel.sort();
  }
  // Floor: critical journeys of affected surfaces; tier additions (rule 3).
  for (const j of journeys.filter((x) => affected.includes(x.surface))) {
    if (j.criticality === 'critical') for (const t of testsOfJourney(j.id)) select(primary, t, 'critical-journey');
    if (j.criticality === 'high' && (tier === 'R2' || tier === 'R3')) for (const t of testsOfJourney(j.id)) select(primary, t, 'risk:R2-high-journey');
  }
  if (tier === 'R3') for (const sid of affected) for (const t of testsOfSurface(sid)) select(primary, t, 'risk:R3-full-suite');

  // Cross-repo: a published package whose files changed or reach a changed file → every consumer repo (portfolio index).
  const consumers = [];
  const me = portfolio?.repos?.find((r) => r.id === primary);
  for (const pub of me?.publishes ?? []) {
    const touched = [...sorted, ...reachedAll].some((f) => matchesAny(f, pub.paths));
    if (!touched) continue;
    for (const c of (portfolio.repos ?? []).filter((r) => r.id !== primary && (r.consumes ?? []).includes(pub.package))) {
      if (!repos[c.id]) { unmapped.push({ file: `portfolio:${c.id}`, surfaces: [] }); continue; }
      const cg = projectGraph(repos[c.id], { external: [pub.package] });
      const reach = reverseReach(cg, `ext:${pub.package}`);
      const hit = testsIn(cg).filter((t) => reach.has(t));
      if (!hit.length) { for (const t of testsIn(cg)) select(c.id, t, `unmapped→full-suite:${c.id}`, repos[c.id]); } // consumer found, mapping not: run wider
      for (const t of hit) select(c.id, t, `portfolio-consumer:${c.id}`, repos[c.id]);
      consumers.push({ repo: c.id, package: pub.package });
    }
  }
  for (const ref of include) {
    const [repo, ...rest] = ref.split(':');
    if (repos[repo] && existsSync(join(repos[repo], rest.join(':')))) select(repo, rest.join(':'), 'include', repos[repo]);
  }

  const plan = {
    apiVersion: 'aisf/4.0',
    kind: 'TestPlan',
    planner: 'acme-policy/test-planner@0.1.0',
    repo: primary,
    tier,
    changed: sorted,
    ...(environment ? { environment: { id: environment.id, kind: environment.kind } } : {}),
    browsers: ['chromium'],
    surfaces: { direct: [...direct].sort(), graph: [...viaGraph].sort(), sentinel, consumers: consumers.map((c) => `${c.repo}:${c.package}`).sort() },
    unmapped,
    selections: [...selections.values()]
      .map((s) => ({ ...s, reasons: [...s.reasons].sort() }))
      .sort((a, b) => `${a.repo}:${a.test}`.localeCompare(`${b.repo}:${b.test}`)),
  };
  return { ...plan, digest: digestOf(plan) };
}

/** Floor check (FE §8.10 rule 5): nobody removes a selected test. @returns {string[]} excluded floor selections */
export function belowFloor(plan, exclude = []) {
  const keys = new Set(plan.selections.map((s) => `${s.repo}:${s.test}`));
  return exclude.filter((x) => keys.has(x)).sort();
}

/** One-line summary per selection, used by scenario expectations and the CLI. */
export const selectionLines = (plan) => plan.selections.map((s) => `${s.repo} ${s.test} ${s.reasons.join(',')}`);
