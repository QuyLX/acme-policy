// knowledge.impact — lists knowledge artifacts whose `describes` globs match changed paths (Standard §5.9–5.10).
// Pilot mode: `warn`; the reconciliation decision is recorded in the PR by someone of the artifact's authority.
// v2 (tech-design 13, SC-20): reads the PR's ReconciliationRecords from `.factory/reconciliation/*.yaml`
// (schemas/reconciliation-record.schema.json, Appendix K.5). An affected ACTIVE intent | decision | procedure | guidance
// artifact is satisfied only by a `decided` entry for `<id>@<version>` whose decidedBy is a human of the artifact's
// authority (§5.9 items 11-13; `policy` only for `update` of a generatedFrom artifact, §5.10 item 11). Agent proposals
// (`proposed`) never satisfy it. implementation-description artifacts only warn (§5.9 item 14).
// A record is written by whoever pushes the PR, so neither its `decidedBy` nor the PR head's roster is trusted:
//   - the authority roster `.factory/teams.yaml` is read from the BASE revision (ctx.readFile('base', …)); a PR cannot
//     add its own decider to the owner team. Without base access only the owner identity itself is of the authority;
//   - a human `decidedBy` counts only if that identity approved the head SHA in the approval input (the input policy.sod
//     evaluates: `--sod-input` or the platform PR event). Without an approval input the record cannot be verified and the
//     check is NOT_ASSESSED for it (never PASS, Standard §8.7 rule 3); an approval on another SHA is stale (GOV-06).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readFrontmatter, readYaml, policyPath } from '../../lib/io.mjs';
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

/** ReconciliationRecords recorded in the change (`.factory/reconciliation/*.yaml`), each validated against the schema. */
export function loadReconciliation(repoRoot) {
  const dir = join(repoRoot, '.factory', 'reconciliation');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => {
    const record = readYaml(join(dir, f));
    return { file: `.factory/reconciliation/${f}`, record, errors: validate('reconciliation-record', record) };
  });
}

/** The owner catalog (`.factory/teams.yaml`) at the BASE revision, or {} when the base cannot be read. */
export function baseTeams(readFile) {
  const text = readFile ? readFile('base', '.factory/teams.yaml') : null;
  return text ? parseYaml(text)?.teams ?? {} : {};
}

/** Humans of an artifact's authority: the owner identity, or the members of the owner team (base `.factory/teams.yaml`).
 *  Agents never qualify: `agent:` / `ci:` identities, `[bot]` logins and registry/agent-accounts.yaml (P20). */
export function authorityHumans(teams, owner) {
  const agents = new Set(readYaml(policyPath('registry', 'agent-accounts.yaml')).logins ?? []);
  const isAgent = (id) => /^(agent|ci):/.test(id) || id.endsWith('[bot]') || agents.has(id);
  return new Set([owner, ...(teams[owner]?.members ?? [])].filter((id) => id && !isAgent(id) && !teams[id]));
}

/** Identities that approved the head SHA, from the approval input `{ headSha, approvals: [{ by, commitSha, isAgent? }] }`
 *  (the policy.sod input shape); undefined when no approval input is available. */
export function headApprovers(approvalInput) {
  if (!approvalInput) return undefined;
  return new Set((approvalInput.approvals ?? []).filter((a) => a.commitSha === approvalInput.headSha && !a.isAgent).map((a) => a.by));
}

/**
 * @param approvers Set of identities that approved the head SHA, or undefined when no approval input is available
 * @returns {{ state: 'decided'|'proposed'|'not-authority'|'unapproved'|'unverified'|'missing', record?, decision?, decidedBy? }}
 */
export function reconciliationState(artifact, records, humans, approvers) {
  const ref = `${artifact.id}@${artifact.version}`;
  const entries = records.filter((r) => !r.errors.length).flatMap((r) => r.record.affected.filter((a) => a.artifact === ref).map((a) => ({ ...a, file: r.file, id: r.record.id })));
  if (!entries.length) return { state: 'missing' };
  const decided = entries.filter((a) => a.state === 'decided');
  if (!decided.length) return { state: 'proposed', record: entries[0].id };
  const who = (a) => (a.decidedBy === 'policy' ? 'policy' : a.decidedBy.id);
  const byPolicy = decided.find((a) => a.decidedBy === 'policy' && a.decision === 'update' && artifact.generatedFrom);
  if (byPolicy) return { state: 'decided', record: byPolicy.id, decision: byPolicy.decision, decidedBy: 'policy' };
  const ofAuthority = decided.filter((a) => a.decidedBy !== 'policy' && humans.has(a.decidedBy.id));
  if (!ofAuthority.length) return { state: 'not-authority', record: decided[0].id, decidedBy: who(decided[0]) };
  if (!approvers) return { state: 'unverified', record: ofAuthority[0].id, decision: ofAuthority[0].decision, decidedBy: who(ofAuthority[0]) };
  const ok = ofAuthority.find((a) => approvers.has(a.decidedBy.id));
  if (ok) return { state: 'decided', record: ok.id, decision: ok.decision, decidedBy: who(ok) };
  return { state: 'unapproved', record: ofAuthority[0].id, decision: ofAuthority[0].decision, decidedBy: who(ofAuthority[0]) };
}

