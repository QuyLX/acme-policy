// test.e2e-journeys — runs the journey tests the TestPlan selected, for real, with the environment's health probed before
// the run and again after every test (FE §8.8, §8.10; CORE-VER-01). The runner here is `node --test` on the selected
// files of the primary repo (the fixture stands in for the Playwright adapter). Outcomes (FE §8.5):
//   - environment unhealthy / data seed not ready before the run (recorded manifest or live probe) → ERROR,
//     failureAttribution environment | test-data, no test runs.
//   - the live probe (request `healthProbe`) reports the environment unhealthy after a test → ERROR, failureAttribution
//     environment: every failure observed while it is unhealthy is attributed to the environment, never a PR FAIL, and
//     the remaining tests do not run (rerun when healthy). ERROR does not consume the repair budget (FE §8.8, Standard
//     §6.5 / task runner).
//   - a selected journey test fails while the environment is healthy → FAIL, failureAttribution product (the test is
//     unchanged by the PR) or test (the PR changed that test file). Triage may later re-attribute; this is the
//     deterministic first attribution.
//   - the runner itself cannot start → ERROR, failureAttribution harness.
// Consumer-repo selections (portfolio-consumer:…) are part of the plan and its digest but are not executed here: they run
// in the consumer repo's own pipeline.
// The environment (id, kind, manifestDigest) and the plan digest are lifted into the VerificationRun via `x-fe-run`.
import { spawnSync } from 'node:child_process';
import { checkResult } from '../../lib/result.mjs';
import { environmentHealth, planFromRequest, probeHealth } from './request.mjs';

function testEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete env[key];
  return env;
}

export function e2eJourneysCheck(def, ctx) {
  const started = Date.now();
  const lifecycle = def.lifecycle === 'active' ? 'active' : 'shadow';
  const fe = (extra) => ({ evidenceLayer: def.evidenceLayer, ownership: 'local', lifecycle, ...extra });
  if (!ctx.input) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no run request (--input) naming the environment and the plan inputs' });
  let p;
  try {
    p = planFromRequest(ctx);
  } catch (err) {
    return checkResult(def, { status: 'ERROR', reason: `run request: ${err.message}`, extensions: { 'x-fe': fe({ failureAttribution: 'harness' }) } });
  }
  try {
    const { plan, root, primary, manifest, environment } = p;
    const selected = plan.selections.filter((s) => s.repo === primary && s.journeys.length);
    const journeys = [...new Set(selected.flatMap((s) => s.journeys))].sort();
    const run = { testPlan: plan.digest, surfaces: [...new Set([...plan.surfaces.direct, ...plan.surfaces.graph])].sort(), sentinelSurfaces: plan.surfaces.sentinel, ...(environment ? { environment } : {}) };
    const { healthProbe } = p;
    const probe = () => (healthProbe ? probeHealth(healthProbe) : { ok: true });
    const notReady = (health, extra = {}) => checkResult(def, {
      status: 'ERROR',
      reason: `environment ${manifest.environment.id} not ready: ${health.detail}. No test ran; rerun when healthy (FE §8.8)`,
      findings: [{ source: 'check', ruleId: 'ENV-NOT-READY', severity: 'INFO', location: manifest.environment.id, message: health.detail, state: 'open' }],
      durationMs: Date.now() - started,
      extensions: { 'x-fe': fe({ journeys, failureAttribution: health.attribution }), 'x-fe-run': run, 'x-results': [], ...extra },
    });
    const probes = [];
    if (manifest) {
      const recorded = environmentHealth(manifest);
      if (!recorded.ok) return notReady(recorded);
      const live = probe();
      probes.push({ when: 'pre-run', ...live });
      if (!live.ok) return notReady(live, { 'x-probes': probes });
    }
    const changed = new Set(plan.changed);
    const results = [];
    let down = null; // the first probe that found the environment unhealthy after the run started
    for (const s of selected) {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', s.test], { cwd: root, encoding: 'utf8', env: testEnv(), timeout: (def.timeoutSeconds ?? 120) * 1000 });
      if (r.error) return checkResult(def, { status: 'ERROR', reason: `runner could not start: ${r.error.message}`, extensions: { 'x-fe': fe({ journeys, failureAttribution: 'harness' }), 'x-fe-run': run } });
      const status = r.status === 0 ? 'PASS' : 'FAIL';
      // Re-probe after every test: a failure observed while the environment is unhealthy is the environment's.
      const health = manifest ? probe() : { ok: true };
      if (manifest) probes.push({ when: `after ${s.test}`, ...health });
      results.push({
        test: s.test, journeys: s.journeys, status, reasons: s.reasons,
        ...(status === 'FAIL' ? { attribution: health.ok ? (changed.has(s.test) ? 'test' : 'product') : health.attribution } : {}),
        output: status === 'PASS' ? undefined : (r.stdout + r.stderr).split('\n').filter((l) => /not ok|Error|error:|expected|actual/.test(l)).slice(0, 6).join('\n'),
      });
      if (!health.ok) { down = { after: s.test, ...health }; break; }
    }
    const failed = results.filter((r) => r.status === 'FAIL');
    const notRun = selected.slice(results.length).map((s) => s.test);
    const failureFindings = failed.map((r) => ({ source: 'check', ruleId: 'E2E-JOURNEY-FAILED', severity: r.attribution === 'environment' || r.attribution === 'test-data' ? 'INFO' : 'BLOCKER', location: r.test, message: `${r.journeys.join(', ')} failed (selected: ${r.reasons.join(', ')}; attribution: ${r.attribution})${r.output ? `\n${r.output}` : ''}`, state: 'open' }));
    const extensions = (attribution) => ({
      'x-fe': fe({ journeys, ...(attribution ? { failureAttribution: attribution } : {}) }),
      'x-fe-run': run,
      'x-results': results.map(({ output, ...r }) => r),
      ...(probes.length ? { 'x-probes': probes } : {}),
      ...(notRun.length ? { 'x-not-run': notRun } : {}),
    });
    if (down) {
      return checkResult(def, {
        status: 'ERROR',
        reason: `environment ${manifest.environment.id} became unhealthy during the run (after ${down.after}): ${down.detail}. ${failed.length} failure(s) observed while unhealthy are not attributed to the change; ${notRun.length} test(s) not run; rerun when healthy (FE §8.8)`,
        findings: [{ source: 'check', ruleId: 'ENV-UNHEALTHY-MID-RUN', severity: 'INFO', location: manifest.environment.id, message: `after ${down.after}: ${down.detail}`, state: 'open' }, ...failureFindings],
        durationMs: Date.now() - started,
        extensions: extensions(down.attribution),
      });
    }
    const attribution = failed.length ? (failed.some((r) => r.attribution === 'test') ? 'test' : 'product') : undefined;
    return checkResult(def, {
      status: failed.length ? 'FAIL' : 'PASS',
      reason: failed.length ? `${failed.length} journey test(s) failed: ${failed.flatMap((r) => r.journeys).join(', ')}` : undefined,
      findings: failureFindings,
      durationMs: Date.now() - started,
      extensions: extensions(attribution),
    });
  } finally {
    p.cleanup();
  }
}
