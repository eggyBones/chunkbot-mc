// Optional, read-only Codex subscription quota observer (D-G4).
//
// A SEPARATE bounded operator adapter, never the gameplay planner transport:
// it starts the pinned CLI's `app-server` over stdio in its own process group
// and sends exactly four messages - `initialize`, `initialized`,
// `account/read {refreshToken:false}` and `account/rateLimits/read
// {excludeResetCreditDetails:true, supportsLunaReserve:false}` - then
// terminates the owned process tree. No thread/turn/tool method, login,
// logout, refresh or reset-credit request is ever sent.
//
// Gates (fail closed, shown as "unavailable"): the exact pinned CLI version,
// the managed ChatGPT login MODE (read-only `codex login status`) with the same
// file credentials store as the planner, an app-owned neutral working
// directory without development-instruction markers, and the planner's
// environment allowlist (never the Jev key). `account/read` must report
// `type: "chatgpt"`; its identity fields (email, plan) are checked in memory
// and discarded. Only returned quota windows are normalized (bucket, used
// percent, window duration, reset time); null fields stay unknown. Server
// requests, tool/thread/turn events or unknown notifications reject the read.
// Raw stderr, RPC error messages and envelopes are never exposed or stored.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AUTH_STORE_OVERRIDE, CODEX_PROFILE, classifyLoginStatus, instructionMarkersAbove, plannerEnv, resolveCommand, type CliRunner } from '../planner/codex-cli.ts';
import { OwnershipTracker, psTable, type ProcessTable } from '../planner/process.ts';

export interface CodexQuotaWindow {
  bucket: string;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAtMs: number | null;
}

export type CodexQuotaFailure = 'not_installed' | 'unsupported_version' | 'auth_mode' | 'neutral_dir' | 'account_type' | 'timeout' | 'protocol' | 'rpc_error' | 'process_error' | 'aborted';
export type CodexQuotaResult = { ok: true; windows: CodexQuotaWindow[] } | { ok: false; reason: CodexQuotaFailure; detail: string };

/** Minimal child surface (test seam). */
export interface QuotaChild {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CodexQuotaOptions {
  /** Configured planner command (`models.planner.command`, normally `codex`). */
  command: string;
  /** Source environment; scrubbed to the planner allowlist before use. */
  env: NodeJS.ProcessEnv;
  /** Environment NAMES never forwarded (e.g. the configured Jev key name). */
  denyEnv?: readonly string[];
  neutralDir?: string;
  timeoutMs?: number;
  /** Synchronous runner for `--version` / `login status` (test seam); default is async execFile (never blocks the viewer). */
  runner?: CliRunner;
  spawnChild?: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => QuotaChild;
  table?: ProcessTable;
  /** Kill hook (test seam); defaults to signalling the owned group and proven descendants. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** The only client requests this adapter may send. */
export const QUOTA_METHODS = ['initialize', 'account/read', 'account/rateLimits/read'] as const;
/** Notifications that are benign during a read (ignored). Anything else rejects the read. */
export const BENIGN_NOTIFICATIONS = new Set(['remoteControl/status/changed', 'account/updated', 'account/rateLimits/updated', 'configWarning', 'deprecationNotice']);

export function defaultQuotaDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `chunkbot-dashboard-quota-${uid}`);
}

/** app-server arguments: stdio only, file auth store pinned, no MCP servers, isolation features off, no history. */
export function quotaArgs(stateDir: string): string[] {
  const args = ['app-server', '--listen', 'stdio://'];
  const c = [
    AUTH_STORE_OVERRIDE,
    'check_for_update_on_startup=false',
    'history.persistence="none"',
    'mcp_servers={}',
    'orchestrator.mcp.enabled=false',
    'agents.enabled=false',
    'web_search="disabled"',
    `sqlite_home=${JSON.stringify(stateDir)}`,
    ...Object.entries(CODEX_PROFILE.features).map(([k, v]) => `features.${k}=${v}`),
  ];
  for (const v of c) args.push('-c', v);
  return args;
}

