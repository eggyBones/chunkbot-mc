// MB-FLOW-001 supervisor behavior with the REAL GoalEngine (fake planner/task/
// world/server ports, manual timers/clock, real durable control store). No inference.
//
// A1  normal run starts a bounded automatic goal after ready; disabled makes zero planner calls
// A4  owner priority, finite owner completion returns to progression, persistent owner work keeps priority
// C1  blocked/interrupted owner intent holds progression; bare resume does NOT clear it; a new instruction does
// A5  stop during automatic planning cancels it and latches paused DURABLY across a restart; resume reassesses
// C2  every automatic planner admission is clamped to the remaining session planner turns; exhausted refuses
// A7  repeated blocked outcomes wait for a state change (no polling); provider not ready blocks without calls
// A9  survival code_task / revoke_unsafe through the same engine; the allowance is bound at admission
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerProposal, SurvivalProposal } from '../src/contracts/index.ts';
import { until } from './helpers.ts';
import { FakeSurvival, OWNER, autonomyHarness } from './autonomy-fakes.ts';
import { cobble, finitePlan, followPlan, holdUntilRevoked, runFor, sleep, task, type PlannerScript } from './handoff-fakes.ts';

const cannot = (missing = 'nothing useful is attainable here'): PlannerProposal => ({ version: 1, disposition: 'cannot_execute', interpretation: 'no milestone', missing, missingCapabilities: [], verifiedProgress: '' }) as PlannerProposal;
const progressionPlan = (n = 1) => finitePlan([task('collect cobblestone for tools', cobble(n))], cobble(n), false, 'collect cobblestone for stone tools');

async function settle(): Promise<void> {
  await sleep(15);
}

/** Fires the earliest pending supervisor timer and lets async work settle. */
async function fire(h: ReturnType<typeof autonomyHarness>): Promise<boolean> {
  const fired = h.timers.fireNext();
  await settle();
  return fired;
}

describe('A1 automatic progression starts through the single admission path', () => {
  it('after ready + settle delay one progression goal is admitted with a generic instruction and bounded autonomy context', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }));
    h.tasks.behaviors.set('collect cobblestone for tools', runFor(5, () => h.server.add('minecraft:cobblestone', 1)));
    h.supervisor.onLifecycle({ type: 'ready', connectionEpoch: 1, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, gameMode: 'survival', serverOnlineMode: false } });
    assert.deepEqual(h.timers.delays(), [5_000]);
    assert.equal(h.planner.count, 0, 'nothing happens before the settle delay');
    await fire(h);
    await until(() => h.engine.status().goal?.state === 'completed');
    const req = h.planner.requests[0]!;
    assert.equal(req.autonomy?.source.kind, 'progression');
    assert.match(req.instruction, /Automatic progression/);
    assert.doesNotMatch(req.instruction, /cobblestone|iron|stone pickaxe/i, 'no hardcoded milestone ladder');
    assert.ok(req.autonomy?.rules.some((r) => /never ask the owner questions/.test(r)));
    assert.equal(h.engine.status().goal?.source?.kind, 'progression');
    assert.equal(h.supervisor.status().session.completed, 1);
    assert.deepEqual(h.timers.delays(), [3_000], 'next assessment after a verified outcome');
  });

  it('a disabled supervisor (inference-free profile / --no-autonomy) never schedules and makes zero planner calls', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }), { enabled: false });
    h.supervisor.onLifecycle({ type: 'ready', connectionEpoch: 1, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, gameMode: 'survival', serverOnlineMode: false } });
    assert.equal(h.timers.pending.size, 0);
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 0);
    assert.equal(h.supervisor.status().mode, 'disabled');
  });

  it('missing durable scope blocks automatic work only; an owner goal still runs', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: followPlan() }), { scope: false });
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 0);
    assert.equal(h.supervisor.status().mode, 'scope_blocked');
    assert.equal(h.supervisor.status().persistence.state, 'missing_scope');
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    assert.equal((await h.engine.submit('follow me', OWNER)).status, 'admitted');
    await until(() => h.tasks.runs.length === 1);
  });
});

