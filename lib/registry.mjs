import { readYaml, policyPath } from './io.mjs';

export function checkRegistry() {
  return readYaml(policyPath('registry', 'checks.yaml')).checks;
}

export function checkDef(checkId) {
  const def = checkRegistry().find((c) => c.checkId === checkId);
  if (!def) throw new Error(`Unknown check: ${checkId} (not in registry/checks.yaml)`);
  return def;
}

export function controlFileGlobs() {
  return readYaml(policyPath('registry', 'control-files.yaml')).paths;
}

export function integrityParams() {
  return readYaml(policyPath('registry', 'integrity.yaml'));
}
