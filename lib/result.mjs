import { checkRegistry } from './registry.mjs';

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

/** Ownership of a check as the Check Registry defines it (never as a CheckResult claims it). */
function registeredOwnership(checkId) {
  return checkId ? checkRegistry().find((d) => d.checkId === checkId)?.ownership : undefined;
}

/**
 * A NOT_ASSESSED result counted as satisfied by a valid `assessed-elsewhere` disposition (Standard §7.5 item 7, K.2;
 * FE §8.2): only for a check the Check Registry declares `ownership: cross-team-contract` (looked up by checkId),
 * decided by policy with a policyRef, bound to a provider run, and not past `validUntil` at `now`. The status stays
 * NOT_ASSESSED (§7.5 item 6: never converted to PASS). Other passing dispositions are not evaluated here.
 */
export function assessedElsewhere(c, now = Date.now()) {
  const d = c.disposition;
  if (c.status !== 'NOT_ASSESSED' || d?.type !== 'assessed-elsewhere') return false;
  if (d.decidedBy !== 'policy' || typeof d.policyRef !== 'string' || !d.policyRef.trim()) return false;
  const until = Date.parse(d.assessedElsewhere?.validUntil ?? '');
  if (!d.assessedElsewhere?.runId || !(until >= now)) return false;
  return registeredOwnership(c.checkId) === 'cross-team-contract';
}

/**
 * Exit code of a whole verification run (FE §7.6), derived from check statuses only — never from the executor:
 * 2 when any check is ERROR (infrastructure, not the change); 1 when a blocking check FAILs or a required blocking
 * check is NOT_ASSESSED (VER-03: NOT_ASSESSED is never PASS, so the gate it guards stays closed) without a valid
 * `assessed-elsewhere` disposition (§7.5 item 8); otherwise 0. `now` (ms) bounds the disposition's validity.
 */
export function runExitCode(checks, { now = Date.now() } = {}) {
  if (checks.some((c) => c.status === 'ERROR')) return 2;
  const blocks = (c) =>
    c.enforcement === 'blocking' && (c.status === 'FAIL' || (c.status === 'NOT_ASSESSED' && c.requirement === 'required' && !assessedElsewhere(c, now)));
  return checks.some(blocks) ? 1 : 0;
}
