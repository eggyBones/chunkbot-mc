// MB-FLOW-002-C1: the planner slot serializes ACTUAL planner processes. A
// caller that waits beyond the bound fails (starts nothing) and never lets
// later work run past a still-running earlier turn; stop stays bounded with a
// non-cooperative planner (one that ignores abort), and rapid replacements
// never start a second planner process.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerRequest } from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { PlannerSlot } from '../src/goals/planner-slot.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { makeEngine, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, cobble, finitePlan, followPlan, holdUntilRevoked, sleep, task, type PlannerScript } from './handoff-fakes.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;

describe('PlannerSlot strict serialization (C1)', () => {
  it('a waiter that times out starts nothing, and later tickets still wait for the running turn', async () => {
    const slot = new PlannerSlot(25);
    const first = await slot.acquire('goal', new AbortController());
    assert.ok(first.ok);
    const release = Promise.withResolvers<void>();
    first.ticket.started(release.promise); // held well beyond the 25 ms bound
    const second = await slot.acquire('preparation', new AbortController());
    assert.deepEqual(second, { ok: false, reason: 'timeout' });
    // A third caller queued after the timed-out (skipped) ticket must still wait for the first turn.
    let thirdAt = 0;
    const third = slot.acquire('preparation', new AbortController()).then((a) => {
      thirdAt = Date.now();
      return a;
    });
    await sleep(10);
    const releasedAt = Date.now();
    release.resolve();
    const t = await third;
    // It either timed out while the first turn ran, or was admitted only after the release.
    if (t.ok) {
      assert.ok(thirdAt >= releasedAt, 'never admitted before the earlier turn settled');
      t.ticket.started(sleep(5));
    }
    await sleep(30);
    assert.equal(slot.maxRunning, 1);
    assert.equal(slot.running, 0);
  });

  it('a waiter whose owner is revoked leaves immediately and does not release later work early', async () => {
    const slot = new PlannerSlot(1_000);
    const first = await slot.acquire('goal', new AbortController());
    assert.ok(first.ok);
    const release = Promise.withResolvers<void>();
    first.ticket.started(release.promise);
    const owner = new AbortController();
    const waiting = slot.acquire('preparation', new AbortController(), owner.signal);
    const later = slot.acquire('preparation', new AbortController());
    owner.abort();
    assert.deepEqual(await waiting, { ok: false, reason: 'aborted' });
    let laterDone = false;
    void later.then(() => (laterDone = true));
    await sleep(50);
    assert.equal(laterDone, false, 'still waiting for the running first turn');
    release.resolve();
    const l = await later;
    assert.ok(l.ok);
    l.ticket.started(Promise.resolve());
    await sleep(5);
    assert.equal(slot.maxRunning, 1);
  });

  it('owner preparation preempts a running lookahead turn', async () => {
    const slot = new PlannerSlot(500);
    const la = new AbortController();
    const a = await slot.acquire('lookahead', la);
    assert.ok(a.ok);
    const done = Promise.withResolvers<void>();
    la.signal.addEventListener('abort', () => setTimeout(() => done.resolve(), 20));
    a.ticket.started(done.promise);
    const p = await slot.acquire('preparation', new AbortController());
    assert.ok(p.ok, 'admitted after the preempted lookahead settled');
    assert.equal(la.signal.aborted, true);
    p.ticket.skip();
  });
});

const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });

function harness(script: (r: PlannerRequest, i: number) => PlannerScript, cleanupTimeoutMs = 100) {
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const tasks = new FakeTaskRuntime(log);
  tasks.behaviors.set('stay near the owner', holdUntilRevoked);
  tasks.behaviors.set('do it', holdUntilRevoked);
  const h = makeEngine({
    planner,
    tasks,
    outcomes: new FakeServer(log),
    observation: new FakeWorld(),
    capabilities: new StaticCapabilityRegistry({ catalogVersion: 'test-c1', capabilities: [cap('mine_block'), cap('follow_entity')] }),
    executor: { readiness: () => ({ ready: true, detail: 'fake' }), execute: async () => { throw new Error('unused'); } },
    registry: new VersionKnowledge({ version: '26.1.2' }),
    limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 5_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs },
    flow: { handoff: 'smooth', lookahead: false },
  });
  return { ...h, planner, tasks };
}

describe('engine with a NON-COOPERATIVE planner (ignores abort; C1)', () => {
  const doIt = finitePlan([task('do it', cobble(1))], cobble(1), false);

  it('rapid replacements never start a second planner process; the newest instruction runs only after the earlier process really ended', async () => {
    // Preparations of A and B ignore the abort and answer 400 ms later; C answers at once.
    const h = harness((r) => (r.instruction === 'follow me' ? { kind: 'reply', proposal: followPlan() } : r.instruction === 'C' ? { kind: 'reply', proposal: doIt } : { kind: 'late', proposal: doIt, delayMs: 400 }), 1_000);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.engine.submit('A', OWNER);
    await until(() => h.planner.count === 2);
    await h.engine.submit('B', OWNER);
    await h.engine.submit('C', OWNER);
    await until(() => h.engine.status().goal?.instruction === 'C' && h.tasks.runs.length === 2, 3_000);
    assert.equal(h.planner.maxInFlight, 1, `planner events: ${JSON.stringify(h.planner.events)}`);
    assert.equal(h.engine.plannerProcesses.maxRunning, 1);
    const aSettled = h.planner.events.find((e) => e.instruction === 'A' && e.what === 'settled')!.t;
    const cStart = h.planner.events.find((e) => e.instruction === 'C' && e.what === 'start')!.t;
    assert.ok(cStart >= aSettled, 'C started only after A\'s process ended');
    assert.deepEqual(h.tasks.runs.map((r) => r.task.spec.objective), ['stay near the owner', 'do it']);
    await h.engine.stop('owner_stop');
  });

  it('when the earlier process outlives the bound, the next turn fails honestly instead of running a second process; stop stays bounded', async () => {
    const h = harness((r) => (r.instruction === 'follow me' ? { kind: 'reply', proposal: followPlan() } : r.instruction === 'A' ? { kind: 'late', proposal: doIt, delayMs: 1_500 } : { kind: 'reply', proposal: doIt }), 100);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.engine.submit('A', OWNER);
    await until(() => h.planner.count === 2);
    await h.engine.submit('B', OWNER); // A's non-cooperative process is still running
    await until(() => h.engine.status().pending === undefined, 3_000);
    assert.equal(h.planner.count, 2, 'B never started a planner process while A ran');
    assert.ok(h.notices.some((n) => /not started \(planner_error\).*no second planner process was started/.test(n.text)), JSON.stringify(h.notices.map((n) => n.text)));
    assert.ok(h.store.ofType('planner_slot_wait_timeout').length >= 1);
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false, 'the follow task kept running');
    const t = Date.now();
    await h.engine.stop('owner_stop');
    assert.ok(Date.now() - t < 250, 'stop is bounded even though a planner process ignores abort');
    await until(() => h.planner.inFlight === 0, 3_000);
    assert.equal(h.planner.maxInFlight, 1);
    assert.equal(h.engine.plannerProcesses.maxRunning, 1);
  });
});