describe('A4 owner priority and return to progression', () => {
  it('an owner instruction preempts automatic work; its verified completion returns to progression', async () => {
    const h = autonomyHarness((r) => (r.autonomy ? { kind: 'reply', proposal: progressionPlan(5) } : { kind: 'reply', proposal: finitePlan([task('get one cobblestone', cobble(1))], cobble(1), false) }));
    h.tasks.behaviors.set('collect cobblestone for tools', holdUntilRevoked);
    h.tasks.behaviors.set('get one cobblestone', runFor(5, () => h.server.add('minecraft:cobblestone', 1)));
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    assert.equal(h.supervisor.status().mode, 'progression');
    const r = await h.engine.submit('get one cobblestone', OWNER);
    assert.equal(r.status, 'preparing', 'smooth handoff: the safe automatic task continues while the owner instruction is prepared');
    await until(() => h.engine.status().goal?.instruction === 'get one cobblestone' && h.engine.status().goal?.state === 'completed', 3_000);
    assert.equal(h.tasks.runs[0]!.task.signal.aborted, true, 'the automatic task was revoked at handoff');
    assert.ok(h.notices.some((n) => /returning to automatic progression/.test(n)));
    await fire(h);
    await until(() => h.engine.status().goal?.source?.kind === 'progression');
  });

  it('a persistent owner follow keeps priority: no automatic admission while it runs', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: followPlan() }));
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.supervisor.assessNow();
    assert.equal(h.planner.requests.filter((r) => r.autonomy).length, 0);
    assert.equal(h.supervisor.status().mode, 'owner');
  });
});

describe('C1 unresolved owner intent', () => {
  it('a blocked owner goal holds progression; bare resume does not clear it; a new owner instruction supersedes it', async () => {
    const h = autonomyHarness((r) => (r.autonomy ? { kind: 'reply', proposal: progressionPlan() } : r.instruction === 'build a castle' ? { kind: 'reply', proposal: cannot('no castle capability') } : { kind: 'reply', proposal: followPlan() }));
    await h.engine.submit('build a castle', OWNER);
    await until(() => h.engine.status().goal?.state === 'blocked');
    await settle();
    let s = h.supervisor.status();
    assert.equal(s.ownerIntent?.state, 'blocked');
    assert.equal(s.ownerIntent?.requiresOwnerDecision, true);
    await h.supervisor.assessNow();
    assert.equal(h.automaticRequests().length, 0, 'unrelated progression waits');
    assert.equal(h.supervisor.status().mode, 'owner_unresolved');
    // stop + resume: the latch clears, the intent stays.
    await h.engine.stop('owner_stop', 'chat');
    h.engine.resume('chat');
    await settle();
    s = h.supervisor.status();
    assert.equal(s.latch.paused, false);
    assert.equal(s.ownerIntent?.state, 'blocked', 'resume never clears unresolved owner intent');
    await fire(h);
    assert.equal(h.automaticRequests().length, 0);
    // A new explicit owner instruction supersedes it.
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.supervisor.status().ownerIntent?.state === 'active');
    assert.match(h.supervisor.status().ownerIntent!.instruction, /follow me/);
  });

  it('stop of the ACTIVE owner goal resolves the intent of that goal', async () => {
    const h = autonomyHarness((r) => (r.instruction === 'build a castle' ? { kind: 'reply', proposal: cannot('no castle') } : { kind: 'reply', proposal: followPlan() }));
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.engine.stop('owner_stop', 'chat');
    await settle();
    assert.equal(h.supervisor.status().ownerIntent, null, 'stopping the active owner goal is the owner resolving it');
  });

  it('a pending owner instruction that fails to plan stays visible as blocked intent', async () => {
    const h = autonomyHarness((r) => (r.instruction === 'do the impossible' ? { kind: 'reply', proposal: cannot('impossible') } : { kind: 'reply', proposal: followPlan() }));
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    assert.equal((await h.engine.submit('do the impossible', OWNER)).status, 'preparing');
    await until(() => h.supervisor.status().ownerIntent?.state === 'blocked');
    assert.match(h.supervisor.status().ownerIntent!.instruction, /impossible/);
  });
});

describe('A5 stop latch is durable and resume reassesses freshly', () => {
  it('stop during automatic planning cancels it, persists the latch, survives a restart, and resume starts a fresh assessment', async () => {
    const h = autonomyHarness(() => ({ kind: 'hang', cleanupMs: 5 }));
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 1);
    const stopped = await h.engine.stop('owner_stop', 'chat');
    assert.equal(stopped.stopped, true);
    assert.equal(h.engine.status().goal?.state, 'cancelled');
    assert.equal(h.timers.pending.size, 0, 'stop cancels automatic scheduling synchronously');
    await h.control.flush();
    assert.equal(h.control.latch().paused, true);
    assert.equal(h.control.latchDurability(), 'written');
    await h.supervisor.close();
    // Restart with the same scope directory.
    const h2 = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }), { dir: h.dir });
    assert.equal(h2.engine.status().latch.paused, true, 'the latch is restored before any connection');
    await h2.supervisor.assessNow();
    assert.equal(h2.planner.count, 0, 'paused across restart: no automatic planner call');
    assert.equal(h2.supervisor.status().mode, 'paused');
    h2.tasks.behaviors.set('collect cobblestone for tools', runFor(5, () => h2.server.add('minecraft:cobblestone', 1)));
    h2.engine.resume('chat');
    await h2.control.flush();
    assert.equal(h2.control.latch().paused, false);
    await fire(h2);
    await until(() => h2.planner.count === 1);
    assert.equal(h2.planner.requests[0]!.turnKind, 'initial', 'a fresh assessment, nothing replayed');
  });
});

