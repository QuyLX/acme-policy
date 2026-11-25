// Group "governance" of tech-design 13 (showcase completion): SC-05 egress, SC-07, SC-12, SC-13, SC-15.
// Each group owns this file only; lib/modules/index.mjs merges the four groups and rejects duplicate keys.
//
// KINDS  — showcase run kinds: (run) => observed, where observed is
//          { checks: CheckResult[], exitCode?, requiredUnmet?, taskState?, decision?, dispositions?, notAssessed? }.
//          `notAssessed: '<reason>'` reports the case NOT_ASSESSED (never PASS) when the harness cannot observe the layer
//          (Standard §8.7 rule 3).
// CHECKS — registry checks without an adapter or command: (def, ctx) => CheckResult, where ctx is
//          { repo?, base?, changed?, diff?, readFile?, config?, executor?, input? } (`input` is a file path).
//
// Shadow checks of this group run at their registry enforcement as module checks; showcase kinds evaluate them at their
// `targetEnforcement` (lib/governance-result.mjs `targetDef`) to demonstrate the gate they will become.
import { policyPath } from '../io.mjs';
import { checkDef } from '../registry.mjs';
import { validate } from '../schema.mjs';
import { runExitCode } from '../result.mjs';
import { readInput, targetDef } from '../governance-result.mjs';
import { simulateQueue, queueEvents } from '../merge-queue.mjs';
import { trippedFor } from '../breakers.mjs';
import { sodCheck } from '../../checks/policy-sod/evaluate.mjs';
import { readEvents, workflowConformanceCheck } from '../../checks/workflow/conformance.mjs';
import { EXECUTOR, sandboxEgressCheck, sandboxEgressModuleCheck } from '../../checks/sec/sandbox-egress.mjs';
import { mergeQueueModuleCheck, mergeQueueResult } from '../../checks/workflow/merge-queue.mjs';
import { crossTeamContractCheck, crossTeamContractModuleCheck } from '../../checks/contract/cross-team.mjs';
import { aiModeCheck, aiModeModuleCheck, reviewerChangeCheck, reviewerChangeModuleCheck } from '../../checks/review/quality.mjs';
import { trustEvaluationCheck, trustEvaluationModuleCheck } from '../../checks/trust/evaluation.mjs';
import {
  autonomyCheck, autonomyModuleCheck, breakerStateFor, changeShepherdCheck, changeShepherdModuleCheck,
  incidentReviewCheck, incidentReviewModuleCheck,
} from '../../checks/ops/governance-ops.mjs';

const input = (run) => readInput(policyPath(run.input));
const viaCheck = (fn, checkId) => (run) => {
  const { result, decision } = fn(targetDef(checkId), input(run));
  return { checks: [result], decision };
};

/** SC-05: the compromised step under the host's sandbox backend, plus a mutation proof (same backend, one restriction off). */
function sandboxEgress(run) {
  const def = targetDef('sec.sandbox-egress');
  const r = sandboxEgressCheck(def, input(run));
  if (r.status === 'NOT_ASSESSED') return { checks: [r], notAssessed: r.reason };
  const observed = { checks: [r], decision: { executor: EXECUTOR, sandboxed: { status: r.status, ...r.extensions['x-sandbox'] } } };
  if (run.mutation) {
    const m = sandboxEgressCheck(def, readInput(policyPath(run.mutation)));
    observed.checks.push(m);
    const x = m.extensions['x-sandbox'];
    observed.decision.mutation = { status: m.status, mutation: x.mutation, sameBackend: x.backend === r.extensions['x-sandbox'].backend, requestsReceived: x.requestsReceived, canaryAbsent: x.canaryAbsent };
  }
  return observed;
}

