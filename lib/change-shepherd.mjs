// Change Shepherd action policy (CORE-OPS-04; Standard §12.2.1 items 8-10, §12.6 item 2.4; FE §11.4, §11.7).
// Evaluates actions the Shepherd attempts against its role (agents/roles/change-shepherd.yaml), the audited tool
// catalog (agents/sandbox.yaml) and the flag registry: only returning a flag to its declared safeState and pausing a
// rollout may be automated, for Low/Medium tiers (R0-R2), tied to an open alert or incident. Turning off a
// `safeState: on` flag removes a security, privacy or legal control: R3 loosening, needs the security owner (FE §11.4).
// SIMULATED: no flag provider or rollout system exists; actions are recorded requests, decided here and audited.
import { readYaml, policyPath } from './io.mjs';

const HUMAN_ONLY = {
  'artifact.rollback': 'artifact rollback',
  'git.revert-main': 'revert on main',
  'data.recover': 'recovery affecting data',
};

export function shepherdRole() {
  return readYaml(policyPath('agents', 'roles', 'change-shepherd.yaml'));
}

/**
 * @param {{ tool: string, flag?: string, value?: string, rollout?: string, alert?: string, incident?: string, at: string }} action
 * @param {{ tier: 'R0'|'R1'|'R2'|'R3', flags: Array<{ id: string, safeState: 'on'|'off' }>, role?: object, catalog?: object }} ctx
 * @returns {{ allowed: boolean, problems: Array<{ ruleId: string, message: string }>, audit: object, taskState?: string }}
 */
export function evaluateShepherdAction(action, { tier, flags, role = shepherdRole(), catalog = readYaml(policyPath('agents', 'sandbox.yaml')).toolCatalog }) {
  const problems = [];
  const no = (ruleId, message) => problems.push({ ruleId, message });
  if (!role.tools.includes(action.tool) || !catalog[action.tool]) {
    const human = HUMAN_ONLY[action.tool];
    no('ops.shepherd-out-of-scope', human ? `${human} MUST be authorized by a human (Standard §12.2.1 item 10); not a Change Shepherd tool` : `${action.tool} is not an approved, audited Change Shepherd tool (§12.2.1 item 8)`);
  }
  const mitigation = action.tool === 'flag.return-to-safe-state' || action.tool === 'rollout.pause';
  if (mitigation) {
    if (!['R0', 'R1', 'R2'].includes(tier)) no('ops.shepherd-tier', `automated ${action.tool} is allowed for Low/Medium tiers only; ${tier} needs a human (§12.2.1 item 9)`);
    if (!action.alert && !action.incident) no('ops.no-alert', `${action.tool} is a mitigation only when tied to an open alert or incident (§12.6 item 2.4)`);
  }
  if (action.tool === 'flag.return-to-safe-state') {
    const flag = flags.find((f) => f.id === action.flag);
    if (!flag) no('ops.unknown-flag', `flag ${action.flag} is not in the flag registry (no declared safeState)`);
    else if (action.value !== flag.safeState) {
      no('ops.flag-leaves-safe-state', `setting ${flag.id} ${action.value} moves it out of its safeState ${flag.safeState}${flag.safeState === 'on' ? ': removes a security/privacy/legal control, R3 loosening, security owner required (FE §11.4)' : ''}`);
    }
  }
  const allowed = problems.length === 0;
  return {
    allowed,
    problems,
    taskState: allowed && mitigation ? 'PAUSED' : undefined,
    audit: { actor: 'agent:change-shepherd', tool: action.tool, subject: action.flag ?? action.rollout ?? action.target ?? null, value: action.value ?? null, trigger: action.alert ?? action.incident ?? null, at: action.at, decision: allowed ? 'executed' : 'refused', reasons: problems.map((p) => p.ruleId) },
  };
}
