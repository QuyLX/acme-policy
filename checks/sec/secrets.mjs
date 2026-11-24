// sec.secrets — secrets in added lines (FE-SEC-002, CORE-SEC-07; FE §19.1). baselineable: false — a hit is fixed or
// waived by the security owner, never baselined.
import { parseUnifiedDiff } from '../../lib/diff.mjs';
import { checkResult } from '../../lib/result.mjs';

const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe-style secret key', /\b[rs]k_live_[0-9A-Za-z]{16,}\b/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['credential in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@/i],
  ['credential assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w-]+)?$/;
const ENV_ALLOWED = /(?:^|\/)\.env\.(?:example|sample|template)$/;

export function secretHits(diffText) {
  const hits = [];
  for (const file of parseUnifiedDiff(diffText)) {
    if (!file.newPath) continue;
    if (file.status === 'added' && ENV_FILE.test(file.newPath) && !ENV_ALLOWED.test(file.newPath)) {
      hits.push({ location: file.path, message: 'Environment file added: real values must never be committed (use .env.example)' });
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== '+') continue;
        const found = PATTERNS.find(([, re]) => re.test(line.text));
        if (found) hits.push({ location: `${file.path}:${line.newLine}`, message: `Possible ${found[0]} (value not shown)` });
      }
    }
  }
  return hits;
}

export function secretsCheck(def, diffText) {
  const hits = secretHits(diffText);
  return checkResult(def, {
    status: hits.length ? 'FAIL' : 'PASS',
    reason: hits.length ? `${hits.length} possible secret(s); rotate the credential if it was real` : undefined,
    findings: hits.map((h) => ({ source: 'check', ruleId: 'FE-SEC-002', severity: 'BLOCKER', location: h.location, message: h.message, state: 'open' })),
  });
}
