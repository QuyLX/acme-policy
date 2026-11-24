// policy.risk — deterministic path → tier classification (Slice 0 form of CORE-GOV-01; Standard §9.5-9.6; FE §10.1).
// Tier = max of all signals. Unmatched paths count as the worst case (Standard §9.5 rule 4). Authors never choose it.
import { checkResult } from '../../lib/result.mjs';
import { matchesAny } from '../../lib/glob.mjs';

const RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };
const STANDARD = { R0: 'Low', R1: 'Low', R2: 'Medium', R3: 'High' };
const FROM_STANDARD = { Low: 'R1', Medium: 'R2', High: 'R3' };
export const STANDARD_RANK = { Low: 0, Medium: 1, High: 2 };
const max = (a, b) => (RANK[b] > RANK[a] ? b : a);

/**
 * @param {{ changed: string[], riskMap: Array<{ paths: string[], tier: string, subTier?: string, reason?: string, source?: string }>,
 *           controlFiles: string[], loosening: string[], securityFindings: string[] }} input
 */
export function classifyRisk({ changed, riskMap, controlFiles, loosening, securityFindings }) {
  const signals = [];
  for (const path of changed) {
    const matches = riskMap.filter((e) => matchesAny(path, e.paths));
    if (!matches.length) {
      signals.push({ source: 'unmatched-path', tier: 'R3', detail: `${path}: not in any riskMap (unknown = worst case)` });
      continue;
    }
    const best = matches.reduce((acc, e) => max(acc, e.subTier ?? FROM_STANDARD[e.tier]), 'R0');
    const why = matches.find((e) => (e.subTier ?? FROM_STANDARD[e.tier]) === best);
    signals.push({ source: 'path', tier: best, detail: `${path}: ${why.reason ?? why.paths.join(', ')}${why.source ? ` (${why.source})` : ''}` });
  }
  for (const f of controlFiles) signals.push({ source: 'control-file', tier: 'R2', detail: `${f}: control file change (Standard §7.13 item 12)` });
  for (const l of loosening) signals.push({ source: 'loosening', tier: 'R3', detail: l });
  for (const s of securityFindings) signals.push({ source: 'security-finding', tier: 'R2', detail: s });
  const tier = signals.reduce((acc, s) => max(acc, s.tier), 'R0');
  return { tier, standardTier: STANDARD[tier], signals };
}

export function riskCheck(def, decision) {
  const top = decision.signals.filter((s) => s.tier === decision.tier);
  return checkResult(def, {
    status: 'PASS',
    findings: top.slice(0, 20).map((s) => ({ source: 'check', ruleId: `policy.risk.${s.source}`, severity: 'INFO', location: s.detail.split(':')[0], message: `${s.tier}: ${s.detail}`, state: 'open' })),
    extensions: { 'x-risk': { tier: decision.tier, standardTier: decision.standardTier, signalCount: decision.signals.length } },
  });
}

/** policy.sod must not run on a tier lower than the classified one (FE §10.1: authors never choose the tier). */
export function understated(sodTier, decision) {
  return STANDARD_RANK[sodTier] < STANDARD_RANK[decision.standardTier];
}
