// Consumer-side result of a `cross-team-contract` check (Standard §8.7 rule 8; §7.5 items 6-8; FE §8.2; CORE-VER-11).
// The behavior is verified in the provider's pipeline, so the consumer can never observe it: the result is always
// NOT_ASSESSED (never converted to PASS, §7.5 item 6). Policy attaches `assessed-elsewhere` only when the provider
// evidence meets every condition (lib/assessed-elsewhere.mjs); otherwise the result blocks and is assigned to fixOwner.
import { resolve } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { evaluateAssessedElsewhere } from '../../lib/assessed-elsewhere.mjs';
import { finding, readInput } from '../../lib/governance-result.mjs';
import { policyPath } from '../../lib/io.mjs';

/**
 * @param {object|null} bundle { providerRun, providerAttestation, deployments, environment, now? } (paths relative to the
 *   policy root). Trust anchors (provider id, pinned policy SHA, signing key) come from `def.params.provider` (Check
 *   Registry), never from the bundle; a bundle field such as `pinnedPolicySha` is ignored.
 */
export function crossTeamContractCheck(def, bundle) {
  const started = Date.now();
  const command = `acme-policy ${def.checkId} (cross-team-contract: assessed in the provider pipeline)`;
  const owner = def.fixOwner ?? def.owner;
  if (def.ownership !== 'cross-team-contract') throw new Error(`${def.checkId} is not a cross-team-contract check`);
  if (!bundle) {
    return checkResult(def, {
      status: 'NOT_ASSESSED',
      command,
      reason: `verified in the provider pipeline; no provider evidence supplied: blocks, assigned to ${owner}`,
      findings: [finding('contract.no-provider-evidence', 'No attested provider run or deployment record', 'BLOCKER')],
    });
  }
  const now = bundle.now ?? new Date().toISOString();
  const read = (p) => readInput(policyPath(p));
  const verdict = evaluateAssessedElsewhere({
    checkId: def.checkId,
    providerRun: read(bundle.providerRun),
    attestation: bundle.providerAttestation ? read(bundle.providerAttestation) : undefined,
    deployments: read(bundle.deployments),
    environment: bundle.environment,
    now,
    freshnessDays: def.params?.freshnessDays ?? 7,
    provider: def.params?.provider,
  });
  const ext = { 'x-cross-team': { fixOwner: owner, deployment: verdict.deployment ?? null, evaluatedAt: now } };
  if (verdict.valid) {
    const ae = verdict.disposition.assessedElsewhere;
    const result = checkResult(def, {
      status: 'NOT_ASSESSED',
      command,
      reason: `assessed elsewhere: provider run ${ae.runId} verified ${ae.providerVersion}, valid until ${ae.validUntil}`,
      durationMs: Date.now() - started,
      extensions: ext,
    });
    return { ...result, disposition: verdict.disposition };
  }
  return checkResult(def, {
    status: 'NOT_ASSESSED',
    command,
    reason: `no valid assessed-elsewhere disposition (${verdict.problems.map((p) => p.ruleId).join(', ')}): blocks, assigned to ${owner}`,
    findings: verdict.problems.map((p) => finding(p.ruleId, p.message, 'BLOCKER')),
    durationMs: Date.now() - started,
    extensions: ext,
  });
}

/** Module-check entry point: `ctx.input` is the provider evidence bundle (YAML). */
export function crossTeamContractModuleCheck(def, ctx) {
  return crossTeamContractCheck(def, ctx.input ? readInput(resolve(ctx.input)) : null);
}
