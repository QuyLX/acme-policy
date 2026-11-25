// Knowledge Index (FE §7.8; Standard §5.9, Appendix K.5 KnowledgeIndex; CORE-KNW-05, CORE-SEC-02). A retrieval layer,
// not a source of truth: every entry points back to its source as URI@SHA, and the source always wins.
// Retrieval rules implemented here (FE §7.8):
//   1. access follows the source: results are filtered by the requester's identity at query time; `restricted` records
//      are not indexed at all without the owner's explicit opt-in (`x-fe.indexOptIn`);
//   2. default results are ACTIVE records whose `x-fe.appliesTo` matches the versions the requester's repo pins;
//      NEEDS_REVALIDATION is returned with a marker; other states only on request (`includeDraft`), marked `not-a-basis`;
//   3. every result carries URI@SHA, authority and version;
//   4. two ACTIVE records that both govern the question are a KnowledgeConflict: escalate, never pick one (Standard
//      §4.7 items 8–14; precedence only from `supersedes` and lifecycle, never from modification time);
//   5. retrieved content is untrusted data: results are marked so and pre-scanned like `review.injection-prescan`;
//   6. every answer states when the index was built and whether it is stale.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readFrontmatter } from './io.mjs';
import { listFiles } from './files.mjs';
import { validate } from './schema.mjs';
import { digestOf, satisfies } from './test-planner.mjs';
import { injectionHits } from '../checks/review/injection-prescan.mjs';
import { parseUnifiedDiff } from './diff.mjs';

const SHA = /^[0-9a-f]{40}$/;
const LOW_TIERS = new Set(['Low', 'R0', 'R1']);

function sourceCommit(root, recorded) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top === root) return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { /* not a git work tree of its own: use the commit the source recorded */ }
  return recorded == null ? undefined : String(recorded);
}

/**
 * @param {{ sources: Array<{ repo: string, root: string, commit?: string }>, builtAt: string }} input
 * @returns K.5 KnowledgeIndex, with the retrievable entries under extensions["x-fe"]
 */
export function buildIndex({ sources, builtAt }) {
  const entries = [];
  const invalid = [];
  const duplicates = [];
  let excludedRestricted = 0;
  for (const src of sources) {
    const commit = sourceCommit(src.root, src.commit);
    for (const rel of listFiles(src.root).filter((f) => f.endsWith('.md')).sort()) {
      const { meta, body } = readFrontmatter(join(src.root, rel));
      if (!meta) continue;
      const errors = validate('knowledge-meta', meta);
      if (errors.length) { invalid.push({ uri: `${src.repo}:${rel}`, errors }); continue; }
      const fe = meta['x-fe'] ?? {};
      const visibility = fe.visibility ?? 'internal';
      if (visibility === 'restricted' && fe.indexOptIn !== true) { excludedRestricted++; continue; } // rule 1
      if (entries.some((e) => e.id === meta.id)) { duplicates.push(meta.id); continue; }
      const text = readFileSync(join(src.root, rel), 'utf8');
      entries.push({
        id: meta.id, kind: meta.kind, status: meta.status, version: String(meta.version), authority: meta.authority, owner: meta.owner,
        title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? meta.id).trim(),
        repo: src.repo, path: rel, sha: commit, uri: `repo://${src.repo}/${rel}`, cite: `${src.repo}:${rel}@${commit}`,
        contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        appliesTo: fe.appliesTo ?? {}, visibility, readers: fe.readers ?? [],
        describes: meta.describes ?? [], supersedes: meta.supersedes ?? [], supersededBy: meta.supersededBy, validatedAgainst: meta.validatedAgainst,
        injection: injectionHits(`diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${body.split('\n').length} @@\n${body.split('\n').map((l) => `+${l}`).join('\n')}\n`, []).map((h) => h.message),
        text: `${meta.id} ${body}`.toLowerCase(),
      });
    }
  }
  const edges = entries.flatMap((e) => [
    ...e.describes.map((to) => ({ from: e.id, rel: 'describes', to, source: 'declared' })),
    ...e.supersedes.map((to) => ({ from: e.id, rel: 'supersedes', to: String(to).split('@')[0], source: 'declared' })),
  ]);
  const builtFrom = sources.map((s) => ({ repo: s.repo, commit: sourceCommit(s.root, s.commit) }));
  return {
    schemaVersion: 'aisf/4.0',
    builtFrom: { repo: 'portfolio', commit: digestOf(builtFrom) },
    artifacts: Object.fromEntries(entries.map((e) => [e.id, { status: e.status, version: e.version, authority: e.authority, owner: e.owner }])),
    edges,
    extensions: { 'x-fe': { builtAt, sources: builtFrom, entries, invalid, duplicates, excludedRestricted } },
  };
}

