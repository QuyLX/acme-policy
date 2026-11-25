// Task-runner hooks of tech-design 13 group A (verification core). lib/task-runner.mjs calls these from deriveTask;
// the logic lives here so the runner itself changes by a few lines only.
//   - oracle.change-requested / oracle.change-decided (FE §9.10 "Oracle protection" item 3; Standard §6.4.1 items
//     10-11, §7.13 item 29): a request returns the task to PLANNED; only a person who approved the ACs decides, never
//     the implementer, and never the requester at tier Medium or above (R2+). Violations: WF-ORACLE-CHANGE.
//   - profile.resolved (Standard §7.3 item 15; FE §8.3): an incomparable conflict that blocks moves the task to BLOCKED.
//   - registered flakes (Standard §7.14 item 5): see registeredFlakeFailure in lib/flaky.mjs.
export { registeredFlakeFailure } from './flaky.mjs';

/** Checkpoints whose approvals confirm acceptance criteria and scenarios (FE §9.10, §9.11; Standard §6.4.1 item 10). */
export const AC_CHECKPOINTS = ['scenario-approval', 'specification-review', 'requirement-review'];
const AT_LEAST_MEDIUM = new Set(['Medium', 'High', 'R2', 'R3']);

export function createVerificationCoreState() {
  return { oracleRequests: [] };
}

function acApprovers(checkpoints) {
  const out = new Set();
  for (const c of checkpoints) {
    if (!AC_CHECKPOINTS.includes(c.checkpoint) || c.outcome !== 'passed') continue;
    for (const a of c.approvals ?? []) if (a.by) out.add(a.by);
  }
  return out;
}

/**
 * Handles the verification-core task events.
 * @param {object} e TaskEvent
 * @param {{ store: object, move: Function, v: Function, facts: object, checkpoints: object[], implementers: Set<string>, requester?: string }} ctx
 */
export function onVerificationCoreEvent(e, ctx) {
  const { store, move, v, facts } = ctx;
  if (e.type === 'oracle.change-requested') {
    store.oracleRequests.push({ requestedBy: e.actor.id, at: e.at, files: e.data.files ?? [], decided: null });
    move('PLANNED', e, 'oracle change requested (FE §9.10 item 3)');
    if (e.data.changeRef && facts.pr && e.data.changeRef === facts.pr) {
      v('WF-ORACLE-CHANGE', `the oracle change is proposed in ${e.data.changeRef}, the same PR as the behavior change it checks (FE §9.10 item 3, §8.6)`);
    }
    return;
  }
  if (e.type === 'oracle.change-decided') {
    const open = store.oracleRequests.find((r) => !r.decided);
    if (!open) {
      v('WF-ORACLE-CHANGE', `oracle change decided by ${e.actor.id} without an open oracle change request`);
      return;
    }
    open.decided = { by: e.actor.id, decision: e.data.decision, at: e.at };
    const by = e.actor.id;
    const approvers = acApprovers(ctx.checkpoints);
    const tier = facts.tier ?? facts.riskTier;
    if (e.actor.kind !== 'human') v('WF-ORACLE-CHANGE', `oracle change decided by ${e.actor.kind} ${by}: only a person decides (FE §9.10 item 3)`);
    if (!approvers.has(by)) v('WF-ORACLE-CHANGE', `oracle change decided by ${by}, who did not approve the ACs (approvers: ${[...approvers].join(', ') || 'none recorded'}) (FE §9.10 item 3)`);
    if (ctx.implementers.has(by)) v('WF-ORACLE-CHANGE', `oracle change decided by the implementer ${by} (FE §9.10 item 3; Standard §6.4.1 item 11)`);
    if (by === ctx.requester && (tier === undefined || AT_LEAST_MEDIUM.has(tier))) v('WF-ORACLE-CHANGE', `oracle change decided by the requester ${by} at tier ${tier ?? 'unknown (worst case)'}: not allowed for R2+ (FE §9.10 item 3)`);
    return;
  }
  if (e.type === 'profile.resolved' && e.data.blocked) {
    const ids = (e.data.conflicts ?? []).filter((c) => c.resolvedBy === 'rejected').map((c) => `${c.checkId}.${c.parameter}`);
    move('BLOCKED', e, `profile resolution failed: incomparable conflict ${ids.join(', ')} (Standard §7.3 item 15)`);
  }
}

/** Violations that only count once the merge-approval gate is reached. */
export function verificationCoreGateViolations(store) {
  return store.oracleRequests.filter((r) => !r.decided).map((r) => ({ code: 'WF-ORACLE-CHANGE', message: `merge approval reached with the oracle change request of ${r.requestedBy} (${r.at}) undecided` }));
}