describe('C2 automatic planner-turn ceiling', () => {
  it('each automatic admission is clamped to the remaining session planner turns and refused when none remain (no replenishment)', async () => {
    const script = (): PlannerScript => ({ kind: 'reply', proposal: cannot() });
    const h = autonomyHarness(script, { config: { session: { maxPlannerTurns: 3, maxConsecutiveUnproductive: 10, maxRepeatsPerFingerprint: 10, maxProgressionGoals: 10, maxSupportGoals: 10 } } });
    for (let i = 0; i < 3; i += 1) {
      h.setFingerprint(`state-${i}`);
      await h.supervisor.assessNow();
      await until(() => h.planner.count === i + 1 && h.engine.status().goal?.terminal !== undefined);
      await settle();
      assert.equal(h.planner.requests[i]!.maxTurns, 3 - i, `admission ${i + 1} gets only the ${3 - i} remaining session turns`);
    }
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 3, 'no automatic planner turn once the session allowance is used');
    assert.equal(h.supervisor.status().mode, 'exhausted');
    h.engine.resume('chat');
    await fire(h);
    assert.equal(h.planner.count, 3, 'resume does not replenish the allowance');
  });

  it('repairs count against the clamp: an automatic goal ends limit_exhausted within its remaining turns', async () => {
    const h = autonomyHarness(() => ({ kind: 'fail', failure: 'invalid_output', detail: 'not json' }), { config: { session: { maxPlannerTurns: 2, maxConsecutiveUnproductive: 10, maxRepeatsPerFingerprint: 10, maxProgressionGoals: 10, maxSupportGoals: 10 } } });
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    assert.equal(h.planner.count, 2, 'initial + one repair, then the clamp');
    assert.equal(h.supervisor.status().session.plannerTurns, 2);
  });
});

describe('A7 bounded waiting', () => {
  it('repeated blocked outcomes in an unchanged state wait for a change; timers alone make no planner call', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot() }), { config: { session: { maxConsecutiveUnproductive: 2, maxRepeatsPerFingerprint: 5, maxPlannerTurns: 100, maxProgressionGoals: 10, maxSupportGoals: 10 } } });
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    await settle();
    assert.deepEqual(h.timers.delays(), [60_000], 'first cooldown');
    await fire(h);
    await until(() => h.planner.count === 2 && h.engine.status().goal?.terminal !== undefined);
    await settle();
    assert.equal(h.supervisor.status().mode, 'waiting');
    for (let i = 0; i < 4; i += 1) await fire(h);
    assert.equal(h.planner.count, 2, 'unchanged state: no new planner call');
    h.setFingerprint('state-changed');
    await fire(h);
    await until(() => h.planner.count === 3);
  });

  it('providers not ready: provider_blocked with zero planner calls and no polling timer', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }), { providers: () => ({ ready: false, code: 'spend_cap', detail: 'cap reached' }) });
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 0);
    assert.equal(h.supervisor.status().mode, 'provider_blocked');
    assert.equal(h.timers.pending.size, 0);
  });

  it('automatic goals never wait for an owner answer (same MB-PLAN-006 counted refusal) and refuse persistent outcomes', async () => {
    let n = 0;
    const h = autonomyHarness(() => {
      n += 1;
      return n === 1 ? { kind: 'reply', proposal: followPlan() } : { kind: 'reply', proposal: { version: 1, disposition: 'needs_clarification', interpretation: 'x', question: 'which tree?' } };
    });
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    const g = h.engine.status().goal!;
    assert.equal(g.terminal?.reason, 'invalid_proposal');
    assert.match(g.terminal!.detail, /does not ask follow-up questions/);
    assert.doesNotMatch(g.terminal!.detail, /which tree/);
    assert.equal(g.counters?.questionRefusals, 2, 'both repair turns answered the same question (allowance exhausted)');
    assert.equal(h.planner.requests[1]!.turnKind, 'repair', 'the persistent outcome was rejected first');
  });
});

