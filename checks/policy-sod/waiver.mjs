// A requester cannot approve a waiver for their own required check (SC-03 requester-own-waiver).
import { validate } from '../../lib/schema.mjs';
import { checkResult } from '../../lib/result.mjs';

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
