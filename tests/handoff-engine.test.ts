// MB-FLOW-002 smooth directive handoff (goal engine, fake ports; no inference).
//
// H1 a delayed (>= 3 s) planner prepares a new instruction while the admitted
//    follow task keeps running; receipt/ack/draft/switch/first-task timestamps.
// H2 the switch goes through revocation + bounded cleanup; the old task's late
//    result never publishes; nothing runs under pending ownership.
// H3 inventory changed by the old task during preparation is part of the REAL
//    admission baseline (pre-admission gains are not "collected").
// H4 rapid A/B/C: one planner process at a time, only C is admitted, late
//    replies are fenced; invalid/unconnected intake leaves everything intact.
// H5 stop and lifecycle cancel both contexts; the stop latch stays set until resume.
// H6 timeout/quota/auth/malformed/legacy-question before admission keep the old task.
// Stale drafts are re-grounded against a fresh snapshot or repaired (counted).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerRequest } from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import type { FlowOptions, GoalEngineLimits } from '../src/goals/goal-engine.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { clarify, makeEngine, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, cobble, finitePlan, followPlan, holdUntilRevoked, runFor, sleep, task, type PlannerScript } from './handoff-fakes.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const FACTS = new VersionKnowledge({ version: '26.1.2' });
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'test-flow', capabilities: [cap('mine_block'), cap('move_near'), cap('follow_entity')] });
const READY_EXECUTOR = { readiness: () => ({ ready: true, detail: 'fake executor' }), execute: async () => { throw new Error('not used'); } };
const LIMITS: GoalEngineLimits = { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 10_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 8 };

function harness(script: (request: PlannerRequest, index: number) => PlannerScript, opts: { limits?: Partial<GoalEngineLimits>; flow?: Partial<FlowOptions> } = {}) {
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const server = new FakeServer(log);
  const tasks = new FakeTaskRuntime(log);
  const world = new FakeWorld();
  const h = makeEngine(
    {
      planner,
      outcomes: server,
      tasks,
      observation: world,
      capabilities: CAPS,
      executor: READY_EXECUTOR,
      registry: FACTS,
      limits: { ...LIMITS, ...opts.limits },
      flow: { handoff: 'smooth', lookahead: false, ...opts.flow },
      connectionEpoch: () => 1,
    },
    log,
  );
  return { ...h, planner, server, tasks, world, log };
}

/** Script by instruction text (first match), default immediate follow plan. */
const byInstruction = (table: Record<string, (r: PlannerRequest, i: number) => PlannerScript>) => (r: PlannerRequest, i: number): PlannerScript => {
  const f = table[r.instruction];
  return f ? f(r, i) : { kind: 'reply', proposal: followPlan() };
};

async function followingHarness(table: Record<string, (r: PlannerRequest, i: number) => PlannerScript>, opts: Parameters<typeof harness>[1] = {}) {
  const h = harness(byInstruction({ 'follow me': () => ({ kind: 'reply', proposal: followPlan() }), ...table }), opts);
  h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
  const first = await h.engine.submit('follow me', OWNER);
  assert.equal(first.status, 'admitted');
  await until(() => h.tasks.runs.length === 1 && h.engine.status().goal?.state === 'executing');
  return h;
}

