// Trust evaluation per (task class, agent configuration) (CORE-GOV-03; Standard §9.4, K.3 TrustEvaluation; FE §10.3).
// Only T0, T1 and T2 exist. Decisions rest on a confidence bound computed here (one-sided 95% Clopper-Pearson upper
// bound of the defect rate; with 0 defects ≈ the rule of three, 3/n), never on a ratio and never on a value read from
// the input (§9.4 item 11.5). Thresholds come from registry/trust.yaml (FE §10.3: the Standard's suggested defaults are
// mandatory in this profile). RECORDED data: task outcomes, eval runs and incidents are fixtures; nothing here merges.
//
// Which failures enter the T2 bound (§9.4 items 6, 11, 11.5, 13): T2 decides whether the human reading the change can be
// removed, so a "defect" is any defect in the agent's output that would have reached production without that human:
// escaped defects and attributed incidents, plus A1 production merges that were not accepted (the reviewer had to make a
// significant/logic change, or the merge was reverted; item 6). Counting only escaped defects would make the bound a
// restatement of the ≥ 50 count (0 of n ≥ 50 always bounds below 6%), i.e. a score ratio in disguise (item 11.5).
// This reading is the profile's implementation choice, not a value the Standard fixes; it only makes T2 harder to reach.
// The production record's duration is measured from the first to the last counted merge (evidence), never from the
// request's window.

export const LEVELS = ['T0', 'T1', 'T2'];
const DAY = 86400000;
const rank = (l) => LEVELS.indexOf(l);
const lower = (a, b) => (rank(a) <= rank(b) ? a : b);

/** P(X ≤ k) for X ~ Binomial(n, p). */
function binomCdf(k, n, p) {
  let term = (1 - p) ** n; // P(X = 0)
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return sum;
}

