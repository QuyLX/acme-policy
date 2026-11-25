// policy.autonomy, ops.change-shepherd, ops.incident-review (SC-15; CORE-GOV-05/07/08, CORE-OPS-02/04/06).
// DECISION ONLY: A0 MUST NOT be enabled in pilot mode (Standard §20.8 item 4.7); policy.autonomy reports the level that
// would apply and refuses any proposal lighter than the policy allows. RECORDED signals, actions and incident reviews.
// Pilot mode is the gate's own policy state: it comes from the Check Registry (`registry/checks.yaml` top-level `mode`),
// never from the request; a request that declares `pilotMode` cannot switch it off.
import { resolve } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { validate } from '../../lib/schema.mjs';
import { decideAutonomy, LEVELS } from '../../lib/autonomy.mjs';
import { applySignals } from '../../lib/breakers.mjs';
import { evaluateShepherdAction } from '../../lib/change-shepherd.mjs';
import { appendEvalCase, reviewIncident } from '../../lib/incident.mjs';
import { finding, readInput, statusFor, violationSeverity } from '../../lib/governance-result.mjs';
import { policyPath, readYaml } from '../../lib/io.mjs';
import { trustEvaluationCheck } from '../trust/evaluation.mjs';
import { checkDef } from '../../lib/registry.mjs';

const read = (p) => readInput(policyPath(p));

/** Breaker state after the recorded signals (tightening is automatic, §9.9 item 3). */
export function breakerStateFor(req) {
  const state = read(req.breakers);
  const errors = validate('breaker-state', state);
  if (errors.length) throw new Error(`${req.breakers}: ${errors.join('; ')}`);
  const policy = readYaml(policyPath('registry', 'trust.yaml')).breakerPolicy;
  const signals = req.signals ? read(req.signals).signals : [];
  const out = applySignals(state, signals, policy, { changesInWindow: req.changesInWindow ?? {}, now: req.now });
  const after = validate('breaker-state', out.state);
  if (after.length) throw new Error(`breaker state after signals invalid: ${after.join('; ')}`);
  return out;
}

/** Pilot mode in effect (Standard §20.8): the Check Registry's `mode`. Unknown or missing → pilot (the stricter mode). */
export function registryPilotMode() {
  const mode = readYaml(policyPath('registry', 'checks.yaml')).mode;
  return mode !== 'default';
}

/**
 * @param {{ facts: string|object, trustFrom?: string, breakers: string, signals?: string, now: string,
 *           changesInWindow?: object, proposed?: string }} req `pilotMode` in a request is ignored (reported as claimed)
 */
export function autonomyCheck(def, req) {
  const started = Date.now();
  const facts = typeof req.facts === 'string' ? read(req.facts) : { ...req.facts };
  let trust = null;
  if (req.trustFrom) {
    // Trust is recomputed from recorded evidence (SC-13 machinery), never taken from the request.
    trust = trustEvaluationCheck(checkDef('trust.evaluation'), read(req.trustFrom)).decision;
    facts.trustLevel = trust.resultLevel;
  }
  const { state, tripped } = breakerStateFor(req);
  const pilotMode = registryPilotMode();
  const d = decideAutonomy(facts, state, { pilotMode });
  const problems = [];
  if (req.proposed) {
    if (LEVELS.indexOf(req.proposed) < LEVELS.indexOf(d.level)) problems.push({ ruleId: 'autonomy.too-light', message: `proposed ${req.proposed} is lighter than the policy allows (${d.level}): ${d.ruleIds.join(', ')}` });
    if (req.proposed === 'A0' && pilotMode) problems.push({ ruleId: 'autonomy.a0-pilot-forbidden', message: 'A0 MUST NOT be enabled in pilot mode (Standard §20.8 item 4.7)' });
  }
  const violated = problems.length > 0;
  const decision = { ...d, trustLevel: facts.trustLevel, newlyTripped: tripped, pilotModeSource: 'registry/checks.yaml mode', claimedPilotMode: req.pilotMode ?? null };
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? problems.map((p) => p.message).join('; ') : undefined,
      findings: problems.map((p) => finding(p.ruleId, p.message, violationSeverity(def), facts.taskClass)),
      durationMs: Date.now() - started,
      extensions: { 'x-autonomy': decision },
    }),
    decision,
  };
}

/** @param {{ tier: string, flags: string, actions: object[] }} req */
export function changeShepherdCheck(def, req) {
  const started = Date.now();
  const flags = read(req.flags).flags;
  const results = req.actions.map((a) => evaluateShepherdAction(a, { tier: req.tier, flags }));
  const problems = results.flatMap((r) => r.problems);
  const violated = problems.length > 0;
  const decision = { allowed: results.every((r) => r.allowed), taskState: results.find((r) => r.taskState)?.taskState ?? null, audit: results.map((r) => r.audit) };
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? problems.map((p) => p.message).join('; ') : undefined,
      findings: problems.map((p) => finding(p.ruleId, p.message, violationSeverity(def))),
      durationMs: Date.now() - started,
      extensions: { 'x-change-shepherd': decision },
    }),
    decision,
  };
}

/** @param {{ review: string, evalSet: string, breakers?: string, now?: string }} req */
export function incidentReviewCheck(def, req) {
  const started = Date.now();
  const record = read(req.review);
  const out = reviewIncident(record);
  const evalSet = read(req.evalSet);
  const after = out.evalCase ? appendEvalCase(evalSet, out.evalCase) : evalSet;
  let breakers = null;
  if (req.breakers) {
    const policy = readYaml(policyPath('registry', 'trust.yaml')).breakerPolicy;
    breakers = applySignals(read(req.breakers), out.signals, policy, { now: req.now ?? record.at });
  }
  const violated = out.problems.length > 0;
  const decision = {
    evalCase: out.evalCase ?? null,
    evalSetIncidents: { before: evalSet.incidents.length, after: after.incidents.length },
    signals: out.signals,
    trippedBreakers: breakers?.tripped ?? [],
    trustEffect: breakers?.state.breakers.find((b) => b.state === 'tripped' && b.signal === 'escaped-defect')?.effects ?? [],
  };
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? out.problems.map((p) => p.message).join('; ') : undefined,
      findings: out.problems.map((p) => finding(p.ruleId, p.message, violationSeverity(def), record.id)),
      durationMs: Date.now() - started,
      extensions: { 'x-incident-review': decision },
    }),
    decision,
  };
}

export const autonomyModuleCheck = (def, ctx) => autonomyCheck(def, readInput(resolve(ctx.input))).result;
export const changeShepherdModuleCheck = (def, ctx) => changeShepherdCheck(def, readInput(resolve(ctx.input))).result;
export const incidentReviewModuleCheck = (def, ctx) => incidentReviewCheck(def, readInput(resolve(ctx.input))).result;
