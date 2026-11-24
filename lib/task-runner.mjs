// Runtime-neutral task runner (tech-design 11 Part B; Standard §6.4-6.7, §6.12-6.14; FE §9.3, §9.10-9.12).
// Derives the Task state and its records (StateTransition, CheckpointRecord, Handoff, RecoveryEvent) from a neutral
// event log, and reports violations of the playbook. Nothing here trusts what an agent says about itself: requester,
// identities and hashes come from the events the platform binding records.

const STATE_BY_SKELETON = (n) =>
  n <= 2 ? 'TRIAGED' : n <= 4 || n === 10 ? 'CONTEXT_READY' : n <= 7 ? 'PLANNED' : n <= 9 ? 'EXECUTING' : n === 11 ? 'VERIFYING' : n <= 14 ? 'REVIEWING' : 'AWAITING_MERGE_APPROVAL';

/** Evaluates a `when` expression: OR of ANDs of `key == value` terms. Unknown facts count as true (worst case). */
export function evaluateWhen(expr, facts) {
  if (!expr) return true;
  return expr.split(/\s+OR\s+/).some((conj) =>
    conj.split(/\s+AND\s+/).every((term) => {
      const m = /^\s*([\w.-]+)\s*==\s*([\w.-]+)\s*$/.exec(term);
      if (!m) return true; // unparseable condition: treated as holding (never weakens a gate)
      const value = facts[m[1]];
      if (value === undefined) return true;
      return Array.isArray(value) ? value.includes(m[2]) : String(value) === m[2];
    }),
  );
}

const minDefined = (...xs) => {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? Math.min(...v) : undefined;
};

/**
 * @param {object[]} events TaskEvent[]
 * @param {object} playbook TaskWorkflowSpec
 * @param {{ policyCost?: number }} [policy] cost ceiling from the task-class registry
 */
