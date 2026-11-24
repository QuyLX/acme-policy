// Showcase and CLI adapter for the GitHub binding cases (SC-03, SC-04, SC-16).
import { readJson, readText, policyPath } from './io.mjs';
import { validate } from './schema.mjs';
import { checkDef, controlFileGlobs } from './registry.mjs';
import { checkResult } from './result.mjs';
import { areasFromCodeowners, toChangeEvent, toSodInput } from './github-event.mjs';
import { attest } from './attest.mjs';
import { evaluateBreakGlass } from './break-glass.mjs';
import { waiverSelfApproval } from '../checks/policy-sod/waiver.mjs';

function result(checkId, status, ruleId, message) {
  return {
    checks: [{
      checkId,
      status,
      findings: ruleId ? [{ ruleId, message }] : [],
    }],
  };
}

export function runBinding(op, fixturePath) {
  const fixture = readJson(policyPath(fixturePath));
  if (op === 'change-event') {
    const event = toChangeEvent(fixture.payload);
    const areas = areasFromCodeowners(fixture.codeowners, event.files);
    const input = toSodInput(event, areas, { tier: fixture.tier });
    const problems = [...validate('change-event', event), ...validate('sod-input', input)];
    const trailer = /Requested-by:\s*(\S+)/.exec(fixture.payload.pull_request?.body ?? '');
    const fromEvent = !trailer || event.requester.id !== trailer[1];
    const ok = problems.length === 0 && fromEvent && event.requester.id === fixture.payload.pull_request.user.login;
    return result('github.requester', ok ? 'PASS' : 'FAIL', ok ? 'github.requester-from-event' : undefined, problems.join('; ') || event.requester.id);
  }
  if (op === 'waiver') {
    const check = waiverSelfApproval(checkDef('policy.sod'), fixture.waiver, fixture.requesterId);
    return { checks: [check] };
  }
  if (op === 'attest') {
    const check = attest(checkDef('provenance.attest'), fixture.run, { pinnedPolicySha: fixture.pinnedPolicySha, headSha: fixture.headSha });
    return { checks: [check] };
  }
  if (op === 'break-glass') {
    const decision = evaluateBreakGlass(fixture.record, { changedPaths: fixture.record.paths, controlGlobs: controlFileGlobs(), now: Date.parse(fixture.now) });
    return result('ops.break-glass', decision.allow ? 'PASS' : 'FAIL', decision.allow ? undefined : 'ops.break-glass', decision.reason);
  }
  if (op === 'verify-absent') {
    return {
      checks: [checkResult(checkDef('policy.sod'), { status: 'NOT_ASSESSED', reason: 'verify job produced no VerificationRun' })],
      requiredUnmet: ['verify'],
    };
  }
  throw new Error(`unknown binding op ${op}`);
}
