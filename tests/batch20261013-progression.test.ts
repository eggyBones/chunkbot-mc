// Actual supervisor entry points and the real GoalEngine, with filtered fake
// observations and scripted planner/task ports. No connection or inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ObservationSnapshot, PlannerProposal, SurvivalProposal } from '../src/contracts/index.ts';
import { FakeSurvival, OWNER, autonomyHarness } from './autonomy-fakes.ts';
import { cobble, finitePlan, followPlan, holdUntilRevoked, runFor, sleep, task } from './handoff-fakes.ts';
import { until } from './helpers.ts';
import { autonomyStatusLines } from '../src/autonomy/status-text.ts';

const cannot: PlannerProposal = { version: 1, disposition: 'cannot_execute', interpretation: 'no attainable milestone', missing: 'no safe visible prerequisites', missingCapabilities: [], verifiedProgress: '' };
const plan = () => finitePlan([task('gain useful supplies', cobble(1))], cobble(1), false, 'gain useful supplies');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function snapshot(h: ReturnType<typeof autonomyHarness>): Promise<ObservationSnapshot> {
  return { ...await h.world.snapshot(0), takenAtMs: h.clock.now() };
}

const eat = (now: number): SurvivalProposal => ({
  proposalId: 'prop-batch-eat', routine: 'eat', priority: 'safety', reason: 'food is low', signature: 'batch-eat', serves: 'progression',
  execution: { kind: 'code_task', spec: { objective: 'eat safe food', decisionInstruction: 'eat', allowedCapabilities: ['use_held_item'], targetSelectors: [], parameters: {} }, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' }, mode: 'complete', objective: 'eat safe food' },
  ceilings: { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 30_000 }, expiresAtMs: now + 60_000,
});

describe('Oct13 supervisor observation ownership', () => {
  it('a ready timer arriving during the guard read still starts idle progression from that one fresh snapshot', async (t) => {
    const read = deferred<ObservationSnapshot>();
    let reads = 0;
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { survival, observe: () => { reads += 1; return read.promise; } });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.supervisor.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    assert.equal(h.timers.fireNext(), true, 'coarse guard goes first at the settle deadline');
    await until(() => reads === 1);
    assert.equal(h.timers.fireNext(), true, 'ordinary settle timer coalesces behind the same read');
    read.resolve(await snapshot(h));
    await until(() => h.planner.count === 1);
    assert.equal(reads, 1);
    assert.equal(survival.assessed.length, 1);
  });
  it('coalesces concurrent timer/guard assessments into one snapshot, policy decision and admission', async (t) => {
    const read = deferred<ObservationSnapshot>();
    let reads = 0;
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { survival, observe: () => { reads += 1; return read.promise; } });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    const first = h.supervisor.assessNow();
    const second = h.supervisor.assessNow();
    const guard = h.supervisor.guardNow();
    await until(() => reads === 1);
    read.resolve(await snapshot(h));
    await Promise.all([first, second, guard]);
    await until(() => h.engine.status().goal?.terminal !== undefined);
    assert.equal(reads, 1);
    assert.equal(survival.assessed.length, 1);
    assert.equal(h.planner.count, 1);
    assert.equal(h.supervisor.status().session.progressionGoals, 1);
  });

  it('stop/resume discards the old observation and starts a fresh assessment, even when the old read settles late', async (t) => {
    const old = deferred<ObservationSnapshot>();
    let reads = 0;
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { survival, observe: () => ++reads === 1 ? old.promise : snapshot(h) });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    const assessment = h.supervisor.assessNow();
    await until(() => reads === 1);
    await h.engine.stop('owner_stop', 'chat');
    await assessment;
    assert.equal(h.planner.count, 0);
    h.engine.resume('chat');
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 1);
    old.resolve(await snapshot(h));
    await sleep(15);
    assert.equal(reads, 2);
    assert.equal(survival.assessed.length, 1, 'stopped read is never given to the policy');
    assert.equal(h.planner.count, 1);
  });

  it('a stale unsafe decision cannot revoke an owner goal admitted during the observation await', async (t) => {
    const read = deferred<ObservationSnapshot>();
    const survival = new FakeSurvival();
    survival.decision = { kind: 'revoke_unsafe', reason: 'old_hazard', detail: 'old snapshot hazard', retainOwnerIntent: true };
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: followPlan() }), { survival, observe: () => read.promise });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    const assessment = h.supervisor.guardNow();
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    read.resolve(await snapshot(h));
    await assessment;
    assert.equal(survival.assessed.length, 0);
    assert.equal(h.engine.activeSource?.kind, 'owner');
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false);
  });

  it('rejects snapshots from another connection, dimension or an old timestamp before any policy/model work', async (t) => {
    for (const change of [ { connectionEpoch: 2 }, { dimension: 'the_nether' }, { takenAtMs: 1 } ]) {
      const survival = new FakeSurvival();
      const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { survival, observe: async () => ({ ...await snapshot(h), ...change }) });
      t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
      await h.supervisor.assessNow();
      assert.equal(h.planner.count, 0);
      assert.equal(survival.assessed.length, 0);
      assert.equal(h.supervisor.status().blocker?.code, 'observation_not_current');
    }
  });

  it('a stopped in-flight guard cannot rearm its timer after the observation settles', async (t) => {
    const read = deferred<ObservationSnapshot>();
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { survival, observe: () => read.promise });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.supervisor.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    assert.equal(h.timers.fireNext(), true);
    await sleep(5);
    await h.engine.stop('owner_stop', 'chat');
    read.resolve(await snapshot(h));
    await sleep(15);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.planner.count, 0);
  });
});

