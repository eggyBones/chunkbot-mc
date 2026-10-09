// Jev adapter against a LOOPBACK provider fault fixture (node:http). No real
// credential, profile or provider is touched. Covers the frozen raw wire
// shape, envelope/choice/distribution/model/provider/usage validation, explicit
// auth/payment/route failures, one bounded transient retry, timeouts, aborts,
// per-goal attempts, the per-run spend cap with reservations, the minimum
// interval, one-in-flight and secret hygiene.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ActionCandidate, DecisionRequest } from '../src/contracts/index.ts';
import { isDecisionError } from '../src/decision/errors.ts';
import { JevDecisionAdapter, MAX_RETAINED_GOALS, type JevAdapterOptions } from '../src/decision/jev-adapter.ts';
import { JEV_CONTEXT_TOKENS, JEV_MAX_PRICE, PROMPT_USD_PER_TOKEN, maxAttemptChargeUsd } from '../src/decision/pricing.ts';

const MAX = maxAttemptChargeUsd(); // full serving context x admitted prompt price
import { SpendLedger } from '../src/decision/spend.ts';
import { modelMatches } from '../src/decision/wire.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';

const KEY = 'sk-or-test-DO-NOT-LEAK-0123456789abcdef';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let endpoint = '';
let handlers: Handler[] = [];
let seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const h = handlers.shift() ?? ((_q, _b, r) => r.writeHead(500).end('{"error":{"message":"no handler"}}'));
      h(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alpha/decisions`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  handlers = [];
  seen = [];
});

function candidate(n: number): ActionCandidate {
  return { id: `act-test${n}aaa`, capability: n % 2 ? 'mine_block' : 'move_near', parameters: {}, snapshotId: 'snap-0001', connectionEpoch: 1, goalEpoch: 1, description: `option ${n}`, criteria: ['does a thing'], preconditions: ['visible'], timeoutMs: 1_000 };
}

function request(overrides: Partial<DecisionRequest> = {}, n = 3): DecisionRequest {
  return {
    requestId: 'req-0001',
    goalId: 'goal-0001',
    goalEpoch: 1,
    taskId: 'task-0001',
    connectionEpoch: 1,
    snapshotId: 'snap-0001',
    objective: 'Collect three logs for the planned tools.',
    instruction: 'Choose a visible log and acquire it.',
    condition: '{"predicate":"inventory_delta"}',
    mode: 'complete',
    state: { observation: { inventory: [] } },
    candidates: Array.from({ length: n }, (_, i) => candidate(i + 1)),
    ...overrides,
  };
}

/** Builds a provider-shaped 200 body for the request it receives. */
function okBody(body: string, patch: (r: Record<string, any>) => void = () => undefined): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = JSON.parse(body) as { questions: { next_action: { criteria: Record<string, string> } } };
  const keys = Object.keys(req.questions.next_action.criteria);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1)]));
  const r: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    model: 'typesafe/jev-1.13-20260917',
    answers: { next_action: { type: 'choice', choice: keys[0], probabilities, confidence: 0.82 } },
    usage: { input_tokens: 420, output_tokens: 30, cost: 420 * PROMPT_USD_PER_TOKEN },
    id: 'gen-dec-1791157233-fixture',
    provider: 'TypeSafe',
  };
  patch(r);
  return JSON.stringify(r);
}
const ok = (patch?: (r: Record<string, any>) => void): Handler => (_q, b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(okBody(b, patch)); // eslint-disable-line @typescript-eslint/no-explicit-any
const status = (code: number, message = 'fixture', headers: Record<string, string> = {}): Handler => (_q, _b, res) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ error: { message, code } }));
const hang: Handler = () => undefined; // never responds

function adapter(overrides: Partial<JevAdapterOptions> = {}) {
  const store = new MemoryRunStore();
  const spend = overrides.spend ?? new SpendLedger(1);
  const sleeps: number[] = [];
  const a = new JevDecisionAdapter({
    endpoint,
    model: 'typesafe/jev-1.13',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    env: () => ({ OPENROUTER_API_KEY: KEY }),
    expectedProvider: 'TypeSafe',
    spend,
    store,
    clock: { now: () => Date.now() },
    timeoutMs: 400,
    minIntervalMs: 1_000,
    attemptsPerGoal: 1_200,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { a, store, spend, sleeps };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    assert.ok(isDecisionError(error), `expected DecisionError, got ${String(error)}`);
    return error.failure;
  }
  assert.fail('expected the decision to fail');
}

describe('Jev raw wire contract', () => {
  it('sends the frozen raw snake_case request with the price ceiling and returns a validated choice with provider evidence', async () => {
    const { a, store, spend } = adapter();
    handlers.push(ok());
    const req = request();
    const choice = await a.choose(req, new AbortController().signal);
    assert.equal(seen.length, 1);
    const sent = seen[0]!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/api/alpha/decisions');
    assert.equal(sent.headers['authorization'], `Bearer ${KEY}`);
    assert.match(String(sent.headers['content-type']), /application\/json/);
    const body = JSON.parse(sent.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'provider', 'questions', 'state']);
    assert.equal(body.model, 'typesafe/jev-1.13');
    assert.deepEqual(body.provider, { allow_fallbacks: false, max_price: { ...JEV_MAX_PRICE } });
    assert.deepEqual(Object.keys(body.questions), ['next_action']);
    const q = body.questions.next_action;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria), req.candidates.map((c) => c.id), 'criteria keyed by code-generated candidate IDs');
    assert.match(q.instructions, /Collect three logs/);
    assert.match(q.instructions, /Choose a visible log/);
    assert.match(q.instructions, /Which one of the offered options/, 'the instructions carry the complete question');
    assert.equal('decisionsRequest' in body, false, 'no SDK wrapper');
    assert.equal(choice.candidateId, req.candidates[0]!.id);
    assert.equal(choice.model, 'typesafe/jev-1.13-20260917');
    assert.equal(choice.provider, 'TypeSafe');
    assert.equal(choice.attempts, 1);
    assert.equal(choice.usage.inputTokens, 420);
    const snap = spend.snapshot();
    assert.ok(Math.abs(snap.reconciledUsd - 420 * PROMPT_USD_PER_TOKEN) < 1e-12, 'reported cost reconciled');
    assert.equal(snap.outstandingUsd, 0);
    assert.equal(store.ofType('jev_request').length, 1);
    assert.equal(store.ofType('jev_response').length, 1);
    assert.equal(JSON.stringify(store.events).includes(KEY), false, 'the key never enters evidence');
  });

  it('accepts only the requested model or its dated snapshot', () => {
    assert.ok(modelMatches('typesafe/jev-1.13', 'typesafe/jev-1.13'));
    assert.ok(modelMatches('typesafe/jev-1.13', 'typesafe/jev-1.13-20260917'));
    assert.ok(!modelMatches('typesafe/jev-1.13', 'typesafe/jev-1.14-20260917'));
    assert.ok(!modelMatches('typesafe/jev-1.13', 'typesafe/jev-1.13-latest'));
    assert.ok(!modelMatches('typesafe/jev-1.13', 'openai/gpt-x'));
  });
});

describe('Jev response validation (fail closed)', () => {
  const cases: Array<{ name: string; patch: (r: Record<string, any>) => void; kind: string; sticky?: boolean }> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    { name: 'choice not offered', patch: (r) => (r.answers.next_action.choice = 'act-invented00'), kind: 'invalid_response' },
    { name: 'missing usage', patch: (r) => delete r.usage, kind: 'invalid_response' },
    { name: 'wrong answer type', patch: (r) => (r.answers.next_action.type = 'text'), kind: 'invalid_response' },
    { name: 'incomplete distribution', patch: (r) => { for (const k of Object.keys(r.answers.next_action.probabilities)) r.answers.next_action.probabilities[k] = 0.1; }, kind: 'invalid_response' },
    { name: 'probability for an option that was not offered', patch: (r) => (r.answers.next_action.probabilities['act-other0000'] = 0), kind: 'invalid_response' },
    { name: 'non-finite probability', patch: (r) => { const k = Object.keys(r.answers.next_action.probabilities)[0]!; r.answers.next_action.probabilities[k] = 'NaN'; }, kind: 'invalid_response' },
    { name: 'confidence out of range', patch: (r) => (r.answers.next_action.confidence = 1.5), kind: 'invalid_response' },
    { name: 'different model (silent fallback)', patch: (r) => (r.model = 'typesafe/jev-2.0-20261001'), kind: 'model_mismatch', sticky: true },
    { name: 'different provider (route change)', patch: (r) => (r.provider = 'OtherCloud'), kind: 'route_changed', sticky: true },
    { name: 'cost above the price ceiling', patch: (r) => (r.usage.cost = r.usage.input_tokens * PROMPT_USD_PER_TOKEN * 3), kind: 'pricing_changed', sticky: true },
    { name: 'input tokens above the verified serving context', patch: (r) => { r.usage.input_tokens = JEV_CONTEXT_TOKENS + 1; r.usage.cost = 0; }, kind: 'pricing_changed', sticky: true },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.kind}${c.sticky ? ' (adapter disabled for the run)' : ''}`, async () => {
      const { a, store } = adapter();
      handlers.push(ok(c.patch));
      const f = await failure(a.choose(request(), new AbortController().signal));
      assert.equal(f.kind, c.kind);
      assert.equal(f.attempts, 1, 'invalid responses are not retried');
      assert.equal(seen.length, 1);
      if (c.sticky) {
        assert.equal(a.readiness().ready, false);
        const again = await failure(a.choose(request(), new AbortController().signal));
        assert.equal(again.kind, c.kind);
        assert.equal(seen.length, 1, 'no further HTTP request after a fail-closed drift');
        assert.equal(store.ofType('jev_disabled_for_run').length, 1);
      }
    });
  }

  it('MB-UI-001-C3: a rejected but trusted answer carries its validated usage into jev_failure; untrusted rejections carry none', async () => {
    const { a, store } = adapter();
    handlers.push(ok((r) => (r.answers.next_action.choice = 'act-invented00')));
    assert.equal((await failure(a.choose(request(), new AbortController().signal))).kind, 'invalid_response');
    const trusted = store.ofType('jev_failure').at(-1)!;
    assert.deepEqual(trusted['usage'], { inputTokens: 420, outputTokens: 30, costUsd: 420 * PROMPT_USD_PER_TOKEN });
    assert.equal(trusted['usageTrusted'], true);
    assert.equal(trusted['willRetry'], false, 'rejection behavior unchanged');
    for (const patch of [(r: Record<string, any>) => delete r.usage, (r: Record<string, any>) => (r.model = 'typesafe/jev-2.0-20261001')]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const fresh = adapter();
      handlers.push(ok(patch));
      await failure(fresh.a.choose(request(), new AbortController().signal));
      const ev = fresh.store.ofType('jev_failure').at(-1)!;
      assert.equal(ev['usage'], null, 'no usage unless proven');
      assert.equal(ev['usageTrusted'], false);
    }
    assert.ok(!JSON.stringify(store.events).includes(KEY), 'no key in evidence');
  });

  it('an oversized response body is rejected without parsing it', async () => {
    const { a, spend } = adapter();
    handlers.push((_q, _b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(`{"pad":"${'x'.repeat(70_000)}"}`));
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'invalid_response');
    assert.equal(spend.snapshot().retained, 1, 'unreadable response: charge ambiguous, reservation retained');
  });
});