describe('H1/H2 smooth handoff while following', () => {
  it('acknowledges at once, keeps the admitted follow task running through a >= 3 s preparation, then switches through revocation and records the timeline', async () => {
    const getCobble = finitePlan([task('mine two cobblestone', cobble(2))], cobble(2), false);
    const h = await followingHarness({ 'get two cobblestone': () => ({ kind: 'reply', proposal: getCobble, delayMs: 3_000 }) });
    h.tasks.behaviors.set('mine two cobblestone', holdUntilRevoked);
    const oldRun = h.tasks.runs[0]!;
    const t0 = Date.now();
    const result = await h.engine.submit('get two cobblestone', OWNER);
    const ackMs = Date.now() - t0;
    assert.equal(result.status, 'preparing');
    assert.ok(ackMs < 100, `acknowledged in ${ackMs} ms`);
    assert.ok(h.notices.some((n) => /Preparing your new instruction: "get two cobblestone"; continuing the current task until handoff/.test(n.text)));

    await sleep(1_500);
    const mid = h.engine.status();
    assert.equal(oldRun.task.signal.aborted, false, 'the admitted follow task keeps running during preparation');
    assert.equal(mid.goal?.instruction, 'follow me');
    assert.equal(mid.goal?.state, 'executing');
    assert.equal(mid.task?.objective, 'stay near the owner');
    assert.equal(mid.pending?.state, 'preparing');
    assert.equal(mid.pending?.plannerTurns, 1);
    assert.equal(h.tasks.runs.length, 1, 'nothing runs under pending ownership');
    assert.equal(h.server.baselines.length, 1, 'no admission baseline (server resync) for the draft');
    const prepRequest = h.planner.requests[1]!;
    assert.equal(prepRequest.subject.kind, 'preparation');
    assert.equal(prepRequest.preparation?.inventory, 'provisional_client_model');
    assert.equal(prepRequest.preparation?.continuingTask, 'stay near the owner');
    assert.equal(prepRequest.admission, undefined, 'the draft has no admission baseline');

    await until(() => h.engine.status().goal?.instruction === 'get two cobblestone' && h.tasks.runs.length === 2, 5_000);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2_900, `switched after the draft was ready (${elapsed} ms)`);
    assert.equal(oldRun.task.signal.aborted, true);
    // Ownership order: old task released (cleanup) BEFORE the new admission baseline.
    assert.ok(h.log.indexOf('task-end:stay near the owner') < h.log.lastIndexOf('baseline:{}'), h.log.join(' | '));
    assert.equal(h.server.baselines.length, 2);
    const timeline = h.store.ofType('handoff_timeline')[0]!;
    const order = ['receivedAtMs', 'acknowledgedAtMs', 'draftReadyAtMs', 'handoffStartedAtMs', 'admittedAtMs', 'firstTaskAtMs'].map((k) => timeline[k] as number);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `timeline is ordered: ${JSON.stringify(timeline)}`);
    assert.ok((timeline['receiptToDraftMs'] as number) >= 2_900);
    const old = h.store.ofType('goal_terminal').find((e) => e['goalId'] === 'goal-0001');
    assert.equal(old?.['reason'], 'replaced');
    const goal = h.engine.status().goal!;
    assert.equal(goal.counters?.preparationTurns, 1, 'the preparation turn transferred to the admitted goal');
    assert.equal(goal.counters?.plannerTurns, 1);
    assert.equal(h.planner.maxInFlight, 1, 'one planner process at a time');
    await h.engine.stop('owner_stop');
  });

  it("H2: the old task's late result after the switch is discarded and never touches the new goal", async () => {
    const plan2 = finitePlan([task('mine two cobblestone', cobble(2))], cobble(2), false);
    const h = await followingHarness({ 'get two cobblestone': () => ({ kind: 'reply', proposal: plan2, delayMs: 50 }) });
    // The old (revoked) task reports a non-cancelled result late.
    h.tasks.behaviors.set('stay near the owner', async (t) => {
      await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
      await sleep(30);
      return { status: 'blocked', reason: 'late_old_result', detail: 'LATE OLD RESULT' };
    });
    // Restart the follow task under the new behavior: replace the goal.
    await h.engine.stop('owner_stop');
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 2 && h.engine.status().goal?.state === 'executing');
    h.tasks.behaviors.set('mine two cobblestone', holdUntilRevoked);
    await h.engine.submit('get two cobblestone', OWNER);
    await until(() => h.tasks.runs.length === 3);
    await sleep(60);
    const discarded = h.store.ofType('task_result_discarded');
    assert.equal(discarded.at(-1)?.['reason'], 'late_old_result');
    const status = h.engine.status();
    assert.equal(status.goal?.instruction, 'get two cobblestone');
    assert.doesNotMatch(status.goal?.progress ?? '', /LATE OLD RESULT/);
    assert.equal(status.lastTask, undefined, 'no stale task summary was published');
    assert.ok(h.tasks.runs.every((r) => r.currentAtStart), 'every task started under a current owner');
    await h.engine.stop('owner_stop');
  });
});

