// Group "product" of tech-design 13 (showcase completion): SC-11 permission-only-in-ui, csv-formula-injection, hold-out
// recall; SC-10.
// Each group owns this file only; lib/modules/index.mjs merges the four groups and rejects duplicate keys.
//
// KINDS  — showcase run kinds: (run) => observed, where observed is
//          { checks: CheckResult[], exitCode?, requiredUnmet?, taskState?, decision?, dispositions?, notAssessed? }.
//          `notAssessed: '<reason>'` reports the case NOT_ASSESSED (never PASS) when the harness cannot observe the layer
//          (Standard §8.7 rule 3).
// CHECKS — registry checks without an adapter or command: (def, ctx) => CheckResult, where ctx is
//          { repo?, base?, changed?, diff?, readFile?, config?, executor?, input? } (`input` is a file path).
// Load this file through lib/modules/index.mjs (as lib/showcase.mjs, lib/fixture-run.mjs and bin/ do): it imports
// lib/fixture-run.mjs, which imports index.mjs, so importing product.mjs first would read KINDS before it is initialized.
import { readdirSync } from 'node:fs';
import { readYaml, readJson, readText, policyPath } from '../io.mjs';
import { checkDef } from '../registry.mjs';
import { runFixture, runPipeline } from '../fixture-run.mjs';
import { permissionMatrixCheck, negativeCheck } from '../../checks/authz/matrix.mjs';
import { csvInjectionCheck } from '../../checks/export/csv-injection.mjs';
import { evaluateWaiver, applyWaiver } from '../../checks/policy-sod/waiver.mjs';
import { activatedDef, applyBaseline, fpSlo, gateExitCode, promote, snapshotBaseline } from '../check-lifecycle.mjs';

const read = (path) => (path.endsWith('.json') ? readJson(policyPath(path)) : readYaml(policyPath(path)));

/** One check on a fixture repo state, through the real `acme-policy run` pipeline (CI executor). */
function runOn(checkId, state) {
  return runPipeline({ repo: state.repo, change: state.change, checks: [checkId], executor: 'ci' }).checks[0];
}

/** A result re-stamped with the enforcement of the activated registry entry (SC-10 simulates the activation). */
const asActive = (result, def) => ({ ...result, enforcement: def.enforcement, requirement: def.requirement });

const record = (checkId, status, findings = [], reason) => ({ checkId, status, findings, ...(reason ? { reason } : {}) });

/**
 * `check-lifecycle` — SC-10 (CORE-VER-10, CORE-GOV-09). Ops:
 *   promote         { checkId, to, now, shadowSince?, fixtures? (proposed registry fixtures), target?: { repo, change } }
 *   snapshot        { checkId, state: { repo, change }, executor, event, ref, now }
 *   apply-baseline  { checkId, activation: { repo, change }, state: { repo, change }, baseline? (recorded file), onTarget? }
 *   fp-slo          { checkId, ledger }
 *   waiver          { checkId, state: { repo, change }, input (waiver + requester + approvers + now), ledger? }
 */
function checkLifecycle(run) {
  const def = checkDef(run.checkId);
  if (run.op === 'promote') {
    const proposed = run.fixtures ? { ...def, fixtures: run.fixtures } : def;
    // Mutation proof: run every violating fixture of the proposed entry now; "fired" means the check reported FAIL.
    const proof = (proposed.fixtures.violating ?? []).map((fx) => ({ fixture: fx.change ?? fx.repo ?? fx.diff ?? fx.input, fired: runFixture(def.checkId, fx).status === 'FAIL' }));
    const violations = run.target ? runOn(def.checkId, run.target).findings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'WARNING').length : 0;
    const d = promote(proposed, { to: run.to, proof, shadowSince: run.shadowSince, now: run.now, violations });
    return {
      checks: [record('lifecycle.promote', d.allowed ? 'PASS' : 'FAIL', d.findings)],
      decision: { from: d.from, to: d.to, allowed: d.allowed, requiresBaselineSnapshot: d.requiresBaselineSnapshot, violations, proof: proof.map((p) => p.fired), lifecycle: d.allowed ? d.def.lifecycle : d.from, enforcement: d.allowed ? d.def.enforcement : def.enforcement, requirement: d.allowed ? d.def.requirement : def.requirement },
    };
  }
  if (run.op === 'snapshot') {
    const result = runOn(def.checkId, run.state);
    const { baseline, problems } = snapshotBaseline(result, { executor: run.executor, event: run.event, ref: run.ref, takenAt: run.now });
    return { checks: [record('baseline.snapshot', baseline ? 'PASS' : 'FAIL', problems), result], decision: baseline ?? {} };
  }
  if (run.op === 'apply-baseline') {
    const active = activatedDef(def);
    const baseline = run.baseline
      ? read(run.baseline)
      : snapshotBaseline(runOn(def.checkId, run.activation), { executor: 'ci', event: 'push', ref: 'refs/heads/main', takenAt: run.now }).baseline;
    if (!baseline) throw new Error('the activation snapshot produced no baseline');
    const applied = applyBaseline(active, asActive(runOn(def.checkId, run.state), active), baseline, { onTarget: Boolean(run.onTarget) });
    return { checks: [applied], exitCode: gateExitCode([applied]), decision: applied.extensions?.['x-baseline'] ?? {} };
  }
  if (run.op === 'fp-slo') {
    const { result, decision } = fpSlo(activatedDef(def), read(run.ledger));
    return { checks: [result], decision };
  }
  if (run.op === 'waiver') {
    const active = activatedDef(def);
    const input = read(run.input);
    const result = asActive(runOn(def.checkId, run.state), active);
    const fpSloExceeded = run.ledger ? fpSlo(active, read(run.ledger)).decision.exceeded : false;
    const approval = evaluateWaiver(checkDef('policy.waiver-approval'), input.waiver, { check: active, result, requesterId: input.requesterId, approvers: input.approvers, fpSloExceeded, now: input.now });
    const waived = applyWaiver(result, input.waiver, approval);
    return { checks: [approval, waived], exitCode: gateExitCode([approval, waived]), decision: approval.extensions?.['x-waiver'] ?? {} };
  }
  throw new Error(`check-lifecycle: unknown op ${run.op}`);
}

