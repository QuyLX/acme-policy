// Merge queue accountability (Standard §6.4 item 19; FE §11.6; CORE-WRK-06).
// SIMULATED: GitHub Free user-owned repositories have no merge queue. The accountability rule is still decided by an
// operational action, not by judgment: the failing check is rerun with two real `acme-policy run` pipelines on a fixture
// repo, (a) latest main without the change and (b) latest main with the change.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runPipeline } from './fixture-run.mjs';
import { policyPath, POLICY_ROOT } from './io.mjs';

/**
 * Standard §6.4 item 19 table. `a`/`b` are the rerun statuses of the failing check.
 * @returns {{ attribution: string, ruleId: string, consumesBudget: boolean, pauseQueue: boolean, action: string }}
 */
export function attribute({ a, b }) {
  if (a === 'ERROR' || b === 'ERROR' || a === 'NOT_ASSESSED' || (a === 'PASS' && b === 'NOT_ASSESSED')) {
    return { attribution: 'error', ruleId: 'queue.rerun-error', consumesBudget: false, pauseQueue: false, action: 'rerun, then escalate to the check owner (§7.5 items 4-5)' };
  }
  if (a === 'FAIL') return { attribution: 'main-broken', ruleId: 'queue.main-broken', consumesBudget: false, pauseQueue: true, action: 'pause the queue and notify the owner of the change that broke main' };
  if (a === 'PASS' && b === 'FAIL') return { attribution: 'attributed-to-change', ruleId: 'queue.attributed-to-change', consumesBudget: true, pauseQueue: false, action: 'return the change to REPAIRING; it must adapt to main (semantic conflicts included)' };
  if (a === 'PASS' && b === 'PASS') return { attribution: 'flake-candidate', ruleId: 'queue.flake-candidate', consumesBudget: false, pauseQueue: false, action: 'handle per §7.14; if it recurs, hand it to the check owner' };
  throw new Error(`attribute: unexpected statuses a=${a} b=${b}`);
}

/** Writes the concatenation of diffs (applied in order) to a temp file; returns its path relative to the policy root. */
function combine(dir, name, diffs) {
  if (!diffs.length) return undefined;
  const path = join(dir, `${name}.diff`);
  writeFileSync(path, diffs.map((d) => readFileSync(policyPath(d), 'utf8')).join(''));
  return relative(POLICY_ROOT, path);
}

const worst = (checks, ids) => {
  const st = ids.map((id) => checks.find((c) => c.checkId === id)?.status ?? 'NOT_ASSESSED');
  return ['ERROR', 'FAIL', 'NOT_ASSESSED'].find((s) => st.includes(s)) ?? 'PASS';
};

/**
 * One queue attempt for `change` on top of the changes already merged to `main`.
 * @param {{ repo: string, main: Array<{ diff: string, owner?: string }>, change: string, checks: string[],
 *           recordedQueueFailure?: { checkId: string }, proveIndependence?: boolean }} spec paths relative to the policy root
 */
export function simulateQueue({ repo, main = [], change, checks, recordedQueueFailure, proveIndependence = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-queue-'));
  try {
    const mainDiffs = main.map((m) => m.diff);
    const withChange = combine(dir, 'main-with-change', [...mainDiffs, change]);
    const withoutChange = combine(dir, 'main-without-change', mainDiffs);
    const run = (c, ids) => runPipeline({ repo, change: c, checks: ids, executor: 'ci' });
    const out = { runs: {} };
    if (proveIndependence) {
      // Each change passes on its own: the change on the main it was branched from, and main's new change alone.
      out.runs.changeAlone = worst(run(change, checks).checks, checks);
      out.runs.mainAlone = worst(run(withoutChange, checks).checks, checks);
    }
    let failing;
    if (recordedQueueFailure) {
      // Recorded: the queue run failed on this check; the reruns below are real.
      out.runs.queue = { status: 'FAIL', recorded: true, checkId: recordedQueueFailure.checkId };
      failing = [recordedQueueFailure.checkId];
    } else {
      const q = run(withChange, checks);
      failing = q.checks.filter((c) => c.status !== 'PASS').map((c) => c.checkId);
      out.runs.queue = { status: worst(q.checks, checks), recorded: false };
      if (!failing.length) return { ...out, attribution: 'passed', ruleId: 'queue.passed', consumesBudget: false, pauseQueue: false, action: 'merge', failing: [] };
    }
    const a = worst(run(withoutChange, failing).checks, failing);
    const b = a === 'FAIL' ? undefined : worst(run(withChange, failing).checks, failing);
    out.runs.a = a;
    if (b !== undefined) out.runs.b = b;
    const verdict = attribute({ a, b });
    const notify = verdict.attribution === 'main-broken' ? [...new Set(main.map((m) => m.owner).filter(Boolean))] : [];
    return { ...out, ...verdict, failing, notify };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** TaskEvents for one queue attempt (consumed by deriveTask through lib/queue-events.mjs). */
export function queueEvents(workItemId, result, at) {
  const t = new Date(at);
  const stamp = (s) => new Date(t.getTime() + s * 1000).toISOString();
  const actor = { id: 'ci:merge-queue', kind: 'ci' };
  return [
    { workItemId, at: stamp(0), actor, type: 'queue.entered', data: {} },
    { workItemId, at: stamp(1), actor, type: 'queue.result', data: { attribution: result.attribution, checkId: result.failing?.[0], runs: result.runs, notify: result.notify ?? [], simulated: true } },
  ];
}
