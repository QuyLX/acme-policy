// Autonomy decision (CORE-GOV-05, CORE-GOV-07; Standard §9.5 items 1-11, §9.10; FE §10.4 matrix, §10.6, §19.4).
// DECISION ONLY: A0 MUST NOT be enabled in pilot mode (Standard §20.8 item 4.7). decideAutonomy returns the level the
// policy would apply and, in pilot mode, the level actually applied (A1 instead of A0). Nothing here merges.
import { trippedFor } from './breakers.mjs';

export const LEVELS = ['A0', 'A1', 'A2', 'A3'];
const heavier = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

/**
 * FE §10.4 matrix (stricter than Standard §9.5 item 8 in the R1 cells, FE §18.4). Unknown → worst case (§9.5 item 4).
 * @returns {{ eligibleLevel: string, notEligibleLevel: string }} level when T2 + zero-human conditions hold, and otherwise
 */
export function matrix(subTier, reversibility) {
  const rev = ['HIGH', 'MEDIUM', 'LOW'].includes(reversibility) ? reversibility : 'LOW';
  switch (subTier) {
    case 'R0':
      return rev === 'LOW' ? { eligibleLevel: 'A2', notEligibleLevel: 'A2' } : { eligibleLevel: 'A0', notEligibleLevel: 'A1' };
    case 'R1':
      if (rev === 'HIGH') return { eligibleLevel: 'A0', notEligibleLevel: 'A1' };
      if (rev === 'MEDIUM') return { eligibleLevel: 'A1', notEligibleLevel: 'A2', t2Only: true };
      return { eligibleLevel: 'A3', notEligibleLevel: 'A3' };
    case 'R2':
      return rev === 'LOW' ? { eligibleLevel: 'A3', notEligibleLevel: 'A3' } : { eligibleLevel: 'A2', notEligibleLevel: 'A2' };
    default:
      return { eligibleLevel: 'A3', notEligibleLevel: 'A3' }; // R3 or unknown risk → High
  }
}

/**
 * @param {object} f facts recorded by the policy step for the reviewed SHA
 * @param {'R0'|'R1'|'R2'|'R3'} f.subTier
 * @param {'HIGH'|'MEDIUM'|'LOW'} f.reversibility
 * @param {string} f.taskClass
 * @param {'T0'|'T1'|'T2'} f.trustLevel trust of (task class, agent configuration) from registry/trust.yaml
 * @param {{ id: string|null, source: string, ownsAllSurfaces: boolean }} f.requester
 * @param {Array<{ id: string, zeroHuman: boolean, aiMode: string }>} f.surfaces direct and indirect (FE §10.4)
 * @param {{ openFindings: number, dismissals: number }} f.aiReview
 * @param {number} f.openSecurityFindings
 * @param {boolean} f.deterministicGatesPass all deterministic gates pass on their own (§9.5 item 11.4)
 * @param {Array<{ path: string, trustedMechanism?: boolean }>} f.controlFilesTouched
 * @param {boolean} f.integrityBlockingHit
 * @param {boolean} f.releaseFreeze
 * @param {boolean} [f.localAgent] PR opened by an agent on a developer machine (never A0, FE §10.4)
 * @param {{ breakers: object[] }} breakerState
 * @param {{ pilotMode: boolean }} opts
 */