describe('Jev HTTP failures, retries and timeouts', () => {
  for (const [code, kind, sticky] of [
    [401, 'auth', true],
    [403, 'auth', true],
    [402, 'payment', true],
    [404, 'model_unavailable', false],
    [400, 'request_rejected', false],
  ] as const) {
    it(`HTTP ${code} -> explicit ${kind}, no retry, reservation released`, async () => {
      const { a, spend } = adapter();
      handlers.push(status(code), ok());
      const f = await failure(a.choose(request(), new AbortController().signal));
      assert.equal(f.kind, kind);
      assert.equal(f.httpStatus, code);
      assert.equal(f.attempts, 1);
      assert.equal(seen.length, 1);
      assert.equal(spend.snapshot().released, 1);
      assert.equal(spend.snapshot().retainedUsd, 0);
      assert.equal(a.readiness().ready, !sticky);
    });
  }

  it('429 then 200: exactly one retry, both attempts counted', async () => {
    const { a, store } = adapter();
    handlers.push(status(429, 'slow down', { 'retry-after': '1' }), ok());
    const choice = await a.choose(request(), new AbortController().signal);
    assert.equal(choice.attempts, 2);
    assert.equal(seen.length, 2);
    assert.equal(a.attemptsForGoal('goal-0001'), 2);
    assert.equal(store.ofType('jev_failure')[0]?.['willRetry'], true);
  });

  it('5xx twice: one retry then an explicit transient failure; ambiguous charges retained', async () => {
    const { a, spend } = adapter();
    handlers.push(status(503), status(502), ok());
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'transient');
    assert.equal(f.attempts, 2);
    assert.equal(seen.length, 2, 'never more than one retry');
    assert.equal(spend.snapshot().retained, 2);
  });

  it('Retry-After beyond the honored bound is not retried', async () => {
    const { a } = adapter();
    handlers.push(status(429, 'later', { 'retry-after': '120' }), ok());
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'rate_limited');
    assert.equal(seen.length, 1);
  });

  it('timeouts abort the HTTP request, retry once, retain both reservations', async () => {
    const { a, spend } = adapter({ timeoutMs: 150 });
    handlers.push(hang, hang);
    const started = Date.now();
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'timeout');
    assert.equal(f.attempts, 2);
    assert.ok(Date.now() - started < 2_000, 'bounded by the timeout');
    assert.equal(spend.snapshot().retained, 2);
    assert.ok(Math.abs(spend.snapshot().retainedUsd - 2 * MAX) < 1e-12, 'each ambiguous attempt retains the FULL serving-context maximum');
  });

  it('revocation aborts in-flight provider I/O immediately, without retry; the reservation stays (ambiguous)', async () => {
    const { a, spend } = adapter({ timeoutMs: 5_000 });
    handlers.push(hang);
    const abort = new AbortController();
    const p = a.choose(request(), abort.signal);
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    const t = Date.now();
    abort.abort(new Error('owner_stop'));
    const f = await failure(p);
    assert.equal(f.kind, 'aborted');
    assert.ok(Date.now() - t < 200, 'abort is prompt');
    assert.equal(seen.length, 1);
    assert.equal(spend.snapshot().retained, 1);
  });
});