const RpcId = z.union([z.number().int(), z.string().max(64)]);
const IncomingSchema = z
  .object({
    id: RpcId.optional(),
    method: z.string().max(128).optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number().int(), message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const InitializeResult = z.object({ userAgent: z.string().max(400) }).passthrough();
const AccountResult = z.object({ account: z.object({ type: z.string().max(40) }).passthrough().nullable().optional(), requiresOpenaiAuth: z.boolean() }).passthrough();
const WindowSchema = z.object({ usedPercent: z.number().finite(), windowDurationMins: z.number().int().positive().nullable().optional(), resetsAt: z.number().int().nullable().optional() }).passthrough();
const SnapshotSchema = z.object({ limitId: z.string().max(200).nullable().optional(), primary: WindowSchema.nullable().optional(), secondary: WindowSchema.nullable().optional() }).passthrough();
const RateLimitsResult = z.object({ rateLimits: SnapshotSchema, rateLimitsByLimitId: z.record(z.string().max(200), SnapshotSchema).nullable().optional() }).passthrough();

const bucketName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 64) || 'unnamed';

/** Normalizes only returned windows; null/absent fields stay null (unknown). */
export function normalizeRateLimits(result: unknown): CodexQuotaWindow[] | undefined {
  const parsed = RateLimitsResult.safeParse(result);
  if (!parsed.success) return undefined;
  const buckets: Array<[string, z.infer<typeof SnapshotSchema>]> = parsed.data.rateLimitsByLimitId
    ? Object.entries(parsed.data.rateLimitsByLimitId).slice(0, 4)
    : [[parsed.data.rateLimits.limitId ?? 'default', parsed.data.rateLimits]];
  const out: CodexQuotaWindow[] = [];
  for (const [id, snap] of buckets) {
    for (const which of ['primary', 'secondary'] as const) {
      const w = snap[which];
      if (!w) continue;
      out.push({
        bucket: `${bucketName(id)}:${which}`,
        usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
        windowDurationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
        resetsAtMs: typeof w.resetsAt === 'number' && w.resetsAt > 0 ? w.resetsAt * 1000 : null,
      });
    }
  }
  return out.slice(0, 8);
}

function ensureNeutralDir(dir: string): string | undefined {
  const markers = instructionMarkersAbove(dir);
  if (markers.length > 0) return 'development-instruction markers exist above the quota working directory';
  mkdirSync(join(dir, 'state'), { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return 'the quota working directory is not app-owned';
  if ((st.mode & 0o077) !== 0) return 'the quota working directory is accessible to other users';
  return undefined;
}

const defaultSpawn = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): QuotaChild =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess as unknown as QuotaChild;

/** One bounded read. Never throws; never exposes raw output. */
export async function readCodexQuota(options: CodexQuotaOptions, signal?: AbortSignal): Promise<CodexQuotaResult> {
  const env = plannerEnv(options.env, options.denyEnv ?? []);
  const command = resolveCommand(options.command, options.env);
  if (!command) return { ok: false, reason: 'not_installed', detail: 'the Codex CLI is not installed on PATH' };
  const dir = options.neutralDir ?? defaultQuotaDir();
  let dirProblem: string | undefined;
  try {
    dirProblem = ensureNeutralDir(dir);
  } catch {
    dirProblem = 'cannot prepare the quota working directory';
  }
  if (dirProblem) return { ok: false, reason: 'neutral_dir', detail: dirProblem };
  const run = (args: string[], timeoutMs: number) => (options.runner ? Promise.resolve(options.runner.run(command, args, { cwd: dir, env, timeoutMs })) : runAsync(command, args, dir, env, timeoutMs));
  const v = await run(['--version'], 5_000);
  const version = /^codex-cli\s+(\S+)\s*$/.exec(v.stdout.trim())?.[1];
  if (v.status !== 0 || !version) return { ok: false, reason: 'unsupported_version', detail: 'cannot read the Codex CLI version' };
  if (version !== CODEX_PROFILE.cliVersion) return { ok: false, reason: 'unsupported_version', detail: `installed Codex CLI ${version.slice(0, 20)} is not the verified ${CODEX_PROFILE.cliVersion}` };
  // Same read-only, mode-only check and file credentials store as the planner (MB-PLAN-002). Text is never kept.
  const status = await run(['login', 'status', '-c', AUTH_STORE_OVERRIDE], 10_000);
  const mode = classifyLoginStatus(status.status, `${status.stdout}\n${status.stderr}`);
  if (mode !== 'chatgpt') return { ok: false, reason: 'auth_mode', detail: `Codex login mode is ${mode}, not the managed ChatGPT subscription` };
  if (signal?.aborted) return { ok: false, reason: 'aborted', detail: 'read cancelled' };
  return runProtocol(command, quotaArgs(join(dir, 'state')), dir, env, options, signal);
}

async function runProtocol(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: CodexQuotaOptions, signal: AbortSignal | undefined): Promise<CodexQuotaResult> {
  let child: QuotaChild;
  try {
    child = (options.spawnChild ?? defaultSpawn)(command, args, { cwd, env });
  } catch {
    return { ok: false, reason: 'process_error', detail: 'cannot start the Codex app-server' };
  }
  const pid = child.pid;
  if (pid === undefined) return { ok: false, reason: 'process_error', detail: 'the Codex app-server did not start' };
  const tracker = new OwnershipTracker(pid, options.table ?? psTable);
  tracker.observe();
  let exited = false;
  child.once('exit', () => (exited = true));
  child.once('error', () => (exited = true));
  child.stderr?.on('data', () => undefined); // drained and discarded: never exposed
  child.stdin?.on?.('error', () => undefined);

  const result = await new Promise<CodexQuotaResult>((resolve) => {
    let settled = false;
    let stdoutBytes = 0;
    let partial = '';
    let step: 'initialize' | 'account' | 'limits' = 'initialize';
    const finish = (r: CodexQuotaResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: `no complete quota reply within ${options.timeoutMs ?? 15_000} ms` }), options.timeoutMs ?? 15_000);
    const onAbort = () => finish({ ok: false, reason: 'aborted', detail: 'read cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('exit', () => finish({ ok: false, reason: 'process_error', detail: 'the Codex app-server exited before replying' }));
    const send = (msg: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        finish({ ok: false, reason: 'process_error', detail: 'cannot write to the Codex app-server' });
      }
    };
    const onMessage = (line: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return finish({ ok: false, reason: 'protocol', detail: 'non-JSON output from the Codex app-server' });
      }
      const m = IncomingSchema.safeParse(raw);
      if (!m.success) return finish({ ok: false, reason: 'protocol', detail: 'unrecognized message from the Codex app-server' });
      const msg = m.data;
      if (msg.method !== undefined) {
        // A server REQUEST (has an id) is never answered: reads must not delegate anything.
        if (msg.id !== undefined) return finish({ ok: false, reason: 'protocol', detail: 'the Codex app-server sent an unexpected request' });
        if (BENIGN_NOTIFICATIONS.has(msg.method)) return;
        return finish({ ok: false, reason: 'protocol', detail: 'the Codex app-server sent an unexpected notification' });
      }
      if (msg.id === undefined) return finish({ ok: false, reason: 'protocol', detail: 'reply without an id' });
      const expected = step === 'initialize' ? 1 : step === 'account' ? 2 : 3;
      if (msg.id !== expected) return finish({ ok: false, reason: 'protocol', detail: 'reply with an unexpected id' });
      if (msg.error) return finish({ ok: false, reason: 'rpc_error', detail: `${step === 'initialize' ? 'initialize' : step === 'account' ? 'account read' : 'rate-limit read'} failed (code ${msg.error.code})` });
      if (step === 'initialize') {
        if (!InitializeResult.safeParse(msg.result).success) return finish({ ok: false, reason: 'protocol', detail: 'unexpected initialize reply' });
        send({ method: 'initialized' });
        step = 'account';
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        return;
      }
      if (step === 'account') {
        const a = AccountResult.safeParse(msg.result);
        // Identity fields (email, plan) are only checked for presence of the account type and discarded.
        if (!a.success) return finish({ ok: false, reason: 'protocol', detail: 'unexpected account reply' });
        if (a.data.account?.type !== 'chatgpt') return finish({ ok: false, reason: 'account_type', detail: `the Codex account is ${a.data.account ? 'not a ChatGPT subscription account' : 'not signed in'}` });
        step = 'limits';
        send({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        return;
      }
      const windows = normalizeRateLimits(msg.result);
      if (!windows) return finish({ ok: false, reason: 'protocol', detail: 'unexpected rate-limit reply shape' });
      finish({ ok: true, windows });
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBytes += text.length;
      if (stdoutBytes > 1024 * 1024) return finish({ ok: false, reason: 'protocol', detail: 'Codex app-server output exceeded the bound' });
      partial += text;
      let nl = partial.indexOf('\n');
      while (nl >= 0 && !settled) {
        const line = partial.slice(0, nl).trim();
        partial = partial.slice(nl + 1);
        if (line) onMessage(line);
        nl = partial.indexOf('\n');
      }
      if (partial.length > 256 * 1024) finish({ ok: false, reason: 'protocol', detail: 'Codex app-server line exceeded the bound' });
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'chunkbot_dashboard', title: 'Chunkbot dashboard quota observer', version: '1' } } });
  });

  await terminate(pid, tracker, () => exited, child, options.kill);
  return result;
}

async function terminate(pid: number, tracker: OwnershipTracker, exited: () => boolean, child: QuotaChild, kill?: (pid: number, signal: NodeJS.Signals) => void): Promise<void> {
  const signalAll = (sig: NodeJS.Signals) => {
    const k = kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s));
    if (!exited()) {
      try {
        k(-pid, sig);
      } catch {
        // group gone
      }
    }
    for (const p of tracker.observe()) {
      try {
        k(p, sig);
      } catch {
        // gone
      }
    }
  };
  try {
    child.stdin?.end();
  } catch {
    // already closed
  }
  const settle = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (exited() && tracker.observe().length === 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return exited() && tracker.observe().length === 0;
  };
  if (await settle(300)) return;
  signalAll('SIGTERM');
  if (await settle(1_000)) return;
  signalAll('SIGKILL');
  await settle(1_000);
}

function runAsync(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      resolve({ status: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}
