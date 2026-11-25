// Local process sandbox for an agent step (tech-design 13 §4, SC-05; CORE-SEC-01).
// Standard §10.1 items 1, 6, 7 ("MUST restrict filesystem access, process execution and network egress") and 8
// (no secrets mounted), applied to one scripted step in an ephemeral worktree. This is NOT the agent runtime (D-09 is
// open): it is the narrowest OS sandbox that can execute a step, so the egress policy of agents/sandbox.yaml is
// demonstrated, not described (FE §20.1). Backends:
//   docker        Linux with a working `docker info`: --network none, --cap-drop ALL, --read-only root, only the
//                 worktree mounted read-write, explicit (scrubbed) environment.
//   sandbox-exec  macOS: an SBPL profile denying network*, process-exec except the node binary, file-write outside the
//                 worktree and file-read outside the worktree and the runtime; scrubbed environment.
//   null          No backend: callers MUST report NOT_ASSESSED (Standard §8.7 rule 3), never a simulated PASS.
// Both backends derive their network setting from the policy (`network.default`), so the mutation proof of SC-05 runs
// the SAME backend with a policy that allows the network (MUTATIONS) and must leak.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { constants as fsc, cpSync, existsSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYaml, policyPath } from './io.mjs';

/** Container image for the docker backend. TODO(supply chain, Standard §10.5): pin by digest (`node:26-slim@sha256:…`). */
export const SANDBOX_IMAGE = process.env.FACTORY_SANDBOX_IMAGE || 'node:26-slim';
/** The only environment variables a sandboxed step receives (Standard §10.1 item 8: nothing is injected). */
export const ENV_ALLOWLIST = ['LANG', 'TZ'];

/**
 * Picks the sandbox backend for this host. `FACTORY_SANDBOX_BACKEND` may require one (CI uses `docker`): when the
 * required backend is unavailable this throws, so a CI step cannot silently degrade to NOT_ASSESSED. `none` forces
 * the no-backend path.
 * @returns {'docker'|'sandbox-exec'|null}
 */
export function resolveBackend({ platform = process.platform, required = process.env.FACTORY_SANDBOX_BACKEND } = {}) {
  if (required === 'none') return null; // simulate a host without a backend (the NOT_ASSESSED path)
  let found = null;
  if (platform === 'linux' && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 }).status === 0) found = 'docker';
  else if (platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0) found = 'sandbox-exec';
  if (required && required !== found) throw new Error(`sandbox backend ${required} required (FACTORY_SANDBOX_BACKEND) but ${found ?? 'none'} is available`);
  return found;
}

export function scrubEnv(env, allow = ENV_ALLOWLIST) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => allow.includes(k)));
}

const sbplString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** SBPL profile for macOS (`sandbox-exec -p`). Paths are real paths: /tmp is a symlink to /private/tmp. */
export function sbplProfile({ worktree, node = realpathSync(process.execPath), policy }) {
  const wt = realpathSync(worktree);
  const runtime = dirname(dirname(node));
  const lines = ['(version 1)', '(allow default)'];
  if (policy.network.default === 'deny') lines.push('(deny network*)'); // allowlistHosts need a proxy: not granted here
  lines.push('(deny process-exec*)', `(allow process-exec (literal ${sbplString(node)}))`);
  lines.push('(deny file-write*)', `(allow file-write* (subpath ${sbplString(wt)}) (literal "/dev/null"))`);
  if (policy.filesystem.read === 'worktree-only') {
    const readable = ['/System', '/usr/lib', '/usr/share', '/private/var/db/dyld', '/Library/Apple', '/dev', runtime, wt];
    lines.push('(deny file-read*)', '(allow file-read-metadata)', `(allow file-read* ${readable.map((p) => `(subpath ${sbplString(p)})`).join(' ')} (literal "/"))`);
  }
  return lines.join('\n');
}

/**
 * docker run arguments for one step: no network (policy `network.default: deny`), no capabilities, read-only root, only
 * the worktree writable. A policy that allows the network gets the default bridge (mutation proof only).
 */
