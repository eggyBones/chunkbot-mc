// MB-UI-001 usage accounting end to end: the REAL JevDecisionAdapter and
// SpendLedger (fake provider responses, no network) feed the dashboard through
// the store tee. Checks exact session rollups, separation of confirmed /
// retained / pending / remaining, tiny precision, retries and charged failures,
// deduplication, planner usage with unknown turns, and the durable dated
// history (restart, unclean end, corruption, time zone) without any effect on
// the spending cap.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { usdToNano } from '../src/contracts/dashboard.ts';
import type { ActionCandidate, DecisionRequest, EvidenceEvent } from '../src/contracts/index.ts';
import { dayKey, readHistory, UsageHistoryStore } from '../src/dashboard/history.ts';
import { createDashboardRuntime } from '../src/dashboard/runtime.ts';
import { UsageAccumulator } from '../src/dashboard/usage.ts';
import { JevDecisionAdapter } from '../src/decision/jev-adapter.ts';
import { PROMPT_USD_PER_TOKEN, maxAttemptChargeUsd } from '../src/decision/pricing.ts';
import { SpendLedger } from '../src/decision/spend.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';

const MAX_NANO = usdToNano(maxAttemptChargeUsd());
let dir: string;
let clock: { t: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-usage-'));
  clock = { t: Date.parse('2026-10-06T15:00:00Z') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function candidate(n: number): ActionCandidate {
  return { id: `act-test${n}aaa`, capability: 'move_near', parameters: {}, snapshotId: 'snap-0001', connectionEpoch: 1, goalEpoch: 1, description: `option ${n}`, criteria: ['x'], preconditions: ['y'], timeoutMs: 1_000 };
}
let reqN = 0;
function request(): DecisionRequest {
  reqN += 1;
  return { requestId: `req-${String(reqN).padStart(4, '0')}`, goalId: 'goal-0001', goalEpoch: 1, taskId: 'task-0001', connectionEpoch: 1, snapshotId: 'snap-0001', objective: 'o', instruction: 'i', condition: 'c', mode: 'complete', state: {}, candidates: [candidate(1), candidate(2)] };
}

type Reply = (body: string, signal: AbortSignal) => Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function okReply(tokens: number, patch: (r: Record<string, unknown>) => void = () => undefined): Reply {
  return async (body) => {
    const keys = Object.keys((JSON.parse(body) as { questions: { next_action: { criteria: Record<string, string> } } }).questions.next_action.criteria);
    const r: Record<string, unknown> = {
      model: 'typesafe/jev-1.13-20260917',
      provider: 'TypeSafe',
      answers: { next_action: { type: 'choice', choice: keys[0], probabilities: { [keys[0]!]: 0.8, [keys[1]!]: 0.2 }, confidence: 0.8 } },
      usage: { input_tokens: tokens, output_tokens: 0, cost: tokens * PROMPT_USD_PER_TOKEN },
    };
    patch(r);
    return json(200, r);
  };
}
const statusReply = (code: number): Reply => async () => json(code, { error: { message: 'fixture', code } });
const hang: Reply = (_b, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

function harness(capUsd = 1, timeoutMs = 40) {
  const replies: Reply[] = [];
  const spend = new SpendLedger(capUsd);
  const store = new MemoryRunStore();
  const runtime = createDashboardRuntime({ dataDir: dir, runId: 'run-usage001', now: () => clock.t, game: { state: 'disconnected', connectionEpoch: 0, onLifecycle: () => () => undefined, session: () => undefined }, profile: { version: '26.1.2', supportLevel: 'upstream-tested' }, spend, timeZone: 'UTC' });
  const tapped = runtime.tapStore(store);
  const adapter = new JevDecisionAdapter({
    model: 'typesafe/jev-1.13',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    env: () => ({ OPENROUTER_API_KEY: 'sk-or-test-not-real-0000000000' }),
    expectedProvider: 'TypeSafe',
    spend,
    store: tapped,
    clock: { now: () => clock.t },
    timeoutMs,
    minIntervalMs: 0,
    attemptsPerGoal: 100,
    sleep: async () => undefined,
    fetch: (async (_url: string, init: RequestInit) => {
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      return next(String(init.body), init.signal as AbortSignal);
    }) as unknown as typeof fetch,
  });
  return { replies, spend, store, runtime, adapter, tapped };
}

const choose = async (h: ReturnType<typeof harness>) => h.adapter.choose(request(), new AbortController().signal).then(() => 'ok', (e: { failure?: { kind: string } }) => e.failure?.kind ?? 'error');

function status(h: ReturnType<typeof harness>) {
  h.runtime.start();
  h.runtime.stop('read');
  return JSON.parse(readFileSync(h.runtime.paths.status, 'utf8'));
}

describe('dashboard usage: Jev session rollups from the real adapter', () => {
  it('separates confirmed, retained and released charges exactly, with retries and charged failures', async () => {
    const h = harness();
    h.replies.push(okReply(420)); // validated
    h.replies.push(okReply(300, (r) => ((r['answers'] as { next_action: { choice: string } }).next_action.choice = 'act-notoffered'))); // charged failure (trusted usage)
    h.replies.push(statusReply(503), okReply(100)); // retained, then retry validated
    h.replies.push(statusReply(400)); // released (provider certainly did not run)
    h.replies.push(hang, hang); // timeout retained, retry timeout retained
    assert.deepEqual([await choose(h), await choose(h), await choose(h), await choose(h), await choose(h)], ['ok', 'invalid_response', 'ok', 'request_rejected', 'timeout']);
    const s = status(h);
    const j = s.usage.jev.value;
    const cost = (n: number) => usdToNano(n * PROMPT_USD_PER_TOKEN);
    assert.equal(j.attempts, 7);
    assert.equal(j.retries, 2);
    assert.equal(j.validatedResponses, 2);
    assert.equal(j.chargedFailures, 1);
    assert.equal(j.retainedAttempts, 3);
    assert.equal(j.releasedAttempts, 1);
    assert.equal(j.inputTokens, 520, 'only validated responses carry token counts');
    assert.equal(j.tokensUnknownAttempts, 4, 'charged failure + 3 ambiguous attempts have unknown tokens');
    assert.ok(Math.abs(j.confirmedNanoUsd - (cost(420) + cost(300) + cost(100))) <= 2);
    assert.equal(j.retainedNanoUsd, 3 * MAX_NANO);
    assert.equal(j.pendingNanoUsd, 0);
    assert.equal(j.capNanoUsd, 1e9);
    assert.equal(j.remainingNanoUsd, j.capNanoUsd - j.confirmedNanoUsd - j.retainedNanoUsd);
    // The dashboard matches the authoritative ledger.
    assert.ok(Math.abs(j.remainingNanoUsd - usdToNano(h.spend.remainingUsd())) <= 2);
  });

  it('shows an in-flight reservation as pending, separate from confirmed', async () => {
    const h = harness(1, 5_000);
    let release: () => void = () => undefined;
    h.replies.push((b, signal) => new Promise((resolve, reject) => {
      release = () => resolve(okReply(50)(b, signal));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const p = h.adapter.choose(request(), new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    h.runtime.start();
    const mid = JSON.parse(readFileSync(h.runtime.paths.status, 'utf8')).usage.jev.value;
    assert.equal(mid.pendingNanoUsd, MAX_NANO);
    assert.equal(mid.confirmedNanoUsd, 0);
    assert.equal(mid.remainingNanoUsd, 1e9 - MAX_NANO);
    release();
    await p;
    h.runtime.stop('done');
    const end = JSON.parse(readFileSync(h.runtime.paths.status, 'utf8')).usage.jev.value;
    assert.equal(end.pendingNanoUsd, 0);
    assert.equal(end.confirmedNanoUsd, usdToNano(50 * PROMPT_USD_PER_TOKEN));
  });

  it('duplicated or replayed events neither double count nor go backwards', async () => {
    const h = harness();
    h.replies.push(okReply(420));
    await choose(h);
    const events = [...h.store.events];
    for (const e of events) h.runtime.observe(e as EvidenceEvent); // replay
    for (const e of events.reverse()) h.runtime.observe(e as EvidenceEvent); // out of order
    const j = status(h).usage.jev.value;
    assert.equal(j.validatedResponses, 1);
    assert.equal(j.inputTokens, 420);
    const hist = readHistory(h.runtime.paths.history);
    assert.ok(hist.ok);
    const day = hist.history.days['2026-10-06']!;
    assert.equal(day.jev.validatedResponses, 1);
    assert.equal(day.jev.attempts, 1);
    assert.equal(day.jev.confirmedNanoUsd, usdToNano(420 * PROMPT_USD_PER_TOKEN));
  });

  it('keeps tiny charges exact in nano-dollars (no $0.00 rounding)', () => {
    const spend = new SpendLedger(1);
    const acc = new UsageAccumulator({ spend: () => spend.snapshot(), now: () => 1 });
    for (let i = 0; i < 1000; i += 1) {
      const r = spend.reserve(0.001344, 'x')!;
      spend.reconcile(r, 0.000000042);
    }
    const j = acc.jev();
    assert.ok(j.known);
    assert.equal(j.value.confirmedNanoUsd, 42_000);
  });

  it('without a spend ledger the Jev usage is unknown, not zero', () => {
    const acc = new UsageAccumulator({ now: () => 1 });
    const j = acc.jev();
    assert.equal(j.known, false);
  });
});

describe('dashboard usage: planner turns', () => {
  it('counts completed turns with usage and failed/no-usage turns as unknown', () => {
    const totals = { turns: 3, completedTurns: 2, failedTurns: 1, inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 200, reasoningOutputTokens: 50 };
    const acc = new UsageAccumulator({ planner: () => totals, now: () => 5 });
    const base = { goalId: 'goal-0001', turnKind: 'initial' };
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p1', turn: 1, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p1', turn: 1, usage: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 200, reasoningOutputTokens: 50 }, ...base });
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p2', turn: 2, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p2', turn: 2, usage: null, ...base });
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p3', turn: 3, ...base });
    acc.observe({ type: 'planner_turn_failed', requestId: 'req-p3', turn: 3, kind: 'aborted', ...base });
    acc.observe({ type: 'planner_turn_failed', requestId: 'req-p3', turn: 3, kind: 'aborted', ...base }); // duplicate
    const p = acc.planner();
    assert.ok(p.known);
    assert.equal(p.value.usageKnownTurns, 1);
    assert.equal(p.value.usageUnknownTurns, 2);
    assert.equal(p.value.inputTokens, 1500);
    assert.equal(p.value.cachedInputTokens, 1000, 'cached is a breakdown of input, not added to it');
  });

  it('planner usage is unknown when the planner is not composed (disabled profile)', () => {
    assert.equal(new UsageAccumulator({ now: () => 1 }).planner().known, false);
  });
});

describe('dashboard usage history: durable dated aggregates', () => {
  const path = () => join(dir, 'dashboard', 'usage-history.json');
  const store = (runId: string, pid: number, alive: (pid: number) => boolean = () => false, timeZone = 'UTC') =>
    new UsageHistoryStore({ path: path(), runId, pid, startedAtMs: clock.t, now: () => clock.t, timeZone, isPidAlive: alive, flushIntervalMs: 0 });

  it('accumulates across runs, by day in the recorded time zone', () => {
    const a = store('run-aaaa0001', 111);
    a.jev({ attempts: 2, confirmedNanoUsd: 30 }, clock.t);
    a.close();
    clock.t += 24 * 3600_000;
    const b = store('run-bbbb0002', 222);
    b.jev({ attempts: 1, confirmedNanoUsd: 12 }, clock.t);
    b.planner({ turns: 1, completedTurns: 1, inputTokens: 900, outputTokens: 40 }, clock.t);
    b.close();
    const h = readHistory(path());
    assert.ok(h.ok);
    assert.deepEqual(Object.keys(h.history.days).sort(), ['2026-10-06', '2026-10-07']);
    assert.equal(h.history.days['2026-10-06']!.jev.confirmedNanoUsd, 30);
    assert.equal(h.history.days['2026-10-07']!.planner.inputTokens, 900);
    assert.equal(h.history.gaps.length, 0);
    assert.equal(dayKey(Date.parse('2026-10-06T23:30:00Z'), 'America/Chicago'), '2026-10-06');
    assert.equal(dayKey(Date.parse('2026-10-07T03:30:00Z'), 'America/Chicago'), '2026-10-06');
  });

  it('marks a run that never closed (crash) as an unclean end gap, and keeps its flushed totals', () => {
    const a = store('run-crash001', 4242);
    a.jev({ attempts: 3, retainedNanoUsd: MAX_NANO }, clock.t);
    a.flush(true); // process then dies without close()
    const b = store('run-next0001', 5151, (pid) => pid === 5151);
    const h = b.snapshot();
    const crashed = h.runs.find((r) => r.runId === 'run-crash001')!;
    assert.equal(crashed.open, false);
    assert.equal(crashed.endedUncleanly, true);
    assert.equal(h.gaps.filter((g) => g.kind === 'unclean_end').length, 1);
    assert.equal(h.days['2026-10-06']!.jev.retainedNanoUsd, MAX_NANO);
  });

  it('a corrupt history is moved aside and restarted with a recorded gap (never parsed loosely)', () => {
    const p = path();
    store('run-first001', 1).close();
    writeFileSync(p, '{"schema":"chunkbot.dashboard.usage-history","version":1,"days":{"2026-10-06":{"jev":{"confirmedNanoUsd":-5}}}}');
    const b = store('run-after001', 2);
    const h = b.snapshot();
    assert.equal(h.gaps[0]?.kind, 'corrupt_reset');
    assert.deepEqual(h.days, {});
    assert.ok(readdirSync(join(dir, 'dashboard')).some((f) => f.startsWith('usage-history.json.corrupt-')));
  });

  it('a time zone change is recorded as a coverage gap instead of silently re-bucketing', () => {
    store('run-tz000001', 1, () => false, 'UTC').close();
    const b = store('run-tz000002', 2, () => false, 'America/Chicago');
    assert.equal(b.snapshot().gaps.at(-1)?.kind, 'time_zone_change');
    assert.equal(b.snapshot().timeZone, 'America/Chicago');
  });

  it('history never touches the spending cap: a new ledger starts at its configured cap regardless of history', async () => {
    const h = harness(0.01);
    h.replies.push(hang, hang);
    await choose(h);
    h.runtime.stop('end');
    const after = harness(0.01);
    assert.equal(after.spend.remainingUsd(), 0.01, 'the per-run cap is configuration, not derived from history');
    const hist = readHistory(h.runtime.paths.history);
    assert.ok(hist.ok && hist.history.days['2026-10-06']!.jev.retainedNanoUsd === 2 * MAX_NANO);
    assert.ok(existsSync(after.runtime.paths.history));
  });
});
