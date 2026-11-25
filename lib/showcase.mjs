// Showcase runner (FE §20.1): scripted, repeatable scenarios that are the acceptance suite of the Factory itself.
// Every case runs the real check code or the real CLI against fixtures; a `pending` case is NOT_ASSESSED, never PASS.
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readText, readYaml, policyPath, POLICY_ROOT } from './io.mjs';
import { validate } from './schema.mjs';
import { checkDef } from './registry.mjs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';
import { runDiffChecks, runPipeline } from './fixture-run.mjs';
import { readEvents, workflowConformanceCheck } from '../checks/workflow/conformance.mjs';
import { classifyPlaybookChange } from './task-runner.mjs';
import { runBinding } from './binding.mjs';
import { runBugfix } from './bugfix-showcase.mjs';
import { MODULE_KINDS } from './modules/index.mjs';

export function loadScenarios(only) {
  const dir = policyPath('showcase', 'scenarios');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const scenario = readYaml(join(dir, f));
      const errors = validate('showcase-scenario', scenario);
      if (errors.length) throw new Error(`showcase/scenarios/${f}: ${errors.join('; ')}`);
      return scenario;
    })
    .filter((s) => !only || s.id === only);
}

function execute(run) {
  if (MODULE_KINDS[run.kind]) return MODULE_KINDS[run.kind](run);
  if (run.kind === 'binding') return runBinding(run.op, run.fixture);
  if (run.kind === 'bugfix') return runBugfix(run);
  if (run.kind === 'integrity') return { checks: runDiffChecks(readText(policyPath(run.diff))) };
  if (run.kind === 'sod') return { checks: [sodCheck(checkDef('policy.sod'), readJson(policyPath(run.input)))] };
  if (run.kind === 'task') {
    const r = workflowConformanceCheck(checkDef('workflow.conformance'), readEvents(policyPath(run.events)), { extraDirs: run.playbooks ? [policyPath(run.playbooks)] : [] });
    return { checks: [r], taskState: r.extensions?.['x-task']?.state };
  }
  if (run.kind === 'generate') {
    const dir = mkdtempSync(join(tmpdir(), 'acme-showcase-gen-'));
    try {
      cpSync(policyPath(run.repo), dir, { recursive: true });
      const args = [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), 'generate', run.generator, run.name, '--repo', dir];
      if (run.checkpoint) args.push('--checkpoint', policyPath(run.checkpoint));
      const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
      return { exitCode: r.status, checks: [{ checkId: 'factory.generate', status: r.status === 0 ? 'PASS' : 'FAIL', findings: [{ ruleId: 'factory.generate', message: (r.stderr || r.stdout).trim() }] }] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (run.kind === 'playbook-change') {
    const changes = classifyPlaybookChange(readYaml(policyPath(run.base)), readYaml(policyPath(run.head)));
    const loosen = changes.filter((c) => c.direction === 'loosen');
    return { checks: [{ checkId: 'workflow.playbook-change', status: loosen.length ? 'FAIL' : 'PASS', findings: changes.map((c) => ({ ruleId: `workflow.${c.direction === 'loosen' ? 'loosening' : c.direction}`, message: c.message })) }] };
  }
  if (run.kind !== 'run') throw new Error(`unknown run kind ${run.kind} (no handler in lib/showcase.mjs or lib/modules)`);
  return runPipeline({ ...run, executor: run.executor ?? 'local' });
}

/** Compares an observed outcome with the expectation; returns a list of mismatches (empty = case passes). */
export function compare(expect, observed) {
  const problems = [];
  const rules = new Set(observed.checks.flatMap((c) => (c.findings ?? []).map((f) => f.ruleId)));
  if (expect.status && observed.checks[0]?.status !== expect.status) problems.push(`status ${observed.checks[0]?.status} ≠ ${expect.status}`);
  for (const rule of expect.rules ?? []) if (!rules.has(rule)) problems.push(`no finding for ${rule}`);
  if (expect.taskState && observed.taskState !== expect.taskState) problems.push(`task state ${observed.taskState} ≠ ${expect.taskState}`);
  if (expect.exitCode !== undefined && observed.exitCode !== expect.exitCode) problems.push(`exit ${observed.exitCode} ≠ ${expect.exitCode}`);
  for (const [id, status] of Object.entries(expect.statuses ?? {})) {
    const got = observed.checks.find((c) => c.checkId === id)?.status;
    if (got !== status) problems.push(`${id} ${got} ≠ ${status}`);
  }
  for (const [path, value] of Object.entries(expect.decision ?? {})) {
    const got = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), observed.decision);
    if (JSON.stringify(got) !== JSON.stringify(value)) problems.push(`decision.${path} ${JSON.stringify(got)} ≠ ${JSON.stringify(value)}`);
  }
  for (const [id, type] of Object.entries(expect.dispositions ?? {})) {
    const got = observed.dispositions?.[id] ?? observed.checks.find((c) => c.checkId === id)?.disposition?.type;
    if (got !== type) problems.push(`${id} disposition ${got} ≠ ${type}`);
  }
  if (expect.requiredUnmet && JSON.stringify([...observed.requiredUnmet].sort()) !== JSON.stringify([...expect.requiredUnmet].sort())) {
    problems.push(`requiredUnmet [${observed.requiredUnmet}] ≠ [${expect.requiredUnmet}]`);
  }
  return problems;
}

/**
 * Cases allowed to stay NOT_ASSESSED (tech-design 13 §6 AC-1). Any other NOT_ASSESSED case fails the suite.
 * - SC-09 visual-baseline-approval: needs a person who is not the author to accept the baselines (D-23).
 * - SC-05 exfiltration-blocked-by-egress: NOT_ASSESSED only on a host without a sandbox backend; CI runs it with Docker.
 */
export const ALLOWED_PENDING = new Set([
  'SC-05.exfiltration-blocked-by-egress',
  'SC-09.visual-baseline-approval',
]);

/** 0 pass, 1 check failure (including an unexpected pending case), 2 infrastructure error. */
export function showcaseExitCode(results) {
  if (results.some((r) => r.status === 'ERROR')) return 2;
  const unexpectedPending = results.some(
    (r) => r.status === 'NOT_ASSESSED' && !ALLOWED_PENDING.has(`${r.scenario}.${r.case}`),
  );
  if (results.some((r) => r.status === 'FAIL') || unexpectedPending) return 1;
  return 0;
}

/** @returns {Array<{ scenario: string, case: string, given: string, status: 'PASS'|'FAIL'|'ERROR'|'NOT_ASSESSED', detail: string }>} */
export function runShowcase({ only } = {}) {
  const results = [];
  for (const scenario of loadScenarios(only)) {
    for (const c of scenario.cases) {
      const base = { scenario: scenario.id, case: c.id, given: c.given };
      if (c.pending) {
        results.push({ ...base, status: 'NOT_ASSESSED', detail: `pending: ${c.pending}` });
        continue;
      }
      try {
        const observed = execute(c.run);
        if (observed.notAssessed) {
          results.push({ ...base, status: 'NOT_ASSESSED', detail: observed.notAssessed });
          continue;
        }
        const problems = compare(c.expect, observed);
        results.push({ ...base, status: problems.length ? 'FAIL' : 'PASS', detail: problems.join('; ') });
      } catch (err) {
        results.push({ ...base, status: 'ERROR', detail: err.message });
      }
    }
  }
  return results;
}