/** SC-07: one or more simulated queue attempts (real reruns), then the task state derived from the event log. */
function mergeQueue(run) {
  const spec = input(run);
  const events = readEvents(policyPath(run.events));
  const workItemId = events[0].workItemId;
  const sims = [];
  for (let i = 0; i < (run.attempts ?? 1); i++) {
    const sim = simulateQueue({ ...spec, proveIndependence: i === 0 && run.proveIndependence === true });
    sims.push(sim);
    events.push(...queueEvents(workItemId, sim, new Date(Date.parse('2026-11-24T10:30:00Z') + i * 3600000).toISOString()));
    if (i === 0 && run.repaired) events.push(...readEvents(policyPath(run.repaired)));
  }
  const conformance = workflowConformanceCheck(checkDef('workflow.conformance'), events);
  const task = conformance.extensions?.['x-task'] ?? {};
  const last = sims.at(-1);
  return {
    checks: [mergeQueueResult(targetDef('workflow.merge-queue'), spec, last), conformance],
    taskState: task.state,
    decision: { attribution: last.attribution, attempts: sims.map((s) => s.attribution), runs: last.runs, notify: last.notify ?? [], queuePaused: task.queuePaused, budget: task.mergeQueueAttempts },
  };
}

/** SC-12: consumer-side result of a cross-team-contract check and the run exit code at the recorded time. */
function crossTeamContract(run) {
  const def = checkDef(run.checkId);
  const bundle = input(run);
  const r = crossTeamContractCheck(def, bundle);
  const errors = validate('check-result', r);
  if (errors.length) throw new Error(`CheckResult invalid: ${errors.join('; ')}`);
  return {
    checks: [r],
    exitCode: runExitCode([r], { now: Date.parse(bundle.now) }),
    dispositions: r.disposition ? { [def.checkId]: r.disposition.type } : {},
    decision: { disposition: r.disposition ?? null, fixOwner: r.extensions['x-cross-team'].fixOwner },
  };
}

/** SC-15: policy.sod with breakerTripped derived from the breaker state after the recorded signals. */
function breakerSod(run) {
  const req = input(run);
  const { state } = breakerStateFor(req);
  const sod = readInput(policyPath(req.sod));
  const tripped = trippedFor(state, { surfaces: sod.areas.map((a) => a.id), taskClass: req.taskClass }).filter((b) => b.effects?.includes('signoff-not-counted'));
  const r = sodCheck(checkDef('policy.sod'), { ...sod, breakerTripped: tripped.length > 0 });
  const slots = r.extensions?.['x-policy-decision']?.approvalSlots ?? [];
  return {
    checks: [r],
    decision: { breakerTripped: tripped.length > 0, tripped: tripped.map((b) => b.id), signoffCounts: slots.find((s) => s.kind === 'requester-signoff')?.countsTowardLevel ?? null, unmet: r.extensions?.['x-policy-decision']?.unmet ?? [] },
  };
}

export const KINDS = {
  'sandbox-egress': sandboxEgress,
  'merge-queue': mergeQueue,
  'cross-team-contract': crossTeamContract,
  // The surface descriptor is a separate, trusted input (`run.repo`), never part of the request.
  'review-mode': (run) => {
    const { result, decision } = aiModeCheck(targetDef('review.ai-mode'), input(run), { repo: run.repo && policyPath(run.repo) });
    return { checks: [result], decision };
  },
  'reviewer-change': viaCheck(reviewerChangeCheck, 'review.reviewer-change'),
  'trust-evaluation': viaCheck(trustEvaluationCheck, 'trust.evaluation'),
  autonomy: viaCheck(autonomyCheck, 'policy.autonomy'),
  'breaker-sod': breakerSod,
  'change-shepherd': viaCheck(changeShepherdCheck, 'ops.change-shepherd'),
  'incident-review': viaCheck(incidentReviewCheck, 'ops.incident-review'),
};

export const CHECKS = {
  'sec.sandbox-egress': sandboxEgressModuleCheck,
  'workflow.merge-queue': mergeQueueModuleCheck,
  'admin.step-up-auth': crossTeamContractModuleCheck,
  'review.ai-mode': aiModeModuleCheck,
  'review.reviewer-change': reviewerChangeModuleCheck,
  'trust.evaluation': trustEvaluationModuleCheck,
  'policy.autonomy': autonomyModuleCheck,
  'ops.change-shepherd': changeShepherdModuleCheck,
  'ops.incident-review': incidentReviewModuleCheck,
};