/** Versions a repo pins (FE §7.3: `factory context` only returns records matching them): package.json deps and the
 *  contracts each app descriptor consumes (`openapi:<id>@<version>`). */
export function repoPins(root) {
  const packages = {};
  const pkgFiles = ['package.json', ...['apps', 'packages'].flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).map((x) => join(d, x, 'package.json')) : []))];
  let repo;
  for (const f of pkgFiles.filter((x) => existsSync(join(root, x)))) {
    const pkg = JSON.parse(readFileSync(join(root, f), 'utf8'));
    if (f === 'package.json') repo = pkg.name;
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) if (/^\d/.test(v.replace(/^[\^~=]/, ''))) packages[name] = v.replace(/^[\^~=]/, '');
  }
  const contracts = {};
  const apps = join(root, 'apps');
  for (const app of existsSync(apps) ? readdirSync(apps) : []) {
    const f = join(apps, app, 'factory.yaml');
    if (!statSync(join(apps, app)).isDirectory() || !existsSync(f)) continue;
    for (const c of parseYaml(readFileSync(f, 'utf8'))?.contracts?.consumes ?? []) {
      const m = /^(?:[a-z]+:)?([^@]+)@(.+)$/.exec(c);
      if (m) contracts[m[1]] = m[2];
    }
  }
  return { repo, packages, contracts };
}

/** FE §7.3 `x-fe.appliesTo`: every declared package / contract range must match a version the requester pins. */
export function appliesToPins(appliesTo = {}, pins = {}) {
  for (const [name, range] of Object.entries(appliesTo.packages ?? {})) if (!pins.packages?.[name] || !satisfies(pins.packages[name], range)) return false;
  for (const [id, range] of Object.entries(appliesTo.contracts ?? {})) if (!pins.contracts?.[id] || !satisfies(pins.contracts[id], range)) return false;
  if (appliesTo.repos?.length && !appliesTo.repos.includes(pins.repo)) return false;
  return true;
}

/** FE §7.8 rule 1: may this requester read the record at its source? */
export function canRead(entry, requester = {}) {
  if (entry.visibility === 'public') return true;
  if (entry.visibility === 'internal') return (requester.clearance ?? []).includes('internal');
  const ids = new Set([requester.id, ...(requester.groups ?? [])]);
  return entry.readers.some((r) => ids.has(r));
}

/**
 * Standard §5.8 (table, items 4–5) and FE §7.3: may this record be a task's basis?
 * ACTIVE: yes. NEEDS_REVALIDATION: only for a Low / R0–R1 task (never for new Medium/High or R2+ work). Others: never.
 */
export function basisEligible(status, tier) {
  if (status === 'ACTIVE') return { eligible: true };
  if (status === 'NEEDS_REVALIDATION') {
    return LOW_TIERS.has(tier) ? { eligible: true, marker: 'needs-revalidation' } : { eligible: false, reason: `NEEDS_REVALIDATION is not a basis at tier ${tier ?? 'unknown'} (Standard §5.8; FE §7.3: not for Medium/High or R2+)` };
  }
  return { eligible: false, reason: `${status} is not usable as a basis (Standard §5.8 table)` };
}

const overlaps = (a, b) => a.some((x) => b.includes(x));
const linked = (a, b) => a.supersedes.some((s) => String(s).split('@')[0] === b.id) || b.supersedes.some((s) => String(s).split('@')[0] === a.id) || a.supersededBy?.split('@')[0] === b.id || b.supersededBy?.split('@')[0] === a.id;

/** Two ACTIVE intent/decision records that govern the same scope for the same pinned versions, with no `supersedes`
 *  link between them: the Factory cannot tell which is authoritative and must not guess (Standard §4.7 item 13). */
export function detectConflicts(entries, { workItemId } = {}) {
  const active = entries.filter((e) => e.status === 'ACTIVE' && ['intent', 'decision'].includes(e.authority));
  const out = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const [a, b] = [active[i], active[j]];
      if (a.authority !== b.authority || !overlaps(a.describes, b.describes) || linked(a, b)) continue;
      out.push({
        id: `KC-${a.id}-${b.id}`,
        ...(workItemId ? { workItemId } : {}),
        sources: [a, b].map((e) => ({ ref: `${e.id}@${e.version} ${e.cite}`, says: e.title })),
        affectsCorrectnessOrRisk: true,
        authority: a.owner === b.owner ? `owner of both records (${a.owner})` : `nearest common owner of ${a.owner} and ${b.owner} (Standard §4.7 item 10: two ACTIVE artifacts conflict)`,
        proposal: `One record must be modified or superseded with a recorded decision; until then the task stops (NEEDS_CLARIFICATION before EXECUTING, BLOCKED after)`,
      });
    }
  }
  return out;
}

