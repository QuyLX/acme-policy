// arch.cycles — FE-ARCH-003: no circular dependencies, between workspace packages or between source files of a
// project (relative value imports; `import type` is erased at compile time and ignored).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { listFiles } from '../../lib/files.mjs';
import { checkResult } from '../../lib/result.mjs';

const SOURCE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

function resolveImport(fromFile, spec, files) {
  const base = normalize(join(dirname(fromFile), spec));
  const stripped = base.replace(/\.(?:js|mjs|jsx)$/, ''); // TS ESM: './x.js' may point at x.ts
  for (const cand of [...EXTS.map((e) => base + e), ...EXTS.map((e) => stripped + e)]) if (files.has(cand)) return cand;
  return null;
}

/** Tarjan's strongly connected components; returns components with more than one node (or a self-loop). */
export function cycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) out.push(comp.reverse());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

export function cyclesCheck(def, repo, projects) {
  const started = Date.now();
  const findings = [];
  // 1. workspace package graph
  const names = new Set(projects.map((p) => p.name));
  const pkgGraph = new Map();
  for (const p of projects) {
    const pkg = JSON.parse(readFileSync(join(p.abs, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).filter((d) => names.has(d));
    pkgGraph.set(p.name, deps);
  }
  for (const c of cycles(pkgGraph)) findings.push({ location: 'package.json', message: `Package cycle: ${[...c, c[0]].join(' → ')}` });
  // 2. source import graph per project (or the whole repo when there are no workspace projects)
  const roots = projects.length ? projects.map((p) => p.dir) : ['.'];
  for (const root of roots) {
    const abs = join(repo, root);
    if (!existsSync(abs)) continue;
    const files = listFiles(abs).filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts'));
    const set = new Set(files);
    const graph = new Map();
    for (const f of files) {
      const text = readFileSync(join(abs, f), 'utf8');
      const edges = [];
      for (const m of text.matchAll(IMPORT)) {
        const target = resolveImport(f, m[1] ?? m[2], set);
        if (target) edges.push(target);
      }
      graph.set(f, edges);
    }
    for (const c of cycles(graph)) findings.push({ location: `${root}/${c[0]}`, message: `Import cycle: ${[...c, c[0]].map((x) => `${root}/${x}`).join(' → ')}` });
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? `${findings.length} dependency cycle(s)` : undefined,
    findings: findings.map((f) => ({ source: 'check', ruleId: 'FE-ARCH-003', severity: 'BLOCKER', state: 'open', ...f })),
    durationMs: Date.now() - started,
  });
}
