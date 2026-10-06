// MB-UI-001 usage accounting end to end: the REAL JevDecisionAdapter and
// SpendLedger (fake provider responses, no network) feed the dashboard through
// the store tee. Checks exact session rollups, separation of confirmed /
// retained / pending / remaining, tiny precision, retries and charged failures,
// deduplication, planner usage with unknown turns, and the durable dated
// history (restart, unclean end, corruption, time zone) without any effect on
// the spending cap.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { usdToNano } from '../src/contracts/dashboard.ts';
import type { ActionCandidate, DecisionRequest, EvidenceEvent } from '../src/contracts/index.ts';
import { compactHistory, dayKey, emptyDay, emptyHistory, readHistory, UsageHistoryStore } from '../src/dashboard/history.ts';
import { DASHBOARD_BOUNDS, UsageHistorySchema, type UsageHistory } from '../src/contracts/dashboard.ts';
import { remoteMetadata } from '../src/dashboard/remote.ts';
import { StatusFollower, buildViewModel } from '../src/dashboard/viewmodel.ts';
import { createDashboardRuntime } from '../src/dashboard/runtime.ts';
import { UsageAccumulator, ZERO_CURSOR } from '../src/dashboard/usage.ts';
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

function harness(capUsd = 1, timeoutMs = 40, enrich: (e: EvidenceEvent) => EvidenceEvent = (e) => e) {
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
    store: { runId: tapped.runId, record: (e: EvidenceEvent) => tapped.record(enrich(e)), close: (x: Record<string, unknown>) => tapped.close(x) },
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
    // The dated aggregate carries the same split.
    const hist = readHistory(h.runtime.paths.history);
    assert.ok(hist.ok);
    const day = hist.history.days['2026-10-06']!.jev;
    assert.deepEqual(
      [day.attempts, day.validatedResponses, day.chargedFailures, day.retainedAttempts, day.releasedAttempts, day.inputTokens, day.tokensUnknownAttempts, day.retainedNanoUsd],
      [7, 2, 1, 3, 1, 520, 4, 3 * MAX_NANO],
    );
    assert.equal(day.confirmedNanoUsd, j.confirmedNanoUsd);
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
    const j = acc.jevUsage();
    assert.ok(j.known);
    assert.equal(j.value.confirmedNanoUsd, 42_000);
  });

  it('without a spend ledger the Jev usage is unknown, not zero', () => {
    const acc = new UsageAccumulator({ now: () => 1 });
    const j = acc.jevUsage();
    assert.equal(j.known, false);
  });
});

describe('dashboard usage: planner turns', () => {
  it('counts completed turns with usage and failed/no-usage turns as unknown', () => {
    const totals = { turns: 3, completedTurns: 2, failedTurns: 1 };
    const acc = new UsageAccumulator({ planner: () => totals, now: () => 5 });
    const base = { goalId: 'goal-0001', turnKind: 'initial' };
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p1', turn: 1, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p1', turn: 1, usage: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 200, reasoningOutputTokens: 50 }, ...base });
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p2', turn: 2, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p2', turn: 2, usage: null, ...base });
    acc.observe({ type: 'planner_turn_started', requestId: 'req-p3', turn: 3, ...base });
    acc.observe({ type: 'planner_turn_failed', requestId: 'req-p3', turn: 3, kind: 'aborted', ...base });
    acc.observe({ type: 'planner_turn_failed', requestId: 'req-p3', turn: 3, kind: 'aborted', ...base }); // duplicate
    const p = acc.plannerUsage();
    assert.ok(p.known);
    assert.equal(p.value.usageKnownTurns, 1);
    assert.equal(p.value.usageUnknownTurns, 2);
    assert.equal(p.value.inputTokens, 1500);
    assert.equal(p.value.cachedInputTokens, 1000, 'cached is a breakdown of input, not added to it');
  });

  it('planner usage is unknown when the planner is not composed (disabled profile)', () => {
    assert.equal(new UsageAccumulator({ now: () => 1 }).plannerUsage().known, false);
  });
});