describe('Oct13 automatic readiness and useful outcomes', () => {
  it('empty and prepared admission inventories allow different prerequisites through the same instruction and catalog', async (t) => {
    const instructions: string[] = [];
    const firstObjectives: string[] = [];
    for (const prepared of [false, true]) {
      const h = autonomyHarness((r) => {
        instructions.push(r.instruction);
        const hasMaterials = (r.admission?.counts?.find((item) => item.key === 'minecraft:oak_log')?.count ?? 0) > 0;
        const output = hasMaterials ? 'minecraft:wooden_pickaxe' : 'minecraft:oak_log';
        const outcome = { predicate: 'inventory_amount' as const, selector: output, atLeast: 1, mode: 'collect_additional' as const };
        const objective = hasMaterials ? 'craft usable equipment' : 'gather visible prerequisites';
        firstObjectives.push(objective);
        assert.ok(r.catalog.capabilities.some((c) => c.id === (hasMaterials ? 'craft_item' : 'mine_block')));
        return { kind: 'reply', proposal: finitePlan([task(objective, outcome, { allowedCapabilities: [hasMaterials ? 'craft_item' : 'mine_block'] })], outcome, false) };
      });
      t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
      if (prepared) h.server.add('minecraft:oak_log', 3);
      h.tasks.behaviors.set('gather visible prerequisites', runFor(5, () => h.server.add('minecraft:oak_log', 1)));
      h.tasks.behaviors.set('craft usable equipment', runFor(5, () => h.server.add('minecraft:wooden_pickaxe', 1)));
      await h.supervisor.assessNow();
      await until(() => h.engine.status().goal?.state === 'completed');
      assert.equal(h.server.inventory.get(prepared ? 'minecraft:wooden_pickaxe' : 'minecraft:oak_log'), 1);
      assert.equal(h.supervisor.status().session.completed, 1);
    }
    assert.equal(instructions[0], instructions[1], 'no phrase/resource dispatch or resource-specific prompt');
    assert.deepEqual(firstObjectives, ['gather visible prerequisites', 'craft usable equipment']);
  });
  it('a guard replacement respects the run spend gate and leaves the current automatic task owned', async (t) => {
    let ready = true;
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: plan() }), { survival, providers: () => ({ ready, decisionReady: ready, code: 'spend_cap', detail: 'run reservation exhausted' }) });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.tasks.behaviors.set('gain useful supplies', holdUntilRevoked);
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    ready = false;
    survival.decision = { kind: 'propose', proposal: eat(h.clock.now()) };
    await h.supervisor.guardNow();
    assert.equal(h.engine.activeSource?.kind, 'progression');
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, false);
    assert.equal(survival.admitted.length, 0);
    assert.equal(h.supervisor.status().blocker?.code, 'spend_cap');
  });

  it('a terminal planner failure cannot be retried by the guard, timers or reconnect; resume rechecks', async (t) => {
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'fail', failure: 'auth', detail: 'subscription unavailable' }), { survival });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    for (let i = 0; i < 3; i += 1) { await h.supervisor.guardNow(); await h.supervisor.assessNow(); }
    h.supervisor.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 1);
    assert.equal(h.supervisor.status().mode, 'provider_blocked');
    h.engine.resume('chat');
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 2);
    assert.equal(h.supervisor.status().session.progressionGoals, 2);
  });

  it('blocked survival holds unrelated progression and ignores zero-delay retry requests', async (t) => {
    const survival = new FakeSurvival();
    survival.decision = { kind: 'blocked', routine: 'rest', signature: 'unsafe', reason: 'unsafe_path', detail: 'no safe resting place', retryAfterMs: 0 };
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: plan() }), { survival });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 0);
    assert.equal(h.supervisor.status().mode, 'waiting');
    assert.deepEqual(h.timers.delays(), [60_000]);
  });

  it('terminal Jev failure holds code-task support as well as planner goals until explicit resume', async (t) => {
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: plan() }), { survival });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    survival.decision = { kind: 'propose', proposal: eat(h.clock.now()) };
    h.tasks.behaviors.set('eat safe food', async () => ({ status: 'failed', reason: 'decision_error', detail: 'provider drift' }));
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal?.reason === 'decision_error');
    await h.supervisor.guardNow();
    await h.supervisor.assessNow();
    assert.equal(h.tasks.runs.length, 1);
    assert.equal(h.supervisor.status().mode, 'provider_blocked');
    h.engine.resume('chat');
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 2);
    assert.equal(h.planner.count, 0, 'support uses the task runtime, with no substitute planner call');
  });

  it('safety replacement gets only planner turns left after the active automatic goal, without renewing the run allowance', async (t) => {
    const survival = new FakeSurvival();
    const h = autonomyHarness((r) => r.autonomy?.source.kind === 'support' ? { kind: 'reply', proposal: cannot } : { kind: 'reply', proposal: plan() }, {
      survival, config: { session: { maxPlannerTurns: 2 } },
    });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.tasks.behaviors.set('gain useful supplies', holdUntilRevoked);
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    assert.equal(h.supervisor.status().session.plannerTurns, 1, 'live automatic turn is already charged');
    survival.decision = { kind: 'propose', proposal: {
      ...eat(h.clock.now()),
      execution: { kind: 'planner_goal', instruction: 'Restore safe food supplies.', context: { routine: 'eat', facts: [], suggestedCapabilities: [], rules: [] } },
      ceilings: { plannerTurns: 8, tasks: 8, replans: 2, deadlineMs: 30_000 },
    } };
    await h.supervisor.guardNow();
    await until(() => h.planner.count === 2 && h.engine.status().goal?.terminal !== undefined);
    assert.equal(h.planner.requests[1]!.maxTurns, 1);
    assert.equal(h.supervisor.status().session.plannerTurns, 2);
    assert.equal(h.supervisor.status().session.supportGoals, 1);
  });

  it('the same already-satisfied completed outcome waits after its bounded repeats instead of generating milestones forever', async (t) => {
    const outcome = { ...cobble(1), mode: 'possess' as const };
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: finitePlan([task('gain useful supplies', outcome)], outcome, false) }));
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.server.add('minecraft:cobblestone', 1);
    for (let i = 0; i < 2; i += 1) {
      await h.supervisor.assessNow();
      await until(() => h.planner.count === i + 1 && h.engine.status().goal?.state === 'completed');
    }
    assert.equal(h.supervisor.status().blocker?.code, 'unchanged_completed_outcome');
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 2);
    assert.equal(h.supervisor.status().mode, 'waiting');
    h.setFingerprint('new-place');
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 3);
  });

  it('fresh admission baselines permit useful additional supplies across two verified windows', async (t) => {
    const outcome = { ...cobble(1), mode: 'collect_additional' as const };
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: finitePlan([task('gain additional supplies', outcome)], outcome, false, 'gain additional supplies') }), { fingerprint: () => JSON.stringify([...h.server.inventory]) });
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.tasks.behaviors.set('gain additional supplies', runFor(5, () => h.server.add('minecraft:cobblestone', 1)));
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.state === 'completed');
    h.timers.fireNext();
    await until(() => h.planner.count === 2 && h.engine.status().goal?.state === 'completed');
    assert.deepEqual(h.server.baselines.map((b) => b.counts['minecraft:cobblestone'] ?? 0), [0, 1]);
    assert.equal(h.server.inventory.get('minecraft:cobblestone'), 2);
    assert.equal(h.supervisor.status().session.completed, 2);
    assert.match(h.planner.requests[1]!.autonomy?.recentMilestones[0]?.interpretation ?? '', /collects 1 cobblestone more/);
    assert.equal(h.supervisor.status().blocker, null);
  });
});

