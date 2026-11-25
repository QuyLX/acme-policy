#!/usr/bin/env node
// acme-policy CLI. Exit codes (FE §7.6): 0 pass, 1 check failure, 2 infrastructure error.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, readYaml, readText, policyPath, POLICY_ROOT } from '../lib/io.mjs';
import { validate } from '../lib/schema.mjs';
import { checkDef, checkRegistry, controlFileGlobs, integrityParams } from '../lib/registry.mjs';
import { assessedElsewhere, exitCodeFor, runExitCode } from '../lib/result.mjs';
import { scanDiff } from '../checks/integrity/scan.mjs';
import { sensorCheck, mutationScoreCheck } from '../checks/integrity/sensors.mjs';
import { injectionHits, injectionPrescanCheck } from '../checks/review/injection-prescan.mjs';
import { secretHits, secretsCheck } from '../checks/sec/secrets.mjs';
import { classifyRisk, riskCheck, understated } from '../checks/policy-risk/classify.mjs';
import { classifyConfigChange } from '../checks/meta/override-direction.mjs';
import { cyclesCheck } from '../checks/arch/cycles.mjs';
import { depsPolicyCheck } from '../checks/deps/policy.mjs';
import { installFrozenCheck } from '../checks/build/install-frozen.mjs';
import { recordSchemaCheck } from '../checks/knowledge/record-schema.mjs';
import { referencesCheck } from '../checks/knowledge/references.mjs';
import { descriptorDriftCheck } from '../checks/meta/descriptor-drift.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';
import { knowledgeImpactCheck } from '../checks/knowledge-impact/impact.mjs';
import { runCommandCheck, ADAPTER } from '../adapters/command-adapter.mjs';
import { createContext, disposeContext, lintCheck, typecheckCheck, testCheck, buildCheck, storyInteractionCheck, visualStoriesCheck } from '../adapters/tools.mjs';
import { kit, readProjectConfig } from '../lib/kit.mjs';
import { resolutionEvidence } from '../lib/resolve.mjs';
import { discoverProjects } from '../lib/workspace.mjs';
import { checkResult } from '../lib/result.mjs';
import { configParityCheck, parityProblems } from '../checks/meta/config-parity.mjs';
import { overrideDirectionCheck } from '../checks/meta/override-direction.mjs';
import { toolchainPinCheck } from '../checks/meta/toolchain-pin.mjs';
import { workflowPinCheck } from '../checks/meta/workflow-pin.mjs';
import { areasFromCodeowners, toChangeEvent, toSodInput } from '../lib/github-event.mjs';
import { attest } from '../lib/attest.mjs';
import { waiverSelfApproval } from '../checks/policy-sod/waiver.mjs';
import { parse as parseYaml } from 'yaml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadScenarios, runShowcase, showcaseExitCode } from '../lib/showcase.mjs';
import { MODULE_CHECKS } from '../lib/modules/index.mjs';
import { search } from '../lib/knowledge-index.mjs';
import { loadKnowledgeInput } from '../checks/knowledge/index-input.mjs';
import { runDiffChecks } from '../lib/fixture-run.mjs';
import { registryProblems } from '../lib/registry-rules.mjs';
import { lockfilePackages } from '../lib/lockfile.mjs';
import { readEvents, loadPlaybook, workflowConformanceCheck } from '../checks/workflow/conformance.mjs';
import { deriveTask } from '../lib/task-runner.mjs';
import { apiCompatCheck, semverChangelogCheck, docsApiSyncCheck, apiProjects } from '../checks/ds/checks.mjs';
import { extractApi } from '../checks/ds/api.mjs';
import { consumerVerificationCheck, tokenUsage } from '../checks/ds/token-usage.mjs';
import { bundleBudgetCheck } from '../checks/ds/bundle-budget.mjs';
import { planApp, planPackage, planDsComponent, verifyCheckpoint } from '../lib/generate.mjs';
import { readTestFiles, trace } from '../lib/trace.mjs';