/** Fails loudly when a hold-out variant is also a dev-set fixture (a registry fixture or a showcase/fixtures diff). */
function assertHeldOut(manifest) {
  const registry = readText(policyPath('registry', 'checks.yaml'));
  if (registry.includes('showcase/holdout/')) throw new Error('holdout-recall: a registry fixture points into showcase/holdout/; the hold-out set must stay out of the dev set (FE §12)');
  const dev = new Set(readdirSync(policyPath('showcase', 'fixtures')).filter((f) => f.endsWith('.diff')).map((f) => readText(policyPath('showcase', 'fixtures', f))));
  for (const c of manifest.classes) {
    for (const v of c.variants) if (dev.has(readText(policyPath(v.diff)))) throw new Error(`holdout-recall: ${c.id}/${v.id} is identical to a development fixture`);
  }
}

const ratio = (caught, total) => (total ? Math.round((caught / total) * 1000) / 1000 : null);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** True when tool output names the rule as a whole word (ESLint prints the rule id as the last column of a message). */
const namesRule = (message, rule) => new RegExp(`(^|\\s)${escapeRe(rule)}(\\s|$)`, 'm').test(message ?? '');

/** A variant is caught when its check FAILs with a finding of one of the class's rules (by ruleId, or named in tool output). */
function caughtBy(result, rules) {
  if (result.status !== 'FAIL') return false;
  return (result.findings ?? []).some((f) => rules.includes(f.ruleId) || rules.some((r) => namesRule(f.message, r)));
}

/**
 * `holdout-recall` — SC-11 (FE §12 seeded defects, FE §20.3 "recall is measured on the hold-out set"). For every class
 * of the manifest: the clean repo must PASS the class's check (otherwise recall is meaningless → ERROR); then every
 * variant diff is applied to a fresh copy and the real check runs through `acme-policy run`. Recall = caught / total,
 * per class and overall. The recall record PASSes when every class and the overall recall reach `run.minRecall`.
 * run: { manifest, minRecall }
 */
function holdoutRecall(run) {
  if (typeof run.minRecall !== 'number') throw new Error('holdout-recall: the case must declare minRecall');
  const manifest = read(run.manifest);
  assertHeldOut(manifest);
  const byClass = {};
  const missed = [];
  let caught = 0;
  let total = 0;
  for (const c of manifest.classes) {
    const clean = runOn(c.check, { repo: c.repo });
    if (clean.status !== 'PASS') throw new Error(`holdout-recall: ${c.check} is ${clean.status} on the clean ${c.repo}; recall on ${c.id} would be meaningless`);
    let hit = 0;
    for (const v of c.variants) {
      if (caughtBy(runOn(c.check, { repo: c.repo, change: v.diff }), c.rules)) hit++;
      else missed.push(`${c.id}/${v.id}`);
    }
    byClass[c.id] = { caught: hit, total: c.variants.length, recall: ratio(hit, c.variants.length) };
    caught += hit;
    total += c.variants.length;
  }
  const overall = ratio(caught, total);
  const belowThreshold = [...Object.entries(byClass).filter(([, r]) => r.recall < run.minRecall).map(([id]) => id), ...(overall < run.minRecall ? ['overall'] : [])];
  const findings = [
    ...missed.map((m) => ({ source: 'check', ruleId: 'holdout.missed', severity: 'INFO', location: m, message: `hold-out variant ${m} was not caught by its check`, state: 'open' })),
    ...belowThreshold.map((id) => ({ source: 'check', ruleId: 'holdout.recall-below-threshold', severity: 'BLOCKER', location: id, message: `recall of ${id} is below the declared minimum ${run.minRecall}`, state: 'open' })),
  ];
  return {
    checks: [record('showcase.holdout-recall', belowThreshold.length ? 'FAIL' : 'PASS', findings)],
    decision: { holdout: manifest.id, minRecall: run.minRecall, caught, total, recall: { overall, byClass: Object.fromEntries(Object.entries(byClass).map(([id, r]) => [id, r.recall])) }, totals: Object.fromEntries(Object.entries(byClass).map(([id, r]) => [id, r.total])), missed, belowThreshold },
  };
}

export const KINDS = { 'check-lifecycle': checkLifecycle, 'holdout-recall': holdoutRecall };
export const CHECKS = {
  'authz.permission-matrix': permissionMatrixCheck,
  'authz.negative': negativeCheck,
  'export.csv-injection': csvInjectionCheck,
};
