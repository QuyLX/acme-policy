// provenance.attest — accept a VerificationRun only when it was produced by the pinned policy SHA (10-ci-cd §3).
import { checkResult } from './result.mjs';

export function attest(def, run, { pinnedPolicySha, headSha }) {
  const started = Date.now();
  const ref = run?.provenance?.verifierRef ?? '';
  const match = /^acme-policy@([0-9a-f]+)$/.exec(ref);
  const findings = [];
  const fail = (message) => findings.push({ source: 'check', ruleId: 'provenance.attest', severity: 'BLOCKER', message, state: 'open' });
  if (!match || !pinnedPolicySha?.startsWith(match[1])) fail(`verifierRef ${ref || '(missing)'} is not the pinned policy SHA`);
  if (run?.subject?.commitSha !== headSha) fail('subject commit is not the pull request head');
  if (run?.environment?.executor !== 'ci') fail('executor is not ci');
  if ((run?.summary?.requiredUnmet ?? []).length) fail('required checks are unmet');
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? findings[0].message : undefined,
    findings,
    durationMs: Date.now() - started,
  });
}
