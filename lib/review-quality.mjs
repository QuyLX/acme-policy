// AI reviewer quality and per-surface review mode (CORE-REV-02, CORE-REV-06).
// Standard §7.9 items 10, 30, 31 (shadow → advisory → blocking, promotion only on §7.12 measurements meeting thresholds
// agreed with the area owner); §7.12 items 1-5 (dispositions fixed / wrong / intentional / didn't-matter; known-clean
// PRs for the harmful rate; incident-derived eval set; a reviewer change is kept only if the score improves); §9.2
// item 12 (no promotion on regression); §9.9 (harmful rate rises → pin to the last good version, disable auto-fix);
// FE §9.9 (mode in `review.aiMode`; raising and lowering are control-file changes; lowering is loosening).
// RECORDED reviewer data: no reviewer runtime exists (D-09 open). Every metric below is computed here from recorded
// dispositions and recorded reviewer outputs; no rate is read from the input.

export const MODES = ['shadow', 'advisory', 'blocking'];
export const RESPONSES = ['fixed', 'wrong', 'intentional', 'didnt-matter'];

/** Precision from author responses (§7.12 item 1): only `fixed` is a useful finding. */
export function precision(dispositions) {
  for (const d of dispositions) if (!RESPONSES.includes(d.authorResponse)) throw new Error(`disposition ${d.finding ?? '?'}: authorResponse ${d.authorResponse} is not one of ${RESPONSES.join(', ')}`);
  const n = dispositions.length;
  return { n, fixed: dispositions.filter((d) => d.authorResponse === 'fixed').length, value: n ? dispositions.filter((d) => d.authorResponse === 'fixed').length / n : 0 };
}

/**
 * Reviewer output on the eval set: recall on the incident-derived set (a case counts when the reviewer flagged the
 * confirmed bug location, §7.12 item 3) and harmful findings per known-clean PR (§7.12 item 2).
 * @param {{ incidents: Array<{ id: string, bugLocation: string }>, cleanPrs: Array<{ id: string }> }} evalSet
 * @param {{ incidents: Array<{ id: string, flagged: string[] }>, cleanPrs: Array<{ id: string, findings: Array<{ location: string, harmful: boolean }> }> }} outputs
 */
export function scoreOnEvalSet(evalSet, outputs) {
  const missingIncident = evalSet.incidents.filter((c) => !outputs.incidents.some((o) => o.id === c.id)).map((c) => c.id);
  const missingClean = evalSet.cleanPrs.filter((c) => !outputs.cleanPrs.some((o) => o.id === c.id)).map((c) => c.id);
  if (missingIncident.length || missingClean.length) throw new Error(`reviewer outputs do not cover the full eval set (§7.12 item 5): missing ${[...missingIncident, ...missingClean].join(', ')}`);
  const caught = evalSet.incidents.filter((c) => outputs.incidents.find((o) => o.id === c.id).flagged.includes(c.bugLocation)).length;
  const harmful = evalSet.cleanPrs.reduce((sum, c) => sum + outputs.cleanPrs.find((o) => o.id === c.id).findings.filter((f) => f.harmful).length, 0);
  const recall = evalSet.incidents.length ? caught / evalSet.incidents.length : 0;
  const harmfulRate = evalSet.cleanPrs.length ? harmful / evalSet.cleanPrs.length : 0;
  return { incidents: evalSet.incidents.length, caught, recall, cleanPrs: evalSet.cleanPrs.length, harmful, harmfulRate, score: recall - harmfulRate };
}

/** All §7.12 measurements for one surface period. */
export function measure({ dispositions, evalSet, outputs }) {
  const p = precision(dispositions);
  const s = scoreOnEvalSet(evalSet, outputs);
  return { dispositions: p.n, precision: p.value, cleanPrs: s.cleanPrs, harmfulRate: s.harmfulRate, incidentCases: s.incidents, incidentRecall: s.recall };
}

