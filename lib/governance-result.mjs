// Small helpers shared by the governance checks of tech-design 13 group C (SC-05, SC-07, SC-12, SC-13, SC-15).
// Convention of this repo: a violation FAILs only when the check is `blocking`; at `warn`/`observe` it is a finding
// (WARNING/INFO) on a PASS (Standard §7.5 item 11). Showcase cases evaluate shadow checks at their
// `targetEnforcement` (`atTarget`) to demonstrate the gate they will become; the registry keeps them shadow.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { checkDef } from './registry.mjs';

const SEVERITY = { blocking: 'BLOCKER', warn: 'WARNING', observe: 'INFO' };

/** The definition evaluated at its target enforcement (unchanged when it has none). */
export function atTarget(def) {
  const enforcement = def.targetEnforcement ?? def.enforcement;
  return { ...def, enforcement, severity: SEVERITY[enforcement] };
}

export const targetDef = (checkId) => atTarget(checkDef(checkId));

/** Finding severity for a violation under this definition. */
export const violationSeverity = (def) => SEVERITY[def.enforcement];

export function statusFor(def, violated) {
  return violated && def.enforcement === 'blocking' ? 'FAIL' : 'PASS';
}

export function finding(ruleId, message, severity = 'INFO', location) {
  return { source: 'check', ruleId, severity, message, state: 'open', ...(location ? { location } : {}) };
}

/** Reads a JSON or YAML input file (module check `ctx.input`, showcase fixtures). */
export function readInput(path) {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
}
