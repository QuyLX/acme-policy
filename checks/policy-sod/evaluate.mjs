// policy.sod — separation of duties (Standard §9.10; CORE-GOV-05, CORE-GOV-06, CORE-WRK-02).
// Input is platform-neutral (schemas/sod-input.schema.json); the CI adapter builds it from PR events.
// Zero-human merge (A0) is not evaluated: it MUST NOT be enabled in pilot mode (Standard §20.8 item 4.7).
import { validate } from '../../lib/schema.mjs';
import { checkResult } from '../../lib/result.mjs';

/**
 * @returns {{ approvalSlots: object[], independentApprovers: string[], rejectedApprovals: object[], unmet: string[] }}
 */
export function evaluateSod(input) {
  const requesterKnown = Boolean(input.requester.id) && input.requester.source !== 'unknown';
  const excluded = new Set([requesterKnown ? input.requester.id : null, input.author, ...input.pushers].filter(Boolean));

  // Approvals: bound to the head SHA (GOV-06), never from an agent (§9.10 item 1), independent of requester/author/pushers.
  const rejectedApprovals = [];
  const independent = new Set();
  for (const a of input.approvals) {
    if (a.isAgent || a.by.startsWith('agent:')) rejectedApprovals.push({ by: a.by, why: 'an agent MUST NOT be an approver (§9.10 item 1)' });
    else if (a.commitSha !== input.headSha) rejectedApprovals.push({ by: a.by, why: `stale: approved ${a.commitSha}, head is ${input.headSha} (GOV-06)` });
    else if (excluded.has(a.by)) rejectedApprovals.push({ by: a.by, why: 'not independent: requester, PR author or pusher (§9.10)' });
    else independent.add(a.by);
  }

  const ownsAll = requesterKnown && input.areas.every((area) => area.teamMembers.includes(input.requester.id));
  const outsideAreas = input.areas.filter((area) => !requesterKnown || !area.teamMembers.includes(input.requester.id));
  const codeOwnerApproved = (owners) => owners.some((o) => independent.has(o));

  const slots = [];
  const signoffCounts = input.tier === 'Low' && ownsAll && !input.breakerTripped && !input.blockingIntegrityHit;

  if (requesterKnown) {
    slots.push({
      kind: 'requester-signoff',
      countsTowardLevel: signoffCounts,
      satisfied: input.requesterSignedOff === true,
      rule: signoffCounts ? 'Low tier, requester owns every area: sign-off is the one approval' : 'sign-off required but not counted',
    });
  }

  let independentNeeded = 0;
  const ownerScopes = [];
  if (input.tier === 'Low') {
    if (!signoffCounts) ownerScopes.push(...input.areas); // 1 code owner of each affected area
  } else if (input.tier === 'Medium') {
    if (outsideAreas.length === 0) independentNeeded = 1;
    else {
      independentNeeded = 2;
      ownerScopes.push(...outsideAreas);
    }
  } else {
    independentNeeded = 2;
    ownerScopes.push(...input.areas);
  }

  for (let i = 0; i < independentNeeded; i++) {
    slots.push({ kind: 'independent', countsTowardLevel: true, satisfied: independent.size > i, rule: `${independentNeeded} independent approval(s) for tier ${input.tier}` });
  }
  for (const area of ownerScopes) {
    slots.push({ kind: 'code-owner', scope: area.id, countsTowardLevel: true, satisfied: codeOwnerApproved(area.codeOwners), rule: 'independent code owner of the area' });
  }
  for (const file of input.controlFilesTouched) {
    slots.push({ kind: 'control-file-owner', scope: file.path, countsTowardLevel: true, satisfied: codeOwnerApproved(file.owners), rule: 'code owner of the changed control file' });
  }

  const unmet = slots.filter((s) => !s.satisfied).map((s) => `${s.kind}${s.scope ? `(${s.scope})` : ''}`);
  return { approvalSlots: slots, independentApprovers: [...independent], rejectedApprovals, unmet, requesterSource: input.requester.source };
}

/** Validates input, evaluates, and returns a CheckResult. Invalid input is an ERROR, never a PASS. */
export function sodCheck(def, input) {
  const started = Date.now();
  const errors = validate('sod-input', input);
  if (errors.length) {
    return checkResult(def, { status: 'ERROR', reason: `invalid policy.sod input: ${errors.join('; ')}`, durationMs: Date.now() - started });
  }
  const decision = evaluateSod(input);
  const findings = decision.rejectedApprovals.map((r) => ({ source: 'check', ruleId: 'policy.sod', severity: 'INFO', message: `Approval by ${r.by} not counted: ${r.why}`, state: 'open' }));
  return checkResult(def, {
    status: decision.unmet.length ? 'FAIL' : 'PASS',
    reason: decision.unmet.length ? `unmet approval slots: ${decision.unmet.join(', ')}` : undefined,
    findings,
    durationMs: Date.now() - started,
    extensions: { 'x-policy-decision': { workItemId: input.workItemId, tier: input.tier, commitSha: input.headSha, ...decision } },
  });
}
