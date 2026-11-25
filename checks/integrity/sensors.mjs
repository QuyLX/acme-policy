// One CheckResult per integrity sensor (Standard §7.13 items 15-22, 38).
//   blocking + hit → FAIL (except control-file-change: its resolution is an approval, enforced by policy.sod)
//   warn → PASS with findings shown to the approver; observe-level hits → INFO findings, never FAIL.
// integrity.oracle-lock also emits a KnowledgeConflict (schemas/knowledge-conflict.schema.json) for every approved
// acceptance criterion the change rewrites or deletes in journeys.yaml: code ≠ AC is a conflict for the product or
// journey owner, never resolved by the implementer (Standard §4.7 items 8-10, FE §9.10 item 3). The records are in
// extensions["x-knowledge-conflicts"]; the task binding turns each into a `knowledge.conflict` task event.
import { checkResult } from '../../lib/result.mjs';

const GATED_BY_APPROVAL = new Set(['integrity.control-file-change']);

/** KnowledgeConflict records for the acceptance-criterion edits of oracle-lock hits. */
export function acceptanceConflicts(hits, { workItemId, change } = {}) {
  return hits.flatMap((h) => (h.acEdits ?? []).map((e) => ({
    id: `KC-${workItemId ?? 'change'}-${e.id}`,
    ...(workItemId ? { workItemId } : {}),
    sources: [
      { ref: `${h.location}#${e.id} (approved acceptance criterion, base revision)`, says: e.was },
      { ref: change ?? 'the change under verification (head)', says: e.now ?? '(deleted)' },
    ],
    affectsCorrectnessOrRisk: true,
    authority: 'product or journey owner, through specification-review (Standard §4.7 item 10: code ≠ acceptance criteria)',
    proposal: 'Revert the AC edit; if the AC is wrong, open an oracle change request in a separate change (FE §9.10 item 3)',
  })));
}

/**
 * @param {object} [ctx] { workItemId?, change? } identify the conflict records oracle-lock emits
 */
export function sensorCheck(def, hits, ctx = {}) {
  const own = hits.filter((h) => h.checkId === def.checkId);
  const counted = own.filter((h) => h.level !== 'observe');
  const blocks = def.enforcement === 'blocking' && counted.length > 0 && !GATED_BY_APPROVAL.has(def.checkId);
  const conflicts = def.checkId === 'integrity.oracle-lock' ? acceptanceConflicts(own, ctx) : [];
  const severity = def.enforcement === 'observe' ? 'INFO' : def.enforcement === 'blocking' ? 'BLOCKER' : 'WARNING';
  return checkResult(def, {
    status: blocks ? 'FAIL' : 'PASS',
    reason: blocks ? `${counted.length} hit(s)` : undefined,
    findings: own.map((h) => ({
      source: 'integrity',
      ruleId: h.ruleId ?? def.checkId,
      severity: h.level === 'observe' || def.enforcement === 'observe' ? 'INFO' : def.enforcement === 'blocking' ? 'BLOCKER' : 'WARNING',
      location: h.location,
      message: h.message,
      state: 'open',
    })).concat(conflicts.map((c) => ({
      source: 'integrity',
      ruleId: 'KNW-CONFLICT',
      severity,
      location: c.sources[0].ref.split(' ')[0],
      message: `${c.sources.map((s) => `${s.ref}: "${s.says}"`).join(' vs ')} → escalate to ${c.authority}`,
      state: 'open',
    }))),
    extensions: def.checkId === 'integrity.control-file-change'
      ? { 'x-control-files-touched': [...new Set(own.map((h) => h.location))] }
      : conflicts.length ? { 'x-knowledge-conflicts': conflicts } : undefined,
  });
}

export function mutationScoreCheck(def) {
  return checkResult(def, {
    status: 'NOT_ASSESSED',
    reason: 'mutation testing on changed lines runs nightly at observe once Stryker is wired (FE §8.6, §15.3); not run in this pipeline',
  });
}