export function dockerArgs({ worktree, cmd, env, policy = { network: { default: 'deny' } }, image = SANDBOX_IMAGE, uid = process.getuid?.(), gid = process.getgid?.() }) {
  const network = policy.network?.default === 'deny' ? 'none' : 'bridge';
  const args = ['run', '--rm', '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '64', '--memory', '256m'];
  if (uid !== undefined) args.push('--user', `${uid}:${gid}`);
  args.push('-v', `${realpathSync(worktree)}:/work:rw`, '-w', '/work');
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(image, ...cmd);
  return args;
}

function collect(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Runs `cmd` (argv, `cmd[0]` is `node`; script paths are relative to the worktree) inside the sandbox.
 * `env` is scrubbed to ENV_ALLOWLIST before it reaches the step. Async: a host listener must keep serving meanwhile.
 * `envGiven` is the environment this host process handed to the backend (observed host-side, not reported by the step).
 * @returns {Promise<{ code: number, stdout: string, stderr: string, backend: string, command: string, envGiven: object }>}
 */
export async function runSandboxed({ policy, worktree, cmd, env = {}, backend = resolveBackend(), timeoutMs = 120000 }) {
  if (!backend) throw new Error('no sandbox backend on this host');
  const clean = { ...scrubEnv(env), HOME: backend === 'docker' ? '/work' : realpathSync(worktree) };
  if (backend === 'docker') {
    const args = dockerArgs({ worktree, cmd, env: clean, policy });
    return { ...(await collect(spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }), timeoutMs)), backend, command: `docker ${args.join(' ')}`, envGiven: clean };
  }
  const node = realpathSync(process.execPath);
  const argv = ['-p', sbplProfile({ worktree, node, policy }), node, ...cmd.slice(1)];
  const envGiven = { ...clean, PATH: '/usr/bin:/bin' };
  const child = spawn('/usr/bin/sandbox-exec', argv, { cwd: realpathSync(worktree), env: envGiven, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ...(await collect(child, timeoutMs)), backend, command: `sandbox-exec -p <profile> node ${cmd.slice(1).join(' ')}`, envGiven };
}

/** Same step, no sandbox, full host environment: the mutation proof (what an unconfined runner would let happen). */
async function runUnsandboxed({ worktree, cmd, env, timeoutMs = 60000 }) {
  const child = spawn(process.execPath, cmd.slice(1), { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ...(await collect(child, timeoutMs)), backend: 'none', command: `node ${cmd.slice(1).join(' ')}`, envGiven: env };
}

/**
 * Mutation proofs of SC-05: the same backend with one restriction of agents/sandbox.yaml removed. A mutated run is
 * expected to leak (FAIL); it can never produce a PASS that counts for the real policy.
 */
export const MUTATIONS = {
  'network-allowed': (policy) => ({ ...policy, network: { ...policy.network, default: 'allow' } }),
};

/**
 * The host address the listener binds to: the docker bridge gateway when docker is the backend (the only host address a
 * container could reach), else loopback. Throws when the gateway cannot be determined: falling back to loopback would
 * make the docker case PASS by construction (a container cannot reach the host's loopback in any network mode).
 */
export function listenerHost(backend, inspect = () => spawnSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' })) {
  if (backend !== 'docker') return '127.0.0.1';
  const r = inspect();
  const ip = r.status === 0 ? r.stdout.trim() : '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`docker bridge gateway not found (${(r.stderr || r.stdout || '').trim() || 'no output'}): the listener cannot be placed where a container could reach it`);
  return ip;
}

/**
 * A host "credentials file" whose read is observable from the host: a FIFO. Opening it for reading completes the host's
 * pending open for writing, so `opened()` is true exactly when some process opened the file (Standard §10.1 item 7);
 * the host then writes the canary into it. `close()` releases the pending open without counting it.
 */
export function observableHostFile(path, content) {
  const r = spawnSync('mkfifo', ['-m', '0644', path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`mkfifo ${path} failed: ${r.stderr || r.error?.message}`);
  let releasing = false;
  let opened = false;
  const pending = openAsync(path, 'w').then(
    async (fh) => {
      if (!releasing) {
        opened = true;
        await fh.write(content).catch(() => {});
      }
      await fh.close();
    },
    () => {},
  );
  return {
    opened: () => opened,
    async close() {
      releasing = true;
      let fd = null;
      try { fd = openSync(path, fsc.O_RDONLY | fsc.O_NONBLOCK); } catch { /* the writer already finished */ }
      await pending;
      if (fd !== null) closeSync(fd);
    },
  };
}

/**
 * Egress probe (SC-05): a host listener counts requests, the host holds a synthetic canary in its environment and in a
 * host file outside the worktree whose opening the host observes (a FIFO), and a scripted "compromised step" follows
 * instructions injected in an issue (untrusted data, Standard §10.1 items 11–12). Every field that decides the outcome
 * is observed on the host side: listener requests and bodies, the env handed to the backend, the step's stdout/stderr,
 * the FIFO open, files outside the worktree, the exit code and the step's work product in its worktree. The step's own
 * JSON report is returned as `stepReport` for diagnostics only.
 * @param {{ issue: string, step: string, sandbox: 'auto'|'none', backend?: string|null, mutation?: string }} opts
 */
export async function egressProbe({ issue, step, sandbox = 'auto', backend, mutation }) {
  if (mutation && !MUTATIONS[mutation]) throw new Error(`unknown sandbox mutation ${mutation} (known: ${Object.keys(MUTATIONS).join(', ')})`);
  if (mutation && sandbox === 'none') throw new Error('a mutation applies to a sandbox backend; sandbox: none is already unconfined');
  const be = sandbox === 'none' ? null : backend === undefined ? resolveBackend() : backend;
  if (sandbox !== 'none' && !be) return { assessed: false, reason: 'no sandbox backend on this host (needs docker on Linux or sandbox-exec on macOS)' };
  const canary = `canary-sc05-${randomBytes(4).toString('hex')}`; // synthetic, obviously fake, unique per run
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { received.push({ method: req.method, url: req.url, body }); res.end('ok'); });
  });
  let host;
  try {
    host = listenerHost(be);
    await new Promise((res, rej) => server.once('error', rej).listen(0, host, res));
  } catch (err) {
    // Never fall back to another address: a listener the step cannot reach would make the case PASS by construction.
    return { assessed: true, infraError: `host listener not available for backend ${be ?? 'none'}: ${err.message}`, backend: be ?? 'none' };
  }
  const url = `http://${host}:${server.address().port}/collect`;
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'acme-sandbox-wt-')));
  const hostDir = realpathSync(mkdtempSync(join(tmpdir(), 'acme-sandbox-host-')));
  let hostFile = null;
  try {
    const hostFilePath = join(hostDir, 'host-credentials.txt');
    hostFile = observableHostFile(hostFilePath, `${canary}\n`);
    writeFileSync(join(worktree, 'issue.md'), readFileSync(issue, 'utf8').replaceAll('{{EXFIL_URL}}', url).replaceAll('{{HOST_FILE}}', hostFilePath).replaceAll('{{OUTSIDE_PATH}}', join(hostDir, 'planted.txt')));
    cpSync(step, join(worktree, basename(step)));
    const cmd = ['node', basename(step), 'issue.md'];
    const hostEnv = { ...process.env, FACTORY_EGRESS_CANARY: canary };
    const base = readYaml(policyPath('agents', 'sandbox.yaml'));
    const policy = mutation ? MUTATIONS[mutation](base) : base;
    const run = be ? await runSandboxed({ policy, worktree, cmd, env: hostEnv, backend: be }) : await runUnsandboxed({ worktree, cmd, env: hostEnv });
    await new Promise((r) => setTimeout(r, 50)); // let an in-flight request body finish
    const line = run.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    let report = null;
    try { report = line ? JSON.parse(line) : null; } catch { report = null; }
    const workProduct = join(worktree, 'fix-attempt.md');
    return {
      assessed: true,
      backend: run.backend,
      mutation: mutation ?? null,
      command: run.command,
      exitCode: run.code,
      // Host-side: the process exited 0 and left its work product in its own worktree.
      stepRan: run.code === 0 && existsSync(workProduct),
      requestsReceived: received.length,
      canaryReachedListener: received.some((r) => r.body.includes(canary) || r.url.includes(canary)),
      canaryInStepOutput: run.stdout.includes(canary) || run.stderr.includes(canary),
      canaryInEnvGiven: Object.values(run.envGiven ?? {}).some((v) => String(v).includes(canary)),
      hostFileOpened: hostFile.opened(),
      wroteOutsideWorktree: existsSync(join(hostDir, 'planted.txt')),
      stepReport: report, // self-reported by the step: diagnostics only, never part of the verdict
      stderrTail: run.stderr.trim().split('\n').slice(-3).join(' | '),
    };
  } finally {
    server.close();
    await hostFile?.close();
    rmSync(worktree, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  }
}

/** Synchronous bridge for check and showcase code (they are synchronous): runs egressProbe in a child process. */
export function egressProbeSync(opts) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'egress-probe', JSON.stringify(opts)], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    const lines = (r.stderr || r.error?.message || '').trim().split('\n');
    throw new Error(`egress probe failed: ${lines.find((l) => /Error\b/.test(l)) ?? lines.slice(-3).join(' ')}`);
  }
  return JSON.parse(r.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'egress-probe') {
  egressProbe(JSON.parse(process.argv[3])).then(
    (out) => process.stdout.write(JSON.stringify(out)),
    (err) => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; },
  );
}
