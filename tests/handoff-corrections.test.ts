// MB-FLOW-002-C2 / C3 corrections (goal engine, fake ports; no inference).
//
// C2: a prepared draft's OUTCOME references are re-grounded with its tasks
//     before the initial binding (unchanged target -> bound to the fresh
//     snapshot; disappeared target -> counted repair, nothing bound or run).
//     A lookahead never rewrites the accepted, bound outcome: it must repeat it
//     exactly; only its new tasks are re-grounded (a disappeared task target is
//     a counted repair, the accepted outcome stays as bound).
// C3: stop, lifecycle and shutdown await the discarded preparation's owned
//     planner-process cleanup within the existing bound (abort-honoring and
//     non-cooperative processes); supersession acknowledgement stays prompt.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OutcomePredicate, PlannerProposal, PlannerRequest } from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import type { FlowOptions, GoalEngineLimits } from '../src/goals/goal-engine.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { makeEngine, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, followPlan, holdUntilRevoked, runFor, sleep, task, type PlannerScript } from './handoff-fakes.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });

function harness(script: (r: PlannerRequest, i: number) => PlannerScript, opts: { limits?: Partial<GoalEngineLimits>; flow?: Partial<FlowOptions> } = {}) {
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const server = new FakeServer(log);
  const tasks = new FakeTaskRuntime(log);
  const world = new FakeWorld();
  tasks.behaviors.set('stay near the owner', holdUntilRevoked);
  const h = makeEngine({
    planner,
    tasks,
    outcomes: server,
    observation: world,
    capabilities: new StaticCapabilityRegistry({ catalogVersion: 'test-c2', capabilities: [cap('mine_block'), cap('move_near'), cap('follow_entity')] }),
    executor: { readiness: () => ({ ready: true, detail: 'fake' }), execute: async () => { throw new Error('unused'); } },
    registry: new VersionKnowledge({ version: '26.1.2' }),
    limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 5_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 8, ...opts.limits },
    flow: { handoff: 'smooth', lookahead: false, ...opts.flow },
    connectionEpoch: () => 1,
  });
  return { ...h, planner, server, tasks, world };
}

const nearObserved = (snapshotId: string, handle: string): OutcomePredicate => ({ predicate: 'near_target', target: { kind: 'observed', snapshotId, handle }, within: 2 });
const walkTo = (r: PlannerRequest, objective = 'walk to the log', more = false): PlannerProposal => {
  const snap = r.observation!;
  const h = snap.blocks[0]!.handle;
  return { version: 1, disposition: 'plan', interpretation: 'walk to the seen log', outcome: { kind: 'finite', outcome: nearObserved(snap.id, h) }, tasks: [task(objective, nearObserved(snap.id, h), { allowedCapabilities: ['move_near'], targetSelectors: [{ kind: 'observed', snapshotId: snap.id, handle: h }] })], morePlanningNeeded: more } as PlannerProposal;
};

async function following(script: (r: PlannerRequest, i: number) => PlannerScript, opts: Parameters<typeof harness>[1] = {}) {
  const h = harness((r, i) => (r.instruction === 'follow me' ? { kind: 'reply', proposal: followPlan() } : script(r, i)), opts);
  await h.engine.submit('follow me', OWNER);
  await until(() => h.tasks.runs.length === 1);
  return h;
}

