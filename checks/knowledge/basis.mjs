// knowledge.basis — every artifact a task records in `basis` is usable as a basis (Standard §5.8 items 4-6, §6.4 item 8;
// FE §7.3, §7.8; CORE-KNW-05): known to the index, at the cited version, readable by the task identity, applicable to
// the pinned versions, ACTIVE (NEEDS_REVALIDATION only at Low/R0-R1), and not in conflict with another ACTIVE basis
// artifact (Standard §4.7: a conflict is escalated, never resolved by picking one).
import { checkResult } from '../../lib/result.mjs';
import { appliesToPins, basisEligible, canRead, detectConflicts } from '../../lib/knowledge-index.mjs';
import { validate } from '../../lib/schema.mjs';
import { loadKnowledgeInput } from './index-input.mjs';

export function basisProblems(index, pins, requester, { artifacts = [] }, tier, workItemId) {
  const byId = new Map(index.extensions['x-fe'].entries.map((e) => [e.id, e]));
  const problems = [];
  const used = [];
  for (const ref of artifacts) {
    const [id, version] = String(ref).split('@');
    if (id.startsWith('contract:')) {
      const c = id.slice('contract:'.length);
      if (pins.contracts?.[c] !== version) problems.push({ ruleId: 'KNW-BASIS-VERSION', location: ref, message: `the repo declares ${c}@${pins.contracts?.[c] ?? 'nothing'}, not ${version}` });
      continue;
    }
    const e = byId.get(id);
    if (!e) { problems.push({ ruleId: 'KNW-BASIS-UNKNOWN', location: ref, message: `${id} is not in the Knowledge Index` }); continue; }
    if (!canRead(e, requester)) { problems.push({ ruleId: 'KNW-BASIS-ACCESS', location: ref, message: `${id} is ${e.visibility}; the task identity cannot read it` }); continue; }
    if (version !== e.version) problems.push({ ruleId: 'KNW-BASIS-STALE', location: ref, message: `${id} is at version ${e.version}, the basis cites ${version}` });
    if (!appliesToPins(e.appliesTo, pins)) problems.push({ ruleId: 'KNW-BASIS-VERSION', location: ref, message: `${id} applies to ${JSON.stringify(e.appliesTo)}, not to the pinned versions` });
    const ok = basisEligible(e.status, tier);
    if (!ok.eligible) problems.push({ ruleId: 'KNW-BASIS-NOT-ACTIVE', location: ref, message: `${id}@${e.version}: ${ok.reason}` });
    used.push(e);
  }
  const conflicts = detectConflicts(used, { workItemId });
  for (const c of conflicts) {
    const errors = validate('knowledge-conflict', c);
    problems.push({ ruleId: 'KNW-CONFLICT', location: c.id, message: `${c.sources.map((s) => s.ref.split(' ')[0]).join(' vs ')}: escalate to ${c.authority}${errors.length ? ` (record invalid: ${errors.join('; ')})` : ''}` });
  }
  return { problems, conflicts };
}

export function basisCheck(def, ctx) {
  const started = Date.now();
  if (!ctx.input) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no task basis (--input)' });
  let loaded;
  try {
    loaded = loadKnowledgeInput(ctx.input);
  } catch (err) {
    return checkResult(def, { status: 'ERROR', reason: `basis input: ${err.message}` });
  }
  const { spec, index, pins, requester } = loaded;
  const { problems, conflicts } = basisProblems(index, pins, requester, spec.basis ?? {}, spec.tier, spec.workItemId);
  return checkResult(def, {
    status: problems.length ? 'FAIL' : 'PASS',
    reason: problems.length ? [...new Set(problems.map((p) => p.ruleId))].join(', ') : undefined,
    findings: problems.map((p) => ({ source: 'check', severity: 'BLOCKER', state: 'open', ...p })),
    durationMs: Date.now() - started,
    extensions: { 'x-conflicts': conflicts },
  });
}
