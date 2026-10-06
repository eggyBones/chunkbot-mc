// MB-UI-001 optional account metadata: global coalescing/backoff/staleness,
// OpenRouter current-key normalization, and the read-only Codex quota observer
// against a FAKE app-server child (no real CLI, account or network). Verifies
// the exact four-message protocol, account-type gate, fail-closed handling of
// server requests / unexpected events / RPC errors, and that raw output is
// never surfaced.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readCodexQuota, normalizeRateLimits, quotaArgs, type CodexQuotaOptions, type QuotaChild } from '../src/dashboard/codex-quota.ts';
import { CoalescedSource, normalizeKeyResponse, openRouterKeyFetcher, remoteMetadata, codexQuotaFetcher } from '../src/dashboard/remote.ts';

describe('coalesced remote metadata', () => {
  it('many tabs/refreshes start one read; the interval is at least 60 s', async () => {
    let t = 0;
    let reads = 0;
    const src = new CoalescedSource({ name: 'x', now: () => t, minIntervalMs: 1_000, fetch: async () => (reads++, { ok: true, value: 1 }) });
    assert.equal(src.minIntervalMs, 60_000, 'clamped to >= 60 s');
    await Promise.all(Array.from({ length: 10 }, () => src.maybeRefresh()));
    assert.equal(reads, 1);
    t = 59_000;
    assert.equal(src.maybeRefresh(), undefined);
    t = 60_000;
    await src.maybeRefresh();
    assert.equal(reads, 2);
    assert.equal(src.state().status, 'fresh');
  });

  it('failures back off exponentially and stale/unavailable never become a value', async () => {
    let t = 0;
    let fail = false;
    const src = new CoalescedSource<number>({ name: 'x', now: () => t, fetch: async () => (fail ? { ok: false, detail: 'HTTP 503' } : { ok: true, value: 7 }) });
    assert.equal(src.state().status, 'pending');
    await src.maybeRefresh();
    fail = true;
    t = 60_000;
    await src.maybeRefresh();
    t = 60_000 + 60_000; // backoff after 1 failure is 60 s
    await src.maybeRefresh();
    t += 60_000; // after 2 failures the next is 120 s away
    assert.equal(src.maybeRefresh(), undefined);
    t = 6 * 60_000;
    const st = src.state();
    assert.equal(st.status, 'stale', 'last success over 5 min ago');
    assert.equal(st.value, 7, 'last good value is kept but labeled stale');
    const never = new CoalescedSource<number>({ name: 'y', now: () => 0, fetch: async () => ({ ok: false, detail: 'nope' }) });
    await never.maybeRefresh();
    assert.equal(never.state().status, 'unavailable');
    assert.equal(never.state().value, null);
  });

  it('times out a hung read', async () => {
    const src = new CoalescedSource<number>({ name: 'x', now: () => Date.now(), timeoutMs: 30, fetch: (signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('a')))) });
    await src.maybeRefresh();
    assert.match(src.state().detail, /no reply within 30 ms/);
  });
});

describe('OpenRouter current-key overview', () => {
  it('normalizes only usage/limit fields; a null limit means no key cap reported', () => {
    const v = normalizeKeyResponse({ data: { label: 'secret-label', usage: 1.25, usage_daily: 0.0001, usage_weekly: 0.2, limit: null, limit_remaining: null, is_free_tier: false, rate_limit: { x: 1 } } }, 5)!;
    assert.deepEqual(v.limitUsd, { known: true, value: null, source: 'remote_metadata', observedAtMs: 5 });
    assert.equal(v.monthlyUsd.known, false, 'absent field stays unknown');
    assert.doesNotMatch(JSON.stringify(v), /secret-label/);
  });

  it('without the key variable it is "not configured"; HTTP errors never echo the body', async () => {
    const none = openRouterKeyFetcher({ apiKeyEnv: 'OPENROUTER_API_KEY', env: () => ({}), now: () => 1 });
    const r1 = await none(new AbortController().signal);
    assert.ok(!r1.ok && r1.notConfigured);
    const seen: string[] = [];
    const denied = openRouterKeyFetcher({ apiKeyEnv: 'K', env: () => ({ K: 'sk-or-x' }), now: () => 1, fetch: (async (url: string, init: RequestInit) => (seen.push(`${init.method} ${url}`), new Response('{"error":{"message":"bad key sk-or-x"}}', { status: 401 }))) as unknown as typeof fetch });
    const r2 = await denied(new AbortController().signal);
    assert.deepEqual(r2, { ok: false, detail: 'HTTP 401' });
    assert.deepEqual(seen, ['GET https://openrouter.ai/api/v1/key']);
  });

  it('the wallet balance is always reported unavailable (needs a management key)', () => {
    assert.equal(remoteMetadata({}).openRouterWallet.status, 'unavailable');
  });
});