const RULE = { missing: 'knowledge.impact', proposed: 'knowledge.impact.proposed-only', 'not-authority': 'knowledge.impact.not-authority', unapproved: 'knowledge.impact.unapproved', unverified: 'knowledge.impact.unverified', decided: 'knowledge.impact.reconciled' };

/**
 * @param {object} [opts]
 * @param {(side: 'base'|'head', path: string) => string|null} [opts.readFile] repository content at base/head (run ctx)
 * @param {{ headSha: string, approvals: Array<{ by: string, commitSha: string, isAgent?: boolean }> }} [opts.approvals]
 */
export function knowledgeImpactCheck(def, repoRoot, changedPaths, { readFile, approvals } = {}) {
  const started = Date.now();
  const artifacts = loadArtifacts(repoRoot, def.params.docsGlobs);
  const findings = []; // invalid frontmatter is reported by knowledge.record-schema
  const affected = knowledgeImpact(artifacts, changedPaths);
  const records = loadReconciliation(repoRoot);
  const teams = baseTeams(readFile);
  const approvers = headApprovers(approvals);
  // FE §8.4: FAIL for intent/decision/procedure/guidance records (warn for implementation-description) once blocking.
  const blockingAuthorities = new Set(['intent', 'decision', 'procedure', 'guidance']);
  const blocking = def.enforcement === 'blocking';
  for (const r of records.filter((x) => x.errors.length)) {
    findings.push({ source: 'check', ruleId: 'knowledge.impact.invalid-record', severity: blocking ? 'BLOCKER' : 'WARNING', location: r.file, message: `Not a valid ReconciliationRecord (ignored): ${r.errors.join('; ')}`, state: 'open' });
  }
  let blocks = false;
  const unverified = [];
  for (const a of affected) {
    const meta = artifacts.find((x) => x.path === a.path)?.meta ?? {};
    const hard = blockingAuthorities.has(a.authority);
    const rec = reconciliationState({ ...a, generatedFrom: meta.generatedFrom }, records, authorityHumans(teams, a.owner), approvers);
    a.reconciliation = rec.state;
    const open = rec.state !== 'decided';
    // An unverified decision is neither satisfied nor refuted: it does not block, it makes the result NOT_ASSESSED.
    if (open && hard && blocking && rec.state === 'unverified') unverified.push(a);
    else if (open && hard && blocking) blocks = true;
    const head = `${a.id}@${a.version} (authority: ${a.authority}, owner: ${a.owner}) describes changed paths ${a.touched.join(', ')}.`;
    const message = {
      missing: `${head} Record a reconciliation decision (keep | update | supersede | deprecate | review) in .factory/reconciliation/ (ReconciliationRecord) and the PR "Knowledge impact" section.`,
      proposed: `${head} ${rec.record} only proposes a decision: agent proposals never satisfy knowledge.impact (Standard §5.9 item 13).`,
      'not-authority': `${head} ${rec.record} was decided by ${rec.decidedBy}, who is not a human of the artifact's authority in the base owner catalog (Standard §5.9 item 12, §5.10 items 11-12).`,
      unapproved: `${head} ${rec.record} names ${rec.decidedBy} as decider, but ${rec.decidedBy} has not approved the head ${approvals?.headSha}: a record only counts when its decider approves the change (Standard §5.9 item 12, GOV-06).`,
      unverified: `${head} ${rec.record} names ${rec.decidedBy} as decider; no approval input (PR approvals of the head SHA) is available to verify it, so it is not counted (Standard §8.7 rule 3).`,
      decided: `${head} Reconciled in ${rec.record}: ${rec.decision} by ${rec.decidedBy}.`,
    }[rec.state];
    findings.push({ source: 'check', ruleId: RULE[rec.state], severity: !open ? 'INFO' : blocking && hard && rec.state !== 'unverified' ? 'BLOCKER' : 'WARNING', location: a.path, message, state: 'open' });
  }
  if (blocking && records.some((x) => x.errors.length) && affected.some((a) => blockingAuthorities.has(a.authority))) blocks = true;
  return checkResult(def, {
    status: blocks ? 'FAIL' : unverified.length ? 'NOT_ASSESSED' : 'PASS', // pilot mode: warn (Standard pilot checklist)
    reason: blocks
      ? `unreconciled ${affected.filter((a) => a.reconciliation !== 'decided' && blockingAuthorities.has(a.authority)).map((a) => `${a.id}@${a.version} (${a.reconciliation})`).join(', ') || 'invalid ReconciliationRecord'}`
      : unverified.length ? `reconciliation of ${unverified.map((a) => `${a.id}@${a.version}`).join(', ')} cannot be verified without the PR approvals of the head SHA` : undefined,
    findings,
    durationMs: Date.now() - started,
    extensions: {
      'x-affected': affected,
      'x-artifacts-scanned': artifacts.length,
      'x-reconciliation': records.map((r) => ({ id: r.record?.id, file: r.file, valid: !r.errors.length })),
    },
  });
}
