// Command verification adapter (Standard §7.16; CORE-VER-12).
// Runs the command defined centrally in registry/checks.yaml — never a command supplied by the change — and maps
// exit codes to canonical states (FE §7.6): 0 → PASS, 1 → FAIL, anything else / timeout / spawn error → ERROR.
import { spawnSync } from 'node:child_process';
import { checkResult } from '../lib/result.mjs';

export const ADAPTER = { id: 'command-adapter', version: '0.1.0' };

// Outside a developer machine, results must be recomputed from the subject, never replayed from a cache the change
// could have populated (Standard §7.15): build-tool caches are disabled for every non-local executor.
export const NO_CACHE_ENV = { NX_SKIP_NX_CACHE: 'true', NX_NO_CLOUD: 'true' };

export function runCommandCheck(def, { cwd, env = process.env, executor = 'local' }) {
  const started = Date.now();
  if (executor !== 'local') env = { ...env, ...NO_CACHE_ENV };
  const [cmd, ...args] = def.command;
  const proc = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: (def.timeoutSeconds ?? 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = Date.now() - started;
  const tail = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');

  let status;
  let reason;
  if (proc.error?.code === 'ETIMEDOUT') {
    status = 'ERROR';
    reason = `timeout after ${def.timeoutSeconds}s (environment, not the change)`;
  } else if (proc.error) {
    status = 'ERROR';
    reason = `could not start ${cmd}: ${proc.error.message}`;
  } else if (proc.status === 0) status = 'PASS';
  else if (proc.status === 1) {
    status = 'FAIL';
    reason = `${def.checkId} failed:\n${tail}`;
  } else {
    status = 'ERROR';
    reason = `exit code ${proc.status ?? `signal ${proc.signal}`}:\n${tail}`;
  }
  return checkResult(def, { status, reason, durationMs, tool: { name: ADAPTER.id, version: ADAPTER.version } });
}
