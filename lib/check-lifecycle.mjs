// Check lifecycle (CORE-VER-10, CORE-GOV-09): promotion, the activation baseline and the false-positive budget.
//   promote          Standard §8.7 rule 1 (a check never seen to fail MUST NOT become active) and rule 4
//                    (planned → shadow → active → deprecated; shadow for at least the profile period; only active may be
//                    required); rule 7 (a baselineable: false check activates only at zero violations).
//   snapshotBaseline Standard §8.7 rule 7, §7.13 item 31: CI snapshots the existing violations on the target branch; a
//                    trusted mechanism (registry/trusted-mechanisms.yaml), never anyone's PR (FE §8.2).
//   applyBaseline    Standard §7.5 `baselined`; FE §8.5: known violations → FAIL + baselined, new ones → FAIL; a fixed
//                    entry is invalidated at once and removed by the shrink mechanism after merge.
//   fpSlo            Standard §8.7 rule 5; FE §8.2: only owner- or non-author-delegate-confirmed false positives count;
//                    autoDemote: false + over SLO → stays blocking, P1 work item, waivers ≤ 14 days and scoped.
import { createHash } from 'node:crypto';
import { readYaml, policyPath } from './io.mjs';
import { validate } from './schema.mjs';

export const LIFECYCLE = ['planned', 'shadow', 'active', 'deprecated'];
/** FE §8.2: "minimum 2–4 weeks" in shadow. The lower bound is used until the profile fixes the value (open). */
export const DEFAULT_MIN_SHADOW_DAYS = 14;
export const BASELINE_PRODUCER = 'trusted:baseline-snapshot';
export const BASELINE_SHRINK = 'trusted:baseline-shrink';
/** FE §8.2: autoDemote: false and fpSlo exceeded → "only scoped waivers of at most 14 days". */
export const FP_SLO_WAIVER_MAX_DAYS = 14;
const DAY = 86_400_000;

const issue = (ruleId, message, severity = 'BLOCKER', extra = {}) => ({ source: 'check', ruleId, severity, message, state: 'open', ...extra });

/** Registered trusted mechanisms (Standard §7.13 item 36). Throws when the registry is invalid. */
export function trustedMechanisms() {
  const reg = readYaml(policyPath('registry', 'trusted-mechanisms.yaml'));
  const errors = validate('trusted-mechanism', reg);
  if (errors.length) throw new Error(`registry/trusted-mechanisms.yaml: ${errors.join('; ')}`);
  return reg.mechanisms;
}

/** The registry entry as it reads once active: target enforcement, required (Standard §8.3 rule 5). */
export function activatedDef(def, { requirement = 'required' } = {}) {
  return { ...def, lifecycle: 'active', enforcement: def.targetEnforcement ?? 'blocking', requirement };
}

/**
 * Decides one lifecycle transition of a check.
 * @param def registry entry (the proposed one, e.g. with its fixtures)
 * @param opts { to, proof: [{ fixture, fired }], shadowSince?, now, minShadowDays?, violations? (findings on the target branch) }
 */