describe('A9 survival support through the same engine', () => {
  const codeTask = (proposalId: string, priority: 'safety' | 'support' = 'support'): SurvivalProposal => ({
    proposalId,
    routine: 'eat',
    priority,
    reason: 'food is low',
    signature: 'eat:sig',
    serves: 'progression',
    execution: { kind: 'code_task', spec: { objective: 'eat safe food', decisionInstruction: 'eat', allowedCapabilities: ['use_held_item'], targetSelectors: [], parameters: {} }, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' }, mode: 'complete', objective: 'eat safe food' },
    ceilings: { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 30_000 },
    lowHealthAllowance: { routine: 'eat', capabilities: ['use_held_item'], items: ['minecraft:bread'], maxActions: 2, ttlMs: 30_000 },
    expiresAtMs: Date.now() + 1e9,
  });

  it('a code_task proposal is admitted as a support goal with no planner turn; survival binds it before the task runs', async () => {
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }), { survival });
    survival.next = [{ kind: 'propose', proposal: { ...codeTask('prop-1'), expiresAtMs: h.clock.now() + 60_000 } }];
    survival.grant = { allowanceId: 'alw-1', dimension: 'overworld', taskId: null, routine: 'eat', capabilities: ['use_held_item'], items: ['minecraft:bread'], maxActions: 2, actionsUsed: 0, expiresAtMs: h.clock.now() + 30_000 };
    h.tasks.behaviors.set('eat safe food', runFor(5));
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    assert.equal(h.planner.count, 0, 'no planner turn for a code task');
    const goal = h.engine.status().goal!;
    assert.equal(goal.kind, 'support_task');
    assert.equal(goal.source?.kind, 'support');
    assert.equal(survival.admitted[0]?.proposalId, 'prop-1');
    assert.equal(survival.admitted[0]?.goalEpoch, goal.epoch, 'bound to the admitted epoch');
    assert.equal(survival.grants.length, 1, 'allowance granted at admission, before the task ran');
    await until(() => h.engine.status().goal?.terminal !== undefined);
    await settle();
    assert.equal(survival.terminals[0]?.proposalId, 'prop-1');
  });

  it('revoke_unsafe revokes an ACTIVE owner goal as safety_interrupted; the interrupted intent holds progression', async () => {
    const survival = new FakeSurvival();
    const h = autonomyHarness((r) => (r.autonomy ? { kind: 'reply', proposal: progressionPlan() } : { kind: 'reply', proposal: followPlan() }), { survival });
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    survival.next = [{ kind: 'revoke_unsafe', reason: 'lava', detail: 'standing next to lava', retainOwnerIntent: true }];
    await h.supervisor.guardNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    assert.equal(h.engine.status().goal?.terminal?.reason, 'safety_interrupted');
    await settle();
    assert.equal(h.supervisor.status().ownerIntent?.state, 'interrupted');
    assert.equal(h.supervisor.status().session.safetyRevocations, 1);
    survival.decision = { kind: 'none', reason: 'safe now' };
    await h.supervisor.assessNow();
    assert.equal(h.automaticRequests().length, 0, 'unrelated progression waits for the owner');
    const lastInput = survival.assessed.at(-1)!;
    assert.equal(lastInput.ownerIntentInterrupted, true);
  });

  it('a planner_goal support proposal is clamped to the remaining session planner turns', async () => {
    const survival = new FakeSurvival();
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: cannot() }), { survival, config: { session: { maxPlannerTurns: 2, maxProgressionGoals: 10, maxSupportGoals: 10, maxConsecutiveUnproductive: 10, maxRepeatsPerFingerprint: 10 } } });
    survival.next = [
      {
        kind: 'propose',
        proposal: { proposalId: 'prop-r', routine: 'death_recovery', priority: 'support', reason: 'recover belongings', signature: 's', serves: 'progression', execution: { kind: 'planner_goal', instruction: 'Recover belongings near your death site.', context: { routine: 'death_recovery', facts: [], suggestedCapabilities: [], rules: [] } }, ceilings: { plannerTurns: 12, tasks: 24, replans: 4, deadlineMs: 60_000 }, expiresAtMs: h.clock.now() + 60_000 },
      },
    ];
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 1);
    assert.equal(h.planner.requests[0]!.maxTurns, 2, 'min(episode ceiling 12, goal limit 20, session remaining 2)');
    assert.equal(h.planner.requests[0]!.autonomy?.source.kind, 'support');
  });
});

