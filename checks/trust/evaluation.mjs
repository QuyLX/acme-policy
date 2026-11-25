// trust.evaluation — a trust level is supported by recomputed evidence (CORE-GOV-03; Standard §9.4, §9.10, K.3;
// FE §10.3). The evaluator recomputes the level and the 95% upper bound from recorded task outcomes and eval results;
// a claimed TrustEvaluation (for the trust registry) is checked against it and never trusted for its numbers.
// RECORDED data only: nothing in this repo raises a level by itself; registry/trust.yaml changes stay human decisions.
// The class's current level (whether a result is a raise that needs both owners, §9.10) is the gate's own policy state:
// it comes from registry/trust.yaml, never from the request; a request `currentLevel` is ignored.
import { resolve } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { evaluateTrust } from '../../lib/trust.mjs';
import { validate } from '../../lib/schema.mjs';
import { finding, readInput, statusFor, violationSeverity } from '../../lib/governance-result.mjs';
import { policyPath, readYaml } from '../../lib/io.mjs';

const RANK = { T0: 0, T1: 1, T2: 2 };

/** Builds the evaluator input from a request (paths relative to the policy root) and the trust registry. */
export function trustRequest(req) {
  const registry = readYaml(policyPath('registry', 'trust.yaml'));
  const cls = registry.classes.find((c) => c.taskClass === req.taskClass);
  if (!cls) throw new Error(`task class ${req.taskClass} is not in registry/trust.yaml`);
  const taskClass = readYaml(policyPath('registry', 'task-classes.yaml')).taskClasses.find((t) => t.id === req.taskClass);
  const [workflow, major] = taskClass.playbook.split('@');
  const evals = readInput(policyPath(req.evals));
  return {
    input: {
      taskClass: { id: req.taskClass, workflow, workflowMajor: Number(major), scope: (taskClass.scope.repositories ?? []).join(','), riskCeiling: taskClass.ceiling, strata: cls.strata },
      agentConfig: cls.agentConfig,
      currentLevel: cls.level,
      window: req.window,
      tasks: readInput(policyPath(req.tasks)).tasks,
      criticalScenarios: evals.criticalScenarios,
      holdout: evals.holdout,
      regression: evals.regression,
      incidents: req.incidents ?? [],
      versionChange: req.versionChange,
      decidedBy: req.decidedBy,
    },
    thresholds: registry.thresholds,
    owners: { areaOwner: cls.areaOwner, factoryOwner: registry.owners.factoryOwner },
  };
}

export function trustEvaluationCheck(def, req) {
  const started = Date.now();
  const { input, thresholds, owners } = trustRequest(req);
  const out = evaluateTrust(input, thresholds, owners);
  const schemaErrors = validate('trust-evaluation', out.evaluation);
  if (schemaErrors.length) return { result: checkResult(def, { status: 'ERROR', reason: `TrustEvaluation invalid: ${schemaErrors.join('; ')}` }), decision: out };
  const problems = [];
  if (!out.raiseApproved) problems.push(out.reasons.find((r) => r.ruleId === 'trust.raise-needs-owners'));
  if (req.claimed) {
    if (RANK[req.claimed.resultLevel] > RANK[out.evaluation.resultLevel]) problems.push({ ruleId: 'trust.level-unsupported', message: `claimed ${req.claimed.resultLevel}, evidence supports ${out.evaluation.resultLevel}` });
    if (req.claimed.failureRateUpper95 !== undefined && Math.abs(req.claimed.failureRateUpper95 - out.evaluation.failureRateUpper95) > 1e-6) {
      problems.push({ ruleId: 'trust.bound-mismatch', message: `claimed upper bound ${req.claimed.failureRateUpper95} ≠ computed ${out.evaluation.failureRateUpper95.toFixed(4)} (§9.4 item 11.5)` });
    }
  }
  const violated = problems.length > 0;
  const level = out.evaluation.resultLevel;
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? problems.map((p) => p.message).join('; ') : undefined,
      findings: problems.map((p) => finding(p.ruleId, p.message, violationSeverity(def), req.taskClass)),
      durationMs: Date.now() - started,
      extensions: { 'x-trust-evaluation': out.evaluation, 'x-trust-counts': out.counts, 'x-trust-reasons': out.reasons },
    }),
    // ruleIds: why the level is what it is (informational; never findings, which mean violations for a shadow check).
    decision: { ...out.evaluation, computedLevel: out.computedLevel, counts: out.counts, ruleIds: [...new Set(out.reasons.map((r) => r.ruleId))], summary: `${req.taskClass}: ${level}` },
  };
}

export const trustEvaluationModuleCheck = (def, ctx) => trustEvaluationCheck(def, readInput(resolve(ctx.input))).result;
