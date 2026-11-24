// knowledge.impact — lists knowledge artifacts whose `describes` globs match changed paths (Standard §5.9–5.10).
// Pilot mode: `warn`; the reconciliation decision is recorded in the PR by someone of the artifact's authority.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readFrontmatter } from '../../lib/io.mjs';
import { matchesAny } from '../../lib/glob.mjs';
import { validate } from '../../lib/schema.mjs';
import { checkResult } from '../../lib/result.mjs';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.git')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Loads knowledge artifacts (Markdown files with frontmatter) under repoRoot matching docsGlobs. */
export function loadArtifacts(repoRoot, docsGlobs) {
  const artifacts = [];
  for (const full of walk(repoRoot)) {
    const rel = relative(repoRoot, full);
    if (!matchesAny(rel, docsGlobs)) continue;
    const { meta } = readFrontmatter(full);
    if (!meta) continue;
    artifacts.push({ path: rel, meta, errors: validate('knowledge-meta', meta) });
  }
  return artifacts;
}

export function knowledgeImpact(artifacts, changedPaths) {
  const affected = [];
  for (const a of artifacts) {
    if (a.errors.length || !a.meta.describes || a.meta.status !== 'ACTIVE') continue;
    const touched = changedPaths.filter((p) => matchesAny(p, a.meta.describes));
    if (touched.length) affected.push({ id: a.meta.id, version: a.meta.version, authority: a.meta.authority, owner: a.meta.owner, path: a.path, touched });
  }
  return affected;
}

export function knowledgeImpactCheck(def, repoRoot, changedPaths) {
  const started = Date.now();
  const artifacts = loadArtifacts(repoRoot, def.params.docsGlobs);
  const findings = []; // invalid frontmatter is reported by knowledge.record-schema
  const affected = knowledgeImpact(artifacts, changedPaths);
  // FE §8.4: FAIL for intent/decision/procedure/guidance records (warn for implementation-description) once blocking.
  const blockingAuthorities = new Set(['intent', 'decision', 'procedure', 'guidance']);
  const blocks = def.enforcement === 'blocking' && affected.some((a) => blockingAuthorities.has(a.authority));
  for (const a of affected) {
    findings.push({
      source: 'check',
      ruleId: 'knowledge.impact',
      severity: def.enforcement === 'blocking' && blockingAuthorities.has(a.authority) ? 'BLOCKER' : 'WARNING',
      location: a.path,
      message: `${a.id}@${a.version} (authority: ${a.authority}, owner: ${a.owner}) describes changed paths ${a.touched.join(', ')}. Record a reconciliation decision (keep | update | supersede | deprecate | review) in the PR "Knowledge impact" section.`,
      state: 'open',
    });
  }
  return checkResult(def, {
    status: blocks ? 'FAIL' : 'PASS', // pilot mode: warn (Standard pilot checklist)
    findings,
    durationMs: Date.now() - started,
    extensions: { 'x-affected': affected, 'x-artifacts-scanned': artifacts.length },
  });
}
