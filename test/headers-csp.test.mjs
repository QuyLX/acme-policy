// test/headers-csp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyPath } from '../lib/io.mjs';
import { mkdtempSync, cpSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headersCspFindings, headersCspCheck, proxyTextFindings, stripComments, findNextConfig } from '../checks/sec/headers-csp.mjs';

test('clean app has no findings', () => {
  assert.deepEqual(headersCspFindings(policyPath('checks/sec/fixtures/headers-clean')), []);
});
test('missing proxy and headers are reported', () => {
  const f = headersCspFindings(policyPath('checks/sec/fixtures/headers-missing')).map((x) => x.message).join('\n');
  assert.match(f, /Content-Security-Policy/);
  assert.match(f, /Strict-Transport-Security/);
  assert.match(f, /X-Robots-Tag/);
});
test('unsafe-inline and production unsafe-eval are reported', () => {
  const f = headersCspFindings(policyPath('checks/sec/fixtures/headers-unsafe')).map((x) => x.message).join('\n');
  assert.match(f, /unsafe-inline/);
  assert.match(f, /unsafe-eval/);
});

// Review fixes: comments, dev-only unsafe-eval, NOT_ASSESSED, template drift.
const proxyOf = (extra) => `export function proxy() {
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [\`script-src 'self' 'nonce-\${n}'\${${extra}}\`, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
  response.headers.set('Content-Security-Policy', csp);
}`;
test('a CSP, directives and a header mentioned only in comments are findings, not a pass', () => {
  const f = headersCspFindings(policyPath('checks/sec/fixtures/headers-comment-only')).map((x) => x.message).join('\n');
  assert.match(f, /Content-Security-Policy header is not set/);
  assert.match(f, /CSP lacks frame-ancestors 'none'/);
  assert.match(f, /CSP lacks 'nonce-/);
  assert.match(f, /missing header X-Robots-Tag/);
  assert.doesNotMatch(f, /missing header X-Content-Type-Options/);
});
test('comments are not code: a prohibition note does not report unsafe-inline; URLs in strings survive', () => {
  assert.deepEqual(proxyTextFindings(`// never use 'unsafe-inline'\n/* nor 'unsafe-eval' */\n${proxyOf(`''`)}`), []);
  assert.equal(stripComments(`const a = 'https://x.y'; // c 'q`), `const a = 'https://x.y'; `);
});
test('the CSP header must be set (.set / header object), not only a bare string', () => {
  const t = `const name = 'Content-Security-Policy'; const d = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "'nonce-"];`;
  assert.match(proxyTextFindings(t).map((x) => x.message).join('\n'), /Content-Security-Policy header is not set/);
  assert.equal(proxyTextFindings(proxyOf(`''`)).length, 0);
});
test("'unsafe-eval' is allowed only in the truthy arm of a dev conditional", () => {
  assert.deepEqual(proxyTextFindings(proxyOf(`isDev ? " 'unsafe-eval'" : ''`)), []);
  assert.deepEqual(proxyTextFindings(proxyOf(`isDev ? " 'self' 'unsafe-eval'" : ''`)), []);
  assert.deepEqual(proxyTextFindings(proxyOf(`process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''`)), []);
  const wrong = proxyTextFindings(proxyOf(`isDev ? "'self'" : "'unsafe-eval'"`)).map((x) => x.message).join('\n');
  assert.match(wrong, /unsafe-eval/);
  assert.match(proxyTextFindings(proxyOf(`" 'unsafe-eval'"`)).map((x) => x.message).join('\n'), /unsafe-eval/);
});
test('no Next.js app is NOT_ASSESSED, never a vacuous PASS', () => {
  const r = headersCspCheck({ checkId: 'sec.headers-csp', checkVersion: '1.0.0' }, policyPath('checks/sec/fixtures'), []);
  assert.equal(r.status, 'NOT_ASSESSED');
  assert.match(r.reason, /no Next\.js app found/);
});
test('next.config.js and next.config.mjs are recognized as the app config', () => {
  for (const ext of ['js', 'mjs']) {
    const dir = mkdtempSync(join(tmpdir(), 'acme-hdr-'));
    try {
      cpSync(policyPath('checks/sec/fixtures/headers-clean'), dir, { recursive: true });
      renameSync(join(dir, 'next.config.ts'), join(dir, `next.config.${ext}`));
      assert.equal(findNextConfig(dir), `next.config.${ext}`);
      assert.deepEqual(headersCspFindings(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