describe('C2: outcome references of a prepared draft', () => {
  it('an unchanged outcome target is re-grounded with the tasks into the fresh admission snapshot BEFORE the initial binding', async () => {
    const h = await following((r) => (r.subject.kind === 'preparation' ? { kind: 'reply', proposal: walkTo(r), delayMs: 20 } : { kind: 'hang' }));
    h.tasks.behaviors.set('walk to the log', holdUntilRevoked);
    await h.engine.submit('walk to that log', OWNER);
    await until(() => h.tasks.runs.length === 2);
    const prepSnap = h.planner.requests[1]!.observation!.id;
    const bound = h.server.boundPredicates.at(-1) as { target: { snapshotId: string; handle: string } };
    const taskSel = h.tasks.runs[1]!.task.spec.targetSelectors[0] as { snapshotId: string; handle: string };
    assert.notEqual(bound.target.snapshotId, prepSnap, 'the bound outcome no longer names the preparation snapshot');
    assert.deepEqual(bound.target, taskSel, 'outcome and task name the same fresh target');
    assert.equal(h.store.ofType('draft_revalidated')[0]?.['regrounded'], 3, 'task selector, task completion and outcome re-grounded');
    await h.engine.stop('owner_stop');
  });

  it('a disappeared outcome target makes the draft stale: counted repair, nothing bound, nothing run', async () => {
    let prep = 0;
    const h = await following((r) => {
      if (r.subject.kind === 'preparation') {
        prep += 1;
        return { kind: 'reply', proposal: walkTo(r), delayMs: 20 };
      }
      return { kind: 'hang' };
    });
    const boundBefore = h.server.boundPredicates.length;
    h.world.persist = false;
    await h.engine.submit('walk to that log', OWNER);
    await until(() => h.planner.count === 3);
    const repair = h.planner.requests[2]!;
    assert.equal(repair.turnKind, 'repair');
    assert.match(repair.rejection?.problems.join(' ') ?? '', /no longer observed as the same target/);
    assert.equal(h.server.boundPredicates.length, boundBefore, 'no outcome was bound from the stale draft');
    assert.equal(h.tasks.runs.length, 1);
    assert.equal(prep, 1);
    await h.engine.stop('owner_stop');
  });
});

describe('C2: a lookahead keeps the accepted, bound outcome immutable', () => {
  function lookaheadHarness(taskTargetGone: boolean) {
    let accepted: PlannerProposal | undefined;
    const h = harness(
      (r) => {
        if (r.turnKind === 'initial') {
          accepted = walkTo(r, 'step 1', true);
          return { kind: 'reply', proposal: accepted };
        }
        if (r.turnKind === 'lookahead') {
          // Repeats the accepted outcome EXACTLY (old snapshot) with a new task on the lookahead snapshot.
          const snap = r.observation!;
          const h2 = snap.blocks[0]!.handle;
          const next = { ...accepted!, morePlanningNeeded: false, tasks: [task('step 2', { predicate: 'near_target', target: { kind: 'observed', snapshotId: snap.id, handle: h2 }, within: 2 }, { allowedCapabilities: ['move_near'], targetSelectors: [{ kind: 'observed', snapshotId: snap.id, handle: h2 }] })] } as PlannerProposal;
          return { kind: 'reply', proposal: next, delayMs: 10 };
        }
        return { kind: 'hang' };
      },
      { flow: { lookahead: true } },
    );
    h.tasks.behaviors.set('step 1', runFor(150, () => {
      if (taskTargetGone) h.world.persist = false;
    }));
    h.tasks.behaviors.set('step 2', holdUntilRevoked);
    return h;
  }

  it('unchanged: the lookahead repeats the accepted outcome, only its task is re-grounded, and the outcome is not re-bound', async () => {
    const h = lookaheadHarness(false);
    await h.engine.submit('walk to that log', OWNER);
    await until(() => h.tasks.runs.length === 2, 3_000);
    assert.equal(h.server.boundPredicates.length, 1, 'bound once, at the first accepted plan');
    const accepted = h.planner.requests[0]!.observation!.id;
    assert.equal((h.server.boundPredicates[0] as { target: { snapshotId: string } }).target.snapshotId, accepted, 'the accepted outcome keeps its original grounded reference');
    const lookaheadSnap = h.planner.requests[1]!.observation!.id;
    const sel = h.tasks.runs[1]!.task.spec.targetSelectors[0] as { snapshotId: string };
    assert.notEqual(sel.snapshotId, lookaheadSnap, 'the new task was re-grounded into the fresh snapshot');
    assert.equal(h.store.ofType('planner_proposal_rejected').length, 0, 'no immutability rejection');
    await h.engine.stop('owner_stop');
  });

  it('disappeared: a lookahead task target that is gone yields a counted repair; the accepted outcome stays as bound', async () => {
    const h = lookaheadHarness(true);
    await h.engine.submit('walk to that log', OWNER);
    await until(() => h.planner.count === 3, 3_000);
    const repair = h.planner.requests[2]!;
    assert.equal(repair.turnKind, 'repair');
    assert.match(repair.rejection?.problems.join(' ') ?? '', /no longer observed as the same target/);
    assert.deepEqual(repair.acceptedOutcome, { kind: 'finite', outcome: h.server.boundPredicates[0] }, 'the accepted outcome is unchanged');
    assert.equal(h.server.boundPredicates.length, 1);
    assert.equal(h.tasks.runs.length, 1, 'nothing ran from the stale lookahead');
    await h.engine.stop('owner_stop');
  });
});

