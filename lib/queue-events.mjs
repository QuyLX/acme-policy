// Merge queue events in the task runner (Standard §6.4 items 9-13, 19; §6.5 IN_MERGE_QUEUE ──fail─→ REPAIRING).
// Kept out of lib/task-runner.mjs: deriveTask calls `handle` for queue.* events and `finish` before it settles the
// final state. Simulated: GitHub Free user-owned repos have no merge queue, so `queue.result` events come from
// lib/merge-queue.mjs, which reruns the failing check on main (a) without and (b) with the change.
import { readYaml, policyPath } from './io.mjs';

export const ATTRIBUTIONS = ['passed', 'attributed-to-change', 'main-broken', 'flake-candidate', 'error'];

/** Policy ceiling of a loop budget counter from the vocabulary (`loopBudget.counters`). */
export function policyCeiling(counter) {
  return readYaml(policyPath('vocabulary', 'aisf-vocabulary.yaml')).loopBudget?.counters?.[counter]?.policyCeiling;
}

const minDefined = (...xs) => {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? Math.min(...v) : undefined;
};

/**
 * @param {{ spec: object, req?: object, policy?: { mergeQueueCeiling?: number } }} args
 */
export function queueTracker({ spec, req, policy = {} }) {
  const ceiling = policy.mergeQueueCeiling ?? policyCeiling('mergeQueueAttempts');
  // Standard §6.4 item 10: effective = min(policy, playbook, task); a playbook or task can only lower it.
  const limit = minDefined(ceiling, spec.budgets?.mergeQueueAttempts, req?.data?.budgets?.mergeQueueAttempts);
  let used = 0;
  let paused = false;
  return {
    /** @param {object} e TaskEvent  @param {{ move: Function, recoveries: object[], v: Function }} rt */
    handle(e, { move, recoveries, v }) {
      if (e.type === 'queue.entered') {
        move('IN_MERGE_QUEUE', e, 'entered the merge queue');
        return;
      }
      const { attribution, checkId, notify } = e.data;
      if (!ATTRIBUTIONS.includes(attribution)) {
        v('WF-QUEUE', `queue.result with unknown attribution "${attribution}" (expected ${ATTRIBUTIONS.join(', ')})`);
        return;
      }
      if (attribution === 'attributed-to-change') {
        used++; // §6.4 item 11: failures attributable to the change, including semantic conflicts with main
        recoveries.push({ cause: 'merge-queue', action: 'repair', detail: `${checkId ?? 'check'} fails on main with the change and passes without it` });
        move('REPAIRING', e, 'merge queue failure attributed to the change (§6.4 item 19)');
      } else if (attribution === 'main-broken') {
        paused = true; // no budget: not caused by this change
        recoveries.push({ cause: 'main-broken', action: 'pause-queue', detail: `notify ${(notify ?? []).join(', ') || 'the owner of the breaking change'}` });
      } else if (attribution === 'flake-candidate') {
        recoveries.push({ cause: 'flake-candidate', action: 'hand-to-check-owner', detail: `${checkId ?? 'check'} not reproducible on rerun (§7.14)` });
      } else if (attribution === 'error') {
        recoveries.push({ cause: 'ERROR', action: 'retry', detail: 'rerun errored: never consumes budget (§6.4 item 13)' });
      } else if (attribution === 'passed') {
        paused = false;
      }
    },
    finish(escalate) {
      // §6.4 item 12: exhausting the counter moves the task to ESCALATED (no queue attempt is left).
      if (limit !== undefined && used >= limit) escalate('budget-exhausted', `${used} merge queue attempt(s) attributed to the change: mergeQueueAttempts budget ${limit} exhausted`);
    },
    summary: () => ({ mergeQueueAttempts: { limit, used }, queuePaused: paused }),
  };
}