/** One-sided upper confidence bound (default 95%) of a failure rate with k failures in n trials (Clopper-Pearson). */
export function upperBound(k, n, confidence = 0.95) {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  const alpha = 1 - confidence;
  if (k === 0) return 1 - alpha ** (1 / n);
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** §9.4 "Acceptance": merged without significant reviewer change; logic changes, closed and reverted PRs never count (item 6). */
export const accepted = (t) => t.merged === true && ['none', 'nits'].includes(t.reviewerChange) && !t.reverted;

/** Near-duplicate tasks count once (§9.4 item 11.1). */
function dedupe(tasks) {
  const seen = new Set();
  return tasks.filter((t) => (seen.has(t.fingerprint) ? false : seen.add(t.fingerprint)));
}

/**
 * @param {object} req
 * @param {{ id: string, workflow: string, workflowMajor: number, scope: string, riskCeiling: string, strata: string[] }} req.taskClass
 * @param {{ modelSnapshot: string, playbook: string, skills: string[] }} req.agentConfig
 * @param {string} req.currentLevel
 * @param {{ from: string, to: string }} req.window
 * @param {object[]} req.tasks recorded task outcomes
 * @param {Array<{ id: string, passed: boolean }>} req.criticalScenarios
 * @param {{ holdout: { passed: number, total: number }, seen: { passed: number, total: number } }} req.holdout
 * @param {{ evalSets: string[], regressions: number }} req.regression
 * @param {Array<{ taskClass: string, confirmedBy?: string }>} [req.incidents] escaped defects attributed in incident review
 * @param {{ kind: 'major'|'minor', what: string, regressionPassed?: boolean }} [req.versionChange]
 * @param {string[]} [req.decidedBy]
 * @param {object} thresholds registry/trust.yaml `thresholds`
 * @param {{ areaOwner: string, factoryOwner: string }} owners
 */
export function evaluateTrust(req, thresholds, owners) {
  const reasons = [];
  const why = (ruleId, message) => reasons.push({ ruleId, message });
  const to = Date.parse(req.window.to);
  // §9.4 item 8: the evidence window is at most 6 months; older tasks do not count, classes are never merged.
  const windowStart = Math.max(Date.parse(req.window.from), to - thresholds.maxWindowMonths * 30.44 * DAY);
  if (Date.parse(req.window.from) < windowStart) why('trust.window-clipped', `window clipped to ${thresholds.maxWindowMonths} months (§9.4 item 8)`);
  const otherClass = req.tasks.filter((t) => t.taskClass !== req.taskClass.id);
  if (otherClass.length) why('trust.other-class-excluded', `${otherClass.length} task(s) of other classes excluded: trust never transfers (§9.4 items 2, 8)`);
  const inWindow = dedupe(req.tasks.filter((t) => t.taskClass === req.taskClass.id && Date.parse(t.at) >= windowStart && Date.parse(t.at) <= to));

  const critical = { total: req.criticalScenarios.length, passed: req.criticalScenarios.filter((c) => c.passed).length };
  const holdoutScore = req.holdout.holdout.passed / req.holdout.holdout.total;
  const seenScore = req.holdout.seen.passed / req.holdout.seen.total;
  const holdoutOk = seenScore - holdoutScore <= thresholds.holdoutMaxGap;
  const regressionOk = req.regression.regressions === 0;
  const strataCount = (tasks) => req.taskClass.strata.map((name) => ({ name, tasks: tasks.filter((t) => t.stratum === name).length }));

  // T1: qualified in shadow or assisted mode (any qualifying task of the class).
  const t1 = thresholds.T1;
  const t1Tasks = inWindow;
  const t1Acc = t1Tasks.length ? t1Tasks.filter(accepted).length / t1Tasks.length : 0;
  const t1Strata = strataCount(t1Tasks);
  const t1Fail = [];
  for (const s of t1Strata) if (s.tasks < t1.minTasksPerStratum) t1Fail.push(['trust.t1-insufficient-tasks', `stratum ${s.name}: ${s.tasks} task(s) < ${t1.minTasksPerStratum} (FE §10.3: the count applies per difficulty tier)`]);
  if (t1Acc < t1.minAcceptance) t1Fail.push(['trust.t1-acceptance', `acceptance ${(t1Acc * 100).toFixed(1)}% < ${t1.minAcceptance * 100}%`]);
  const escapedBlockers = t1Tasks.filter((t) => t.escapedBlocker).length;
  if (escapedBlockers > t1.maxEscapedBlockers) t1Fail.push(['trust.t1-escaped-blocker', `${escapedBlockers} escaped blocker(s)`]);
  if (critical.passed < critical.total) t1Fail.push(['trust.critical-scenarios', `${critical.passed}/${critical.total} critical scenarios pass`]);
  if (!holdoutOk) t1Fail.push(['trust.holdout-gap', `holdout ${holdoutScore.toFixed(3)} vs seen ${seenScore.toFixed(3)}: gap > ${thresholds.holdoutMaxGap}`]);
  if (!regressionOk) t1Fail.push(['trust.regression', `${req.regression.regressions} regression(s)`]);

  // T2: supervised production record. FE §10.3: only merges through A1 count (a human read the change).
  const t2 = thresholds.T2;
  const production = inWindow.filter((t) => t.merged && t.levelAtTime === 'T1' && t.environment === 'production');
  const a0 = production.filter((t) => t.mergedVia !== 'A1');
  if (a0.length) why('trust.a0-not-counted', `${a0.length} production merge(s) not through A1 excluded (FE §10.3)`);
  const t2Tasks = production.filter((t) => t.mergedVia === 'A1');
  const classIncidents = (req.incidents ?? []).filter((i) => i.taskClass === req.taskClass.id).length;
  const escaped = t2Tasks.filter((t) => t.escapedDefect).length + classIncidents;
  // Bound failures: tasks with an escaped defect or that were not accepted (caught by the A1 human), plus incidents.
  const failed = t2Tasks.filter((t) => t.escapedDefect || !accepted(t));
  const failures = failed.length + classIncidents;
  const upper = upperBound(failures, t2Tasks.length);
  // Span of the evidence itself (first → last counted merge); the request's window.to never lengthens it.
  const mergedAt = t2Tasks.map((t) => Date.parse(t.at));
  const weeks = mergedAt.length ? (Math.max(...mergedAt) - Math.min(...mergedAt)) / (7 * DAY) : 0;
  const intervention = t2Tasks.length ? t2Tasks.filter((t) => t.intervention).length / t2Tasks.length : 1;
  const t2Strata = strataCount(t2Tasks);
  const t2Fail = [];
  for (const s of t2Strata) if (s.tasks < t2.minTasksPerStratum) t2Fail.push(['trust.t2-insufficient-tasks', `stratum ${s.name}: ${s.tasks} A1 production merge(s) at T1 < ${t2.minTasksPerStratum}`]);
  if (escaped > t2.maxEscapedDefects) t2Fail.push(['trust.t2-escaped-defect', `${escaped} escaped defect(s)`]);
  if (weeks < t2.minWeeks) t2Fail.push(['trust.t2-window', `production record spans ${weeks.toFixed(1)} weeks (first to last counted merge) < ${t2.minWeeks}`]);
  if (upper > t2.maxUpper95) t2Fail.push(['trust.t2-upper-bound', `95% upper bound of the defect rate ${(upper * 100).toFixed(2)}% > ${t2.maxUpper95 * 100}% (n=${t2Tasks.length}, k=${failures}: ${escaped} escaped, ${failed.length - t2Tasks.filter((t) => t.escapedDefect).length} not accepted at A1)`]);
  if (intervention >= t2.maxInterventionRate) t2Fail.push(['trust.t2-intervention', `intervention rate ${(intervention * 100).toFixed(1)}% ≥ ${t2.maxInterventionRate * 100}%`]);
  if (!holdoutOk || critical.passed < critical.total || !regressionOk) t2Fail.push(['trust.t2-evals', 'critical scenarios, holdout and regression must all pass']);

  let level = 'T0';
  if (!t1Fail.length) level = 'T1';
  if (level === 'T1' && !t2Fail.length) level = 'T2';
  for (const [ruleId, message] of level === 'T0' ? t1Fail : level === 'T1' ? t2Fail : []) why(ruleId, message);

  let status = 'CURRENT';
  // §9.4 item 10 + FE §10.3: an escaped defect attributed to the class → T0 and re-evaluation.
  if ((req.incidents ?? []).some((i) => i.taskClass === req.taskClass.id)) {
    level = 'T0';
    status = 'RE-EVALUATION_REQUIRED';
    why('trust.incident', 'escaped defect attributed to the class: back to T0 (FE §10.3) and re-evaluation (§9.4 item 10)');
  }
  // §9.4 item 9: a major change caps at T1 and requires re-evaluation; a minor change keeps the level only if the
  // regression evals pass (otherwise T0 until they do).
  if (req.versionChange?.kind === 'major') {
    if (rank(level) > rank('T1')) why('trust.major-change-cap', `${req.versionChange.what}: capped at T1 (§9.4 item 9)`);
    level = lower(level, 'T1');
    status = 'RE-EVALUATION_REQUIRED';
  } else if (req.versionChange?.kind === 'minor' && !req.versionChange.regressionPassed) {
    level = 'T0';
    status = 'RE-EVALUATION_REQUIRED';
    why('trust.minor-change-regression', `${req.versionChange.what}: regression evals did not pass, the level is not kept`);
  }

  // §9.10: raising a trust level needs the area owner AND the Factory owner; otherwise the raise is only proposed.
  const raising = rank(level) > rank(req.currentLevel);
  const decidedBy = req.decidedBy ?? [];
  const approvedRaise = !raising || (decidedBy.includes(owners.areaOwner) && decidedBy.includes(owners.factoryOwner));
  if (!approvedRaise) why('trust.raise-needs-owners', `raising ${req.currentLevel} → ${level} needs ${owners.areaOwner} and ${owners.factoryOwner} (§9.10); decided by [${decidedBy.join(', ')}]`);

  const evaluation = {
    taskClass: { workflow: req.taskClass.workflow, workflowMajor: req.taskClass.workflowMajor, scope: req.taskClass.scope, riskCeiling: req.taskClass.riskCeiling },
    agentConfig: req.agentConfig,
    window: { from: new Date(windowStart).toISOString(), to: new Date(to).toISOString() },
    strata: (level === 'T0' ? t1Strata : t2Strata).map((s) => ({ name: s.name, tasks: s.tasks, accepted: (level === 'T0' ? t1Tasks : t2Tasks).filter((t) => t.stratum === s.name && accepted(t)).length, minRequired: level === 'T0' ? t1.minTasksPerStratum : t2.minTasksPerStratum })),
    criticalScenarios: critical,
    holdout: { score: holdoutScore, seenScore, maxGap: thresholds.holdoutMaxGap },
    regression: req.regression,
    escapedDefects: escaped,
    failureRateUpper95: upper,
    interventionRate: t2Tasks.length ? intervention : 0,
    resultLevel: approvedRaise ? level : req.currentLevel,
    status,
    decidedBy,
    decidedAt: new Date(to).toISOString(),
  };
  return { evaluation, computedLevel: level, raiseApproved: approvedRaise, reasons, counts: { t1Tasks: t1Tasks.length, t1Acceptance: t1Acc, t2Tasks: t2Tasks.length, t2Failures: failures, a0Excluded: a0.length, weeks } };
}
