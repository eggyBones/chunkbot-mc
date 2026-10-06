// Optional remote account/key metadata for the viewer, behind one coalesced
// refresher PER SOURCE shared by all tabs: at most one read in flight, at most
// one start per `minIntervalMs` (>= 60 s; the Codex quota uses 120 s), bounded timeout, exponential backoff after
// failures, and a stale label after `staleAfterMs` (5 min) without success.
// Browser tabs only read the cached normalized state; they can never trigger
// a read themselves. Only normalized, non-sensitive metrics are kept: never
// raw envelopes, key labels, headers, account identity or error bodies.
import { z } from 'zod';
import { known, unknown, type Known, type RemoteMetadata } from '../contracts/dashboard.ts';
import type { CodexQuotaResult, CodexQuotaWindow } from './codex-quota.ts';

export type FetchResult<T> = { ok: true; value: T } | { ok: false; detail: string; notConfigured?: boolean };

export interface CoalescedOptions<T> {
  name: string;
  now: () => number;
  fetch: (signal: AbortSignal) => Promise<FetchResult<T>>;
  /** Minimum time between read starts (clamped to >= 60 s unless `allowFastForTests`). */
  minIntervalMs?: number;
  timeoutMs?: number;
  staleAfterMs?: number;
  maxBackoffMs?: number;
  allowFastForTests?: boolean;
}

export interface CoalescedState<T> {
  status: 'fresh' | 'stale' | 'unavailable' | 'not_configured' | 'pending';
  checkedAtMs: number | null;
  lastSuccessAtMs: number | null;
  detail: string;
  value: T | null;
}

/** One shared refresher per metadata source. */
export class CoalescedSource<T> {
  private readonly o: CoalescedOptions<T>;
  private inFlight: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private nextAllowedAtMs = 0;
  private failures = 0;
  private checkedAtMs: number | null = null;
  private lastSuccessAtMs: number | null = null;
  private value: T | null = null;
  private detail = 'not checked yet';
  private notConfigured = false;
  /** Number of reads actually started (evidence for coalescing tests). */
  reads = 0;

  constructor(options: CoalescedOptions<T>) {
    this.o = options;
  }

  get minIntervalMs(): number {
    const v = this.o.minIntervalMs ?? 60_000;
    return this.o.allowFastForTests ? v : Math.max(60_000, v);
  }

  /** Starts a read only if none is in flight and the interval/backoff allows. Returns the in-flight promise. */
  maybeRefresh(): Promise<void> | undefined {
    if (this.inFlight) return this.inFlight;
    const now = this.o.now();
    if (now < this.nextAllowedAtMs) return undefined;
    this.reads += 1;
    this.checkedAtMs = now;
    const abort = new AbortController();
    this.abort = abort;
    const timeoutMs = this.o.timeoutMs ?? 15_000;
    const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);
    timer.unref?.();
    this.inFlight = (async () => {
      let r: FetchResult<T>;
      try {
        r = await this.o.fetch(abort.signal);
      } catch {
        r = { ok: false, detail: abort.signal.aborted ? `no reply within ${timeoutMs} ms` : 'read failed' };
      } finally {
        clearTimeout(timer);
      }
      if (abort.signal.aborted && r.ok) r = { ok: false, detail: `no reply within ${timeoutMs} ms` };
      const done = this.o.now();
      if (r.ok) {
        this.value = r.value;
        this.lastSuccessAtMs = done;
        this.failures = 0;
        this.notConfigured = false;
        this.detail = 'ok';
        this.nextAllowedAtMs = done + this.minIntervalMs;
      } else {
        this.failures += 1;
        this.notConfigured = Boolean(r.notConfigured);
        this.detail = r.detail.slice(0, 200);
        const backoff = Math.min(this.o.maxBackoffMs ?? 15 * 60_000, this.minIntervalMs * 2 ** Math.min(6, this.failures - 1));
        this.nextAllowedAtMs = done + backoff;
      }
    })().finally(() => {
      this.inFlight = undefined;
      this.abort = undefined;
    });
    return this.inFlight;
  }

  state(): CoalescedState<T> {
    const now = this.o.now();
    const stale = this.o.staleAfterMs ?? 5 * 60_000;
    let status: CoalescedState<T>['status'];
    if (this.notConfigured && this.lastSuccessAtMs === null) status = 'not_configured';
    else if (this.lastSuccessAtMs === null) status = this.inFlight || this.checkedAtMs === null ? 'pending' : 'unavailable';
    else status = now - this.lastSuccessAtMs > stale ? 'stale' : 'fresh';
    return { status, checkedAtMs: this.checkedAtMs, lastSuccessAtMs: this.lastSuccessAtMs, detail: this.detail, value: this.value };
  }

  /** Cancels an in-flight read (viewer shutdown). */
  close(): void {
    this.abort?.abort(new Error('closed'));
  }
}

// ------------------------------------------------------------------ OpenRouter current key

export const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';