describe('H3 admission baseline after handoff', () => {
  it('binds the accepted outcome to the server inventory captured at the REAL admission, so gains made by the old task during preparation do not count', async () => {
    const h = harness(byInstruction({
      'mine some stone': () => ({ kind: 'reply', proposal: finitePlan([task('mine stone', cobble(10))], cobble(10), false) }),
      'get two more cobblestone': () => ({ kind: 'reply', proposal: finitePlan([task('mine two more', cobble(2))], cobble(2), false), delayMs: 200 }),
    }));
    h.server.add('minecraft:cobblestone', 3);
    // The old task gains 2 cobblestone 100 ms into the preparation, then keeps working.
    h.tasks.behaviors.set('mine stone', async (t) => {
      await runFor(100)(t);
      if (!t.signal.aborted) h.server.add('minecraft:cobblestone', 2);
      await holdUntilRevoked(t);
    });
    await h.engine.submit('mine some stone', OWNER);
    await until(() => h.tasks.runs.length === 1);
    let newGoalGains = 0;
    h.tasks.behaviors.set('mine two more', async (t) => {
      // Before the new task acquires anything, the outcome (bound to the admission baseline) is still unmet.
      const verdict = await h.server.evaluate({ predicate: cobble(2), boundAtMs: 0, baselines: { 'inv:minecraft:cobblestone': h.server.boundWith.at(-1)!.counts!['minecraft:cobblestone']! } });
      assert.equal(verdict.status, 'unsatisfied', 'pre-admission gains are not newly collected');
      await runFor(20)(t);
      h.server.add('minecraft:cobblestone', 2);
      newGoalGains += 2;
    });
    const r = await h.engine.submit('get two more cobblestone', OWNER);
    assert.equal(r.status, 'preparing');
    await until(() => h.engine.status().goal?.state === 'completed', 3_000);
    assert.deepEqual(h.server.baselines.map((b) => b.counts['minecraft:cobblestone']), [3, 5], 'admission baselines: first goal 3, handed-off goal 5 (after the old gain)');
    assert.equal(h.server.boundWith.at(-1)?.counts?.['minecraft:cobblestone'], 5, 'outcome bound to the real admission baseline');
    assert.equal(newGoalGains, 2);
    const bound = h.store.ofType('goal_outcome_bound').at(-1)!;
    assert.equal(bound['fromAdmission'], true);
    assert.ok(bound['intentId'], 'bound for the handed-off instruction');
    assert.equal(h.server.inventory.get('minecraft:cobblestone'), 7);
  });
});

describe('H4 rapid instructions and invalid intake', () => {
  it('A/B/C in quick succession: one planner process at a time, only C is admitted, a stale reply from A never acts', async () => {
    const plan = (name: string) => finitePlan([task(`do ${name}`, cobble(1))], cobble(1), false, `do ${name}`);
    const h = await followingHarness({
      A: () => ({ kind: 'late', proposal: plan('A'), delayMs: 120 }),
      B: () => ({ kind: 'hang', cleanupMs: 40 }),
      C: () => ({ kind: 'reply', proposal: plan('C'), delayMs: 30 }),
    });
    h.tasks.behaviors.set('do C', holdUntilRevoked);
    const a = await h.engine.submit('A', OWNER);
    const b = await h.engine.submit('B', OWNER);
    const c = await h.engine.submit('C', OWNER);
    assert.deepEqual([a.status, b.status, c.status], ['preparing', 'preparing', 'preparing']);
    assert.equal(c.status === 'preparing' && c.supersededIntentId, b.status === 'preparing' ? b.intentId : '');
    assert.equal(h.engine.status().pending?.instruction, 'C', 'newest pending only');
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false, 'superseding drafts does not stop the active task');
    await until(() => h.engine.status().goal?.instruction === 'C' && h.tasks.runs.length === 2, 3_000);
    await sleep(200); // A's late reply arrives now
    assert.equal(h.planner.maxInFlight, 1, `one planner process at a time: ${JSON.stringify(h.planner.events)}`);
    const admitted = h.store.ofType('goal_admitted').map((e) => e['instruction']);
    assert.deepEqual(admitted, ['follow me', 'C']);
    assert.deepEqual(h.tasks.runs.map((r) => r.task.spec.objective), ['stay near the owner', 'do C'], 'no action from A or B');
    assert.deepEqual(h.store.ofType('preparation_discarded').map((e) => e['reason']), ['superseded', 'superseded']);
    assert.equal(h.engine.status().handoff.discarded, 2);
    // C's turn started only after the earlier processes settled.
    const cStart = h.planner.events.find((e) => e.instruction === 'C' && e.what === 'start')!.t;
    for (const e of h.planner.events.filter((x) => x.instruction !== 'C' && x.instruction !== 'follow me' && x.what === 'settled')) assert.ok(e.t <= cStart + 2, 'earlier process settled first');
    await h.engine.stop('owner_stop');
  });

  it('empty, oversized and unconnected instructions leave the active task and the pending instruction untouched', async () => {
    const h = await followingHarness({ 'get wood': () => ({ kind: 'hang' }) });
    await h.engine.submit('get wood', OWNER);
    await until(() => h.planner.count === 2);
    const pending = h.engine.status().pending!;
    for (const text of ['   ', 'x'.repeat(501)]) {
      const r = await h.engine.submit(text, OWNER);
      assert.equal(r.status, 'rejected');
    }
    h.setReady(false);
    assert.equal((await h.engine.submit('come here', OWNER)).status, 'rejected');
    h.setReady(true);
    assert.equal(h.engine.status().pending?.intentId, pending.intentId);
    assert.equal(h.planner.signals[1]?.aborted, false);
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false);
    await h.engine.stop('owner_stop');
  });
});