// ------------------------------------------------------------------ Codex quota observer

class FakeChild extends EventEmitter implements QuotaChild {
  readonly pid = 999_999;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<Record<string, unknown>> = [];
  constructor(script: (msg: Record<string, unknown>, child: FakeChild) => void) {
    super();
    let buf = '';
    this.stdin.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.received.push(msg);
        script(msg, this);
        i = buf.indexOf('\n');
      }
    });
    this.stdin.on('finish', () => setImmediate(() => this.emit('exit', 0, null)));
    this.stderr.write('stderr detail that must never be shown: token=abc123\n');
  }
  send(msg: unknown): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
}

const RATE_LIMITS = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_791_582_412 }, secondary: null, credits: null, planType: 'pro' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1_791_582_412 }, secondary: null } },
  accountId: 'acct-should-not-leak',
  rateLimitResetCredits: { availableCount: 1, credits: null },
};

function happy(extra: (msg: Record<string, unknown>, c: FakeChild) => boolean = () => false) {
  return (msg: Record<string, unknown>, c: FakeChild) => {
    if (extra(msg, c)) return;
    if (msg['method'] === 'initialize') c.send({ id: msg['id'], result: { userAgent: 'codex/0.160.0', codexHome: '/Users/x/.codex', platformFamily: 'unix', platformOs: 'macos' } });
    else if (msg['method'] === 'account/read') {
      c.send({ method: 'remoteControl/status/changed', params: {} });
      c.send({ id: msg['id'], result: { account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: true } });
      c.send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
    } else if (msg['method'] === 'account/rateLimits/read') c.send({ id: msg['id'], result: RATE_LIMITS });
  };
}

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'dash-quota-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function opts(script: ConstructorParameters<typeof FakeChild>[0], over: Partial<CodexQuotaOptions> = {}) {
  const children: FakeChild[] = [];
  const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const o: CodexQuotaOptions = {
    command: process.execPath, // any existing absolute path; the runner and child are fakes
    env: { PATH: '/usr/bin', HOME: '/Users/x', OPENROUTER_API_KEY: 'sk-or-must-not-pass', OPENAI_API_KEY: 'sk-nope' },
    denyEnv: ['OPENROUTER_API_KEY'],
    neutralDir: join(dir, 'quota'),
    timeoutMs: 500,
    runner: { run: (_c, args) => (args[0] === '--version' ? { status: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' } : { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }) },
    spawnChild: (_c, args, o2) => {
      spawned.push({ args, env: o2.env });
      const ch = new FakeChild(script);
      children.push(ch);
      return ch;
    },
    table: { list: () => [] },
    kill: () => undefined,
    ...over,
  };
  return { o, children, spawned };
}

describe('Codex quota observer (fake app-server)', () => {
  it('sends exactly initialize, initialized, account/read and account/rateLimits/read; normalizes the returned window only', async () => {
    const { o, children, spawned } = opts(happy());
    const r = await readCodexQuota(o);
    assert.deepEqual(r, { ok: true, windows: [{ bucket: 'codex:primary', usedPercent: 41, windowDurationMins: 10080, resetsAtMs: 1_791_582_412_000 }] });
    const sent = children[0]!.received.map((m) => [m['method'], m['params'] ?? null]);
    assert.deepEqual(sent, [
      ['initialize', { clientInfo: { name: 'chunkbot_dashboard', title: 'Chunkbot dashboard quota observer', version: '1' } }],
      ['initialized', null],
      ['account/read', { refreshToken: false }],
      ['account/rateLimits/read', { excludeResetCreditDetails: true, supportsLunaReserve: false }],
    ]);
    assert.doesNotMatch(JSON.stringify(r), /person@example|acct-should-not-leak|pro|codexHome/);
    // stdio app-server with the planner's pinned auth store; Jev key and API keys not forwarded
    assert.deepEqual(spawned[0]!.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    assert.ok(spawned[0]!.args.includes('cli_auth_credentials_store="file"'));
    assert.equal(spawned[0]!.env['OPENROUTER_API_KEY'], undefined);
    assert.equal(spawned[0]!.env['OPENAI_API_KEY'], undefined);
    assert.equal(spawned[0]!.env['HOME'], '/Users/x');
  });

  it('fails closed on a non-ChatGPT account', async () => {
    const { o } = opts(happy((m, c) => (m['method'] === 'account/read' ? (c.send({ id: m['id'], result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } }), true) : false)));
    const r = await readCodexQuota(o);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'account_type');
  });

  it('rejects an unexpected server request or tool/turn event and never answers it', async () => {
    const req = opts(happy((m, c) => (m['method'] === 'account/read' ? (c.send({ id: 77, method: 'item/tool/call', params: {} }), true) : false)));
    const r1 = await readCodexQuota(req.o);
    assert.deepEqual(r1.ok ? null : r1.reason, 'protocol');
    assert.equal(req.children[0]!.received.filter((m) => m['id'] === 77).length, 0, 'no reply to the server request');
    const ev = opts(happy((m, c) => (m['method'] === 'account/read' ? (c.send({ method: 'turn/started', params: {} }), true) : false)));
    const r2 = await readCodexQuota(ev.o);
    assert.equal(!r2.ok && r2.reason, 'protocol');
  });

  it('RPC errors and stderr are never surfaced raw', async () => {
    const { o } = opts(happy((m, c) => (m['method'] === 'account/rateLimits/read' ? (c.send({ id: m['id'], error: { code: -32600, message: 'secret internal detail token=abc123' } }), true) : false)));
    const r = await readCodexQuota(o);
    assert.equal(!r.ok && r.reason, 'rpc_error');
    assert.doesNotMatch(JSON.stringify(r), /secret internal|abc123/);
  });

  it('gates on the pinned version and the managed ChatGPT login mode before starting anything', async () => {
    const v = opts(happy(), { runner: { run: () => ({ status: 0, stdout: 'codex-cli 0.161.0\n', stderr: '' }) } });
    const r1 = await readCodexQuota(v.o);
    assert.equal(!r1.ok && r1.reason, 'unsupported_version');
    assert.equal(v.spawned.length, 0);
    const a = opts(happy(), { runner: { run: (_c, args) => (args[0] === '--version' ? { status: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' } : { status: 0, stdout: 'Logged in using an API key - sk-***\n', stderr: '' }) } });
    const r2 = await readCodexQuota(a.o);
    assert.equal(!r2.ok && r2.reason, 'auth_mode');
    assert.equal(a.spawned.length, 0);
    assert.doesNotMatch(JSON.stringify(r2), /sk-/);
  });

  it('times out a silent server and still terminates it', async () => {
    const { o, children } = opts(() => undefined, { timeoutMs: 50 });
    const r = await readCodexQuota(o);
    assert.equal(!r.ok && r.reason, 'timeout');
    assert.ok(children[0]!.stdin.writableEnded, 'stdin closed during cleanup');
  });

  it('unknown/null window fields stay unknown; unreturned windows are not invented', () => {
    assert.deepEqual(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 10 }, secondary: null } }), [{ bucket: 'default:primary', usedPercent: 10, windowDurationMins: null, resetsAtMs: null }]);
    assert.deepEqual(normalizeRateLimits({ rateLimits: { primary: null, secondary: null } }), []);
    assert.equal(normalizeRateLimits({ nope: 1 }), undefined);
    assert.ok(quotaArgs('/x/state').every((a) => !/thread|turn|login|logout/.test(a)));
  });

  it('the coalesced fetcher maps an unavailable read to an honest unavailable state', async () => {
    const src = new CoalescedSource({ name: 'q', now: () => 0, fetch: codexQuotaFetcher(async () => ({ ok: false, reason: 'auth_mode', detail: 'Codex login mode is api_key, not the managed ChatGPT subscription' })) });
    await src.maybeRefresh();
    const m = remoteMetadata({ codexQuota: src }).codexQuota;
    assert.equal(m.status, 'unavailable');
    assert.deepEqual(m.windows, []);
  });
});

describe('metadata cadence copy', () => {
  it('states the actual per-source intervals, shared by all tabs', async () => {
    const { remoteCadence } = await import('../src/dashboard/remote.ts');
    const k = new CoalescedSource({ name: 'k', now: () => 0, minIntervalMs: 60_000, fetch: async () => ({ ok: true, value: 1 }) });
    const q = new CoalescedSource({ name: 'q', now: () => 0, minIntervalMs: 120_000, fetch: async () => ({ ok: true, value: [] }) });
    assert.equal(remoteCadence({ openRouterKey: k as never, codexQuota: q as never }), 'per source, shared by all tabs: OpenRouter key at most once a minute; Codex quota at most once every 2 minutes');
    assert.equal(remoteCadence({}), 'no account metadata reads');
  });
});