/**
 * One promotion step at a time (§7.9 item 30) and only when thresholds are met (§7.9 item 31).
 * @returns {{ mode: string, changed: boolean, loosening: boolean, problems: Array<{ ruleId: string, message: string }> }}
 */
export function promoteMode({ current, requested, metrics, thresholds }) {
  const from = MODES.indexOf(current);
  const to = MODES.indexOf(requested);
  if (from < 0 || to < 0) throw new Error(`unknown AI review mode ${current} → ${requested}`);
  if (to === from) return { mode: current, changed: false, loosening: false, problems: [] };
  if (to < from) {
    // FE §9.9: lowering is a control-file change that loosens a gate (R3 path, code owner of the control file).
    return { mode: requested, changed: true, loosening: true, problems: [{ ruleId: 'review.mode-lowered', message: `${current} → ${requested} lowers the AI review mode: loosening, needs the control-file owner's approval` }] };
  }
  if (to - from > 1) return { mode: current, changed: false, loosening: false, problems: [{ ruleId: 'review.mode-skip', message: `${current} → ${requested} skips ${MODES[from + 1]}: every surface moves one step at a time (Standard §7.9 item 30)` }] };
  const t = thresholds[requested];
  if (!t) throw new Error(`no thresholds for ${requested}`);
  const unmet = [];
  const need = (ok, what) => ok || unmet.push(what);
  need(metrics.dispositions >= t.minDispositions, `${metrics.dispositions} dispositions < ${t.minDispositions}`);
  need(metrics.precision >= t.minPrecision, `precision ${metrics.precision.toFixed(3)} < ${t.minPrecision}`);
  need(metrics.cleanPrs >= t.minCleanPrs, `${metrics.cleanPrs} known-clean PRs < ${t.minCleanPrs}`);
  need(metrics.harmfulRate <= t.maxHarmfulRate, `harmful rate ${metrics.harmfulRate.toFixed(3)} > ${t.maxHarmfulRate}`);
  need(metrics.incidentCases >= t.minIncidentCases, `${metrics.incidentCases} incident cases < ${t.minIncidentCases}`);
  need(metrics.incidentRecall >= t.minIncidentRecall, `incident recall ${metrics.incidentRecall.toFixed(3)} < ${t.minIncidentRecall}`);
  if (unmet.length) return { mode: current, changed: false, loosening: false, problems: [{ ruleId: 'review.threshold-unmet', message: `${current} → ${requested} refused: ${unmet.join('; ')}` }] };
  return { mode: requested, changed: true, loosening: false, problems: [] };
}

/**
 * A reviewer change (prompt, tools, model or filters) is scored on the full eval set and kept only if the score
 * improves (§7.12 item 5) and nothing regresses (§9.2 item 12). Otherwise the reviewer stays pinned to the baseline;
 * a higher harmful rate also disables auto-fix (§9.9 breaker table).
 */
export function scoreReviewerChange({ evalSet, baseline, candidate }) {
  const b = scoreOnEvalSet(evalSet, baseline.outputs);
  const c = scoreOnEvalSet(evalSet, candidate.outputs);
  const problems = [];
  if (c.recall < b.recall) problems.push({ ruleId: 'review.eval-regression', message: `incident recall ${b.recall.toFixed(3)} → ${c.recall.toFixed(3)}` });
  if (c.harmfulRate > b.harmfulRate) problems.push({ ruleId: 'review.eval-regression', message: `harmful rate on known-clean PRs ${b.harmfulRate.toFixed(3)} → ${c.harmfulRate.toFixed(3)}` });
  if (!problems.length && !(c.score > b.score)) problems.push({ ruleId: 'review.no-improvement', message: `score ${b.score.toFixed(3)} → ${c.score.toFixed(3)} does not improve: the change is not kept` });
  const kept = problems.length === 0;
  return {
    kept,
    pinnedTo: kept ? candidate.version : baseline.version,
    autoFixDisabled: c.harmfulRate > b.harmfulRate,
    baseline: { version: baseline.version, ...b },
    candidate: { version: candidate.version, ...c },
    problems,
  };
}
