// workflow.merge-queue — merge queue accountability (Standard §6.4 item 19; FE §11.6; CORE-WRK-06).
// SIMULATED: GitHub Free user-owned repositories have no merge queue. The check reruns the failing check with two real
// `acme-policy run` pipelines on a fixture repo, (a) main without the change and (b) main with it, and applies the table:
//   a FAIL            → queue.main-broken          NOT_ASSESSED, pause the queue, notify, no budget
//   a PASS, b FAIL    → queue.attributed-to-change violation, consumes mergeQueueAttempts (semantic conflicts included)
//   a PASS, b PASS    → queue.flake-candidate      NOT_ASSESSED, handled per §7.14, no budget
//   ERROR             → ERROR, never consumes budget (§6.4 item 13)
import { resolve } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { simulateQueue } from '../../lib/merge-queue.mjs';
import { finding, readInput, statusFor, violationSeverity } from '../../lib/governance-result.mjs';

export function mergeQueueResult(def, spec, sim, durationMs = 0) {
  const ext = { 'x-merge-queue': { simulated: 'no merge queue (GitHub Free, user-owned repos)', ...sim } };
  const at = spec.change;
  const base = { command: 'acme-policy workflow.merge-queue (rerun on main without / with the change)', durationMs, extensions: ext };
  const runs = JSON.stringify(sim.runs);
  switch (sim.attribution) {
    case 'passed':
      return checkResult(def, { ...base, status: 'PASS' });
    case 'attributed-to-change':
      return checkResult(def, {
        ...base,
        status: statusFor(def, true),
        reason: `${sim.failing.join(', ')} passes on main without the change and fails with it: attributed to the change, consumes mergeQueueAttempts`,
        findings: [finding('queue.attributed-to-change', `Failure attributed to the change (semantic conflicts included): ${runs}`, violationSeverity(def), at)],
      });
    case 'main-broken':
      return checkResult(def, {
        ...base,
        status: 'NOT_ASSESSED',
        reason: `main is broken without the change (${sim.failing.join(', ')}): queue paused, ${sim.notify.length ? `notified ${sim.notify.join(', ')}` : 'owner of the breaking change notified'}, no budget consumed`,
        findings: [finding('queue.main-broken', `Not caused by this change: ${runs}`, 'INFO', at)],
      });
    case 'flake-candidate':
      return checkResult(def, {
        ...base,
        status: 'NOT_ASSESSED',
        reason: `${sim.failing.join(', ')} failed in the queue but passes on both reruns: flake candidate (§7.14), no budget consumed`,
        findings: [finding('queue.flake-candidate', `Failure not reproducible: ${runs}`, 'WARNING', at)],
      });
    default:
      return checkResult(def, { ...base, status: 'ERROR', reason: `rerun errored (${runs}): rerun, then escalate to the check owner; no budget consumed`, findings: [finding('queue.rerun-error', runs, 'INFO', at)] });
  }
}

/** Module check: `ctx.input` is a YAML queue spec { repo, main: [{ diff, owner }], change, checks, recordedQueueFailure? }. */
export function mergeQueueModuleCheck(def, ctx) {
  if (!ctx.input) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no queue input (--input <file>): there is no merge queue to observe' });
  const started = Date.now();
  const spec = readInput(resolve(ctx.input));
  return mergeQueueResult(def, spec, simulateQueue(spec), Date.now() - started);
}
