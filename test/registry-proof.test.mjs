// Mutation proof of the Check Registry (FE §8.2 rule 1; Standard §8.7): every active check fires on each of its
// violating fixtures and stays quiet on each conforming fixture. A check whose detector is removed or broken fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readYaml, policyPath } from '../lib/io.mjs';
import { runFixture } from '../lib/fixture-run.mjs';

const registry = readYaml(policyPath('registry', 'checks.yaml'));
const loud = (r) => r.findings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'WARNING');

function fires(def, r, fixture) {
  if (fixture.expect?.tier) return r.extensions?.['x-risk']?.tier === fixture.expect.tier;
  if (r.status === 'FAIL') return true;
  if (def.enforcement === 'observe') return r.findings.length > 0;
  return loud(r).length > 0;
}
function quiet(def, r, fixture) {
  if (fixture.expect?.tier) return r.extensions?.['x-risk']?.tier === fixture.expect.tier;
  return r.status === 'PASS' && loud(r).length === 0;
}

for (const def of registry.checks.filter((c) => c.lifecycle === 'active' || c.lifecycle === 'shadow')) {
  for (const [i, fx] of (def.fixtures.violating ?? []).entries()) {
    test(`${def.checkId} fires on violating fixture #${i + 1} (${fx.diff ?? fx.change ?? fx.repo ?? fx.sodInput})`, () => {
      const r = runFixture(def.checkId, fx);
      assert.ok(fires(def, r, fx), `${def.checkId} did not fire: status ${r.status}, ${r.reason ?? ''} ${JSON.stringify(r.findings.map((f) => f.message)).slice(0, 300)} ${JSON.stringify(r.extensions ?? {}).slice(0, 200)}`);
    });
  }
  for (const [i, fx] of (def.fixtures.conforming ?? []).entries()) {
    test(`${def.checkId} passes on conforming fixture #${i + 1} (${fx.diff ?? fx.change ?? fx.repo ?? fx.sodInput})`, () => {
      const r = runFixture(def.checkId, fx);
      assert.ok(quiet(def, r, fx), `${def.checkId} not quiet: status ${r.status}, ${r.reason ?? ''} ${JSON.stringify(loud(r).map((f) => f.message)).slice(0, 300)} ${JSON.stringify(r.extensions ?? {}).slice(0, 200)}`);
    });
  }
}