describe('MB-FLOW-003-C4 retained interrupted intent vs live owner intake', () => {
  it('after a restart, survival\'s DURABLE interrupted directive holds progression; necessary support still runs; a new owner instruction supersedes it', async () => {
    const survival = new FakeSurvival();
    survival.durableInterrupted = [{ goalId: 'goal-old1', instruction: 'collect 10 logs', reason: 'death', interruptedAtMs: 1, durable: true }];
    const h = autonomyHarness((r) => (r.autonomy?.source.kind === 'progression' ? { kind: 'reply', proposal: progressionPlan() } : { kind: 'reply', proposal: followPlan() }), { survival });
    await h.supervisor.assessNow();
    assert.equal(h.automaticRequests().length, 0, 'no automatic progression may ignore the durable unresolved intent');
    const st = h.supervisor.status();
    assert.equal(st.mode, 'owner_unresolved');
    assert.equal(st.ownerIntent?.goalId, 'goal-old1');
    const input = survival.assessed.at(-1)!;
    assert.equal(input.ownerIntentInterrupted, true, 'retained interrupted directive is passed as interrupted');
    assert.equal(input.ownerIntakePending, false, 'it is NOT live owner intake');
    // Necessary support (eat) serving the owner intent is admitted while the intent stays held.
    survival.next = [
      {
        kind: 'propose',
        proposal: {
          proposalId: 'prop-eat',
          routine: 'eat',
          priority: 'safety',
          reason: 'health low; eat before anything else',
          signature: 's-eat',
          serves: 'owner_intent',
          execution: { kind: 'code_task', spec: { objective: 'eat safe food', decisionInstruction: 'eat', allowedCapabilities: ['use_held_item'], targetSelectors: [], parameters: {} }, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' }, mode: 'complete', objective: 'eat safe food' },
          ceilings: { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 30_000 },
          expiresAtMs: h.clock.now() + 60_000,
        },
      },
    ];
    h.tasks.behaviors.set('eat safe food', runFor(5));
    await h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    assert.equal(h.engine.status().goal?.source?.kind, 'support');
    await settle();
    // Resume never clears it.
    h.engine.resume('chat');
    await settle();
    assert.equal(h.supervisor.status().ownerIntent?.goalId, 'goal-old1');
    // A new explicit owner instruction supersedes it.
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.some((r) => r.task.spec.objective === 'stay near the owner'));
    assert.equal(survival.ownerInstructions.length, 1);
    assert.equal(survival.interruptedOwnerIntent().length, 0);
  });

  it('a live pending owner instruction is intake (survival yields); an owner question is intake too', async () => {
    const survival = new FakeSurvival();
    const h = autonomyHarness((r) => (r.instruction === 'which one?' ? { kind: 'hang', cleanupMs: 5 } : { kind: 'reply', proposal: followPlan() }), { survival });
    h.tasks.behaviors.set('stay near the owner', holdUntilRevoked);
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    assert.equal((await h.engine.submit('which one?', OWNER)).status, 'preparing');
    await h.supervisor.guardNow();
    assert.equal(survival.assessed.at(-1)?.ownerIntakePending, true);
    assert.equal(survival.assessed.at(-1)?.ownerIntentInterrupted, false);
  });
});

describe('code-task support budget truthfulness', () => {
  const eat = (h: ReturnType<typeof autonomyHarness>): SurvivalProposal => ({
    proposalId: 'prop-e2',
    routine: 'eat',
    priority: 'support',
    reason: 'food low',
    signature: 's',
    serves: 'progression',
    execution: { kind: 'code_task', spec: { objective: 'eat safe food', decisionInstruction: 'eat', allowedCapabilities: ['use_held_item'], targetSelectors: [], parameters: {} }, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' }, mode: 'complete', objective: 'eat safe food' },
    ceilings: { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 30_000 },
    expiresAtMs: h.clock.now() + 60_000,
  });

  it('a code task needs no planner but DOES need Jev (spend cap / Jev not ready blocks it without calls)', async () => {
    const survival = new FakeSurvival();
    let decisionReady = false;
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: progressionPlan() }), { survival, providers: () => ({ ready: false, decisionReady, code: decisionReady ? 'planner_not_ready' : 'spend_cap', detail: 'test providers' }) });
    survival.decision = { kind: 'propose', proposal: eat(h) };
    await h.supervisor.assessNow();
    assert.equal(h.tasks.runs.length, 0, 'Jev unavailable (spend cap): the code task is not admitted');
    assert.equal(h.supervisor.status().mode, 'provider_blocked');
    decisionReady = true;
    h.tasks.behaviors.set('eat safe food', runFor(5));
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    assert.equal(h.planner.count, 0, 'planner unavailable is fine for a code task');
  });
});