export function promote(def, { to, proof = [], shadowSince, now, minShadowDays = DEFAULT_MIN_SHADOW_DAYS, violations = 0 }) {
  const from = def.lifecycle;
  const findings = [];
  const i = LIFECYCLE.indexOf(from);
  const j = LIFECYCLE.indexOf(to);
  if (j < 0) throw new Error(`unknown lifecycle ${to}`);
  const valid = (j === i + 1) || (to === 'deprecated' && from !== 'deprecated');
  if (!valid) findings.push(issue(j > i + 1 ? 'lifecycle.skip' : 'lifecycle.invalid-transition', `${def.checkId}: ${from} → ${to} is not allowed; the lifecycle is planned → shadow → active → deprecated (Standard §8.7 rule 4)`));
  if (to === 'shadow' || to === 'active') {
    const violating = def.fixtures?.violating ?? [];
    if (!violating.length && !def.fixtures?.proofTest) findings.push(issue('lifecycle.mutation-proof', `${def.checkId}: no violating fixture — every check MUST have violating fixtures (Standard §8.7 rule 1)`));
    else if (to === 'active' && (!proof.length || proof.some((p) => !p.fired))) {
      const silent = proof.filter((p) => !p.fired).map((p) => p.fixture);
      findings.push(issue('lifecycle.mutation-proof', `${def.checkId}: never seen to fail on ${silent.length ? silent.join(', ') : 'any violating fixture'} — a check that has never been seen to fail MUST NOT become active (Standard §8.7 rule 1)`));
    }
  }
  let shadowDays;
  let requiresBaselineSnapshot = false;
  if (to === 'active') {
    shadowDays = shadowSince ? Math.floor((Date.parse(now) - Date.parse(shadowSince)) / DAY) : 0;
    if (!shadowSince || shadowDays < minShadowDays) findings.push(issue('lifecycle.shadow-period', `${def.checkId}: ${shadowDays} day(s) in shadow, the profile requires at least ${minShadowDays} (Standard §8.7 rule 4; FE §8.2)`));
    if (violations > 0) {
      if (def.baselineable) requiresBaselineSnapshot = true;
      else findings.push(issue('lifecycle.baseline-zero', `${def.checkId}: baselineable: false and ${violations} violation(s) on the target branch — it may only become active at zero (Standard §8.7 rule 7; FE §8.2)`));
    }
  }
  const next = to === 'active' ? activatedDef(def) : { ...def, lifecycle: to, requirement: 'optional', enforcement: to === 'shadow' ? 'observe' : def.enforcement };
  return { allowed: findings.length === 0, from, to, def: next, shadowDays, violations, requiresBaselineSnapshot, findings };
}

/** Fingerprint of a finding that has none: file (line dropped) + rule + message without numbers. */
export function fingerprintOf(checkId, finding) {
  if (finding.fingerprint) return finding.fingerprint;
  const file = (finding.location ?? '').replace(/:\d+(?::\d+)?$/, '');
  return createHash('sha256').update([checkId, file, finding.ruleId ?? '', (finding.message ?? '').replace(/\d+/g, '#')].join('\0')).digest('hex').slice(0, 16);
}

const violationsOf = (result) => (result.findings ?? []).filter((f) => f.severity === 'BLOCKER' || f.severity === 'WARNING');

/**
 * The activation baseline. Only the registered snapshot mechanism, run by CI on the target branch, may produce it.
 * @returns {{ baseline: object|null, problems: object[] }}
 */
export function snapshotBaseline(result, { executor, event, ref, commitSha, takenAt, producer = BASELINE_PRODUCER, mechanisms = trustedMechanisms() }) {
  const problems = [];
  const mechanism = mechanisms.find((m) => m.id === producer && m.produces === 'check-baseline');
  if (!mechanism || producer !== BASELINE_PRODUCER) problems.push(issue('baseline.untrusted-producer', `${producer} is not the registered baseline snapshot mechanism (${BASELINE_PRODUCER}; Standard §7.13 item 36)`));
  else if (executor !== mechanism.runsOn.executor || event !== mechanism.runsOn.event || ref !== mechanism.runsOn.ref) {
    problems.push(issue('baseline.snapshot-not-ci', `the baseline is snapshotted by CI on ${mechanism.runsOn.ref} (${mechanism.runsOn.event}), not by ${executor}/${event} on ${ref} — never via anyone's PR (FE §8.2; Standard §8.7 rule 7)`));
  }
  if (result.status !== 'PASS' && result.status !== 'FAIL') problems.push(issue('baseline.no-evidence', `${result.checkId} is ${result.status}: nothing to snapshot`));
  if (problems.length) return { baseline: null, problems };
  const baseline = {
    apiVersion: 'aisf/4.0',
    kind: 'CheckBaseline',
    checkId: result.checkId,
    checkVersion: result.checkVersion,
    producer,
    ref,
    ...(commitSha ? { commitSha } : {}),
    takenAt,
    entries: violationsOf(result).map((f) => ({ location: f.location, fingerprint: fingerprintOf(result.checkId, f), ruleId: f.ruleId })),
  };
  const errors = validate('check-baseline', baseline);
  if (errors.length) throw new Error(`baseline: ${errors.join('; ')}`);
  return { baseline, problems };
}

