// review.ai-mode and review.reviewer-change (CORE-REV-02, CORE-REV-06; Standard §7.9 items 30-31, §7.12, §9.2 item 12;
// FE §9.9). RECORDED reviewer data: no reviewer runtime exists (D-09 open); every rate is computed from recorded
// dispositions and recorded reviewer outputs on the eval set (lib/review-quality.mjs).
// The current mode is the gate's own policy state: it is read from the surface's descriptor (`apps/*/factory.yaml`,
// `review.aiMode`, or `autonomy.aiReviewMode[surface]`; FE §9.9: every surface starts at shadow) in the repository under
// verification, never from the request. A request that declares a different `current` is a finding.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkResult } from '../../lib/result.mjs';
import { validate } from '../../lib/schema.mjs';
import { measure, promoteMode, scoreReviewerChange } from '../../lib/review-quality.mjs';
import { finding, readInput, statusFor, violationSeverity } from '../../lib/governance-result.mjs';
import { policyPath, readYaml } from '../../lib/io.mjs';

const read = (p) => readInput(policyPath(p));

/**
 * The surface's current AI review mode from the descriptors of `repo` (trusted checkout, not the request).
 * Throws when the surface is not declared, a descriptor is invalid, or the two declarations disagree.
 * @returns {{ mode: string, source: string }}
 */
export function currentModeFromDescriptor(repo, surfaceId) {
  const apps = join(repo, 'apps');
  const found = [];
  for (const app of existsSync(apps) ? readdirSync(apps).sort() : []) {
    const f = join(apps, app, 'factory.yaml');
    if (!statSync(join(apps, app)).isDirectory() || !existsSync(f)) continue;
    const cfg = parseYaml(readFileSync(f, 'utf8')) ?? {};
    const errors = validate('factory-config', cfg);
    if (errors.length) throw new Error(`apps/${app}/factory.yaml invalid: ${errors.slice(0, 3).join('; ')}`);
    const surface = (cfg.surfaces ?? []).find((s) => s.id === surfaceId);
    if (!surface) continue;
    const declared = [surface.review?.aiMode, cfg.autonomy?.aiReviewMode?.[surfaceId]].filter(Boolean);
    if (new Set(declared).size > 1) throw new Error(`apps/${app}/factory.yaml: ${surfaceId} declares review.aiMode ${declared[0]} and autonomy.aiReviewMode ${declared[1]}`);
    found.push({ mode: declared[0] ?? 'shadow', source: `apps/${app}/factory.yaml${declared.length ? '' : ' (no mode declared: shadow, FE §9.9)'}` });
  }
  if (found.length !== 1) throw new Error(`surface ${surfaceId} is declared in ${found.length} descriptor(s) under ${repo}; exactly one is required`);
  return found[0];
}

/**
 * @param {{ surface, requested, dispositions, evalSet, reviewerOutputs, current? }} req paths relative to the policy root;
 *   `current` is only a claim, compared with the descriptor
 * @param {{ repo: string }} trusted the repository whose descriptor holds the surface's mode (absolute path)
 */
export function aiModeCheck(def, req, { repo } = {}) {
  const started = Date.now();
  if (!repo) return { result: checkResult(def, { status: 'ERROR', reason: 'no repository: the current AI review mode is read from the surface descriptor, never from the request' }), decision: null };
  const thresholds = readYaml(policyPath('registry', 'ai-review-thresholds.yaml')).promotion;
  const metrics = measure({ dispositions: read(req.dispositions).dispositions, evalSet: read(req.evalSet), outputs: read(req.reviewerOutputs).outputs });
  const current = currentModeFromDescriptor(repo, req.surface);
  const d = promoteMode({ current: current.mode, requested: req.requested, metrics, thresholds });
  const problems = [...d.problems];
  if (req.current !== undefined && req.current !== current.mode) {
    problems.push({ ruleId: 'review.current-mismatch', message: `the request declares current mode ${req.current}, but ${current.source} sets ${current.mode}: the descriptor is authoritative` });
  }
  const decision = { surface: req.surface, from: current.mode, fromSource: current.source, claimedCurrent: req.current ?? null, requested: req.requested, ...d, problems, metrics };
  const violated = problems.length > 0;
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? problems.map((p) => p.message).join('; ') : undefined,
      findings: problems.map((p) => finding(p.ruleId, p.message, violationSeverity(def), `${req.surface}: review.aiMode`)),
      durationMs: Date.now() - started,
      extensions: { 'x-review-mode': decision },
    }),
    decision,
  };
}

/** @param {{ evalSet, baseline, candidate }} req paths to the eval set and recorded reviewer outputs */
export function reviewerChangeCheck(def, req) {
  const started = Date.now();
  const base = read(req.baseline);
  const cand = read(req.candidate);
  const d = scoreReviewerChange({ evalSet: read(req.evalSet), baseline: { version: base.version, outputs: base.outputs }, candidate: { version: cand.version, outputs: cand.outputs } });
  const violated = !d.kept;
  return {
    result: checkResult(def, {
      status: statusFor(def, violated),
      reason: violated ? `${cand.version} not kept, reviewer pinned to ${d.pinnedTo}: ${d.problems.map((p) => p.message).join('; ')}` : undefined,
      findings: d.problems.map((p) => finding(p.ruleId, `${cand.version}: ${p.message}`, violationSeverity(def))),
      durationMs: Date.now() - started,
      extensions: { 'x-reviewer-change': d },
    }),
    decision: d,
  };
}

export const aiModeModuleCheck = (def, ctx) => aiModeCheck(def, readInput(resolve(ctx.input)), { repo: ctx.repo && resolve(ctx.repo) }).result;
export const reviewerChangeModuleCheck = (def, ctx) => reviewerChangeCheck(def, readInput(resolve(ctx.input))).result;