describe('Jev limits: attempts, spend cap, interval, one in flight', () => {
  it('refuses before dispatch when the key is missing (no HTTP, no reservation)', async () => {
    const { a, spend } = adapter({ env: () => ({}) });
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'not_configured');
    assert.equal(seen.length, 0);
    assert.equal(spend.snapshot().attempts, 0);
    assert.equal(a.readiness().ready, false);
  });

  it('refuses an oversized request before dispatch', async () => {
    const { a } = adapter();
    const f = await failure(a.choose(request({ state: { pad: 'x'.repeat(20_000) } }), new AbortController().signal));
    assert.equal(f.kind, 'request_too_large');
    assert.equal(seen.length, 0);
  });

  it('the spend cap is per application run: ambiguous reservations from one goal block the next goal before any HTTP', async () => {
    const one = MAX;
    const spend = new SpendLedger(one * 2.5);
    const { a } = adapter({ spend, timeoutMs: 100 });
    handlers.push(hang, hang);
    const f1 = await failure(a.choose(request({ goalId: 'goal-000a' }), new AbortController().signal));
    assert.equal(f1.kind, 'timeout');
    assert.equal(seen.length, 2);
    assert.ok(spend.snapshot().remainingUsd < one, 'two retained reservations leave less than one more');
    const f2 = await failure(a.choose(request({ goalId: 'goal-000b' }), new AbortController().signal));
    assert.equal(f2.kind, 'spend_cap', 'a NEW goal does not get a fresh dollar');
    assert.equal(seen.length, 2, 'refused before dispatch');
    assert.equal(a.readiness().ready, false);
  });

  it('a cap that cannot cover the conservative bound refuses the first call', async () => {
    const { a } = adapter({ spend: new SpendLedger(MAX - 1e-9) });
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'spend_cap');
    assert.equal(seen.length, 0);
  });

  it('MB-JEV-001: the reservation is the full serving-context maximum at the admitted price, before every attempt', async () => {
    assert.ok(Math.abs(MAX - JEV_CONTEXT_TOKENS * PROMPT_USD_PER_TOKEN) < 1e-15);
    assert.ok(Math.abs(MAX - 0.001344) < 1e-12);
    const { a, store, spend } = adapter();
    handlers.push(ok());
    const choice = await a.choose(request(), new AbortController().signal);
    const req = store.ofType('jev_request')[0]!;
    assert.ok(Math.abs(Number(req['reservationUsd']) - MAX) < 1e-15, 'reserved the serving-context maximum');
    assert.equal(req['reservationBasis'], 'serving_context_x_admitted_prompt_price');
    assert.ok(Math.abs(spend.snapshot().reconciledUsd - choice.usage.costUsd) < 1e-15, 'a small real-sized request reconciles to its actual cost');
    assert.equal(spend.snapshot().outstandingUsd, 0);
  });

  it('MB-JEV-001 boundary: a remaining run budget just below the maximum dispatches nothing; exactly the maximum allows one attempt', async () => {
    const below = adapter({ spend: new SpendLedger(MAX * (1 - 1e-6)) });
    handlers.push(ok());
    const f = await failure(below.a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'spend_cap');
    assert.equal(seen.length, 0, 'zero dispatches when the cap cannot cover the maximum');
    assert.equal(below.a.readiness().ready, false);
    handlers = [];
    const exact = adapter({ spend: new SpendLedger(MAX) });
    // Worst permitted usage: the full serving context at the ceiling. It is within the reservation.
    handlers.push(ok((r) => {
      r.usage.input_tokens = JEV_CONTEXT_TOKENS;
      r.usage.cost = JEV_CONTEXT_TOKENS * PROMPT_USD_PER_TOKEN;
    }));
    const choice = await exact.a.choose(request(), new AbortController().signal);
    assert.equal(choice.usage.inputTokens, JEV_CONTEXT_TOKENS);
    assert.ok(exact.spend.snapshot().reconciledUsd <= exact.spend.capUsd + 1e-12, 'the cap held for the worst permitted charge');
    assert.equal(seen.length, 1);
    // The run budget is now spent: the next goal is refused before dispatch.
    const next = await failure(exact.a.choose(request({ goalId: 'goal-0002' }), new AbortController().signal));
    assert.equal(next.kind, 'spend_cap');
    assert.equal(seen.length, 1);
  });

  it('MB-JEV-001: a transient retry needs its own full reservation from the shared run ledger', async () => {
    const { a, spend } = adapter({ spend: new SpendLedger(MAX * 1.5) });
    handlers.push(status(503), ok());
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'spend_cap', 'the retained ambiguous first attempt leaves too little for a second maximum');
    assert.equal(seen.length, 1, 'the retry was not dispatched');
    assert.equal(spend.snapshot().retained, 1);
    assert.ok(Math.abs(spend.snapshot().retainedUsd - MAX) < 1e-12);
  });

  it('MB-JEV-001: the charge bound applies only to the verified route; an unverified model or provider sends nothing', async () => {
    for (const over of [{ model: 'typesafe/jev-2.0' }, { model: 'other/model-x' }, { expectedProvider: 'OtherCloud' }, { expectedProvider: undefined }]) {
      const { a, spend } = adapter(over);
      handlers.push(ok());
      const f = await failure(a.choose(request(), new AbortController().signal));
      assert.equal(f.kind, 'not_configured', JSON.stringify(over));
      assert.match(f.detail, /no verified pricing\/context profile/);
      assert.equal(seen.length, 0);
      assert.equal(spend.snapshot().attempts, 0);
      assert.equal(a.readiness().ready, false);
      assert.equal(a.maxAttemptChargeUsd, undefined);
      handlers = [];
    }
  });

  it('every attempt counts toward the per-goal allowance, including the retry', async () => {
    const { a } = adapter({ attemptsPerGoal: 1 });
    handlers.push(status(500), ok(), ok());
    const f = await failure(a.choose(request(), new AbortController().signal));
    assert.equal(f.kind, 'attempt_limit');
    assert.equal(seen.length, 1, 'the retry was refused by the allowance');
    const other = await a.choose(request({ goalId: 'goal-0002' }), new AbortController().signal);
    assert.equal(other.attempts, 1, 'another goal has its own allowance');
  });

  it('keeps the minimum interval between attempt starts', async () => {
    const { a, sleeps } = adapter();
    handlers.push(ok(), ok());
    await a.choose(request(), new AbortController().signal);
    await a.choose(request({ requestId: 'req-0002' }), new AbortController().signal);
    assert.equal(sleeps.length, 1);
    assert.ok((sleeps[0] ?? 0) > 800 && (sleeps[0] ?? 0) <= 1_000, `waited ${sleeps[0]}ms`);
  });

  it('allows only one request in flight', async () => {
    const { a } = adapter({ timeoutMs: 300 });
    handlers.push(hang);
    const first = a.choose(request(), new AbortController().signal);
    const second = await failure(a.choose(request({ requestId: 'req-0002' }), new AbortController().signal));
    assert.equal(second.kind, 'busy');
    await failure(first);
  });
});

