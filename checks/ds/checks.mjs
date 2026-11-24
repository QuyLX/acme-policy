// ds.api-compat, ds.semver-changelog, ds.docs-api-sync (FE §8.4 design-system profile; FE §5.2).
// Applies to every project in factory.config.yaml that declares `publicApi`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkResult } from '../../lib/result.mjs';
import { extractApi, compareApi, docsGaps } from './api.mjs';

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function apiProjects(config, projects) {
  return projects.filter((p) => config?.projects[p.name]?.publicApi).map((p) => ({ ...p, publicApi: config.projects[p.name].publicApi }));
}

export function apiCompatCheck(def, ctx) {
  const findings = [];
  for (const p of apiProjects(ctx.config, ctx.projects)) {
    const snapPath = join(p.abs, p.publicApi.snapshot);
    const current = extractApi(join(p.abs, p.publicApi.entry));
    if (!existsSync(snapPath)) { findings.push({ location: `${p.dir}/${p.publicApi.snapshot}`, message: 'API snapshot missing: run `acme-policy ds api --repo . --write`' }); continue; }
    const diff = compareApi(JSON.parse(readFileSync(snapPath, 'utf8')), current);
    if (diff.level !== 'none') findings.push({ location: `${p.dir}/${p.publicApi.snapshot}`, message: `public API differs from the snapshot (${diff.level}): ${[...diff.breaking, ...diff.additive].slice(0, 8).join('; ')} — update the snapshot in this PR and add a changeset` });
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? 'public API snapshot out of date' : undefined,
    findings: findings.map((f) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', state: 'open', ...f })),
  });
}

/** A changed snapshot needs a changeset whose bump for the package is at least the required level. */
export function semverChangelogCheck(def, ctx) {
  const findings = [];
  for (const p of apiProjects(ctx.config, ctx.projects)) {
    const rel = `${p.dir}/${p.publicApi.snapshot}`;
    const base = ctx.readFile('base', rel);
    const head = ctx.readFile('head', rel);
    if (!base || !head || base === head) continue; // first snapshot or unchanged
    const diff = compareApi(JSON.parse(base), JSON.parse(head));
    if (diff.level === 'none') continue;
    const bumps = ctx.changed
      .filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && f !== '.changeset/README.md')
      .map((f) => parseYaml(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(ctx.repo, f), 'utf8'))?.[1] ?? '') ?? {})
      .map((fm) => fm[p.name])
      .filter(Boolean);
    const best = bumps.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');
    if (RANK[best] < RANK[diff.level]) findings.push({ location: rel, message: `${diff.level} API change of ${p.name} needs a changeset with a ${diff.level} bump (found: ${best}); breaking changes also need a codemod note (FE §5.2)` });
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    findings: findings.map((f) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', state: 'open', ...f })),
  });
}

export function docsApiSyncCheck(def, ctx) {
  const gaps = apiProjects(ctx.config, ctx.projects).flatMap((p) => docsGaps(p.abs).map((g) => ({ ...g, dir: p.dir })));
  return checkResult(def, {
    status: gaps.length && def.enforcement === 'blocking' ? 'FAIL' : 'PASS',
    findings: gaps.map((g) => ({ source: 'check', ruleId: def.checkId, severity: def.enforcement === 'blocking' ? 'BLOCKER' : 'INFO', location: `${g.dir}/${g.component}`, message: `prop ${g.prop} of ${g.component} is not documented in ${g.component}.doc.ts`, state: 'open' })),
  });
}
