// A requester cannot approve a waiver for their own required check (SC-03 requester-own-waiver); evaluateWaiver below
// adds the approver, scope and expiry rules (SC-10).
import { validate } from '../../lib/schema.mjs';
import { checkResult } from '../../lib/result.mjs';
import { matchesAny } from '../../lib/glob.mjs';

export function waiverSelfApproval(def, waiver, requesterId, { agentLogins = [] } = {}) {
  const started = Date.now();
  const errors = validate('waiver', waiver);
  if (errors.length) return checkResult(def, { status: 'ERROR', reason: `invalid waiver: ${errors.join('; ')}`, durationMs: Date.now() - started });
  const approver = waiver.approvedBy.id;
  if (approver === requesterId) {
    return checkResult(def, {
      status: 'FAIL',
      reason: 'the requester approved their own waiver',
      findings: [{ source: 'check', ruleId: 'policy.sod.waiver-self', severity: 'BLOCKER', message: `${approver} approved a waiver they requested`, state: 'open' }],
      durationMs: Date.now() - started,
    });
  }
  if (agentLogins.includes(approver) || approver.startsWith('agent:')) {
    return checkResult(def, {
      status: 'FAIL',
      reason: 'an agent cannot approve a waiver',
      findings: [{ source: 'check', ruleId: 'policy.sod.waiver-self', severity: 'BLOCKER', message: `${approver} is an agent`, state: 'open' }],
      durationMs: Date.now() - started,
    });
  }
  return checkResult(def, { status: 'PASS', durationMs: Date.now() - started });
}

// ---------------------------------------------------------------------------------------------------------------------
// evaluateWaiver — the full waiver rules for a `waived` disposition (Standard §7.5, §9.10 waiver row, K.3 Waiver;
// FE §10.5 waiver approver, FE §8.2 FP SLO). waiverSelfApproval above stays the self/agent part and is reused here.
//   policy.sod.waiver-self       the requester or an agent approved (FE §10.5: never on a BLOCKER check)
//   waiver.approver-not-permitted approver is not the role FE §10.5 names, or (BLOCKER) not a code owner of the area
//   waiver.out-of-scope          wrong check, repo-wide scope, or a finding outside the scope
//   waiver.expiry-too-long       > 14 days while the check is over its FP SLO, > 90 days otherwise (unless the
//                                Frontend Platform Owner approves; never for a baselineable: false check)
//   waiver.expired               now is past expiresAt
export const WAIVER_MAX_DAYS = 90;
export const WAIVER_MAX_DAYS_FP_SLO = 14;
const DAY = 86_400_000;
const UNSCOPED = new Set(['', '*', '**', '**/*', '.', './', '/']);

/** True when a repo path is inside a waiver scope (comma-separated globs or directory prefixes). */
export function inWaiverScope(path, scope) {
  return scope.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean).some((s) => path === s || path.startsWith(`${s}/`) || matchesAny(path, [s]));
}

/** Approver roles FE §10.5 allows for this check and duration. */
export function permittedApproverRoles(check, days) {
  if (!check.baselineable) return ['securityOwner'];
  if (days > WAIVER_MAX_DAYS) return ['platformOwner'];
  return check.checkId.startsWith('ds.') ? ['dsOwner'] : ['techLead'];
}

/**
 * @param def      the policy check that reports the decision (e.g. policy.waiver-approval)
 * @param waiver   K.3 Waiver
 * @param ctx      { check: registry entry of the waived check, result?: its CheckResult, requesterId,
 *                   approvers: { techLead?, dsOwner?, securityOwner?, platformOwner?, codeOwners?: string[] },
 *                   fpSloExceeded?: boolean, now: ISO date, agentLogins?: string[] }
 */
export function evaluateWaiver(def, waiver, { check, result, requesterId, approvers = {}, fpSloExceeded = false, now, agentLogins = [] }) {
  const started = Date.now();
  const self = waiverSelfApproval(def, waiver, requesterId, { agentLogins });
  if (self.status === 'ERROR') return self;
  const findings = [...self.findings];
  const add = (ruleId, message) => findings.push({ source: 'check', ruleId, severity: 'BLOCKER', message, state: 'open' });
  const approver = waiver.approvedBy.id;
  const days = (Date.parse(waiver.expiresAt) - Date.parse(waiver.createdAt)) / DAY;

  const roles = permittedApproverRoles(check, days);
  const allowed = roles.map((r) => approvers[r]).filter(Boolean);
  if (!allowed.includes(approver)) add('waiver.approver-not-permitted', `${approver} may not approve a waiver of ${check.checkId}: FE §10.5 requires ${roles.join(' or ')}${days > WAIVER_MAX_DAYS ? ` for a waiver longer than ${WAIVER_MAX_DAYS} days` : ''}`);
  else if (check.severity === 'BLOCKER' && approvers.codeOwners && !approvers.codeOwners.includes(approver)) {
    add('waiver.approver-not-permitted', `${approver} is not a code owner of the area: a waiver on a BLOCKER check needs an independent code owner (Standard §7.5, §9.10)`);
  }

  const maxDays = fpSloExceeded ? WAIVER_MAX_DAYS_FP_SLO : WAIVER_MAX_DAYS;
  if (fpSloExceeded && days > WAIVER_MAX_DAYS_FP_SLO) add('waiver.expiry-too-long', `${days} days while ${check.checkId} is over its false-positive SLO: at most ${WAIVER_MAX_DAYS_FP_SLO} days (Standard §8.7 rule 5; FE §8.2)`);
  else if (days > WAIVER_MAX_DAYS && (!check.baselineable || approver !== approvers.platformOwner)) add('waiver.expiry-too-long', `${days} days: more than ${WAIVER_MAX_DAYS} days needs the Frontend Platform Owner and is never allowed on a baselineable: false check (FE §10.5)`);
  if (now && Date.parse(now) > Date.parse(waiver.expiresAt)) add('waiver.expired', `expired on ${waiver.expiresAt}`);

  if (waiver.checkId !== check.checkId) add('waiver.out-of-scope', `the waiver is for ${waiver.checkId}, not ${check.checkId}`);
  else if (waiver.scope.split(',').some((s) => UNSCOPED.has(s.trim()))) add('waiver.out-of-scope', `scope "${waiver.scope}" is the whole repository: a waiver is a scoped exception (FE §8.5; Standard §8.7 rule 5)`);
  else {
    for (const f of result?.findings ?? []) {
      if (!f.location || (f.severity !== 'BLOCKER' && f.severity !== 'WARNING')) continue;
      const path = f.location.replace(/:\d+(?::\d+)?$/, '');
      if (!inWaiverScope(path, waiver.scope)) add('waiver.out-of-scope', `${f.location} is outside the waiver scope "${waiver.scope}"`);
    }
  }

  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? `waiver ${waiver.id} is not valid` : undefined,
    findings,
    durationMs: Date.now() - started,
    extensions: { 'x-waiver': { waiverId: waiver.id, checkId: waiver.checkId, days, maxDays, approverRoles: roles, fpSloExceeded } },
  });
}

/** The waived result: a FAIL / NOT_ASSESSED result with a `waived` disposition, only when the approval passed. */
export function applyWaiver(result, waiver, approval) {
  if (approval.status !== 'PASS' || (result.status !== 'FAIL' && result.status !== 'NOT_ASSESSED')) return result;
  return { ...result, disposition: { type: 'waived', waiverId: waiver.id, decidedBy: waiver.approvedBy.id, owner: waiver.owner.id, scope: waiver.scope, expiresAt: waiver.expiresAt } };
}