describe('H5 stop and lifecycle during preparation', () => {
  it('stop cancels the pending planner process and the active task at once, latches pause, and a later explicit instruction still works', async () => {
    const h = await followingHarness({ 'get wood': () => ({ kind: 'hang', cleanupMs: 20 }) });
    await h.engine.submit('get wood', OWNER);
    await until(() => h.planner.count === 2);
    const t = Date.now();
    const stopped = await h.engine.stop('owner_stop', 'chat');
    const stopMs = Date.now() - t;
    assert.ok(stopMs < 250, `stop completed in ${stopMs} ms`);
    assert.equal(stopped.stopped, true);
    assert.ok(stopped.intentId);
    assert.equal(h.planner.signals[1]?.aborted, true, 'pending planner process cancelled');
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, true, 'active task cancelled');
    const s = h.engine.status();
    assert.equal(s.pending, undefined);
    assert.equal(s.goal?.terminal?.reason, 'owner_stop');
    assert.equal(s.latch.paused, true);
    assert.equal(h.engine.autonomyAllowed(), false);
    assert.ok(h.notices.some((n) => /pending new instruction was discarded/.test(n.text)));
    // An explicit owner instruction is still accepted; the latch stays until resume.
    const next = await h.engine.submit('follow me', OWNER);
    assert.equal(next.status, 'admitted');
    assert.equal(h.engine.status().latch.paused, true);
    assert.deepEqual(h.engine.resume('chat'), { wasPaused: true });
    assert.equal(h.engine.autonomyAllowed(), true);
    await h.engine.stop('owner_stop');
  });

  it('a lifecycle interruption invalidates both the active goal and the pending instruction', async () => {
    for (const reason of ['death', 'disconnected', 'dimension_change'] as const) {
      const h = await followingHarness({ 'get wood': () => ({ kind: 'hang' }) });
      await h.engine.submit('get wood', OWNER);
      await until(() => h.planner.count === 2);
      await h.engine.endOwnership(reason, `lifecycle ${reason}`);
      assert.equal(h.engine.status().pending, undefined);
      assert.equal(h.engine.status().goal?.terminal?.reason, reason);
      assert.equal(h.planner.signals[1]?.aborted, true);
      assert.equal(h.store.ofType('preparation_discarded')[0]?.['reason'], 'lifecycle');
    }
  });
});

