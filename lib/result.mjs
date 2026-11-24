/** Builds a CheckResult (Standard Appendix K.2) from a registry check definition. */
export function checkResult(def, { status, reason, findings = [], command, durationMs = 0, attempts = 1, tool, extensions }) {
  const result = {
    checkId: def.checkId,
    checkVersion: def.checkVersion,
    requiredBy: ['aisf-frontend@1.1.0'],
    requirement: def.requirement,
    enforcement: def.enforcement,
    severity: def.severity,
    gate: def.gate,
    status,
    command: command ?? (def.command ? def.command.join(' ') : `acme-policy ${def.checkId}`),
    durationMs,
    attempts,
    findings,
    evidence: [],
  };
  if (reason) result.reason = reason;
  if (tool) result.tool = tool;
  if (extensions) result.extensions = extensions;
  return result;
}

/** Exit code mapping of FE §7.6: 0 pass, 1 check failure, 2 infrastructure error. */
export function exitCodeFor(status) {
  if (status === 'PASS') return 0;
  if (status === 'FAIL') return 1;
  return 2;
}

/**
 * Exit code of a whole verification run (FE §7.6), derived from check statuses only — never from the executor:
 * 2 when any check is ERROR (infrastructure, not the change); 1 when a blocking check FAILs or a required blocking
 * check is NOT_ASSESSED (VER-03: NOT_ASSESSED is never PASS, so the gate it guards stays closed); otherwise 0.
 */
export function runExitCode(checks) {
  if (checks.some((c) => c.status === 'ERROR')) return 2;
  const blocks = (c) =>
    c.enforcement === 'blocking' && (c.status === 'FAIL' || (c.status === 'NOT_ASSESSED' && c.requirement === 'required'));
  return checks.some(blocks) ? 1 : 0;
}