const USAGE = `Usage: acme-policy <command> [options]

  validate --schema <name> <file...>      Validate YAML/JSON files against schemas/<name>.schema.json
  integrity --diff <file|->               Run the diff-based checks (integrity sensors, injection pre-scan, secrets)
  sod --input <file>                      Run policy.sod on a platform-neutral input
  knowledge-impact --repo <dir> --changed <file|->   List knowledge artifacts affected by changed paths
  knowledge-search --input <spec.yaml> <query...> [--include-draft]
                                          Query the Knowledge Index (FE §7.8): sources, pinned repo and requester from the spec
  run --repo <dir> [--base <ref>] [--checks a,b | --command verify:fast] [--sod-input <file> | --github-payload <event.json>]
  attest --run <VerificationRun.json> --head <sha>
                                          Run registered checks and print a VerificationRun
  generate <app|package|ds-component> <name> --repo <dir> [--kind react-lib|node-lib] [--port n] [--privileged-admin]
           [--description <text>]
           [--checkpoint <CheckpointRecord.json>] [--dry-run]   Golden-path generators (FE §9.8)
  ds api --repo <dir> [--write]           Print or write public API snapshots (projects with publicApi)
  ds token-usage --repo <dir>             Token Usage Index: design token → files using it (FE §5.5)
  task derive --events <file.jsonl>        Derive Task state, transitions, checkpoints, handoffs from a task event log
  trace <req:KEY|journey|AC> --repo <dir> [--journeys <file>] [--tests <dir>] [--runs <file|dir,...>]
                                          Requirement → journey → AC → scenario → test → PASS evidence (FE §7.7)
  sync --repo <dir> [--check]             Generate lint/TS/test config from the pinned presets + factory.config.yaml
  showcase [--only SC-xx] [--json]        Run the Factory's acceptance scenarios (FE §20.1)
  validate-self                           Validate this policy repo's own registries`;

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function git(repo, args) {
  // stderr is captured, not inherited: probing a path that does not exist at base is expected, not an error to print.
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function policyRef() {
  try {
    return `acme-policy@${git(POLICY_ROOT, ['rev-parse', '--short', 'HEAD']).trim()}`;
  } catch {
    return 'acme-policy@uncommitted';
  }
}

/** Changes under verification: committed diff against base, plus uncommitted and untracked changes. */
function collectChanges(repo, base) {
  const diff = git(repo, ['diff', base, '--']) + untrackedAsDiff(repo);
  const changed = [...new Set([...git(repo, ['diff', '--name-only', base, '--']).split('\n'), ...untracked(repo)].filter(Boolean))];
  return { diff, changed };
}

function untracked(repo) {
  return git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
}

function untrackedAsDiff(repo) {
  return untracked(repo)
    .map((p) => {
      const lines = readText(resolve(repo, p)).split('\n');
      return `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    })
    .join('');
}

function commandValidate(values, files) {
  let failed = 0;
  for (const file of files) {
    const data = file.endsWith('.json') ? readJson(file) : readYaml(file);
    const errors = validate(values.schema, data);
    if (errors.length) {
      failed++;
      console.error(`✗ ${file}\n  ${errors.join('\n  ')}`);
    } else console.log(`✓ ${file}`);
  }
  return failed ? 1 : 0;
}

/** Check IDs of a standard command (registry/commands.yaml), with `include` expanded. */
function commandChecks(name, seen = new Set()) {
  const commands = readYaml(policyPath('registry', 'commands.yaml')).commands;
  if (!commands[name]) throw new Error(`Unknown command: ${name} (registry/commands.yaml)`);
  if (seen.has(name)) throw new Error(`Command include cycle at ${name}`);
  seen.add(name);
  return [...new Set(commands[name].flatMap((x) => (typeof x === 'string' ? [x] : commandChecks(x.include, seen))))];
}

function commandRun(values) {
  const repo = resolve(values.repo);
  const executor = process.env.FACTORY_EXECUTOR ?? 'local';
  const base = values.base ?? 'HEAD';
  const ids = values.checks ? values.checks.split(',') : values.command ? commandChecks(values.command) : checkRegistry().map((c) => c.checkId);
  if ((values['sod-input'] || values['github-payload']) && !ids.includes('policy.sod')) ids.push('policy.sod');
  const startedAt = new Date().toISOString();
  const { diff, changed } = collectChanges(repo, base);
  const headSha = (() => {
    try {
      return git(repo, ['rev-parse', 'HEAD']).trim();
    } catch {
      return undefined;
    }
  })();

  const pinned = kit();
  const { config, errors: configErrors } = readProjectConfig(repo);
  const ctx = createContext({ repo, kit: pinned, config, projects: config ? discoverProjects(repo) : [], executor });
  const TOOL_CHECKS = { eslint: lintCheck, tsc: typecheckCheck, vitest: testCheck, build: buildCheck, 'vitest-browser': storyInteractionCheck, 'vitest-visual': visualStoriesCheck };
  const baseConfig = (() => {
    try {
      return parseYaml(git(repo, ['show', `${base}:factory.config.yaml`]));
    } catch {
      return null;
    }
  })();

  // Shared inputs, computed once per run.
  const readFile = (side, path) => {
    if (side === 'head') return existsSync(join(repo, path)) ? readFileSync(join(repo, path), 'utf8') : null;
    try {
      return git(repo, ['show', `${base}:${path}`]);
    } catch {
      return null;
    }
  };
  const descriptors = (() => {
    const dir = join(repo, 'apps');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((a) => existsSync(join(dir, a, 'factory.yaml')))
      .map((a) => parseYaml(readFileSync(join(dir, a, 'factory.yaml'), 'utf8')) ?? {});
  })();
  const controlGlobs = controlFileGlobs();
  const promptAssets = descriptors.flatMap((d) => d.promptAssets ?? []);
  let memo;
  const shared = () => {
    if (memo) return memo;
    const hits = scanDiff(diff, { params: integrityParams(), controlFileGlobs: controlGlobs, readFile });
    const loosening = [
      ...classifyConfigChange(baseConfig, config ?? {}).filter((c) => c.direction === 'loosen').map((c) => `factory.config.yaml#${c.location}: ${c.message}`),
      ...hits.filter((h) => h.checkId === 'integrity.control-file-change' && / deleted:/.test(h.message)).map((h) => `${h.location}: control file deleted`),
    ];
    const security = [...injectionHits(diff, [...controlGlobs, ...promptAssets]), ...secretHits(diff)].map((h) => `${h.location}: ${h.message}`);
    const risk = classifyRisk({
      changed,
      riskMap: descriptors.flatMap((d) => d.riskMap ?? []),
      controlFiles: [...new Set(hits.filter((h) => h.checkId === 'integrity.control-file-change').map((h) => h.location))],
      loosening,
      securityFindings: security,
    });
    return (memo = { hits, risk });
  };
  // PR approvals of the head SHA and the PR author (the policy.sod input), for checks that bind a recorded human
  // decision to an approval (knowledge.impact) or name the change author (oracle-lock conflicts). undefined without PR input.
  const prInput = (() => {
    if (values['github-payload']) {
      const event = toChangeEvent(readJson(resolve(values['github-payload'])), { agentLogins: readYaml(policyPath('registry', 'agent-accounts.yaml')).logins });
      return { headSha: event.headSha, author: event.author, approvals: event.reviews.filter((r) => r.state === 'approved').map(({ by, commitSha, isAgent }) => ({ by, commitSha, isAgent })) };
    }
    if (values['sod-input']) {
      const input = readJson(values['sod-input']);
      return { headSha: input.headSha, author: input.author, approvals: input.approvals ?? [] };
    }
    return undefined;
  })();
  const sensorCtx = { workItemId: process.env.FACTORY_WORK_ITEM, change: prInput?.author ? `change by ${prInput.author} (head ${prInput.headSha})` : undefined };
  const baseLock = readFile('base', 'pnpm-lock.yaml');
  const baseKeys = baseLock ? new Set(Object.keys(lockfilePackages(baseLock))) : null;
  const isNew = (name, version) => !baseKeys || !baseKeys.has(`${name}@${version}`);

  const checks = [];
  for (const id of ids) {
    const def = checkDef(id);
    if (def.adapter) {
      checks.push(
        config
          ? TOOL_CHECKS[def.adapter](def, ctx)
          : checkResult(def, { status: 'FAIL', reason: `cannot verify without a valid factory.config.yaml: ${configErrors.join('; ')}` }),
      );
    } else if (def.command) checks.push(runCommandCheck(def, { cwd: repo, executor }));
    else if (id === 'meta.config-parity') checks.push(configParityCheck(def, repo, pinned.version, pinned.dir));
    else if (id === 'meta.override-direction') checks.push(overrideDirectionCheck(def, baseConfig, config ?? {}));
    else if (id === 'meta.toolchain-pin') checks.push(toolchainPinCheck(def, repo, pinned));
    else if (id === 'meta.workflow-pin') checks.push(workflowPinCheck(def, repo));
    else if (id === 'provenance.attest') checks.push(checkResult(def, { status: 'NOT_ASSESSED', reason: 'attest runs on the VerificationRun artifact in the attest job' }));
    else if (id === 'policy.waiver-approval') {
      const waivers = readYaml(policyPath('registry', 'waivers.yaml')).waivers;
      const requesterId = values['github-payload']
        ? toChangeEvent(readJson(resolve(values['github-payload']))).requester.id
        : null;
      if (!waivers.length) checks.push(checkResult(def, { status: 'PASS' }));
      else if (!requesterId) checks.push(checkResult(def, { status: 'NOT_ASSESSED', reason: 'waivers exist but no pull-request event identifies the requester' }));
      else checks.push(...waivers.map((waiver) => waiverSelfApproval(def, waiver, requesterId, { agentLogins: readYaml(policyPath('registry', 'agent-accounts.yaml')).logins })));
    }
    else if (id === 'meta.descriptor-drift') checks.push(descriptorDriftCheck(def, repo));
    else if (id === 'integrity.mutation-score') checks.push(mutationScoreCheck(def));
    else if (id.startsWith('integrity.')) checks.push(sensorCheck(def, shared().hits, sensorCtx));
    else if (id === 'review.injection-prescan') checks.push(injectionPrescanCheck(def, diff, [...controlGlobs, ...promptAssets]));
    else if (id === 'sec.secrets') checks.push(secretsCheck(def, diff));
    else if (id === 'policy.risk') checks.push(riskCheck(def, shared().risk));
    else if (id === 'arch.cycles') checks.push(cyclesCheck(def, repo, discoverProjects(repo)));
    else if (id === 'deps.policy') checks.push(depsPolicyCheck(def, { repo, policy: readYaml(policyPath('registry', 'deps-policy.yaml')), changed, isNew, timeoutSeconds: def.timeoutSeconds ?? 120 }));
    else if (id === 'build.install-frozen') checks.push(installFrozenCheck(def, { repo, allowedHosts: readYaml(policyPath('registry', 'deps-policy.yaml')).lockfile.allowedTarballHosts, timeoutSeconds: def.timeoutSeconds ?? 300 }));
    else if (id === 'ds.bundle-budget') checks.push(bundleBudgetCheck(def, { config, projects: config ? discoverProjects(repo) : [] }));
    else if (id === 'ds.consumer-verification') checks.push(consumerVerificationCheck(def, { repo, config, projects: config ? discoverProjects(repo) : [], readFile, changed }));
    else if (id === 'ds.api-compat' || id === 'ds.semver-changelog' || id === 'ds.docs-api-sync') {
      const dsCtx = { repo, config, projects: config ? discoverProjects(repo) : [], readFile, changed };
      checks.push((id === 'ds.api-compat' ? apiCompatCheck : id === 'ds.semver-changelog' ? semverChangelogCheck : docsApiSyncCheck)(def, dsCtx));
    } else if (id === 'workflow.conformance') {
      checks.push(values['task-events'] ? workflowConformanceCheck(def, readEvents(resolve(values['task-events']))) : checkResult(def, { status: 'NOT_ASSESSED', reason: 'no task event log (produced by the platform binding, M3)' }));
    } else if (id === 'knowledge.impact') checks.push(knowledgeImpactCheck(def, repo, changed, { readFile, approvals: prInput && { headSha: prInput.headSha, approvals: prInput.approvals } }));
    else if (id === 'knowledge.record-schema') checks.push(recordSchemaCheck(def, repo));
    else if (id === 'knowledge.references') checks.push(referencesCheck(def, repo));
    else if (id === 'policy.sod') {
      const input = values['github-payload']
        ? toSodInput(
            toChangeEvent(readJson(resolve(values['github-payload'])), { agentLogins: readYaml(policyPath('registry', 'agent-accounts.yaml')).logins }),
            areasFromCodeowners(existsSync(join(repo, 'CODEOWNERS')) ? readText(join(repo, 'CODEOWNERS')) : '', changed),
            { tier: shared().risk.standardTier },
          )
        : values['sod-input']
          ? readJson(values['sod-input'])
          : null;
      if (!input) checks.push({ ...sodCheck(def, {}), status: 'NOT_ASSESSED', reason: 'no PR event input (policy.sod runs in CI on the PR)' });
      else {
        const result = sodCheck(def, input);
        const risk = shared().risk;
        // FE §10.1: authors never choose the tier; the SoD slots are computed for at least the classified tier.
        if (result.status !== 'ERROR' && understated(input.tier, risk)) {
          result.status = 'FAIL';
          result.reason = `tier understated: input says ${input.tier}, policy.risk classified ${risk.tier} (${risk.standardTier})${result.reason ? `; ${result.reason}` : ''}`;
        }
        checks.push(result);
      }
    } else if (MODULE_CHECKS[id]) {
      checks.push(MODULE_CHECKS[id](def, { repo, base, changed, diff, readFile, config, executor, input: values.input ? resolve(values.input) : undefined }));
    } else throw new Error(`No runner for ${id}`);
  }
  disposeContext(ctx);

  const byStatus = { PASS: 0, FAIL: 0, ERROR: 0, NOT_ASSESSED: 0 };
  for (const c of checks) byStatus[c.status]++;
  // NOT_ASSESSED is never PASS (VER-03); `local` evidence never satisfies a required check (VER-14).
  const requiredUnmet = checks
    .filter((c) => c.requirement === 'required' && ((c.status !== 'PASS' && !assessedElsewhere(c)) || executor === 'local'))
    .map((c) => c.checkId);

  // FE §8.5, §8.8: a check that planned the tests or resolved the test environment reports them as `x-fe-run`; the run
  // carries the plan digest (extensions["x-fe"].testPlan) and environment.{id, kind, manifestDigest}.
  const feRun = Object.assign({}, ...checks.map((c) => c.extensions?.['x-fe-run'] ?? {}));
  // Standard §7.3 item 16, Appendix K.2; FE §8.3 item 5: when profile.resolve ran, its resolution trace (layers and
  // versions, conflicts and how each was resolved) is the run's `resolution`, and the resolved layers its resolvedProfiles.
  const resolved = resolutionEvidence(checks);
  const run = {
    schemaVersion: 'aisf/4.0',
    runId: `run-${Date.now()}`,
    workItemId: process.env.FACTORY_WORK_ITEM ?? 'local',
    channel: 'code',
    subject: { repo, commitSha: headSha, baseSha: base },
    resolvedProfiles: resolved.resolvedProfiles ?? [{ id: 'aisf-frontend', version: '1.1.0' }],
    ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
    environment: { executor, ...(feRun.environment ?? {}) },
    ...(Object.keys(feRun).length ? { extensions: { 'x-fe': feRun } } : {}),
    adapters: [ADAPTER, ...readYaml(policyPath('registry', 'adapters.yaml')).adapters.map(({ adapterId, version }) => ({ id: adapterId, version }))],
    kit: { package: '@acme/presets', version: pinned.version },
    checks,
    summary: { byStatus, requiredUnmet },
    provenance: { factoryVersion: '0.1.0', verifierRef: policyRef(), producer: { ciJob: process.env.FACTORY_CI_JOB ?? 'local' }, startedAt, finishedAt: new Date().toISOString() },
  };
  print(run);
  return runExitCode(checks);
}

/** `factory sync`: writes the generated files; with --check only reports what would change (exit 1 if anything). */
function commandSync(values) {
  const repo = resolve(values.repo);
  const pinned = kit();
  const problems = parityProblems(repo, pinned.version, pinned.dir);
  const fixable = problems.filter((p) => p.expected !== undefined);
  const blocking = problems.filter((p) => p.expected === undefined);
  for (const p of blocking) console.error(`✗ ${p.location}: ${p.message}`);
  for (const p of fixable) {
    if (values.check) console.log(`✗ ${p.location}: ${p.message}`);
    else {
      mkdirSync(dirname(join(repo, p.location)), { recursive: true });
      writeFileSync(join(repo, p.location), p.expected);
      console.log(`✓ wrote ${p.location}`);
    }
  }
  if (!problems.length) console.log(`✓ in sync with @acme/presets@${pinned.version}`);
  if (blocking.length) return 1;
  return values.check && fixable.length ? 1 : 0;
}

function commandValidateSelf() {
  const results = [
    ['checks registry schema', validate('check-registry', readYaml(policyPath('registry', 'checks.yaml'))).length === 0],
    ['checks registry rules (targets, pilot mode, lifecycle, fixtures)', (() => {
      const problems = registryProblems(readYaml(policyPath('registry', 'checks.yaml')));
      for (const p of problems) console.error(`  ✗ ${p}`);
      return problems.length === 0;
    })()],
    ['playbooks valid (TaskWorkflowSpec)', readdirSync(policyPath('workflows')).filter((f) => f.endsWith('.yaml')).every((f) => {
      const errs = validate('task-workflow-spec', readYaml(policyPath('workflows', f)));
      for (const e of errs) console.error(`  ✗ workflows/${f}: ${e}`);
      return errs.length === 0;
    })],
    ['task classes bound to existing playbooks', readYaml(policyPath('registry', 'task-classes.yaml')).taskClasses.every((t) => loadPlaybook(t.playbook))],
    ['agent roles valid; tools within the sandbox catalog; verifier and implementer separated', (() => {
      const sandbox = readYaml(policyPath('agents', 'sandbox.yaml'));
      const problems = validate('sandbox-policy', sandbox).map((e) => `sandbox: ${e}`);
      const roles = readdirSync(policyPath('agents', 'roles')).map((f) => readYaml(policyPath('agents', 'roles', f)));
      for (const r of roles) {
        problems.push(...validate('agent-role', r).map((e) => `${r.id}: ${e}`));
        for (const t of r.tools ?? []) if (!sandbox.toolCatalog[t]) problems.push(`${r.id}: tool ${t} is not in the sandbox catalog`);
        if (Array.isArray(r.egress)) for (const h of r.egress) if (!sandbox.network.allowlistHosts.includes(h)) problems.push(`${r.id}: egress ${h} not allowlisted`);
      }
      const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
      if (!byId.verifier?.distinctIdentityFrom?.includes('implementer') || !byId.implementer?.distinctIdentityFrom?.includes('verifier')) problems.push('verifier and implementer must declare distinct identities (FE §9.10 item 2)');
      for (const p of problems) console.error(`  ✗ ${p}`);
      return problems.length === 0;
    })()],
    ['every command check is registered', Object.values(readYaml(policyPath('registry', 'commands.yaml')).commands).flat().filter((x) => typeof x === 'string').every((id) => readYaml(policyPath('registry', 'checks.yaml')).checks.some((c) => c.checkId === id))],
    ['control files', Array.isArray(controlFileGlobs())],
    ['waivers', readYaml(policyPath('registry', 'waivers.yaml')).waivers.every((w) => validate('waiver', w).length === 0)],
    ['vocabulary', Boolean(readYaml(policyPath('vocabulary', 'aisf-vocabulary.yaml')))],
  ];
  results.push(['showcase scenarios', (() => { loadScenarios(); return true; })()]);
  results.push(['kit pinned and installed', kit().installed]);
  results.push(['adapters registered for every adapter check', readYaml(policyPath('registry', 'checks.yaml')).checks.filter((c) => c.adapter).every((c) => readYaml(policyPath('registry', 'adapters.yaml')).adapters.some((a) => a.adapterId === c.adapter && a.checks.includes(c.checkId)))]);
  for (const name of ['factory-config', 'check-result', 'waiver', 'knowledge-meta', 'sod-input', 'showcase-scenario', 'factory-project-config', 'check-registry', 'task-workflow-spec', 'task-event', 'agent-role', 'sandbox-policy', 'change-event', 'verification-run', 'break-glass']) {
    results.push([`schema ${name}`, (() => { validate(name, {}); return true; })()]);
  }
  for (const [name, ok] of results) console.log(`${ok ? '✓' : '✗'} ${name}`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}

function commandShowcase(values) {
  const results = runShowcase({ only: values.only });
  if (values.json) print(results);
  else {
    for (const r of results) console.log(`${r.status.padEnd(12)} ${r.scenario}.${r.case}${r.detail ? `\n             ${r.detail}` : ''}`);
    const count = (s) => results.filter((r) => r.status === s).length;
    console.log(`\n${count('PASS')} pass · ${count('FAIL')} fail · ${count('ERROR')} error · ${count('NOT_ASSESSED')} pending (NOT_ASSESSED)`);
  }
  return showcaseExitCode(results);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { schema: { type: 'string' }, diff: { type: 'string' }, input: { type: 'string' }, repo: { type: 'string' }, changed: { type: 'string' }, base: { type: 'string' }, checks: { type: 'string' }, 'sod-input': { type: 'string' }, 'github-payload': { type: 'string' }, head: { type: 'string' }, only: { type: 'string' }, json: { type: 'boolean' }, check: { type: 'boolean' }, write: { type: 'boolean' }, kind: { type: 'string' }, description: { type: 'string' }, checkpoint: { type: 'string' }, 'dry-run': { type: 'boolean' }, port: { type: 'string' }, 'privileged-admin': { type: 'boolean' }, command: { type: 'string' }, events: { type: 'string' }, 'task-events': { type: 'string' }, journeys: { type: 'string' }, tests: { type: 'string' }, runs: { type: 'string' }, 'include-draft': { type: 'boolean' } },
  });
  switch (command) {
    case 'validate':
      return commandValidate(values, positionals);
    case 'integrity': {
      const results = runDiffChecks(readText(values.diff ?? '-'));
      print(results);
      return runExitCode(results);
    }
    case 'sod': {
      const result = sodCheck(checkDef('policy.sod'), readJson(values.input));
      print(result);
      return exitCodeFor(result.status);
    }
    case 'knowledge-impact': {
      const changed = readText(values.changed ?? '-').split('\n').filter(Boolean);
      const result = knowledgeImpactCheck(checkDef('knowledge.impact'), resolve(values.repo), changed);
      print(result);
      return exitCodeFor(result.status);
    }
    case 'knowledge-search': {
      // FE §7.8 `factory search`: access-filtered, ACTIVE + pinned versions by default, URI@SHA citations, conflicts.
      if (!values.input || !positionals.length) { console.log(USAGE); return 2; }
      const { index, pins, requester } = loadKnowledgeInput(resolve(values.input));
      const answer = search(index, positionals.join(' '), { requester, pins, includeDraft: Boolean(values['include-draft']) });
      print(answer);
      return answer.conflicts.length ? 1 : 0;
    }
    case 'attest': {
      if (!values.run || !values.head) { console.log(USAGE); return 2; }
      const result = attest(checkDef('provenance.attest'), readJson(resolve(values.run)), { pinnedPolicySha: readYaml(policyPath('registry', 'github-pin.yaml')).policySha, headSha: values.head });
      print(result);
      return exitCodeFor(result.status);
    }
    case 'run':
      return commandRun(values);
    case 'generate': {
      // generate <package|ds-component> <name> --repo <dir> [--kind] [--description] [--checkpoint <CheckpointRecord.json>] [--dry-run]
      const [what, name] = positionals;
      if (!['app', 'package', 'ds-component'].includes(what) || !name || !values.repo) { console.log(USAGE); return 2; }
      const repo = resolve(values.repo);
      const plan = what === 'app'
        ? planApp({ repo, name, port: values.port ? Number(values.port) : undefined, privilegedAdmin: Boolean(values['privileged-admin']) })
        : what === 'package'
        ? planPackage({ repo, name, kind: values.kind ?? 'node-lib', description: values.description ?? `Platform package ${name}.` })
        : planDsComponent({ repo, name, summary: values.description ?? `${name} component.` });
      if (plan.generator.requiresCheckpoint) {
        const problem = verifyCheckpoint(values.checkpoint && resolve(values.checkpoint), plan.generator.requiresCheckpoint);
        if (problem) { console.error(`✗ ${problem}`); return 1; }
      }
      for (const f of Object.keys(plan.files)) console.log(`${values['dry-run'] ? '·' : '✓'} ${values['dry-run'] ? 'would write' : 'wrote'} ${f}`);
      if (values['dry-run']) return 0;
      for (const [f, content] of Object.entries(plan.files)) {
        mkdirSync(dirname(join(repo, f)), { recursive: true });
        writeFileSync(join(repo, f), content);
      }
      if (plan.configEntry) writeFileSync(join(repo, 'factory.config.yaml'), readFileSync(join(repo, 'factory.config.yaml'), 'utf8').replace(/\n*$/, '\n') + plan.configEntry);
      if (plan.exportLines) {
        const idx = join(repo, plan.indexPath);
        const text = readFileSync(idx, 'utf8');
        const marker = "export type { ComponentDoc } from './doc';";
        writeFileSync(idx, text.includes(marker) ? text.replace(marker, `${plan.exportLines}${marker}`) : text + plan.exportLines);
      }
      const synced = commandSync({ repo });
      console.log(`\nGenerated by ${plan.generator.id}@${plan.generator.version}. Next: pnpm install, then pnpm verify:fast.`);
      return synced;
    }
    case 'ds': {
      // ds api --repo <dir> [--write]: print or write the public API snapshot of every project with publicApi
      if (!['api', 'token-usage'].includes(positionals[0]) || !values.repo) { console.log(USAGE); return 2; }
      const repo = resolve(values.repo);
      if (positionals[0] === 'token-usage') { print(tokenUsage(repo, discoverProjects(repo))); return 0; }
      const { config } = readProjectConfig(repo);
      for (const p of apiProjects(config, discoverProjects(repo))) {
        const api = `${JSON.stringify(extractApi(join(p.abs, p.publicApi.entry)), null, 2)}\n`;
        if (values.write) {
          mkdirSync(dirname(join(p.abs, p.publicApi.snapshot)), { recursive: true });
          writeFileSync(join(p.abs, p.publicApi.snapshot), api);
          console.log(`✓ wrote ${p.dir}/${p.publicApi.snapshot}`);
        } else process.stdout.write(api);
      }
      return 0;
    }
    case 'task': {
      // task derive --events <file.jsonl>: Task state and records derived from a neutral event log (B-AC-4)
      if (positionals[0] !== 'derive' || !values.events) { console.log(USAGE); return 2; }
      const events = readEvents(resolve(values.events));
      const ref = events.find((e) => e.type === 'task.requested')?.data.workflow;
      const playbook = ref && loadPlaybook(ref);
      if (!playbook) { console.error(`no playbook ${ref}`); return 1; }
      const d = deriveTask(events, playbook);
      print(d);
      return d.violations.length ? 1 : 0;
    }
    case 'trace': {
      // trace <ref> --repo <dir>: traceability report from journeys.yaml, tagged tests and VerificationRuns (FE §7.7)
      if (!positionals[0] || !values.repo) { console.log(USAGE); return 2; }
      const repo = resolve(values.repo);
      const runFiles = (values.runs ?? '').split(',').filter(Boolean).map((p) => resolve(p))
        .flatMap((p) => (existsSync(p) && !p.endsWith('.json') ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)) : [p]));
      const t = trace(positionals[0], {
        journeys: readYaml(values.journeys ? resolve(values.journeys) : join(repo, 'journeys.yaml')),
        testFiles: readTestFiles([values.tests ? resolve(values.tests) : repo], repo),
        runs: runFiles.map((f) => readJson(f)),
      });
      print(t);
      return t.complete ? 0 : 1;
    }
    case 'sync':
      return commandSync(values);
    case 'showcase':
      return commandShowcase(values);
    case 'validate-self':
      return commandValidateSelf();
    default:
      console.log(USAGE);
      return command ? 2 : 0;
  }
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`acme-policy: ${err.message}`);
  process.exitCode = 2;
}
