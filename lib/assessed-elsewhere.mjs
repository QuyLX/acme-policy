// `assessed-elsewhere` disposition for cross-team-contract checks (CORE-VER-11).
// Standard §7.5 item 7: decided by policy, only on NOT_ASSESSED, when (1) the provider run is attested, (2) the version
// it verified is the version deployed, or about to be deployed, to the target environment, and (3) the run is within
// the profile's freshness window. FE §8.2 (08-verification.md): validity ≤ 7 days or until the provider's next deploy,
// whichever comes first; otherwise NOT_ASSESSED blocks and is assigned to `fixOwner`. Standard §8.7 rule 8; K.2.
//
// What is real and what is simulated:
// - The trust anchors come from the Check Registry (`params.provider` of the check: provider id, the policy SHA its
//   pipeline must run, the Ed25519 public key of its CI signer), never from the evidence bundle.
// - (1) The Ed25519 signature over the canonical JSON of the provider VerificationRun is verified for real
//   (node:crypto) against the registry key. SIMULATED: the signer. The key pair is synthetic, generated once to sign
//   the recorded fixtures and then discarded; there is no provider pipeline, key distribution or rotation here.
//   provenance.attest (lib/attest.mjs) then checks verifierRef against the registry's pinned SHA, executor ci, nothing
//   required unmet, and that the run's subject commit equals the commit of the relevant deployment record.
// - (2) The deployment record (what the provider runs, or is about to run) is the independent source of the commit and
//   version the run must have verified. RECORDED: deployment records are fixtures validated against their schema; a real
//   binding reads them from the deploy broker. Their authenticity is not verified here.
import { createPublicKey, verify } from 'node:crypto';
import { validate } from './schema.mjs';
import { attest } from './attest.mjs';

const DAY = 86400000;
export const POLICY_REF = 'Standard §7.5 item 7; FE 4.1 §8.2 cross-team-contract (≤ 7 days or until the next provider deploy)';

/**
 * The provider version that matters for the consumer: a pending deployment (about to be deployed) wins over the
 * current one, because the consumer change will run against it. Records after `now` are ignored.
 */
export function relevantDeployment(records, environment, now) {
  const env = records.filter((r) => r.environment === environment && Date.parse(r.at) <= now).sort((a, b) => a.at.localeCompare(b.at));
  const pending = env.filter((r) => r.status === 'pending').at(-1);
  const deployed = env.filter((r) => r.status === 'deployed').at(-1);
  return pending && (!deployed || pending.at >= deployed.at) ? pending : deployed;
}

/** Canonical JSON (keys sorted recursively): the byte string the provider signs. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Verifies the provider's Ed25519 signature over the run with the registry key. @returns {string|null} problem */
export function verifyProviderSignature(providerRun, attestation, key) {
  if (!key?.publicKey || key.alg !== 'ed25519') return 'no provider attestation key in the Check Registry';
  if (!attestation?.signature) return 'no provider signature';
  if (attestation.alg !== 'ed25519' || (key.keyId && attestation.keyId !== key.keyId)) return `signature key ${attestation.keyId ?? '?'} (${attestation.alg ?? '?'}) is not the registered ${key.keyId} (ed25519)`;
  const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(canonicalJson(providerRun)), pub, Buffer.from(attestation.signature, 'base64')) ? null : 'signature does not verify over the recorded run';
}

/**
 * @param {{ checkId: string, providerRun: object, attestation?: object, deployments: object[], environment: string,
 *           now: string, freshnessDays: number,
 *           provider: { id: string, pinnedPolicySha: string, attestationKey: { keyId: string, alg: string, publicKey: string } } }} args
 *   `provider` comes from the Check Registry (the check's params), never from the evidence bundle
 * @returns {{ valid: boolean, disposition?: object, problems: Array<{ ruleId: string, message: string }>, deployment?: object }}
 */
export function evaluateAssessedElsewhere({ checkId, providerRun, attestation, deployments, environment, now, freshnessDays, provider }) {
  const nowMs = Date.parse(now);
  const problems = [];
  const add = (ruleId, message) => problems.push({ ruleId, message });

  if (!provider?.id || !provider.pinnedPolicySha) add('contract.no-trust-anchor', `${checkId}: the Check Registry declares no provider trust anchor (params.provider)`);
  const runErrors = validate('verification-run', providerRun);
  if (runErrors.length) add('contract.invalid-evidence', `provider VerificationRun invalid: ${runErrors.slice(0, 3).join('; ')}`);
  for (const [i, d] of deployments.entries()) for (const e of validate('deployment-record', d)) add('contract.invalid-evidence', `deployment #${i + 1}: ${e}`);
  if (problems.length) return { valid: false, problems };

  // (2) first: the independent source of the commit the run must have verified. Only records of the registered provider.
  const deployment = relevantDeployment(deployments.filter((d) => d.provider === provider.id), environment, nowMs);
  if (!deployment) add('contract.no-deployment', `no deployment record of ${provider.id} in ${environment}`);
  else if (deployment.commitSha !== providerRun.subject.commitSha) {
    add('contract.version-mismatch', `${environment} runs (or is about to run) provider ${deployment.version} @ ${deployment.commitSha.slice(0, 12)} (${deployment.status} ${deployment.at}), but run ${providerRun.runId} verified ${providerRun.subject.commitSha.slice(0, 12)}`);
  }

  // (1) attested: signed by the registered provider key, produced by the registered pinned policy SHA, executor ci,
  // nothing required unmet, and its subject is the deployment's commit (lib/attest.mjs; headSha from the deployment).
  const sigProblem = verifyProviderSignature(providerRun, attestation, provider.attestationKey);
  if (sigProblem) add('contract.not-attested', `provider run ${providerRun.runId}: ${sigProblem}`);
  if (deployment) {
    const att = attest({ checkId: 'provenance.attest', checkVersion: '1.0.0' }, providerRun, { pinnedPolicySha: provider.pinnedPolicySha, headSha: deployment.commitSha });
    const other = att.findings.filter((f) => !/subject commit/.test(f.message)); // a subject mismatch is contract.version-mismatch above
    if (other.length) add('contract.not-attested', `provider run ${providerRun.runId} is not attested: ${other.map((f) => f.message).join('; ')}`);
  }
  const own = providerRun.checks.find((c) => c.checkId === checkId);
  if (own?.status !== 'PASS') add('contract.provider-not-pass', `provider run ${providerRun.runId} has ${checkId} ${own?.status ?? 'missing'}, not PASS`);

  // (3) freshness: ≤ freshnessDays since the run finished; a later deploy of another version already fails (2).
  const finished = Date.parse(providerRun.provenance.finishedAt);
  const validUntilMs = finished + freshnessDays * DAY;
  if (nowMs > validUntilMs) add('contract.stale', `run ${providerRun.runId} finished ${providerRun.provenance.finishedAt}: ${((nowMs - finished) / DAY).toFixed(1)} days old > ${freshnessDays} days`);

  if (problems.length) return { valid: false, problems, deployment };
  return {
    valid: true,
    problems,
    deployment,
    disposition: {
      type: 'assessed-elsewhere',
      decidedBy: 'policy',
      decidedAt: new Date(nowMs).toISOString(),
      policyRef: POLICY_REF,
      assessedElsewhere: { runId: providerRun.runId, providerVersion: deployment.version, validUntil: new Date(validUntilMs).toISOString() },
    },
  };
}