describe('MB-FLOW-003-C12 per-goal budget retention through support-goal churn', () => {
  const churn = async (a: JevDecisionAdapter, n: number) => {
    for (let i = 0; i < n; i += 1) {
      handlers.push(ok());
      await a.choose(request({ goalId: `goal-sup${String(i).padStart(3, '0')}`, requestId: `req-c${i}` }), new AbortController().signal);
    }
  };

  it('a retained (active/held) logical goal keeps its attempts after 40 other goals; an unretained one is evicted and would refill (control)', async () => {
    const retained = adapter({ attemptsPerGoal: 2 }).a;
    handlers.push(ok());
    await retained.choose(request({ goalId: 'goal-owner1' }), new AbortController().signal);
    retained.retainGoalBudget('goal-owner1', true);
    await churn(retained, 40);
    assert.equal(retained.attemptsForGoal('goal-owner1'), 1, 'count survived the churn');
    handlers.push(ok(), ok());
    await retained.choose(request({ goalId: 'goal-owner1', requestId: 'req-o2' }), new AbortController().signal);
    const f = await failure(retained.choose(request({ goalId: 'goal-owner1', requestId: 'req-o3' }), new AbortController().signal));
    assert.equal(f.kind, 'attempt_limit', 'the cumulative allowance is enforced across the churn');

    const control = adapter({ attemptsPerGoal: 2 }).a;
    handlers.push(ok());
    await control.choose(request({ goalId: 'goal-owner1' }), new AbortController().signal);
    await churn(control, 40);
    assert.equal(control.attemptsForGoal('goal-owner1'), 0, 'without retention the entry was evicted (the bug this guards)');
  });

  it('retention is bounded (oldest released, recorded) and releasing restores normal eviction; spend reservations are unchanged', async () => {
    const { a, store, spend } = adapter();
    for (let i = 0; i < MAX_RETAINED_GOALS + 3; i += 1) a.retainGoalBudget(`goal-r${String(i).padStart(3, '0')}`, true);
    assert.equal(a.retainedGoals().length, MAX_RETAINED_GOALS);
    assert.ok(!a.retainedGoals().includes('goal-r000'));
    assert.equal(store.ofType('jev_goal_budget_retention_released').length, 3);
    a.retainGoalBudget('goal-r010', false);
    assert.ok(!a.retainedGoals().includes('goal-r010'));
    const before = spend.snapshot().remainingUsd;
    handlers.push(ok());
    await a.choose(request({ goalId: 'goal-r005' }), new AbortController().signal);
    assert.ok(spend.snapshot().remainingUsd < before, 'the run SpendLedger still charges every attempt');
  });
});
