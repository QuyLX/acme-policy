// Registry rules beyond the schema (Standard §7.13, §8.7; FE §8.2). Used by validate-self.
import { existsSync } from 'node:fs';
import { policyPath } from './io.mjs';

const TARGET = {
  'integrity.test-count-delta': 'blocking', 'integrity.skip-focus': 'blocking', 'integrity.suppressions': 'blocking',
  'integrity.control-file-change': 'blocking', 'integrity.expected-value-edit': 'blocking', 'integrity.self-mocking': 'blocking',
  'integrity.vacuous-test': 'blocking', 'integrity.tolerance-inflation': 'warn', 'integrity.broad-catch': 'warn',
  'integrity.snapshot-churn': 'warn', 'integrity.threshold-change': 'warn', 'integrity.mutation-score': 'observe',
};
const PILOT_BLOCKING = ['integrity.skip-focus', 'integrity.control-file-change', 'integrity.oracle-lock'];
const NO_AUTO_DEMOTE = new Set(['security', 'privacy', 'legal', 'wcag', 'contract', 'core']);
// Standard §8.7 rule 5: core checks are never auto-demoted, whatever their basis class.
const isCoreCheck = (id) => id.startsWith('integrity.') || id === 'knowledge.impact' || id === 'policy.sod';

/** @returns {string[]} problems */
export function registryProblems(registry) {
  const problems = [];
  const ids = new Set();
  for (const c of registry.checks) {
    const at = c.checkId;
    if (ids.has(at)) problems.push(`${at}: duplicate checkId`);
    ids.add(at);
    if (c.requirement === 'required' && c.lifecycle !== 'active') problems.push(`${at}: only active checks may be required (FE §8.2)`);
    if (NO_AUTO_DEMOTE.has(c.basis.class) && c.autoDemote) problems.push(`${at}: autoDemote must be false for basis.class ${c.basis.class}`);
    if (isCoreCheck(at) && c.autoDemote) problems.push(`${at}: autoDemote must be false for a core check (Standard §8.7 rule 5)`);
    if (c.lifecycle === 'active') {
      const f = c.fixtures ?? {};
      if (!f.proofTest && !(f.violating?.length)) problems.push(`${at}: an active check needs a violating fixture or a proof test (mutation proof)`);
      if (f.proofTest && !existsSync(policyPath(f.proofTest))) problems.push(`${at}: proofTest ${f.proofTest} does not exist`);
      for (const fx of [...(f.violating ?? []), ...(f.conforming ?? [])]) {
        for (const key of ['diff', 'repo', 'change', 'sodInput', 'taskEvents', 'playbooks', 'input']) if (fx[key] && !existsSync(policyPath(fx[key]))) problems.push(`${at}: fixture ${fx[key]} does not exist`);
      }
    }
    if (TARGET[at] && c.targetEnforcement !== TARGET[at]) problems.push(`${at}: targetEnforcement must be ${TARGET[at]} (Standard §7.13 items 16, 41)`);
    if (registry.mode === 'pilot' && PILOT_BLOCKING.includes(at) && c.enforcement !== 'blocking') problems.push(`${at}: must be blocking in pilot mode (Standard §7.13 item 26; FE §8.6)`);
    if (registry.mode === 'default' && c.targetEnforcement && c.enforcement !== c.targetEnforcement && c.lifecycle === 'active') problems.push(`${at}: default mode requires the target enforcement`);
  }
  for (const id of Object.keys(TARGET)) if (!ids.has(id)) problems.push(`${id}: Standard core integrity sensor missing (Standard §7.13 item 38)`);
  return problems;
}
