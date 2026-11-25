// Basis tracking for deriveTask (Standard §6.5 "When a task's basis changes", §5.8 items 4-6, §4.7 items 8-9;
// Appendix K.4 TaskBasis and BasisChange; FE §7.3; CORE-KNW-08, CORE-WRK-10). Hooked into lib/task-runner.mjs.
// Events (schemas/task-event.schema.json):
//   basis.recorded    { basis: { id?, artifacts: ["ID@version" | "contract:x@v"], assumptions?, scopeRef? },
//                       snapshot?: { "ID@version": { status } } }  — statuses come from the Knowledge Index the
//                       binding passes in (policy.knowledgeIndex) or the snapshot it recorded, never from the agent
//   knowledge.changed { ref: "ID@version", status?, version?, supersededBy? }
//   basis.decided     { decision: continue|replan|reapprove|stop, reason?, touches?: { acceptanceCriteria?, scope? }, to? }
//   knowledge.conflict  KnowledgeConflict (Appendix K.5)
// Violations: WF-BASIS (a gate attempted with a basis change or a blocking conflict pending), WF-BASIS-AUTHORITY (the
// decision came from an agent or from someone without the authority of item 4), WF-BASIS-INELIGIBLE (a basis artifact
// that is not usable as a basis at the task's tier, §5.8).
import { digestOf } from './test-planner.mjs';
import { basisEligible } from './knowledge-index.mjs';
import { validate } from './schema.mjs';

const BEFORE_EXECUTING = new Set(['REQUESTED', 'TRIAGED', 'NEEDS_CLARIFICATION', 'CONTEXT_READY', 'PLANNED', 'AWAITING_PLAN_APPROVAL']);
const CHANGED_STATUS = new Set(['NEEDS_REVALIDATION', 'SUPERSEDED', 'DEPRECATED']);
const isHuman = (actor) => actor?.kind === 'human';

/** The tier used for basis eligibility: unknown facts count as the worst case (like evaluateWhen). */
function taskTier(facts) {
  if (['R2', 'R3'].includes(facts.subTier)) return facts.subTier;
  return facts.tier ?? facts.subTier ?? 'High';
}

/** Gate a pending basis change blocks (§6.5 item 2): plan approval, merge approval, merge queue, merge. */
function gateOf(e) {
  if (e.type === 'step.completed' && e.data.step === 'approve-merge') return 'merge-approval';
  if (e.type === 'checkpoint.recorded' && e.data.checkpoint === 'plan-review' && e.data.outcome === 'passed') return 'plan-approval';
  if (e.type === 'queue.entered') return 'merge-queue';
  if (e.type === 'task.merged') return 'merge';
  return null;
}

/**
 * @param {{ violation: (code: string, message: string) => void, move: Function, state: () => string, facts: object,
 *           checkpoints: object[], requester?: string, workItemId?: string, knowledgeIndex?: Record<string, { status: string, version: string }> }} o
 */
