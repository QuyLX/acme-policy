// Group "knowledge" of tech-design 13 (showcase completion): SC-17, SC-18, SC-20.
// Each group owns this file only; lib/modules/index.mjs merges the four groups and rejects duplicate keys.
//
// KINDS  — showcase run kinds: (run) => observed, where observed is
//          { checks: CheckResult[], exitCode?, requiredUnmet?, taskState?, decision?, dispositions?, notAssessed? }.
//          `notAssessed: '<reason>'` reports the case NOT_ASSESSED (never PASS) when the harness cannot observe the layer
//          (Standard §8.7 rule 3).
// CHECKS — registry checks without an adapter or command: (def, ctx) => CheckResult, where ctx is
//          { repo?, base?, changed?, diff?, readFile?, config?, executor?, input? } (`input` is a file path).
//
// Every kind runs the real library or check code on recorded inputs; nothing here decides an outcome by itself.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readYaml, policyPath, POLICY_ROOT } from '../io.mjs';
import { validate } from '../schema.mjs';
import { checkDef } from '../registry.mjs';
import { checkResult } from '../result.mjs';
import { selectionLines } from '../test-planner.mjs';
import { citationComplete, indexFromSourcesFile, repoPins, search } from '../knowledge-index.mjs';
import { gardenKnowledge } from '../knowledge-gardening.mjs';
import { testPlanCheck } from '../../checks/test/plan.mjs';
import { e2eJourneysCheck } from '../../checks/test/e2e-journeys.mjs';
import { loadRequest, prepareCopy } from '../../checks/test/request.mjs';
import { retrievalCheck, retrievalProblems } from '../../checks/knowledge/retrieval.mjs';
import { basisCheck } from '../../checks/knowledge/basis.mjs';
import { knowledgeImpactCheck, loadArtifacts } from '../../checks/knowledge-impact/impact.mjs';
import { readEvents, workflowConformanceCheck } from '../../checks/workflow/conformance.mjs';

export const CHECKS = {
  'test.plan': testPlanCheck,
  'test.e2e-journeys': e2eJourneysCheck,
  'knowledge.retrieval': retrievalCheck,
  'knowledge.basis': basisCheck,
};

const pseudo = (checkId, status, findings, extensions) => ({ checkId, status, findings, ...(extensions ? { extensions } : {}) });
const conformance = (events, knowledgeIndex) => workflowConformanceCheck(checkDef('workflow.conformance'), events, { knowledgeIndex });
const lastAt = (events) => events.map((e) => e.at).sort().pop();
const later = (at, s) => new Date(Date.parse(at) + s * 1000).toISOString().replace('.000Z', 'Z');

/** SC-17: the TestPlan for a run request (lib/test-planner.mjs through the test.plan check). */
function testPlanKind(run) {
  const r = testPlanCheck(checkDef('test.plan'), { input: policyPath(run.request) });
  const plan = r.extensions?.['x-plan'];
  return { checks: [r], decision: plan ? { selected: selectionLines(plan), surfaces: plan.surfaces, unmapped: plan.unmapped.map((u) => u.file), digest: plan.digest } : {} };
}

/**
 * SC-17: the real pipeline (`acme-policy run --checks test.plan,test.e2e-journeys`) on a temp git copy of the fixture
 * monorepo with the change applied, then the task runner on the verify outcome (ERROR never consumes repair budget).
 * Staging does not exist: its stand-in is a temp directory holding the environment's health document (a copy of the
 * request's `healthProbe`, which becomes the run's live probe) and the request's recorded `stagingOutage`, if any. The
 * fixture's tenants-api client (apps/admin/test/support/tenants-api.mjs) uses it through STAGING_STANDIN_DIR.
 */
