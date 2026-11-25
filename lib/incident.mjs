// Incident review → preventive mechanism and eval case (CORE-OPS-06; Standard §12.4 items 1, 4-8; §9.9 item 7;
// FE §11.5: the output is a rule, test, eval case, documentation fix, playbook or ADR, not a checklist by default).
// RECORDED incident review: the review record is a fixture; this code validates it, derives the eval case appended to
// the reviewer/agent eval set (§12.4 item 8, §7.12 item 4) and the breaker signal for an attributed task class.

export const ROOT_CAUSE_AREAS = ['requirements', 'implementation', 'architecture', 'contract', 'verification', 'agent-context', 'release'];
export const MECHANISMS = ['code-api-design', 'rule', 'regression-test', 'contract', 'skill', 'documentation', 'eval-case', 'runbook', 'operational-control', 'checklist'];
export const LAYERS = ['guide', 'sensor', 'human-gate'];

/**
 * @param {object} r incident review record
 * @returns {{ problems: Array<{ ruleId: string, message: string }>, evalCase?: object, signals: object[] }}
 */
export function reviewIncident(r) {
  const problems = [];
  const no = (ruleId, message) => problems.push({ ruleId, message });
  // §12.4 item 1: every root-cause area examined (a verdict per area, even "not a cause").
  const missing = ROOT_CAUSE_AREAS.filter((a) => !(a in (r.rootCause ?? {})));
  if (missing.length) no('incident.root-cause', `root-cause areas not examined: ${missing.join(', ')} (§12.4 item 1)`);
  // §12.4 item 6: which layer should have caught it, and what the agent was missing up front.
  if (!LAYERS.includes(r.shouldHaveCaught?.layer)) no('incident.layer-unanswered', 'which layer should have caught this defect (guide, sensor or human gate) is not answered (§12.4 item 6)');
  if (!r.agentWasMissing) no('incident.layer-unanswered', 'what the agent was missing up front is not answered (§12.4 item 6)');
  // §12.4 items 4-5, 7: a mechanism addressing the root cause, routed to that layer; never a checklist by default.
  const m = r.preventiveMechanism;
  if (!m || !MECHANISMS.includes(m.kind)) no('incident.no-mechanism', 'no preventive mechanism chosen (§12.4 item 5)');
  else if (m.kind === 'checklist') no('incident.checklist-default', 'a new checklist is not a preventive mechanism by default (§12.4 item 4)');
  if (m && r.shouldHaveCaught?.layer && m.layer !== r.shouldHaveCaught.layer) no('incident.misrouted', `fix routed to ${m.layer}, but the layer that should have caught it is ${r.shouldHaveCaught.layer} (§12.4 item 7)`);
  // §12.4 item 8: the incident is added to the reviewer and agent eval sets.
  const ec = r.evalCase;
  let evalCase;
  if (!ec?.pr || !ec?.bugLocation || !ec?.confirmedBy) no('incident.no-eval-case', 'the incident is not added to the eval sets with a confirmed bug location (§12.4 item 8, §7.12 item 3)');
  else if (ec.confirmedBy.startsWith('agent:')) no('incident.no-eval-case', 'the bug location must be confirmed by an engineer, not an agent (§7.12 item 3)');
  else evalCase = { id: `INC-${r.id}`, pr: ec.pr, bugLocation: ec.bugLocation, source: `incident ${r.id}`, sets: ec.sets ?? ['reviewer', 'agent'] };
  // §9.9 item 7: attributed escaped defects lower the class's trust; unattributed ones count against the area.
  const signals = [];
  if (r.attribution?.taskClass && r.attribution?.confirmedBy) signals.push({ kind: 'escaped-defect', taskClass: r.attribution.taskClass, confirmedBy: r.attribution.confirmedBy, incident: r.id, at: r.at });
  else if (r.attribution?.surface) signals.push({ kind: 'escaped-defect', surface: r.attribution.surface, incident: r.id, at: r.at });
  return { problems, evalCase, signals };
}

/** Appends an incident eval case to the incident-derived eval set (immutable; duplicates rejected). */
export function appendEvalCase(evalSet, evalCase) {
  if (evalSet.incidents.some((c) => c.id === evalCase.id)) throw new Error(`eval case ${evalCase.id} already in the eval set`);
  return { ...evalSet, incidents: [...evalSet.incidents, { id: evalCase.id, pr: evalCase.pr, bugLocation: evalCase.bugLocation }] };
}