describe('C3: owned preparation process cleanup is awaited (bounded)', () => {
  const pending = async (cleanup: PlannerScript, limits: Partial<GoalEngineLimits> = {}) => {
    const h = await following(() => cleanup, { limits });
    await h.engine.submit('build a tower', OWNER);
    await until(() => h.planner.count === 2);
    return h;
  };

  for (const via of ['stop', 'lifecycle', 'shutdown'] as const) {
    it(`${via} returns only after the abort-honoring preparation process has cleaned up`, async () => {
      const h = await pending({ kind: 'hang', cleanupMs: 120 });
      const t = Date.now();
      if (via === 'stop') await h.engine.stop('owner_stop');
      else if (via === 'lifecycle') await h.engine.endOwnership('death', 'test death');
      else await h.engine.shutdown();
      const ms = Date.now() - t;
      assert.ok(ms >= 100, `${via} waited for the process cleanup (${ms} ms)`);
      assert.equal(h.planner.inFlight, 0, 'no preparation process left running');
      assert.equal(h.planner.signals[1]?.aborted, true, 'aborted synchronously');
      assert.equal(h.tasks.runs[0]!.task.signal.aborted, true, 'control invalidation is immediate');
      assert.equal(h.store.ofType('preparation_cleanup').at(-1)?.['outcome'], 'settled');
    });
  }

  it('a non-cooperative preparation process is waited for only within the cleanup bound', async () => {
    const h = await pending({ kind: 'late', proposal: followPlan(), delayMs: 3_000 }, { cleanupTimeoutMs: 150 });
    const t = Date.now();
    await h.engine.stop('owner_stop');
    const ms = Date.now() - t;
    assert.ok(ms >= 140 && ms < 600, `bounded (${ms} ms)`);
    assert.equal(h.store.ofType('preparation_cleanup').at(-1)?.['outcome'], 'timeout');
  });

  it('a superseding instruction is still acknowledged promptly; the next turn starts only after the old process ended', async () => {
    const h = await following((r) => (r.instruction === 'A' ? { kind: 'hang', cleanupMs: 120 } : { kind: 'hang' }));
    await h.engine.submit('A', OWNER);
    await until(() => h.planner.count === 2);
    const t = Date.now();
    const b = await h.engine.submit('B', OWNER);
    assert.equal(b.status, 'preparing');
    assert.ok(Date.now() - t < 50, 'prompt acknowledgement');
    await until(() => h.planner.count === 3);
    const aSettled = h.planner.events.find((e) => e.instruction === 'A' && e.what === 'settled')!.t;
    const bStart = h.planner.events.find((e) => e.instruction === 'B' && e.what === 'start')!.t;
    assert.ok(bStart >= aSettled, 'serialized behind the real cleanup');
    await sleep(10);
    await h.engine.stop('owner_stop');
  });
});