/**
 * @param {object} index KnowledgeIndex from buildIndex
 * @param {string} query lexical query
 * @param {{ requester: { id: string, kind?: string, clearance?: string[], groups?: string[] }, pins?: object,
 *           includeDraft?: boolean, kind?: string, now?: string, staleAfterHours?: number, workItemId?: string }} o
 */
export function search(index, query, { requester, pins = {}, includeDraft = false, kind, now, staleAfterHours = 24, workItemId } = {}) {
  const fe = index.extensions['x-fe'];
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9@./-]+/).filter((t) => t.length >= 3))];
  const results = [];
  for (const e of fe.entries) {
    if (kind && e.kind !== kind) continue;
    if (!canRead(e, requester)) continue; // being findable is not a reason to return (rule 1)
    if (!appliesToPins(e.appliesTo, pins)) continue; // rule 2: the version the repo pins
    const marker = e.status === 'ACTIVE' ? undefined : e.status === 'NEEDS_REVALIDATION' ? 'needs-revalidation' : 'not-a-basis';
    if (marker === 'not-a-basis' && !includeDraft) continue;
    const score = terms.reduce((n, t) => n + (e.title.toLowerCase().includes(t) ? 2 : 0) + (e.text.includes(t) ? 1 : 0), 0);
    if (!score) continue;
    results.push({ id: e.id, version: e.version, status: e.status, authority: e.authority, kind: e.kind, owner: e.owner, title: e.title, uri: e.uri, sha: e.sha, cite: e.cite, contentHash: e.contentHash, ...(marker ? { marker } : {}), trust: 'untrusted-data', ...(e.injection.length ? { injection: e.injection } : {}), score });
  }
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const builtAt = fe.builtAt;
  const ageH = (Date.parse(now ?? new Date().toISOString()) - Date.parse(builtAt)) / 3.6e6;
  const governing = fe.entries.filter((e) => results.some((r) => r.id === e.id && r.status === 'ACTIVE'));
  return { query, builtAt, stale: ageH > staleAfterHours, results, conflicts: detectConflicts(governing, { workItemId }) };
}

/** A citation is complete when it names the source and a full commit SHA, plus authority and version (rule 3). */
export const citationComplete = (r) => typeof r.cite === 'string' && SHA.test(r.cite.split('@').pop()) && Boolean(r.authority) && Boolean(r.version);

/** Loads a sources file: { builtAt, sources: [{ repo, root (relative to the policy root), commit }] }. */
export function indexFromSourcesFile(path, resolveRoot) {
  const spec = parseYaml(readFileSync(path, 'utf8'));
  return buildIndex({ builtAt: spec.builtAt, sources: spec.sources.map((s) => ({ ...s, root: resolveRoot(s.root) })) });
}

const AC_LINE = /\{\s*id:\s*(AC-[A-Z0-9-]+)\s*,\s*statement:\s*"([^"]*)"/;

/**
 * An implementer edit of an acceptance criterion in journeys.yaml is a knowledge conflict (code ≠ AC), never a
 * resolution: Standard §4.7 items 6 and 8-10; FE §7.7, §9.10 (the implementer never edits ACs; the product or journey
 * owner decides through an oracle change request). Returns one KnowledgeConflict per edited or deleted AC.
 */
export function conflictsFromAcEdit(diffText, { workItemId, actor }) {
  const out = [];
  for (const file of parseUnifiedDiff(diffText).filter((f) => /(^|\/)journeys\.yaml$/.test(f.path))) {
    const before = new Map();
    const after = new Map();
    for (const line of file.hunks.flatMap((h) => h.lines)) {
      const m = AC_LINE.exec(line.text);
      if (!m) continue;
      if (line.type === '-') before.set(m[1], m[2]);
      if (line.type === '+') after.set(m[1], m[2]);
    }
    for (const [id, was] of before) {
      if (after.get(id) === was) continue;
      out.push({
        id: `KC-${workItemId}-${id}`,
        workItemId,
        sources: [
          { ref: `${file.path}#${id} (approved acceptance criterion)`, says: was },
          { ref: `change by ${actor.id} (${actor.kind})`, says: after.has(id) ? after.get(id) : '(deleted)' },
        ],
        affectsCorrectnessOrRisk: true,
        authority: 'product or journey owner, through specification-review (Standard §4.7 item 10: code ≠ acceptance criteria)',
        proposal: 'Revert the AC edit; if the AC is wrong, open an oracle change request in a separate change (FE §9.10 item 3)',
      });
    }
  }
  return out;
}