describe('dashboard usage history: durable dated aggregates', () => {
  const path = () => join(dir, 'dashboard', 'usage-history.json');
  const store = (runId: string, pid: number, alive: (pid: number) => boolean = () => false, timeZone = 'UTC') =>
    new UsageHistoryStore({ path: path(), runId, pid, startedAtMs: clock.t, now: () => clock.t, timeZone, isPidAlive: alive, flushIntervalMs: 0 });

  it('accumulates across runs, by day in the recorded time zone', () => {
    const a = store('run-aaaa0001', 111);
    a.commitLedger({ ...ZERO_CURSOR, attempts: 2, reconciledNanoUsd: 30, reconciled: 2 }, { attempts: 2, confirmedNanoUsd: 30 }, clock.t);
    a.close();
    clock.t += 24 * 3600_000;
    const b = store('run-bbbb0002', 222);
    b.commitLedger({ ...ZERO_CURSOR, attempts: 1, reconciledNanoUsd: 12, reconciled: 1 }, { attempts: 1, confirmedNanoUsd: 12 }, clock.t);
    b.applyEvent('pdone:req-x:1', { planner: { turns: 1, completedTurns: 1, inputTokens: 900, outputTokens: 40 } }, clock.t);
    assert.equal(b.applyEvent('pdone:req-x:1', { planner: { turns: 1 } }, clock.t), false, 'duplicate event identity is ignored');
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
    a.commitLedger({ ...ZERO_CURSOR, attempts: 3, retainedNanoUsd: MAX_NANO, retained: 1 }, { attempts: 3, retainedNanoUsd: MAX_NANO }, clock.t);
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


describe('MB-UI-001 corrections (C1 size bound, C2 atomic cursor, C3 nullable usage)', () => {
  const path = () => join(dir, 'dashboard', 'usage-history.json');

  it('C1: many runs with many events stay under the reader bound and remain readable by the viewer', () => {
    for (let r = 0; r < 70; r += 1) {
      const st = new UsageHistoryStore({ path: path(), runId: `run-many${String(r).padStart(4, '0')}`, pid: 10_000 + r, startedAtMs: clock.t, now: () => clock.t, timeZone: 'UTC', isPidAlive: () => false, flushIntervalMs: 60_000 });
      for (let i = 0; i < 512; i += 1) st.applyEvent(`jres:req-${r}-${i}:1`, { jev: { validatedResponses: 1, inputTokens: 100 } }, clock.t);
      st.commitLedger({ ...ZERO_CURSOR, attempts: 512, reconciledNanoUsd: 512 * 4_200, reconciled: 512 }, { attempts: 512, confirmedNanoUsd: 512 * 4_200 }, clock.t);
      if (r % 3 !== 0) st.close();
      else st.flush(true); // some crash after a flush (left open)
      clock.t += 6 * 3600_000;
    }
    const size = statSync(path()).size;
    assert.ok(size <= DASHBOARD_BOUNDS.historyWriteTargetBytes, `history is ${size} bytes`);
    const h = readHistory(path()); // the viewer's (smaller) bound
    assert.ok(h.ok, 'the viewer can read what the writer wrote');
    let validated = h.history.rollup?.totals.jev.validatedResponses ?? 0;
    for (const d of Object.values(h.history.days)) validated += d.jev.validatedResponses;
    assert.equal(validated, 70 * 512, 'no usage was dropped to save space');
    assert.ok(h.history.runs.length <= DASHBOARD_BOUNDS.historyRuns);
  });

  it('C1: an oversized version-1 history of our own (persisted event IDs) is migrated and compacted, not reset', () => {
    const v1 = {
      schema: 'chunkbot.dashboard.usage-history',
      version: 1,
      timeZone: 'UTC',
      recordedSinceMs: clock.t - 86_400_000,
      updatedAtMs: clock.t,
      days: { '2026-10-05': { jev: { ...emptyDay().jev, attempts: 9, confirmedNanoUsd: 77 }, planner: { turns: 2, completedTurns: 2, failedTurns: 0, usageUnknownTurns: 0, inputTokens: 10, cachedInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 1 } } },
      runs: Array.from({ length: 44 }, (_, r) => ({ runId: `run-old${String(r).padStart(5, '0')}`, pid: 20_000 + r, startedAtMs: 1, lastFlushAtMs: 2, open: false, endedUncleanly: false, jev: { ...ZERO_CURSOR }, seen: Array.from({ length: 512 }, (_, i) => `pstart:req-${(r * 1000 + i).toString(36).padStart(32, '0')}:12`) })),
      gaps: [],
    };
    rmSync(join(dir, 'dashboard'), { recursive: true, force: true });
    mkdirSync(join(dir, 'dashboard'), { recursive: true });
    writeFileSync(path(), JSON.stringify(v1));
    assert.ok(statSync(path()).size > DASHBOARD_BOUNDS.maxHistoryBytes, 'fixture reproduces the >1 MiB file');
    assert.equal(readHistory(path()).ok, false, 'the viewer bound refuses it as-is');
    const st = new UsageHistoryStore({ path: path(), runId: 'run-new00001', pid: 31_000, startedAtMs: clock.t, now: () => clock.t, timeZone: 'UTC', isPidAlive: () => false, flushIntervalMs: 0 });
    const h = st.snapshot();
    assert.equal(h.gaps.some((g) => g.kind === 'corrupt_reset'), false, 'own valid history is never reset');
    assert.equal(h.gaps.some((g) => g.kind === 'migrated'), true);
    assert.equal(h.days['2026-10-05']!.jev.confirmedNanoUsd, 77);
    assert.ok(statSync(path()).size <= DASHBOARD_BOUNDS.historyWriteTargetBytes);
    assert.ok(readHistory(path()).ok);
  });

  it('C1: compaction folds old days into a rollup that keeps the sums', () => {
    const h: UsageHistory = emptyHistory(0, 'UTC');
    for (let d = 1; d <= 30; d += 1) {
      const day = emptyDay();
      day.jev.confirmedNanoUsd = d;
      day.planner.turns = 1;
      h.days[`2026-09-${String(d).padStart(2, '0')}`] = day;
    }
    const text = compactHistory(h, 4_000, 1, 400);
    assert.ok(Buffer.byteLength(text) <= 4_000);
    const parsed = UsageHistorySchema.parse(JSON.parse(text));
    const sum = Object.values(parsed.days).reduce((n, d) => n + d.jev.confirmedNanoUsd, parsed.rollup?.totals.jev.confirmedNanoUsd ?? 0);
    assert.equal(sum, (30 * 31) / 2);
    assert.equal((parsed.rollup?.days ?? 0) + Object.keys(parsed.days).length, 30);
    const vm = buildViewModel({ follower: new StatusFollower(), now: 1, pidAlive: () => false, history: { ok: true, history: parsed }, remote: remoteMetadata({}), timeZone: 'UTC' });
    assert.match(vm.history.coverage, /kept as one total/);
  });

  it('C2: no committed file ever holds an advanced ledger cursor without its dated charge', async () => {
    const writes: string[] = [];
    const spend = new SpendLedger(1);
    const st = new UsageHistoryStore({ path: path(), runId: 'run-atomic01', pid: 32_000, startedAtMs: clock.t, now: () => clock.t, timeZone: 'UTC', flushIntervalMs: 0, write: (_p, text) => writes.push(text) });
    const acc = new UsageAccumulator({ spend: () => spend.snapshot(), sink: st, now: () => clock.t });
    const r1 = spend.reserve(0.001344, 'req-a')!;
    acc.observe({ type: 'jev_request', requestId: 'req-a', attempt: 1 });
    spend.reconcile(r1, 0.00002);
    acc.observe({ type: 'jev_response', requestId: 'req-a', attempt: 1, usage: { inputTokens: 476, outputTokens: 0, costUsd: 0.00002 } });
    const r2 = spend.reserve(0.001344, 'req-b')!;
    acc.observe({ type: 'jev_request', requestId: 'req-b', attempt: 1 });
    spend.retain(r2);
    acc.observe({ type: 'jev_failure', requestId: 'req-b', attempt: 1, kind: 'timeout' });
    assert.ok(writes.length >= 3);
    for (const text of writes) {
      const h = UsageHistorySchema.parse(JSON.parse(text));
      const run = h.runs.find((x) => x.runId === 'run-atomic01')!;
      const days = Object.values(h.days);
      const confirmed = days.reduce((n, d) => n + d.jev.confirmedNanoUsd, 0);
      const retained = days.reduce((n, d) => n + d.jev.retainedNanoUsd, 0);
      assert.equal(confirmed, run.jev.reconciledNanoUsd, 'cursor and dated confirmed charge move together');
      assert.equal(retained, run.jev.retainedNanoUsd, 'cursor and dated retained charge move together');
    }
    const last = UsageHistorySchema.parse(JSON.parse(writes.at(-1)!));
    assert.equal(last.runs[0]!.jev.reconciledNanoUsd, 20_000);
    assert.equal(last.days['2026-10-06']!.jev.confirmedNanoUsd, 20_000);
  });

  it('C3: missing planner usage or breakdown stays unknown/partial; totals never add cached/reasoning twice', () => {
    const st = new UsageHistoryStore({ path: path(), runId: 'run-plan0001', pid: 33_000, startedAtMs: clock.t, now: () => clock.t, timeZone: 'UTC', flushIntervalMs: 0 });
    const acc = new UsageAccumulator({ planner: () => ({ turns: 3, completedTurns: 3, failedTurns: 0 }), sink: st, now: () => clock.t });
    const base = { goalId: 'goal-0001' };
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p1', turn: 1, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, reasoningOutputTokens: null }, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p2', turn: 2, usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: null, reasoningOutputTokens: null }, ...base });
    acc.observe({ type: 'planner_turn_completed', requestId: 'req-p3', turn: 3, usage: null, ...base });
    const p = acc.plannerUsage();
    assert.ok(p.known);
    assert.deepEqual([p.value.inputTokens, p.value.outputTokens, p.value.cachedInputTokens, p.value.cachedKnownTurns, p.value.reasoningKnownTurns, p.value.usageKnownTurns, p.value.usageUnknownTurns], [1500, 150, 800, 1, 0, 2, 1]);
    st.close();
    const day = readHistory(path());
    assert.ok(day.ok);
    const d = day.history.days['2026-10-06']!.planner;
    assert.deepEqual([d.inputTokens, d.cachedInputTokens, d.cachedKnownTurns, d.reasoningKnownTurns, d.usageUnknownTurns], [1500, 800, 1, 0, 1]);
    const f = new StatusFollower();
    const vm = buildViewModel({ follower: f, now: clock.t, pidAlive: () => true, history: day, remote: remoteMetadata({}), timeZone: 'UTC' });
    assert.ok(vm);
  });

  it('C3: trusted usage on a charged failure is counted separately, with no double charge', async () => {
    // Simulates the designated writer's change: jev_failure carries the validated trusted usage.
    const h = harness(1, 40, (e) => (e.type === 'jev_failure' ? { ...e, usageTrusted: { inputTokens: 300, outputTokens: 0, costUsd: 300 * PROMPT_USD_PER_TOKEN } } : e));
    h.replies.push(okReply(300, (r) => ((r['answers'] as { next_action: { choice: string } }).next_action.choice = 'act-notoffered')));
    assert.equal(await choose(h), 'invalid_response');
    for (const e of h.store.events) h.runtime.observe(e as EvidenceEvent); // replay of the raw events is deduplicated
    const j = status(h).usage.jev.value;
    assert.equal(j.chargedFailures, 1);
    assert.equal(j.chargedFailuresTokensKnown, 1);
    assert.equal(j.chargedFailureInputTokens, 300);
    assert.equal(j.inputTokens, 0, 'validated-response tokens exclude charged failures');
    assert.equal(j.tokensUnknownAttempts, 0);
    assert.equal(j.confirmedNanoUsd, usdToNano(300 * PROMPT_USD_PER_TOKEN), 'cost comes from the ledger once');
    const day = readHistory(h.runtime.paths.history);
    assert.ok(day.ok);
    const dj = day.history.days['2026-10-06']!.jev;
    assert.deepEqual([dj.chargedFailures, dj.chargedFailuresTokensKnown, dj.chargedFailureInputTokens, dj.tokensUnknownAttempts, dj.confirmedNanoUsd], [1, 1, 300, 0, usdToNano(300 * PROMPT_USD_PER_TOKEN)]);
  });
});