function crossSurfaceRunKind(run) {
  const reqPath = policyPath(run.request);
  const { request } = loadRequest(reqPath);
  const ws = prepareCopy(policyPath(request.repo), request.change && policyPath(request.change));
  const tmp = mkdtempSync(join(tmpdir(), 'acme-sc17-'));
  try {
    const standIn = join(tmp, 'staging');
    mkdirSync(standIn);
    if (request.healthProbe) writeFileSync(join(standIn, 'health.json'), readFileSync(policyPath(request.healthProbe), 'utf8'));
    if (request.stagingOutage) writeFileSync(join(standIn, 'outage.json'), JSON.stringify(request.stagingOutage));
    const pipelineRequest = join(tmp, 'request.json');
    writeFileSync(pipelineRequest, JSON.stringify({ primary: request.primary, portfolio: policyPath(request.portfolio), environment: request.environment && policyPath(request.environment), healthProbe: request.healthProbe && join(standIn, 'health.json'), tier: request.tier }));
    const r = spawnSync(process.execPath, [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), 'run', '--repo', ws.root, '--base', 'HEAD', '--checks', 'test.plan,test.e2e-journeys', '--input', pipelineRequest], { encoding: 'utf8', env: { ...process.env, FACTORY_EXECUTOR: 'ci', ...(request.healthProbe ? { STAGING_STANDIN_DIR: standIn } : {}) }, maxBuffer: 64 * 1024 * 1024 });
    if (!r.stdout) throw new Error(`acme-policy run produced no output: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
    const vr = JSON.parse(r.stdout);
    const e2e = vr.checks.find((c) => c.checkId === 'test.e2e-journeys');
    const plan = vr.checks.find((c) => c.checkId === 'test.plan');
    // The verify step of the task carries the e2e outcome as the binding would record it.
    const events = readEvents(policyPath(run.events));
    events.push({ workItemId: events[0].workItemId, at: later(lastAt(events), 60), actor: { id: 'agent:verifier-1', kind: 'agent' }, type: 'step.completed', data: { step: 'verify', status: e2e.status } });
    const task = conformance(events);
    return {
      exitCode: r.status,
      checks: [...vr.checks, task],
      taskState: task.extensions['x-task'].state,
      decision: {
        evidence: {
          schemaErrors: validate('verification-run', vr),
          testPlan: vr.extensions?.['x-fe']?.testPlan,
          planMatches: vr.extensions?.['x-fe']?.testPlan === plan.extensions['x-plan'].digest,
          environment: vr.environment,
          failureAttribution: e2e.extensions?.['x-fe']?.failureAttribution ?? null,
          failed: (e2e.extensions?.['x-results'] ?? []).filter((x) => x.status === 'FAIL').flatMap((x) => x.journeys),
          ran: (e2e.extensions?.['x-results'] ?? []).map((x) => `${x.test} ${x.status}${x.attribution ? ` ${x.attribution}` : ''}`),
          notRun: e2e.extensions?.['x-not-run'] ?? [],
          probes: (e2e.extensions?.['x-probes'] ?? []).map((x) => `${x.when}: ${x.ok ? 'healthy' : `unhealthy (${x.attribution})`}`),
        },
        task: { verifyFails: task.extensions['x-task'].verifyFails, state: task.extensions['x-task'].state },
      },
    };
  } finally {
    ws.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** SC-18: a Knowledge Index query (lib/knowledge-index.mjs), evaluated against the retrieval rules; conflicts become
 *  `knowledge.conflict` task events and the task runner decides the state. */
function knowledgeSearchKind(run) {
  const index = indexFromSourcesFile(policyPath(run.sources), policyPath);
  const pins = repoPins(policyPath(run.repo));
  const answer = search(index, run.query, { requester: run.requester, pins, includeDraft: run.includeDraft, now: run.now, workItemId: run.workItemId });
  const problems = retrievalProblems(index, pins, run.requester, { id: run.query, query: run.query, expect: run.expectSources }, answer.results);
  const retrieval = checkResult(checkDef('knowledge.retrieval'), {
    status: problems.length ? 'FAIL' : 'PASS',
    reason: problems.length ? problems.map((p) => p.ruleId).join(', ') : undefined,
    findings: problems.map((p) => ({ source: 'check', severity: 'BLOCKER', state: 'open', ...p })),
  });
  const conflictErrors = answer.conflicts.flatMap((c) => validate('knowledge-conflict', c));
  const checks = [retrieval, pseudo('knowledge.conflict', answer.conflicts.length ? 'FAIL' : 'PASS', answer.conflicts.map((c) => ({ ruleId: 'KNW-CONFLICT', message: `${c.sources.map((s) => s.ref.split(' ')[0]).join(' vs ')} → ${c.authority}` })))];
  let taskState;
  if (run.taskEvents) {
    const events = readEvents(policyPath(run.taskEvents));
    answer.conflicts.forEach((c, i) => events.push({ workItemId: events[0].workItemId, at: later(lastAt(events), i + 1), actor: { id: 'ci:knowledge-index', kind: 'ci' }, type: 'knowledge.conflict', data: c }));
    const task = conformance(events);
    checks.push(task);
    taskState = task.extensions['x-task'].state;
  }
  return {
    checks,
    taskState,
    decision: {
      results: answer.results.map((r) => `${r.id}@${r.version} ${r.status}${r.marker ? ` ${r.marker}` : ''}`),
      citations: answer.results.map((r) => r.cite),
      citationsComplete: answer.results.every(citationComplete),
      untrusted: answer.results.every((r) => r.trust === 'untrusted-data'),
      builtAt: answer.builtAt,
      conflicts: answer.conflicts.map((c) => c.id),
      conflictRecordErrors: conflictErrors,
      indexed: Object.keys(index.artifacts).sort(),
    },
  };
}

/** Runs one of this group's registry checks on an input file (the same call `acme-policy run --input` makes). */
function knowledgeCheckKind(run) {
  const r = CHECKS[run.check](checkDef(run.check), { input: policyPath(run.input) });
  return { checks: [r], decision: { conflicts: (r.extensions?.['x-conflicts'] ?? []).map((c) => c.id), answers: r.extensions?.['x-answers'] } };
}

/**
 * SC-20: knowledge.impact v2 on a temp git copy of the repo with the change applied, with the same inputs the
 * `acme-policy run` pipeline gives it: the owner catalog is read from the base commit (git show HEAD:<path>; the change
 * is uncommitted) and `approvals` is the PR approval input (policy.sod input shape, `--sod-input`). `mode: default`
 * evaluates the check at its registry targetEnforcement (the registry entry stays `warn` in pilot mode), which the
 * pipeline cannot do; hence the direct call.
 */
function knowledgeImpactKind(run) {
  const registryDef = checkDef('knowledge.impact');
  const def = run.mode === 'default' ? { ...registryDef, enforcement: registryDef.targetEnforcement } : registryDef;
  const ws = prepareCopy(policyPath(run.repo), run.change && policyPath(run.change));
  try {
    const readFile = (side, path) => {
      if (side === 'head') return existsSync(join(ws.root, path)) ? readFileSync(join(ws.root, path), 'utf8') : null;
      const r = spawnSync('git', ['show', `HEAD:${path}`], { cwd: ws.root, encoding: 'utf8' });
      return r.status === 0 ? r.stdout : null;
    };
    const pr = run.approvals ? readJson(policyPath(run.approvals)) : undefined;
    const r = knowledgeImpactCheck(def, ws.root, ws.changed, { readFile, approvals: pr && { headSha: pr.headSha, approvals: pr.approvals } });
    const records = r.extensions['x-reconciliation'];
    return {
      checks: [r],
      decision: {
        enforcement: def.enforcement,
        affected: Object.fromEntries(r.extensions['x-affected'].map((a) => [a.id, `${a.reconciliation} ${r.findings.find((f) => f.location === a.path).severity}`])),
        reconciliationRecords: records.map((x) => `${x.id} ${x.valid ? 'valid' : 'invalid'}`),
      },
    };
  } finally {
    ws.cleanup();
  }
}

/**
 * SC-20: an implementer edits an AC in journeys.yaml. The real pipeline (`acme-policy run --checks
 * integrity.oracle-lock`) runs on a temp git copy of the repo with the change applied; oracle-lock emits the
 * KnowledgeConflict records (extensions["x-knowledge-conflicts"]). As the binding would, each emitted record becomes a
 * `knowledge.conflict` task event; the task runner decides the state. Nothing here builds a conflict.
 */
function acEditKind(run) {
  const events = readEvents(policyPath(run.events));
  const workItemId = events[0].workItemId;
  const ws = prepareCopy(policyPath(run.repo), policyPath(run.change));
  try {
    const r = spawnSync(process.execPath, [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), 'run', '--repo', ws.root, '--base', 'HEAD', '--checks', 'integrity.oracle-lock'], { encoding: 'utf8', env: { ...process.env, FACTORY_EXECUTOR: 'ci', FACTORY_WORK_ITEM: workItemId }, maxBuffer: 64 * 1024 * 1024 });
    if (!r.stdout) throw new Error(`acme-policy run produced no output: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
    const vr = JSON.parse(r.stdout);
    const lock = vr.checks.find((c) => c.checkId === 'integrity.oracle-lock');
    const conflicts = lock.extensions?.['x-knowledge-conflicts'] ?? [];
    conflicts.forEach((c, i) => events.push({ workItemId, at: later(lastAt(events), i + 1), actor: { id: 'ci:policy', kind: 'ci' }, type: 'knowledge.conflict', data: c }));
    const task = conformance(events);
    return {
      exitCode: r.status,
      checks: [...vr.checks, task],
      taskState: task.extensions['x-task'].state,
      decision: { conflicts: conflicts.map((c) => c.id), conflictRecordErrors: conflicts.flatMap((c) => validate('knowledge-conflict', c)), taskConflicts: (task.extensions['x-basis']?.knowledgeConflicts ?? []).map((c) => c.id) },
    };
  } finally {
    ws.cleanup();
  }
}