describe('H6 honest failures before admission keep the current task', () => {
  const failing = async (script: () => PlannerScript, limits: Partial<GoalEngineLimits> = {}) => {
    const h = await followingHarness({ 'get wood': script }, { limits });
    const r = await h.engine.submit('get wood', OWNER);
    assert.equal(r.status, 'preparing');
    await until(() => h.engine.status().pending === undefined, 3_000);
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false, 'the still-valid old task continues');
    assert.equal(h.engine.status().goal?.instruction, 'follow me');
    assert.equal(h.engine.status().goal?.state, 'executing');
    assert.equal(h.tasks.runs.length, 1, 'no action for the failed instruction');
    return h;
  };

  it('quota: not started, no retry and no fallback', async () => {
    const h = await failing(() => ({ kind: 'fail', failure: 'quota', detail: "You've hit your usage limit" }));
    assert.equal(h.planner.count, 2);
    const n = h.notices.at(-1)!.text;
    assert.match(n, /not started \(planner_not_ready\).*usage limit.*no paid or alternative planner.*Continuing goal goal-0001/);
    assert.ok(!h.notices.some((x) => /Goal goal-0002 accepted/.test(x.text)), 'never claims the new instruction started');
    await h.engine.stop('owner_stop');
  });

  it('auth: actionable sign-in advice; the old task continues', async () => {
    const h = await failing(() => ({ kind: 'fail', failure: 'auth', detail: '401 please log in' }));
    assert.match(h.notices.at(-1)!.text, /codex login/);
    await h.engine.stop('owner_stop');
  });

  it('timeout: one counted retry, then not started; discarded turns are counted against the run allowance', async () => {
    const h = await failing(() => ({ kind: 'hang' }), { plannerTimeoutMs: 80 });
    assert.equal(h.planner.count, 3, 'initial + one retry');
    assert.equal(h.planner.requests[2]?.turnKind, 'retry');
    assert.match(h.notices.at(-1)!.text, /planner_error.*timeout/);
    assert.equal(h.engine.status().handoff.discardedTurns, 2);
    await h.engine.stop('owner_stop');
  });

  it('malformed output: bounded repair turns, then not started', async () => {
    const h = await failing(() => ({ kind: 'fail', failure: 'invalid_output', detail: 'the final message is not JSON' }));
    assert.equal(h.planner.count, 4, 'initial + 2 repairs');
    assert.deepEqual(h.planner.requests.slice(2).map((r) => r.turnKind), ['repair', 'repair']);
    assert.match(h.notices.at(-1)!.text, /invalid_proposal/);
    await h.engine.stop('owner_stop');
  });

  it('MB-PLAN-006: a legacy clarification for the new instruction is a counted preparation repair; the active task continues, nothing is asked, and the repaired draft hands off', async () => {
    let turn = 0;
    const plan = finitePlan([task('chop oak', cobble(1))], cobble(1), false, 'chop oak');
    const h = await followingHarness({ 'get wood': () => (turn++ === 0 ? { kind: 'reply', proposal: clarify('Oak or birch?') } : { kind: 'reply', proposal: plan }) });
    h.tasks.behaviors.set('chop oak', holdUntilRevoked);
    await h.engine.submit('get wood', OWNER);
    await until(() => h.engine.status().goal?.instruction === 'get wood' && h.tasks.runs.length === 2);
    assert.ok(!h.notices.some((n) => /Question q\d|Oak or birch|answer q\d/.test(n.text)), 'no owner question');
    const goal = h.engine.status().goal!;
    assert.equal(goal.counters?.questionRefusals, 1);
    assert.equal(goal.counters?.repairs, 1);
    assert.equal(goal.counters?.preparationTurns, 2);
    assert.equal(h.planner.requests[2]?.turnKind, 'repair');
    assert.ok(h.planner.requests[2]?.rejection?.problems.some((p) => p.startsWith('owner_question_refused')));
    await h.engine.stop('owner_stop');
  });

  it('MB-PLAN-006: preparation questions until exhaustion discard the draft declaratively while the old task continues', async () => {
    const h = await failing(() => ({ kind: 'reply', proposal: clarify('Oak or birch?') }));
    assert.equal(h.planner.count, 4, 'initial + 2 repairs');
    assert.match(h.notices.at(-1)!.text, /not started \(invalid_proposal\): the planner kept asking for an owner decision/);
    assert.ok(!h.notices.some((n) => /Oak or birch/.test(n.text)));
    assert.equal(h.engine.status().goal?.state, 'executing', 'the still-valid old task keeps running');
    await h.engine.stop('owner_stop');
  });

  it('cannot_execute: the exact reason is reported and the old task continues', async () => {
    const h = await failing(() => ({ kind: 'reply', proposal: { version: 1, disposition: 'cannot_execute', interpretation: 'fly', missing: 'there is no flying capability', missingCapabilities: [], verifiedProgress: '' } }));
    assert.match(h.notices.at(-1)!.text, /not started \(cannot_execute\): there is no flying capability/);
    await h.engine.stop('owner_stop');
  });
});