export function basisTracker({ violation, move, state, facts, checkpoints, requester, workItemId, knowledgeIndex }) {
  let basis = null;
  let pending = null; // BasisChange awaiting a decision
  let blockedFrom = null;
  const changes = [];
  const conflicts = [];
  const humanCheckpoints = []; // { checkpoint, at, humans: [] } — who approved what, for §6.5 item 4

  const statusOf = (ref, snapshot) => {
    const [id, version] = ref.split('@');
    const k = knowledgeIndex?.[id];
    if (k) return k.version === version ? k.status : 'NEEDS_REVALIDATION'; // cited version is no longer current
    return snapshot?.[ref]?.status;
  };
  const block = (e, gate, why) => {
    violation('WF-BASIS', `${gate} attempted while ${why}: the task MUST NOT pass the next gate until it is resolved (Standard §6.5 item 2, §4.7 item 9)`);
    if (state() !== 'BLOCKED') { blockedFrom = state(); move('BLOCKED', e, why); }
  };

  function onRecorded(e) {
    const b = e.data.basis ?? {};
    const artifacts = [...(b.artifacts ?? [])];
    basis = { id: b.id ?? `basis-${workItemId}-${changes.length + 1}`, workItemId, artifacts, assumptions: b.assumptions ?? [], scopeRef: b.scopeRef ?? 'unknown', capturedAt: e.at };
    basis.digest = digestOf({ artifacts, assumptions: basis.assumptions, scopeRef: basis.scopeRef });
    const tier = taskTier(facts);
    for (const ref of artifacts.filter((r) => !r.startsWith('contract:'))) {
      const status = statusOf(ref, e.data.snapshot);
      if (!status) continue; // not resolvable here; knowledge.basis checks it against the index
      const ok = basisEligible(status, tier);
      if (!ok.eligible) violation('WF-BASIS-INELIGIBLE', `${ref}: ${ok.reason}`);
    }
  }

  function onChanged(e) {
    if (!basis) return;
    const [id, oldVersion] = e.data.ref.split('@');
    const inBasis = basis.artifacts.find((a) => a.split('@')[0] === id);
    if (!inBasis) return;
    const versionChanged = e.data.version && e.data.version !== inBasis.split('@')[1];
    const statusChanged = CHANGED_STATUS.has(e.data.status);
    if (!versionChanged && !statusChanged) return;
    pending = {
      workItemId,
      trigger: { type: versionChanged ? 'artifact-version' : 'artifact-status', ref: `${id}@${oldVersion ?? inBasis.split('@')[1]}`, detail: versionChanged ? `version ${inBasis.split('@')[1]} → ${e.data.version}` : `status → ${e.data.status}${e.data.supersededBy ? ` (superseded by ${e.data.supersededBy})` : ''}` },
      previousBasis: basis.id,
      invalidatedApprovals: [],
      blockedGate: BEFORE_EXECUTING.has(state()) ? 'plan-approval' : 'merge-approval',
      at: e.at,
      newRef: e.data.version ? `${id}@${e.data.version}` : e.data.supersededBy ?? inBasis,
    };
    changes.push(pending);
  }

  function onDecided(e) {
    const d = e.data.decision;
    if (!pending) return;
    const affected = humanCheckpoints.filter((c) => c.at <= pending.at);
    const approvers = new Set(affected.flatMap((c) => c.humans));
    const touches = e.data.touches ?? {};
    const tier = taskTier(facts);
    if (!isHuman(e.actor)) {
      violation('WF-BASIS-AUTHORITY', `${e.actor.id} (${e.actor.kind}) recorded "${d}": an agent MAY propose and record the analysis but MUST NOT decide (Standard §6.5 item 4)`);
      return;
    }
    const requesterContinue = d === 'continue' && e.actor.id === requester && ['Low', 'R0', 'R1'].includes(tier) && !touches.acceptanceCriteria && !touches.scope;
    if (!approvers.has(e.actor.id) && !requesterContinue) {
      violation('WF-BASIS-AUTHORITY', `${e.actor.id} is not the approver of an affected checkpoint (${affected.map((c) => c.checkpoint).join(', ') || 'none recorded'})${e.actor.id === requester ? `; the requester may only decide "continue" at tier Low with no acceptance criterion or scope touched (tier ${tier})` : ''} (Standard §6.5 item 4)`);
      return;
    }
    Object.assign(pending, { decision: d, decidedBy: { id: e.actor.id }, decidedAt: e.at, reason: e.data.reason });
    if (d === 'continue') {
      basis.artifacts = basis.artifacts.map((a) => (a.split('@')[0] === pending.trigger.ref.split('@')[0] ? pending.newRef : a));
      basis.digest = digestOf({ artifacts: basis.artifacts, assumptions: basis.assumptions, scopeRef: basis.scopeRef });
      pending.newBasis = basis.id;
      if (state() === 'BLOCKED' && blockedFrom) move(blockedFrom, e, 'basis decision: continue');
    } else if (d === 'replan' || d === 'reapprove') {
      if (d === 'reapprove') {
        for (const c of checkpoints) if (c.recordedAt <= pending.at && !c.invalidated) { c.invalidated = true; pending.invalidatedApprovals.push(`${c.checkpoint}@${c.recordedAt}`); }
      }
      move('PLANNED', e, `basis decision: ${d}`);
    } else if (d === 'stop') move(e.data.to === 'BLOCKED' ? 'BLOCKED' : 'CANCELLED', e, 'basis decision: stop');
    pending = null;
    blockedFrom = null;
  }

  function onConflict(e) {
    const errors = validate('knowledge-conflict', e.data);
    if (errors.length) { violation('WF-BASIS', `knowledge.conflict is not a valid KnowledgeConflict: ${errors.join('; ')}`); return; }
    conflicts.push(e.data);
    if (e.data.affectsCorrectnessOrRisk && !e.data.resolution) move(BEFORE_EXECUTING.has(state()) ? 'NEEDS_CLARIFICATION' : 'BLOCKED', e, `knowledge conflict ${e.data.id} (Standard §4.7 item 9)`);
  }

  return {
    /** @returns {boolean} true when the event is consumed here (the core loop skips it) */
    handle(e) {
      switch (e.type) {
        case 'basis.recorded': onRecorded(e); return true;
        case 'knowledge.changed': onChanged(e); return true;
        case 'basis.decided': onDecided(e); return true;
        case 'knowledge.conflict': onConflict(e); return true;
      }
      if (e.type === 'checkpoint.recorded' && e.data.outcome === 'passed') {
        humanCheckpoints.push({ checkpoint: e.data.checkpoint, at: e.at, humans: [...(isHuman(e.actor) ? [e.actor.id] : []), ...(e.data.approvals ?? []).map((a) => a.by)] });
      }
      const gate = gateOf(e);
      if (!gate) return false;
      const open = conflicts.find((c) => c.affectsCorrectnessOrRisk && !c.resolution);
      if (pending) { if (!pending.attempted) { pending.blockedGate = gate; pending.attempted = true; } block(e, gate, `basis change ${pending.trigger.ref} (${pending.trigger.detail}) has no decision`); return true; }
      if (open) { block(e, gate, `knowledge conflict ${open.id} is unresolved`); return true; }
      return false;
    },
    result: () => ({ basis, basisChanges: changes.map(({ at, newRef, attempted, ...c }) => c), knowledgeConflicts: conflicts }),
  };
}