/**
 * Applies the activation baseline to a result of an active check.
 * On a change (default), a fixed entry never blocks the change: it is invalidated and reported `baseline.stale` (INFO).
 * On the target branch (`onTarget`), a stale entry blocks until the shrink mechanism removes it (Standard §7.5).
 */
export function applyBaseline(def, result, baseline, { onTarget = false, mechanisms = trustedMechanisms() } = {}) {
  if (!baseline || (result.status !== 'FAIL' && result.status !== 'PASS')) return result;
  const trusted = validate('check-baseline', baseline).length === 0 && baseline.checkId === def.checkId && baseline.producer === BASELINE_PRODUCER && mechanisms.some((m) => m.id === baseline.producer);
  if (!trusted) {
    const finding = issue('baseline.untrusted-producer', `baseline for ${baseline.checkId} by ${baseline.producer} is not a CI snapshot of ${BASELINE_PRODUCER}; ignored — a baseline is never added through a PR (Standard §8.7 rule 7; FE §8.2)`);
    return { ...result, reason: result.reason ?? 'baseline ignored', findings: [...result.findings, finding] };
  }
  const known = new Set(baseline.entries.map((e) => e.fingerprint));
  const current = violationsOf(result).map((f) => ({ finding: f, fp: fingerprintOf(def.checkId, f) }));
  const seen = new Set(current.map((c) => c.fp));
  const matched = current.filter((c) => known.has(c.fp));
  const fresh = current.filter((c) => !known.has(c.fp));
  const stale = baseline.entries.filter((e) => !seen.has(e.fingerprint));
  const findings = [
    ...result.findings.map((f) => (matched.some((m) => m.finding === f) ? { ...f, baselined: true } : f)),
    ...fresh.map((c) => issue('baseline.new-violation', `${c.finding.location}: new violation, not in the activation baseline (Standard §8.7 rule 7)`)),
    ...stale.map((e) => issue('baseline.stale', `${e.location}: baseline entry no longer fails — invalidated now, removed by ${BASELINE_SHRINK} after merge (FE §8.5)`, onTarget ? 'BLOCKER' : 'INFO')),
  ];
  const extensions = { ...(result.extensions ?? {}), 'x-baseline': { producer: baseline.producer, ref: baseline.ref, matched: matched.map((m) => m.fp), new: fresh.map((c) => c.fp), invalidated: stale.map((e) => e.fingerprint) } };
  const base = { ...result, findings, extensions };
  if (fresh.length) return { ...base, status: 'FAIL', reason: `${fresh.length} new violation(s) not in the baseline` };
  if (onTarget && stale.length) return { ...base, status: 'FAIL', reason: `${stale.length} stale baseline entr(ies) on the target branch` };
  if (matched.length) {
    return { ...base, status: 'FAIL', reason: `${matched.length} violation(s), all in the activation baseline`, disposition: { type: 'baselined', decidedBy: 'policy', rule: 'Standard §7.5; §8.7 rule 7', baseline: `${baseline.producer}@${baseline.ref}`, entries: matched.length } };
  }
  const { reason, ...pass } = base;
  return { ...pass, status: 'PASS' };
}

/** A baseline only shrinks: entries are added only by the initial CI snapshot (Standard §8.7 rule 7). */
export function baselineChange(prev, next) {
  const before = new Set((prev?.entries ?? []).map((e) => e.fingerprint));
  const added = (next?.entries ?? []).filter((e) => !before.has(e.fingerprint));
  const initial = !prev && next?.producer === BASELINE_PRODUCER;
  if (added.length && !initial) return [issue('baseline.grow', `${added.length} entr(ies) added to the baseline by ${next.producer} — the baseline can only shrink (Standard §8.7 rule 7; §7.13 item 31: adding a baseline entry is loosening)`)];
  return [];
}