describe('draft revalidation and allowance', () => {
  const observedPlan = (snapshotId: string, handle: string) => finitePlan([task('chop that log', cobble(1), { targetSelectors: [{ kind: 'observed', snapshotId, handle }] })], cobble(1), false, 'chop the seen log');

  it('re-grounds observed handles of the draft into the fresh admission snapshot before executing', async () => {
    const h = await followingHarness({ 'chop that log': (r) => ({ kind: 'reply', proposal: observedPlan(r.observation!.id, r.observation!.blocks[0]!.handle), delayMs: 20 }) });
    h.tasks.behaviors.set('chop that log', holdUntilRevoked);
    await h.engine.submit('chop that log', OWNER);
    await until(() => h.tasks.runs.length === 2);
    const selector = h.tasks.runs[1]!.task.spec.targetSelectors[0] as { snapshotId: string; handle: string };
    const prepSnap = h.planner.requests[1]!.observation!.id;
    assert.notEqual(selector.snapshotId, prepSnap, 'moved to the fresh snapshot');
    assert.equal(selector.snapshotId, h.world.taken.at(-1)!.id);
    assert.equal(h.store.ofType('draft_revalidated')[0]?.['regrounded'], 1);
    assert.equal(h.world.taken.find((t) => t.id === prepSnap)?.goalEpoch, 0, 'the preparation snapshot belongs to no goal epoch');
    await h.engine.stop('owner_stop');
  });

  it('a materially stale draft gets a counted repair turn and never acts on the stale target', async () => {
    let n = 0;
    const repaired = finitePlan([task('chop any log', cobble(1), { targetSelectors: [{ kind: 'registry', key: '#minecraft:logs' }] })], cobble(1), false);
    const h = await followingHarness({ 'chop that log': (r) => (n++ === 0 ? { kind: 'reply', proposal: observedPlan(r.observation!.id, r.observation!.blocks[0]!.handle), delayMs: 20 } : { kind: 'reply', proposal: repaired }) });
    h.tasks.behaviors.set('chop any log', holdUntilRevoked);
    h.world.persist = false; // the seen log is gone by the switch
    await h.engine.submit('chop that log', OWNER);
    await until(() => h.tasks.runs.length === 2);
    assert.deepEqual(h.tasks.runs.map((r) => r.task.spec.objective), ['stay near the owner', 'chop any log']);
    const repair = h.planner.requests.at(-1)!;
    assert.equal(repair.subject.kind, 'goal');
    assert.equal(repair.turnKind, 'repair');
    assert.match(repair.rejection?.problems.join(' ') ?? '', /no longer observed as the same target/);
    assert.ok(repair.admission, 'the repair turn sees the real admission inventory');
    const c = h.engine.status().goal!.counters!;
    assert.deepEqual([c.preparationTurns, c.repairs, c.plannerTurns], [1, 1, 2]);
    await h.engine.stop('owner_stop');
  });

  it('after the per-run allowance of discarded preparation turns is used up, a new instruction replaces directly', async () => {
    const h = await followingHarness({ 'get wood': () => ({ kind: 'fail', failure: 'quota' }), 'get stone': () => ({ kind: 'hang' }) }, { flow: { preparationTurnsPerRun: 1 } });
    await h.engine.submit('get wood', OWNER);
    await until(() => h.engine.status().pending === undefined);
    assert.equal(h.engine.status().handoff.discardedTurns, 1);
    const r = await h.engine.submit('get stone', OWNER);
    assert.equal(r.status, 'admitted', 'direct replacement once the allowance is spent');
    assert.ok(h.notices.some((n) => /allowance .* is used up/.test(n.text)));
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, true);
    await h.engine.stop('owner_stop');
  });

  it('immediate mode keeps the pre-MB-FLOW-002 replacement behavior', async () => {
    const h = await followingHarness({ 'get wood': () => ({ kind: 'hang' }) }, { flow: { handoff: 'immediate' } });
    const r = await h.engine.submit('get wood', OWNER);
    assert.equal(r.status, 'admitted');
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, true);
    await h.engine.stop('owner_stop');
  });
});