export function decideAutonomy(f, breakerState, { pilotMode = true } = {}) {
  const surfaceIds = f.surfaces.map((s) => s.id);
  const tripped = trippedFor(breakerState, { surfaces: surfaceIds, taskClass: f.taskClass });
  const requesterKnown = Boolean(f.requester?.id) && f.requester.source !== 'unknown';
  const ownership = requesterKnown && f.requester.ownsAllSurfaces === true;
  const execution = f.trustLevel === 'T2';
  const unmet = [];
  const miss = (ruleId, message) => unmet.push({ ruleId, message });

  // Standard §9.5 item 11, the six zero-human conditions (FE §10.4 specifications in brackets).
  const m = matrix(f.subTier, f.reversibility);
  const c1 = m.eligibleLevel === 'A0' && ownership && execution;
  if (m.eligibleLevel !== 'A0') miss('autonomy.not-a0-cell', `${f.subTier} with ${f.reversibility} reversibility is never A0 (FE §10.4)`);
  if (!ownership) miss('autonomy.not-eligible', 'requester does not own every affected surface (or is unknown): ownership trust fails (§9.5 item 3)');
  if (!execution) miss('autonomy.not-eligible', `trust ${f.trustLevel ?? 'unknown'} for ${f.taskClass}: execution trust needs T2 (§9.5 item 3)`);
  const c2 = f.surfaces.every((s) => s.zeroHuman === true);
  if (!c2) miss('autonomy.not-opted-in', `surface(s) without autonomy.zeroHuman: ${f.surfaces.filter((s) => !s.zeroHuman).map((s) => s.id).join(', ')}`);
  const c3 = f.surfaces.every((s) => s.aiMode === 'blocking') && f.aiReview.openFindings === 0 && f.openSecurityFindings === 0 && f.aiReview.dismissals === 0;
  if (!f.surfaces.every((s) => s.aiMode === 'blocking')) miss('autonomy.ai-review-not-blocking', 'AI review is not in blocking mode on every affected surface (review.aiMode)');
  if (f.aiReview.openFindings || f.openSecurityFindings) miss('autonomy.open-findings', `${f.aiReview.openFindings} open AI finding(s), ${f.openSecurityFindings} open security finding(s)`);
  if (f.aiReview.dismissals) miss('autonomy.dismissal', 'a finding was dismissed on an A0 candidate: moves to A1 (FE §10.4 item 4)');
  const c4 = f.deterministicGatesPass === true;
  if (!c4) miss('autonomy.gates', 'deterministic gates do not all pass on their own (§7.9 item 20)');
  const untrustedControl = f.controlFilesTouched.filter((c) => !c.trustedMechanism);
  const c5 = untrustedControl.length === 0 && !f.integrityBlockingHit;
  if (untrustedControl.length) miss('autonomy.control-file', `control file(s) touched outside a trusted mechanism: ${untrustedControl.map((c) => c.path).join(', ')}`);
  if (f.integrityBlockingHit) miss('autonomy.integrity-hit', 'a blocking integrity sensor fired');
  const budgetBreakers = tripped.filter((b) => b.signal === 'error-budget');
  const otherBreakers = tripped.filter((b) => b.signal !== 'error-budget' && b.effects?.includes('pause-a0'));
  const classBreakers = tripped.filter((b) => b.scope.kind === 'taskClass');
  const c6 = !otherBreakers.length && !budgetBreakers.length && !classBreakers.length && !f.releaseFreeze;
  for (const b of [...otherBreakers, ...classBreakers.filter((b) => !otherBreakers.includes(b))]) miss('autonomy.breaker-tripped', `breaker ${b.id} tripped: ${b.reason}`);
  for (const b of budgetBreakers) miss('autonomy.error-budget', `${b.reason}`);
  if (f.releaseFreeze) miss('autonomy.release-freeze', 'release freeze in effect');
  if (f.localAgent) miss('autonomy.local-agent', 'PR created by an agent on a developer machine: never A0 (Standard §6.15, FE §10.4)');

  const zeroHuman = c1 && c2 && c3 && c4 && c5 && c6 && !f.localAgent;
  let level;
  if (zeroHuman) level = 'A0';
  else if (m.t2Only) level = execution && ownership ? m.eligibleLevel : m.notEligibleLevel;
  else level = m.notEligibleLevel;
  // §9.5 item 2: LOW reversibility already tightens through the matrix; protected categories set floors upstream.
  if (f.floorLevel) level = heavier(level, f.floorLevel);

  // A1 slot (§9.5 item 6, §9.10, FE §10.4): sign-off counts only at R0/R1, owning team, no tripped breaker, no hit.
  const signoffCounts = level === 'A1' && ['R0', 'R1'].includes(f.subTier) && ownership && tripped.filter((b) => b.effects?.includes('signoff-not-counted')).length === 0 && !f.integrityBlockingHit;
  const slots = level === 'A0' ? [] : level === 'A1' ? [signoffCounts ? 'requester-signoff (counts)' : 'code-owner of each affected surface (requester sign-off required, not counted)'] : level === 'A2' ? ['independent code owner'] : ['plan-approval', 'independent code owner', 'independent'];

  const ruleIds = [...new Set(unmet.map((u) => u.ruleId))];
  return {
    level,
    decisionOnly: true,
    zeroHumanConditions: { eligible: c1, optedIn: c2, aiReviewBlockingClean: c3, gatesPass: c4, noControlFileOrIntegrityHit: c5, noBreakerBudgetOrFreeze: c6 },
    unmet: zeroHuman ? [] : unmet,
    ruleIds: zeroHuman ? [] : ruleIds,
    signoffCounts,
    slots,
    trippedBreakers: tripped.map((b) => b.id),
    pilot: pilotMode ? { a0Allowed: false, applied: level === 'A0' ? 'A1' : level, note: 'A0 MUST NOT be enabled in pilot mode (Standard §20.8 item 4.7): decision only' } : { a0Allowed: true, applied: level },
  };
}
