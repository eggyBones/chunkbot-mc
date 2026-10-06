// MB-FLOW-002 H7 generic window lookahead (goal engine, fake delayed planner).
// Two ordinary finite windows: with lookahead the next window is planned while
// the previous window's last task runs, revalidated against fresh state, and the
// measured gap between windows shrinks; it is never reported as zero latency.
// A lookahead is discarded when its premise fails, and owner preparation
// preempts it (one planner process at a time).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerRequest } from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import type { FlowOptions } from '../src/goals/goal-engine.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { makeEngine, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, cobble, finitePlan, holdUntilRevoked, runFor, task, type PlannerScript } from './handoff-fakes.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'test-flow', capabilities: [cap('mine_block'), cap('move_near'), cap('follow_entity')] });
const READY_EXECUTOR = { readiness: () => ({ ready: true, detail: 'fake executor' }), execute: async () => { throw new Error('not used'); } };

const PLANNER_MS = 300;
const TASK_MS = 500;

function harness(script: (r: PlannerRequest, i: number) => PlannerScript, flow: Partial<FlowOptions>) {
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const server = new FakeServer(log);
  const tasks = new FakeTaskRuntime(log);
  const h = makeEngine(
    {
      planner,
      outcomes: server,
      tasks,
      observation: new FakeWorld(),
      capabilities: CAPS,
      executor: READY_EXECUTOR,
      registry: new VersionKnowledge({ version: '26.1.2' }),
      limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 10_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 8 },
      flow: { handoff: 'smooth', ...flow },
    },
    log,
  );
  return { ...h, planner, server, tasks, log };
}

/** Each window: one ordinary finite task that collects two cobblestone over TASK_MS. */
function twoWindows(lookahead: boolean) {
  const outcome = cobble(4);
  // The planner expects window 2 to finish the goal (morePlanningNeeded=false): no lookahead then.
  const window = (n: number) => finitePlan([task(`window ${n}: mine two cobblestone`, cobble(2))], outcome, n < 2);
  const h = harness((_r, i) => ({ kind: 'reply', proposal: window(i + 1), delayMs: PLANNER_MS }), { lookahead });
  for (const n of [1, 2, 3]) h.tasks.behaviors.set(`window ${n}: mine two cobblestone`, runFor(TASK_MS, () => h.server.add('minecraft:cobblestone', 2)));
  return h;
}

describe('H7 window lookahead', () => {
  it('reduces the measured planner wait between two finite windows and uses no extra planner turn', async () => {
    const off = twoWindows(false);
    await off.engine.submit('get four cobblestone', OWNER);
    await until(() => off.engine.status().goal?.state === 'completed', 5_000);
    const on = twoWindows(true);
    await on.engine.submit('get four cobblestone', OWNER);
    await until(() => on.engine.status().goal?.state === 'completed', 5_000);

    const gapOff = off.engine.status().windowGaps[0]!;
    const gapOn = on.engine.status().windowGaps[0]!;
    assert.equal(gapOff.source, 'replan');
    assert.ok(gapOff.gapMs >= PLANNER_MS - 20, `without lookahead the next window waits for a planner turn (${gapOff.gapMs} ms)`);
    assert.equal(gapOn.source, 'lookahead');
    assert.ok(gapOn.gapMs < PLANNER_MS / 2, `with lookahead the wait shrinks (${gapOn.gapMs} ms vs ${gapOff.gapMs} ms)`);
    assert.equal(typeof gapOn.revalidationMs, 'number', 'revalidation time is measured, not assumed zero');
    const cOn = on.engine.status().goal!.counters!;
    const cOff = off.engine.status().goal!.counters!;
    assert.equal(cOn.lookaheads, 1);
    assert.equal(cOn.plannerTurns, cOff.plannerTurns, 'the used lookahead replaced the replan turn');
    assert.deepEqual([cOn.windows, cOn.replans], [2, 1]);
    assert.equal(on.planner.requests[1]?.turnKind, 'lookahead');
    assert.equal(on.planner.requests[1]?.lookahead?.runningTask, 'window 1: mine two cobblestone');
    assert.equal(on.planner.maxInFlight, 1);
    assert.equal(on.store.ofType('draft_revalidated')[0]?.['source'], 'lookahead');
    assert.equal(on.engine.status().handoff.lookaheadsUsed, 1);
    assert.equal(on.server.inventory.get('minecraft:cobblestone'), 4, 'both windows ran; the outcome was verified by code');
  });

  it('discards the lookahead when the running task fails and replans with its feedback', async () => {
    const outcome = cobble(4);
    const h = harness((r) => ({ kind: 'reply', proposal: finitePlan([task(r.turnKind === 'replan' ? 'recover' : 'first try', cobble(2))], outcome, true), delayMs: 50 }), { lookahead: true });
    h.tasks.behaviors.set('first try', async (t) => {
      await runFor(150)(t);
      return { status: 'blocked', reason: 'no_candidates', detail: 'no visible stone' };
    });
    h.tasks.behaviors.set('recover', holdUntilRevoked);
    await h.engine.submit('get four cobblestone', OWNER);
    await until(() => h.tasks.runs.length === 2, 3_000);
    assert.deepEqual(h.planner.requests.slice(0, 3).map((r) => r.turnKind), ['initial', 'lookahead', 'replan']);
    assert.equal(h.planner.requests[2]?.feedback?.at(-1)?.reason, 'no_candidates');
    assert.equal(h.engine.status().handoff.lookaheadsDiscarded, 1);
    assert.match(String(h.store.ofType('lookahead_discarded')[0]?.['reason']), /blocked \(no_candidates\)/);
    await h.engine.stop('owner_stop');
  });

  it('an owner instruction preempts a lookahead turn in flight; one planner process at a time', async () => {
    const outcome = cobble(4);
    const h = harness((r) => {
      if (r.instruction === 'come here') return { kind: 'reply', proposal: finitePlan([task('walk over', cobble(1))], cobble(1), false), delayMs: 30 };
      if (r.turnKind === 'lookahead') return { kind: 'hang', cleanupMs: 60 };
      return { kind: 'reply', proposal: finitePlan([task('dig', cobble(2))], outcome, true) };
    }, { lookahead: true });
    h.tasks.behaviors.set('dig', holdUntilRevoked);
    h.tasks.behaviors.set('walk over', holdUntilRevoked);
    await h.engine.submit('get four cobblestone', OWNER);
    await until(() => h.planner.requests.some((r) => r.turnKind === 'lookahead'));
    const r = await h.engine.submit('come here', OWNER);
    assert.equal(r.status, 'preparing');
    await until(() => h.engine.status().goal?.instruction === 'come here' && h.tasks.runs.length === 2, 3_000);
    const la = h.planner.requests.findIndex((x) => x.turnKind === 'lookahead');
    assert.equal(h.planner.signals[la]?.aborted, true, 'lookahead turn aborted');
    assert.ok(h.store.ofType('lookahead_preempted').length === 1);
    assert.equal(h.planner.maxInFlight, 1);
    await h.engine.stop('owner_stop');
  });
});
