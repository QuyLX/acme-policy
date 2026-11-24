// One CheckResult per integrity sensor (Standard §7.13 items 15-22, 38).
//   blocking + hit → FAIL (except control-file-change: its resolution is an approval, enforced by policy.sod)
//   warn → PASS with findings shown to the approver; observe-level hits → INFO findings, never FAIL.
import { checkResult } from '../../lib/result.mjs';

const GATED_BY_APPROVAL = new Set(['integrity.control-file-change']);

export function sensorCheck(def, hits) {
  const own = hits.filter((h) => h.checkId === def.checkId);
  const counted = own.filter((h) => h.level !== 'observe');
  const blocks = def.enforcement === 'blocking' && counted.length > 0 && !GATED_BY_APPROVAL.has(def.checkId);
  return checkResult(def, {
    status: blocks ? 'FAIL' : 'PASS',
    reason: blocks ? `${counted.length} hit(s)` : undefined,
    findings: own.map((h) => ({
      source: 'integrity',
      ruleId: h.ruleId ?? def.checkId,
      severity: h.level === 'observe' || def.enforcement === 'observe' ? 'INFO' : def.enforcement === 'blocking' ? 'BLOCKER' : 'WARNING',
      location: h.location,
      message: h.message,
      state: 'open',
    })),
    extensions: def.checkId === 'integrity.control-file-change' ? { 'x-control-files-touched': [...new Set(own.map((h) => h.location))] } : undefined,
  });
}

export function mutationScoreCheck(def) {
  return checkResult(def, {
    status: 'NOT_ASSESSED',
    reason: 'mutation testing on changed lines runs nightly at observe once Stryker is wired (FE §8.6, §15.3); not run in this pipeline',
  });
}
