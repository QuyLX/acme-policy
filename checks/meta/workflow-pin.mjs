// meta.workflow-pin — the product caller and @acme/presets must use the policy checkout that is running
// the check. That checkout's HEAD is the SHA a reusable workflow was called at. A pin passed in tests
// overrides it. registry/github-pin.yaml records the SHA for readers; it cannot name its own commit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { POLICY_ROOT } from '../../lib/io.mjs';

export function policyHeadSha() {
  return execFileSync('git', ['-C', POLICY_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function workflowPinCheck(def, repo, pin) {
  const started = Date.now();
  const sha = pin?.policySha ?? policyHeadSha();
  const findings = [];
  const fail = (location, message) => findings.push({ source: 'check', ruleId: 'meta.workflow-pin', severity: 'BLOCKER', location, message, state: 'open' });
  if (!/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) fail('registry/github-pin.yaml', 'policy SHA is not pinned yet');
  else {
    const workflowPath = join(repo, '.github', 'workflows', 'verify.yml');
    const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';
    const workflowRef = pin?.workflow ?? 'QuyLX/acme-policy/.github/workflows/verify.yml';
    if (!workflow.includes(`@${sha}`)) fail('.github/workflows/verify.yml', `caller does not use ${workflowRef}@${sha}`);
    const pkg = existsSync(join(repo, 'package.json')) ? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) : {};
    const preset = pkg.devDependencies?.['@acme/presets'] ?? pkg.dependencies?.['@acme/presets'] ?? '';
    if (!preset.includes(sha)) fail('package.json', `@acme/presets does not use ${sha}`);
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? findings[0].message : undefined,
    findings,
    durationMs: Date.now() - started,
  });
}
