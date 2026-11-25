// workflow.conformance — a task's event log follows its playbook (tech-design 11 Part B; Standard §6.4-6.7,
// §6.12-6.14; FE §9.10-9.12). Optional until the platform binding (M3) produces events for every PR.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readYaml, policyPath } from '../../lib/io.mjs';
import { validate } from '../../lib/schema.mjs';
import { deriveTask } from '../../lib/task-runner.mjs';
import { checkResult } from '../../lib/result.mjs';

export function readEvents(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Finds `<id>@<version>` among the central playbooks (and extra dirs, used by fixtures only). */
export function loadPlaybook(ref, extraDirs = []) {
  const [id, version] = ref.split('@');
  for (const dir of [policyPath('workflows'), ...extraDirs]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      const pb = readYaml(join(dir, f));
      if (pb.metadata?.id === id && (!version || pb.metadata.version === version || pb.metadata.version.split('.')[0] === version)) return pb;
    }
  }
  return null;
}

export function workflowConformanceCheck(def, events, { extraDirs = [], flakyRegistry, knowledgeIndex } = {}) {
  const started = Date.now();
  const bad = events.flatMap((e, i) => validate('task-event', e).map((m) => `event #${i + 1}: ${m}`));
  if (bad.length) return checkResult(def, { status: 'ERROR', reason: `invalid task events: ${bad.slice(0, 5).join('; ')}` });
  const ref = events.find((e) => e.type === 'task.requested')?.data.workflow;
  const playbook = ref && loadPlaybook(ref, extraDirs);
  if (!playbook) return checkResult(def, { status: 'FAIL', reason: `no playbook ${ref ?? '(task.requested missing)'}: a task class runs only on a registered playbook (CORE-WRK-07)` });
  const taskClass = readYaml(policyPath('registry', 'task-classes.yaml')).taskClasses.find((t) => t.playbook.split('@')[0] === playbook.metadata.id);
  const d = deriveTask(events, playbook, { policyCost: taskClass?.budgets?.cost?.limit, flakyRegistry, knowledgeIndex });
  return checkResult(def, {
    status: d.violations.length && def.enforcement === 'blocking' ? 'FAIL' : 'PASS',
    reason: d.violations.length ? d.violations.map((x) => `${x.code}: ${x.message}`).join('; ') : undefined,
    findings: [
      ...d.violations.map((x) => ({ source: 'check', ruleId: x.code, severity: 'BLOCKER', location: d.task.workItemId, message: x.message, state: 'open' })),
      ...d.warnings.map((w) => ({ source: 'check', ruleId: 'WF-NOTICE', severity: 'INFO', location: d.task.workItemId, message: w, state: 'open' })),
    ],
    durationMs: Date.now() - started,
    extensions: { 'x-task': d.task, 'x-handoffs': d.handoffs.map((h) => ({ from: h.from.role, to: h.to.role, status: h.status, problems: h.problems })), 'x-checkpoints': d.checkpoints.length, 'x-recoveries': d.recoveries, 'x-basis': { basis: d.basis, basisChanges: d.basisChanges, knowledgeConflicts: d.knowledgeConflicts } },
  });
}
