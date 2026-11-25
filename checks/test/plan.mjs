// test.plan — the Test Planner produced a valid, deterministic TestPlan, and nobody removed a test from it (FE §8.10
// rules 1, 2 and 5; Standard §7.3 item 5; CORE-VER-01). The plan digest is lifted into the VerificationRun
// (`x-fe-run` → VerificationRun.extensions["x-fe"].testPlan, FE §8.5).
// Status is the outcome; the registry enforcement decides whether it blocks (FE §8.2).
import { checkResult } from '../../lib/result.mjs';
import { validate } from '../../lib/schema.mjs';
import { belowFloor } from '../../lib/test-planner.mjs';
import { planFromRequest } from './request.mjs';

export function testPlanCheck(def, ctx) {
  const started = Date.now();
  if (!ctx.input) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no run request (--input): the planner needs the portfolio index, tier and environment' });
  let p;
  try {
    p = planFromRequest(ctx);
  } catch (err) {
    return checkResult(def, { status: 'ERROR', reason: `planner input: ${err.message}`, extensions: { 'x-fe': { evidenceLayer: 'static', ownership: 'local', lifecycle: def.lifecycle === 'active' ? 'active' : 'shadow', failureAttribution: 'harness' } } });
  }
  try {
    const { plan, request } = p;
    const errors = validate('test-plan', plan);
    if (errors.length) return checkResult(def, { status: 'ERROR', reason: `TestPlan invalid: ${errors.join('; ')}` });
    const removed = belowFloor(plan, request.exclude ?? []);
    const findings = [
      ...removed.map((x) => ({ source: 'check', ruleId: 'TEST-PLAN-BELOW-FLOOR', severity: 'BLOCKER', location: x, message: `${x} is in the plan (${plan.selections.find((s) => `${s.repo}:${s.test}` === x).reasons.join(', ')}); nobody removes a test from the floor (FE §8.10 rule 5)`, state: 'open' })),
      ...plan.unmapped.map((u) => ({ source: 'check', ruleId: 'TEST-PLAN-UNMAPPED', severity: 'INFO', location: u.file, message: `not mapped by the import graph: full suite of ${u.surfaces.join(', ') || 'the repo'} (FE §8.10 rule 2)`, state: 'open' })),
    ];
    return checkResult(def, {
      status: removed.length ? 'FAIL' : 'PASS',
      reason: removed.length ? `${removed.length} floor test(s) excluded from the plan` : undefined,
      findings,
      durationMs: Date.now() - started,
      extensions: {
        'x-plan': plan,
        'x-fe-run': { testPlan: plan.digest, surfaces: [...new Set([...plan.surfaces.direct, ...plan.surfaces.graph])].sort(), sentinelSurfaces: plan.surfaces.sentinel },
      },
    });
  } finally {
    p.cleanup();
  }
}