/**
 * False-positive budget of one check over a ledger window.
 * @returns {{ result: object, decision: object }} result is a CheckResult-like record `lifecycle.fp-slo`
 */
export function fpSlo(def, ledger) {
  const errors = validate('fp-ledger', ledger);
  if (errors.length) throw new Error(`fp ledger: ${errors.join('; ')}`);
  if (ledger.checkId !== def.checkId) throw new Error(`fp ledger is for ${ledger.checkId}, not ${def.checkId}`);
  if (ledger.owner.team !== def.owner) throw new Error(`fp ledger owner ${ledger.owner.team} ≠ check owner ${def.owner}`);
  const confirmers = new Set([...ledger.owner.members, ...(ledger.delegates ?? [])]);
  const fps = ledger.reports.filter((r) => r.verdict === 'false-positive');
  const counts = (r) => Boolean(r.confirmedBy) && r.confirmedBy !== r.changeAuthor && confirmers.has(r.confirmedBy);
  const counted = fps.filter(counts);
  const notCounted = fps.filter((r) => !counts(r));
  const disputed = ledger.reports.filter((r) => r.verdict === 'disputed').length;
  const rate = ledger.findings ? counted.length / ledger.findings : 0;
  const exceeded = rate > def.fpSlo;
  const findings = notCounted.map((r) => issue('fpslo.not-counted', `${r.finding}: confirmed by ${r.confirmedBy ?? 'nobody'}${r.confirmedBy === r.changeAuthor ? ' (the author of the change)' : ''} — only the check owner or a non-author delegate confirms a false positive (Standard §8.7 rule 5)`, 'INFO'));
  let action = 'none';
  if (exceeded && !def.autoDemote) {
    action = 'priority-work-item';
    findings.push(issue('fpslo.priority-work-item', `${def.checkId}: confirmed FP rate ${rate.toFixed(3)} > fpSlo ${def.fpSlo}; autoDemote: false → stays ${def.enforcement}, P1 work item for ${def.owner}, waivers scoped and ≤ ${FP_SLO_WAIVER_MAX_DAYS} days (Standard §8.7 rule 5; FE §8.2)`));
  } else if (exceeded) {
    action = 'demotion-proposal';
    findings.push(issue('fpslo.demotion-proposal', `${def.checkId}: confirmed FP rate ${rate.toFixed(3)} > fpSlo ${def.fpSlo}; a demotion to advisory is proposed as a loosening change and the check stays ${def.enforcement} until it is approved (Standard §8.7 rule 5, §7.13)`));
  }
  const decision = {
    checkId: def.checkId, rate, fpSlo: def.fpSlo, exceeded, counted: counted.length, notCounted: notCounted.length, disputed,
    enforcement: def.enforcement, action, workItem: action === 'priority-work-item' ? { priority: 'P1', owner: def.owner } : null,
    waiverMaxDays: exceeded ? FP_SLO_WAIVER_MAX_DAYS : null,
  };
  const result = { checkId: 'lifecycle.fp-slo', status: exceeded ? 'FAIL' : 'PASS', reason: exceeded ? `false-positive SLO exceeded (${rate.toFixed(3)} > ${def.fpSlo})` : undefined, findings };
  return { result, decision };
}

/**
 * Exit code of a gate over checks of an activated policy (FE §7.6): a blocking FAIL counts as satisfied only with a
 * valid `baselined` or `waived` disposition (Standard §7.5 rule 7); NOT_ASSESSED blocks when required.
 */
export function gateExitCode(checks) {
  if (checks.some((c) => c.status === 'ERROR')) return 2;
  const satisfied = (c) => c.status === 'FAIL' && ['baselined', 'waived'].includes(c.disposition?.type);
  const blocks = (c) => c.enforcement === 'blocking' && ((c.status === 'FAIL' && !satisfied(c)) || (c.status === 'NOT_ASSESSED' && c.requirement === 'required' && c.disposition?.type !== 'waived'));
  return checks.some(blocks) ? 1 : 0;
}