const num = z.number().finite();
const KeyResponse = z
  .object({
    data: z
      .object({
        usage: num.nonnegative().optional(),
        usage_daily: num.nonnegative().optional(),
        usage_weekly: num.nonnegative().optional(),
        usage_monthly: num.nonnegative().optional(),
        limit: num.nonnegative().nullable().optional(),
        limit_remaining: num.nullable().optional(),
        limit_reset: z.string().max(64).nullable().optional(),
        is_free_tier: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type OpenRouterKeyValue = NonNullable<RemoteMetadata['openRouterKey']['value']>;

/** Keeps only the documented usage/limit fields; absent fields stay unknown (null limit = no key cap reported). */
export function normalizeKeyResponse(raw: unknown, atMs: number): OpenRouterKeyValue | undefined {
  const p = KeyResponse.safeParse(raw);
  if (!p.success) return undefined;
  const d = p.data.data;
  const k = <T>(v: T | undefined, what: string): Known<T> => (v === undefined ? unknown(`${what} not reported`) : known(v, 'remote_metadata', atMs));
  return {
    usageUsd: k(d.usage, 'usage'),
    dailyUsd: k(d.usage_daily, 'daily usage'),
    weeklyUsd: k(d.usage_weekly, 'weekly usage'),
    monthlyUsd: k(d.usage_monthly, 'monthly usage'),
    limitUsd: k(d.limit, 'key limit'),
    limitRemainingUsd: k(d.limit_remaining, 'remaining key limit'),
    limitReset: k(d.limit_reset === undefined ? undefined : d.limit_reset === null ? null : d.limit_reset.slice(0, 64), 'limit reset'),
    isFreeTier: k(d.is_free_tier, 'free-tier flag'),
  };
}

export interface OpenRouterKeyOptions {
  /** Environment variable NAME holding the key (read at call time, never stored). */
  apiKeyEnv: string;
  env: () => Record<string, string | undefined>;
  now: () => number;
  endpoint?: string;
  fetch?: typeof fetch;
}

export function openRouterKeyFetcher(o: OpenRouterKeyOptions): (signal: AbortSignal) => Promise<FetchResult<OpenRouterKeyValue>> {
  return async (signal) => {
    const key = o.env()[o.apiKeyEnv];
    if (!key) return { ok: false, notConfigured: true, detail: `${o.apiKeyEnv} is not set for the viewer process` };
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(o.endpoint ?? OPENROUTER_KEY_ENDPOINT, { method: 'GET', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal, redirect: 'error' });
    } catch {
      return { ok: false, detail: signal.aborted ? 'timed out' : 'network error' };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 64 * 1024) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, detail: 'response too large' };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false, detail: 'response read failed' };
    }
    if (text.length > 64 * 1024) return { ok: false, detail: 'response too large' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, detail: 'response is not JSON' };
    }
    const value = normalizeKeyResponse(raw, o.now());
    return value ? { ok: true, value } : { ok: false, detail: 'unexpected response shape' };
  };
}

// ------------------------------------------------------------------ Codex quota

export function codexQuotaFetcher(read: (signal: AbortSignal) => Promise<CodexQuotaResult>): (signal: AbortSignal) => Promise<FetchResult<CodexQuotaWindow[]>> {
  return async (signal) => {
    const r = await read(signal);
    return r.ok ? { ok: true, value: r.windows } : { ok: false, detail: r.detail, ...(r.reason === 'not_installed' ? { notConfigured: true } : {}) };
  };
}

// ------------------------------------------------------------------ assembly

export interface RemoteSources {
  openRouterKey?: CoalescedSource<OpenRouterKeyValue>;
  codexQuota?: CoalescedSource<CodexQuotaWindow[]>;
}

/** Human cadence of the configured sources (actual intervals; per source, shared by all tabs). */
export function remoteCadence(sources: RemoteSources): string {
  const parts: string[] = [];
  const every = (ms: number) => (ms % 60_000 === 0 ? (ms === 60_000 ? 'once a minute' : `once every ${ms / 60_000} minutes`) : `once every ${Math.round(ms / 1000)} s`);
  if (sources.openRouterKey) parts.push(`OpenRouter key at most ${every(sources.openRouterKey.minIntervalMs)}`);
  if (sources.codexQuota) parts.push(`Codex quota at most ${every(sources.codexQuota.minIntervalMs)}`);
  return parts.length ? `per source, shared by all tabs: ${parts.join('; ')}` : 'no account metadata reads';
}

export function remoteMetadata(sources: RemoteSources): RemoteMetadata {
  const k = sources.openRouterKey?.state();
  const q = sources.codexQuota?.state();
  return {
    openRouterKey: k
      ? { status: k.status, scope: 'openrouter_api_key', checkedAtMs: k.checkedAtMs, lastSuccessAtMs: k.lastSuccessAtMs, detail: k.detail, value: k.value }
      : { status: 'not_configured', scope: 'openrouter_api_key', checkedAtMs: null, lastSuccessAtMs: null, detail: 'key overview disabled', value: null },
    openRouterWallet: { status: 'unavailable', detail: 'account wallet balance needs an OpenRouter management key, which Chunkbot does not use' },
    codexQuota: q
      ? { status: q.status, scope: 'codex_account', checkedAtMs: q.checkedAtMs, lastSuccessAtMs: q.lastSuccessAtMs, detail: q.detail, windows: q.value ?? [] }
      : { status: 'not_configured', scope: 'codex_account', checkedAtMs: null, lastSuccessAtMs: null, detail: 'quota observer disabled', windows: [] },
  };
}

export function refreshAll(sources: RemoteSources): void {
  void sources.openRouterKey?.maybeRefresh();
  void sources.codexQuota?.maybeRefresh();
}