export function deriveTask(events, playbook, policy = {}) {
  const ev = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const spec = playbook.spec;
  const stepDef = Object.fromEntries(spec.steps.map((s) => [s.id, { ...spec.recoveryDefaults, ...s }]));
  const violations = [];
  const warnings = [];
  const transitions = [];
  const checkpoints = [];
  const handoffs = [];
  const recoveries = [];
  const facts = {};
  const completed = new Map(); // step → last status
  const actorsByRole = { verifier: new Set(), implementer: new Set() };
  let locked = null;
  let state = 'REQUESTED';
  let escalated = null;
  let cost = 0;
  let verifyFails = 0;
  let reviewRounds = 0;
  let gateReached = false;
  const attempts = new Map();
  const rejections = new Map();
  const v = (code, message) => violations.push({ code, message });
  const escalate = (cause, detail) => {
    if (!escalated) escalated = { cause, detail };
    recoveries.push({ cause, action: 'escalate', detail });
  };
  const move = (to, e, reason) => {
    if (to === state) return;
    transitions.push({ from: { state }, to: { state: to }, actor: e.actor, at: e.at, reason });
    state = to;
  };

  const req = ev.find((e) => e.type === 'task.requested');
  const workItemId = req?.workItemId ?? ev[0]?.workItemId;
  const budgets = { ...spec.budgets, ...(req?.data.budgets ?? {}) };
  const costCeiling = minDefined(policy.policyCost, spec.budgets?.cost?.limit, req?.data.budgets?.cost?.limit);

  for (const e of ev) {
    switch (e.type) {
      case 'task.requested':
        move('TRIAGED', e, 'requested');
        if (!e.data.requestedBy || e.data.requesterSource === 'unknown') warnings.push('requester unknown: not eligible for sign-off (WRK-02)');
        break;
      case 'facts.recorded':
        Object.assign(facts, e.data);
        break;
      case 'step.completed': {
        const def = stepDef[e.data.step];
        if (!def) {
          v('WF-STEP', `step "${e.data.step}" is not in ${playbook.metadata.id}@${playbook.metadata.version}`);
          break;
        }
        const n = (attempts.get(def.id) ?? 0) + 1;
        attempts.set(def.id, n);
        const prev = completed.get(def.id);
        if (n > 1 && (prev === 'ERROR' || prev === 'timeout')) {
          if (def.sideEffect === 'irreversible') v('WF-IRREVERSIBLE', `step "${def.id}" has an irreversible side effect and was retried automatically after ${prev}`);
          recoveries.push({ step: def.id, cause: prev, action: 'retry', attempt: n });
        }
        if ((e.data.status === 'ERROR' || e.data.status === 'timeout') && def.retry && n > def.retry.max + 1) escalate(e.data.status, `step "${def.id}" exceeded ${def.retry.max} retries`);
        completed.set(def.id, e.data.status);
        if (def.role in actorsByRole) actorsByRole[def.role].add(e.actor.id);
        if (def.id === 'verify' && e.data.status === 'FAIL') verifyFails++; // ERROR/timeout never consume the loop budget
        if (def.id === 'review') reviewRounds++;
        if (e.data.status === 'PASS') move(STATE_BY_SKELETON(def.skeletonStep), e, def.id);
        if (e.data.status === 'FAIL' && def.id === 'verify') move('REPAIRING', e, 'verify failed');
        if (def.id === 'approve-merge') gateReached = true;
        break;
      }
      case 'checkpoint.recorded':
        checkpoints.push({ workItemId, checkpoint: e.data.checkpoint, outcome: e.data.outcome, condition: e.data.condition, approvals: e.data.approvals ?? [], recordedAt: e.at, recordedBy: e.actor.id });
        break;
      case 'handoff.offered': {
        const decl = (spec.handoffs ?? []).find((h) => h.from === e.data.from.role && h.to === e.data.to.role);
        const missing = decl ? decl.requiredArtifacts.filter((a) => !e.data.artifacts.includes(a)) : [];
        const leaked = decl ? (decl.excludeContext ?? []).filter((c) => (e.data.context ?? []).includes(c)) : [];
        const problems = [];
        if (!decl) problems.push('undeclared handoff');
        else if (!decl.validIn.includes(e.data.state)) problems.push(`not valid in ${e.data.state} (valid: ${decl.validIn.join(', ')})`);
        if (missing.length) problems.push(`missing ${missing.join(', ')}`);
        if (leaked.length) problems.push(`excluded context present: ${leaked.join(', ')}`);
        const key = `${e.data.from.role}→${e.data.to.role}`;
        const status = problems.length ? 'rejected' : 'accepted';
        handoffs.push({ workItemId, from: e.data.from, to: e.data.to, at: { state: e.data.state }, artifacts: e.data.artifacts, excludedContext: decl?.excludeContext ?? [], status, missing, problems, respondedAt: e.at });
        if (status === 'rejected') {
          rejections.set(key, (rejections.get(key) ?? 0) + 1);
          recoveries.push({ cause: 'handoff-rejected', action: 'return', detail: `${key}: ${problems.join('; ')}` });
          if (rejections.get(key) >= (spec.maxHandoffRejections ?? 2)) escalate('handoff-rejected', `${key} rejected ${rejections.get(key)} times`);
        } else rejections.delete(key);
        break;
      }
      case 'oracle.locked':
        locked = { ...e.data.files };
        break;
      case 'oracle.observed':
        if (!locked) v('WF-ORACLE', 'oracle observed but never locked: the verifier must lock oracleRefs at PLANNED');
        else for (const [path, hash] of Object.entries(locked)) if (e.data.files[path] !== hash) v('WF-ORACLE', `oracle ${path} changed after lock (${hash} → ${e.data.files[path] ?? 'deleted'})`);
        break;
      case 'cost.reported':
        cost += e.data.amount;
        if (costCeiling !== undefined) {
          if (cost >= costCeiling) escalate('budget-exhausted', `cost ${cost} ≥ ceiling ${costCeiling} ${spec.budgets?.cost?.unit ?? ''}`.trim());
          else if (cost >= 0.8 * costCeiling && !warnings.some((w) => w.startsWith('cost'))) warnings.push(`cost ${cost} reached 80% of the ceiling ${costCeiling}: requester warned`);
        }
        break;
      case 'task.merged':
        move('MERGED', e, 'merged');
        break;
    }
  }

  if (budgets.verifyRepairIterations !== undefined && verifyFails > budgets.verifyRepairIterations) escalate('budget-exhausted', `${verifyFails} failing verify iterations > budget ${budgets.verifyRepairIterations}`);
  if (budgets.reviewRounds !== undefined && reviewRounds > budgets.reviewRounds) escalate('budget-exhausted', `${reviewRounds} review rounds > budget ${budgets.reviewRounds}`);
  if (escalated) {
    v(escalated.cause === 'handoff-rejected' ? 'WF-HANDOFF' : escalated.cause === 'budget-exhausted' ? (/cost/.test(escalated.detail) ? 'WF-COST' : 'WF-LOOP') : 'WF-RECOVERY', `ESCALATED: ${escalated.detail}`);
    state = 'ESCALATED';
  }
  const shared = [...actorsByRole.verifier].filter((a) => actorsByRole.implementer.has(a));
  if (shared.length) v('WF-INDEPENDENCE', `the same identity acted as verifier and implementer: ${shared.join(', ')}`);
  const open = [...rejections.entries()].filter(([, n]) => n > 0);
  if (gateReached && open.length) v('WF-HANDOFF', `merge approval reached with rejected handoff(s) unresolved: ${open.map(([k]) => k).join(', ')}`);

  if (gateReached) {
    for (const s of spec.steps) {
      const needed = s.kind === 'mandatory' || (s.kind === 'conditional' && evaluateWhen(s.when, facts));
      if (needed && completed.get(s.id) !== 'PASS' && s.id !== 'approve-merge') v('WF-STEP', `${s.kind} step "${s.id}"${s.when ? ` (when ${s.when})` : ''} was not completed before merge approval`);
    }
    for (const c of spec.checkpoints) {
      const needed = c.kind === 'mandatory' || evaluateWhen(c.when, facts);
      if (needed && !checkpoints.some((r) => r.checkpoint === c.id && r.outcome === 'passed')) v('WF-CHECKPOINT', `${c.kind} checkpoint "${c.id}"${c.when ? ` (when ${c.when})` : ''} not passed before merge approval`);
    }
  }
  return {
    task: { workItemId, workflow: `${playbook.metadata.id}@${playbook.metadata.version}`, requestedBy: req?.data.requestedBy ?? null, requesterSource: req?.data.requesterSource ?? 'unknown', state, facts, cost, verifyFails, reviewRounds },
    transitions, checkpoints, handoffs, recoveries, violations, warnings,
  };
}

