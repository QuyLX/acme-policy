// SC-01: a reproduction oracle fails on the base commit, the fix commit makes it pass, the
// VerificationRun is bound to that commit, and policy.sod rejects the author (FE §20.3).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyPath } from './io.mjs';
import { validate } from './schema.mjs';
import { checkDef } from './registry.mjs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';

const GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

function oracleEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete env[key];
  }
  return env;
}

function git(cwd, args) {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function sodInput(headSha, approver) {
  return {
    workItemId: 'SC-01',
    headSha,
    author: 'alice',
    pushers: ['alice'],
    areas: [{ id: 'admin/tenants', teamMembers: ['alice', 'bob'], codeOwners: ['bob'] }],
    controlFilesTouched: [],
    tier: 'Medium',
    requester: { id: 'alice', source: 'issue-command' },
    requesterSignedOff: true,
    approvals: [{ by: approver, commitSha: headSha }],
  };
}

/** @returns {{ checks: Array<{ checkId: string, status: string, findings: Array<{ ruleId: string, message: string }> }> }} */
export function runBugfix({ repo, fix }) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-bugfix-'));
  const problems = [];
  try {
    cpSync(policyPath(repo), dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'base']);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    const before = spawnSync(process.execPath, ['--test', 'src/read.oracle.test.mjs'], { cwd: dir, encoding: 'utf8', env: oracleEnv() });
    if (before.status === 0) problems.push('oracle passed on the base commit');
    git(dir, ['apply', policyPath(fix)]);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fix']);
    const headSha = git(dir, ['rev-parse', 'HEAD']);
    const after = spawnSync(process.execPath, ['--test', 'src/read.oracle.test.mjs'], { cwd: dir, encoding: 'utf8', env: oracleEnv() });
    if (after.status !== 0) problems.push('oracle failed on the fix commit');
    const now = new Date().toISOString();
    const run = {
      schemaVersion: 'aisf/4.0',
      runId: 'sc-01',
      workItemId: 'SC-01',
      channel: 'code',
      subject: { repo: 'admin-tenants', commitSha: headSha, baseSha },
      environment: { executor: 'ci' },
      checks: [{ checkId: 'quality.test', status: 'PASS' }],
      summary: { byStatus: { PASS: 1 }, requiredUnmet: [] },
      provenance: { verifierRef: 'acme-policy@showcase', producer: { name: 'showcase' }, startedAt: now, finishedAt: now },
    };
    const errors = validate('verification-run', run);
    if (errors.length) problems.push(`VerificationRun: ${errors.join('; ')}`);
    if (run.subject.commitSha !== headSha) problems.push('VerificationRun is not bound to the fix commit');
    const author = sodCheck(checkDef('policy.sod'), sodInput(headSha, 'alice'));
    const independent = sodCheck(checkDef('policy.sod'), sodInput(headSha, 'bob'));
    if (author.status !== 'FAIL') problems.push(`author approval status ${author.status}`);
    if (independent.status !== 'PASS') problems.push(`independent approval status ${independent.status}`);
    return {
      checks: [{
        checkId: 'showcase.bugfix',
        status: problems.length ? 'FAIL' : 'PASS',
        findings: [{ ruleId: 'showcase.bugfix', message: problems.join('; ') || `head ${headSha}` }],
      }],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