describe('Oct13 stop across execution and lookahead', () => {
  it('a maintained owner follow remains active in status while unrelated progression stays idle', async (t) => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: followPlan() }));
    t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.supervisor.assessNow();
    const status = h.supervisor.status();
    assert.equal(status.active?.source.kind, 'owner');
    assert.equal(h.automaticRequests().length, 0);
    const intent = autonomyStatusLines(status).find((line) => line.startsWith('owner intent:'))!;
    assert.match(intent, /owner intent: active/);
    assert.doesNotMatch(intent, /held|continues when it is safe/);
  });
  for (const [capability, objective] of [['move_near', 'travel to supplies'], ['craft_item', 'make useful equipment'], ['place_block', 'build approved shelter cells']] as const) {
    it(`stop revokes ${capability} task ownership and in-flight lookahead, then restores pause on restart`, async (t) => {
      const outcome = cobble(4);
      const h = autonomyHarness((r) => r.turnKind === 'lookahead' ? { kind: 'hang', cleanupMs: 5 } : { kind: 'reply', proposal: finitePlan([task(objective, cobble(2), { allowedCapabilities: [capability] })], outcome, true) }, { lookahead: true });
      t.after(async () => { await h.engine.stop(); await h.supervisor.close(); });
      h.tasks.behaviors.set(objective, holdUntilRevoked);
      await h.supervisor.assessNow();
      await until(() => h.tasks.runs.length === 1 && h.planner.count === 2);
      await h.engine.stop('owner_stop', 'chat');
      assert.equal(h.tasks.runs[0]!.task.signal.aborted, true);
      assert.equal(h.planner.signals[1]!.aborted, true);
      assert.equal(h.planner.inFlight, 0);
      assert.equal(h.timers.pending.size, 0);
      assert.equal(h.supervisor.status().session.plannerTurns, 2, 'lookahead consumed the same automatic allowance');
      await h.control.flush();
      await h.supervisor.close();
      const restarted = autonomyHarness(() => ({ kind: 'reply', proposal: cannot }), { dir: h.dir });
      t.after(async () => { await restarted.engine.stop(); await restarted.supervisor.close(); });
      await restarted.supervisor.assessNow();
      assert.equal(restarted.planner.count, 0);
      assert.equal(restarted.supervisor.status().mode, 'paused');
    });
  }
});