/** SC-20: gardening flags an ownerless runbook; the task runner then judges a task basis against the gardened state. */
function gardeningKind(run) {
  const records = loadArtifacts(policyPath(run.records), ['docs/**/*.md']).filter((a) => !a.errors.length);
  const { owners, now } = readYaml(policyPath(run.owners));
  const g = gardenKnowledge(records, { owners, now, runId: 'garden-1' });
  const checks = [pseudo('knowledge.gardening', 'PASS', [
    ...g.transitions.map((t) => ({ ruleId: 'KNW-GARDEN-NEEDS-REVALIDATION', message: `${t.artifact}: ${t.from} → ${t.to} (${t.reason})` })),
    ...g.proposals.map((p) => ({ ruleId: 'KNW-GARDEN-PROPOSAL', message: `${p.artifact}: ${p.proposal} (${p.reason})` })),
  ])];
  let taskState;
  if (run.events) {
    const task = conformance(readEvents(policyPath(run.events)), g.statuses);
    checks.push(task);
    taskState = task.extensions['x-task'].state;
  }
  return {
    checks,
    taskState,
    decision: {
      transitions: g.transitions.map((t) => `${t.artifact} ${t.from}→${t.to}`),
      statuses: Object.fromEntries(Object.entries(g.statuses).map(([id, s]) => [id, s.status])),
      reconciliation: g.reconciliation.map((r) => `${r.id} ${r.affected.map((a) => `${a.decision}/${a.state}`).join(',')}`),
      proposals: g.proposals.map((p) => `${p.artifact} ${p.proposal}`),
    },
  };
}

export const KINDS = {
  'test-plan': testPlanKind,
  'cross-surface-run': crossSurfaceRunKind,
  'knowledge-search': knowledgeSearchKind,
  'knowledge-check': knowledgeCheckKind,
  'knowledge-impact': knowledgeImpactKind,
  'knowledge-ac-edit': acEditKind,
  'knowledge-gardening': gardeningKind,
};