/** Playbook change direction (MET-03, REV-07): anything that weakens a gate or checkpoint is loosening. */
export function classifyPlaybookChange(base, head) {
  const out = [];
  const add = (direction, message) => out.push({ direction, message });
  const RANK = { Low: 0, Medium: 1, High: 2 };
  const bs = base.spec;
  const hs = head.spec;
  for (const c of bs.checkpoints) {
    const h = hs.checkpoints.find((x) => x.id === c.id);
    if (!h) add('loosen', `checkpoint ${c.id} removed`);
    else if (c.kind === 'mandatory' && h.kind !== 'mandatory') add('loosen', `checkpoint ${c.id} made conditional`);
  }
  for (const s of bs.steps) {
    const h = hs.steps.find((x) => x.id === s.id);
    if (!h) add(s.kind === 'optional' ? 'neutral' : 'loosen', `step ${s.id} removed`);
    else if (s.kind === 'mandatory' && h.kind !== 'mandatory') add('loosen', `step ${s.id} is no longer mandatory`);
    else if (s.verification !== h.verification) add('neutral', `step ${s.id} verification changed (review the new criterion)`);
  }
  for (const [k, val] of Object.entries(bs.budgets ?? {})) {
    const hv = hs.budgets?.[k];
    const n = (x) => (typeof x === 'object' ? x?.limit : x);
    if (hv === undefined || n(hv) > n(val)) add('loosen', `budget ${k} raised or removed (${n(val)} → ${n(hv) ?? 'none'})`);
  }
  if (RANK[hs.riskCeiling] > RANK[bs.riskCeiling]) add('loosen', `riskCeiling raised ${bs.riskCeiling} → ${hs.riskCeiling}`);
  for (const h of bs.handoffs ?? []) {
    const n = (hs.handoffs ?? []).find((x) => x.from === h.from && x.to === h.to);
    const dropped = (h.excludeContext ?? []).filter((c) => !(n?.excludeContext ?? []).includes(c));
    if (!n || dropped.length) add('loosen', `handoff ${h.from}→${h.to} ${n ? `no longer excludes ${dropped.join(', ')}` : 'removed'}`);
  }
  return out;
}
