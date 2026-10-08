import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KnowledgePort, PlannerProposal } from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { ScriptedPlanner, clarify, makeEngine, tick, until } from './helpers.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const FACTS = new VersionKnowledge({ version: '26.1.2' });
const TERMINAL = { surface: 'terminal', principal: 'operator' } as const;

describe('open-ended goal intake', () => {
  it('admits arbitrary instructions through one surface and reports planner-not-ready without fake success', async () => {
    const { engine, store } = makeEngine();
    const instructions = [
      'collect stone',
      'get resources and make yourself armor',
      'follow me',
      'gather three kinds of flowers, put them in a chest by the door, then wait for me on the roof',
    ];
    for (const instruction of instructions) {
      const result = await engine.submit(instruction, OWNER);
      assert.equal(result.status, 'admitted');
      await until(() => engine.status().goal?.state === 'blocked');
      const goal = engine.status().goal;
      assert.equal(goal?.instruction, instruction);
      assert.equal(goal?.terminal?.reason, 'planner_not_ready');
      assert.match(goal?.terminal?.detail ?? '', /MB-V1-04.*No game actions were taken/);
    }
    assert.equal(store.ofType('goal_admitted').length, instructions.length);
    assert.equal(store.ofType('goal_terminal').filter((e) => e['state'] === 'completed').length, 0);
  });

  it('passes the verbatim instruction and the implemented (empty) catalog to the planner port', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('  build a tiny hut next to the river  ', TERMINAL);
    await until(() => planner.waiting === 1);
    assert.equal(planner.requests[0]?.instruction, 'build a tiny hut next to the river');
    assert.deepEqual(planner.requests[0]?.catalog, { catalogVersion: 'foundation-0', capabilities: [] });
    assert.equal(planner.requests[0]?.observation, null);
  });
});

describe('validation before replacement', () => {
  it('rejects empty and oversized instructions without touching the active goal', async () => {
    const planner = new ScriptedPlanner();
    const { engine, store } = makeEngine({ planner });
    await engine.submit('mine some coal', OWNER);
    await until(() => planner.waiting === 1);
    const before = engine.status().goal;

    assert.deepEqual(await engine.submit('   ', OWNER), { status: 'rejected', reason: 'empty', detail: 'instruction is empty; nothing was changed' });
    const long = await engine.submit('x'.repeat(501), OWNER);
    assert.equal(long.status, 'rejected');
    assert.equal(long.status === 'rejected' && long.reason, 'too_long');

    const after = engine.status().goal;
    assert.equal(after?.id, before?.id);
    assert.equal(after?.state, 'planning');
    assert.equal(planner.signals[0]?.aborted, false);
    assert.equal(store.ofType('instruction_rejected').length, 2);
  });

  it('rejects instructions while not connected', async () => {
    const h = makeEngine();
    h.setReady(false);
    const result = await h.engine.submit('come here', OWNER);
    assert.equal(result.status === 'rejected' && result.reason, 'not_connected');
    assert.equal(h.engine.status().goal, undefined);
  });
});

describe('replacement and stop', () => {
  it('revokes old ownership and finishes its cleanup before the new goal plans', async () => {
    const log: string[] = [];
    const planner = new ScriptedPlanner(log);
    const { engine } = makeEngine({ planner }, log);
    await engine.submit('first goal', OWNER);
    await until(() => planner.waiting === 1);
    const firstEpoch = engine.currentEpoch;
    assert.equal(
      engine.registerCleanup(firstEpoch, async () => {
        await tick(20);
        log.push('cleanup:first');
      }),
      true,
    );

    const result = await engine.submit('second goal', OWNER);
    assert.equal(result.status, 'admitted');
    assert.equal(result.status === 'admitted' && result.replacedGoalId, 'goal-0001');
    await until(() => planner.requests.length === 2);
    assert.deepEqual(log, [
      'planner:request:first goal',
      'planner:aborted:first goal',
      'cleanup:first',
      'planner:request:second goal',
    ]);
    // A late reply for the replaced goal is discarded.
    planner.respond(clarify('stale question?'));
    await tick(10);
    const goal = engine.status().goal;
    assert.equal(goal?.instruction, 'second goal');
    assert.equal(goal?.state, 'planning');
    assert.equal(goal?.pendingClarification, undefined);
  });

  it('stops a planning goal as cancelled and discards the late planner reply', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('dig a well', OWNER);
    await until(() => planner.waiting === 1);
    const result = await engine.stop('owner_stop', 'chat');
    assert.equal(result.stopped, true);
    assert.equal(planner.signals[0]?.aborted, true);
    assert.equal(engine.status().goal?.state, 'cancelled');
    assert.equal(engine.status().goal?.terminal?.reason, 'owner_stop');
    planner.respond(clarify('too late?'));
    await tick(10);
    assert.equal(engine.status().goal?.state, 'cancelled');
  });

  it('reports nothing to stop when idle or already terminal', async () => {
    const { engine } = makeEngine();
    assert.deepEqual(await engine.stop(), { stopped: false });
    await engine.submit('collect stone', OWNER);
    await until(() => engine.status().goal?.state === 'blocked');
    assert.deepEqual(await engine.stop(), { stopped: false });
    assert.equal(engine.status().goal?.state, 'blocked');
  });

  it('a stop that arrives while a replacement awaits cleanup supersedes the replacement', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('first', OWNER);
    await until(() => planner.waiting === 1);
    engine.registerCleanup(engine.currentEpoch, () => tick(30));
    const pending = engine.submit('second', OWNER);
    await tick(5);
    await engine.stop('owner_stop', 'terminal');
    assert.deepEqual(await pending, { status: 'superseded' });
    assert.equal(planner.requests.length, 1);
    assert.equal(engine.status().goal?.instruction, 'first');
    assert.equal(engine.status().goal?.state, 'cancelled');
  });
});

describe('no follow-up questions (MB-PLAN-006)', () => {
  const noQuestionNotice = (notices: Array<{ text: string }>) => notices.filter((n) => /Question q\d|answer q\d|\?/.test(n.text));

  it('refuses a legacy clarification with a counted repair, never asks, never waits, and blocks declaratively on exhaustion', async () => {
    const planner = new ScriptedPlanner();
    const { engine, notices, store } = makeEngine({ planner });
    await engine.submit('make armor', OWNER);
    for (let i = 0; i < 3; i += 1) {
      await until(() => planner.waiting === 1);
      assert.notEqual(engine.status().goal?.state, 'awaiting_owner');
      planner.respond(clarify('Which material: leather or iron?'));
      if (i < 2) {
        await until(() => planner.requests.length === i + 2);
        const repair = planner.requests[i + 1]!;
        assert.equal(repair.turnKind, 'repair');
        assert.ok(repair.rejection?.problems.some((p) => p.startsWith('owner_question_refused')));
      }
    }
    await until(() => engine.status().goal?.state === 'blocked');
    const goal = engine.status().goal!;
    assert.equal(goal.terminal?.reason, 'invalid_proposal');
    assert.doesNotMatch(goal.terminal!.detail, /leather or iron/);
    assert.match(goal.terminal!.detail, /does not ask follow-up questions/);
    assert.equal(goal.pendingClarification, undefined);
    assert.deepEqual({ refusals: goal.counters?.questionRefusals, repairs: goal.counters?.repairs, turns: goal.counters?.plannerTurns }, { refusals: 3, repairs: 2, turns: 3 });
    assert.deepEqual(noQuestionNotice(notices), [], 'no owner-facing question or answer prompt');
    assert.equal(store.ofType('clarification_requested').length, 0);
    assert.equal(store.ofType('planner_question_refused').length, 3);
    assert.equal(store.ofType('goal_state').some((e) => e['state'] === 'awaiting_owner'), false);
  });

  it('refuses owner questions embedded in a blocker or interpretation (even without a question mark) and relays only the declarative repair', async () => {
    const planner = new ScriptedPlanner();
    const { engine, notices } = makeEngine({ planner });
    await engine.submit('cut down that floating tree', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond({ version: 1, disposition: 'cannot_execute', interpretation: 'Two trees are visible', missing: 'Please confirm which tree should be removed', missingCapabilities: [], verifiedProgress: '' });
    await until(() => planner.requests.length === 2);
    planner.respond({ version: 1, disposition: 'cannot_execute', interpretation: 'Let me know if you want the birch or the oak', missing: 'target', missingCapabilities: [], verifiedProgress: '' });
    await until(() => planner.requests.length === 3);
    planner.respond({ version: 1, disposition: 'cannot_execute', interpretation: 'Removing the floating birch tree is not possible here', missing: 'no floating tree is visible from the current position', missingCapabilities: [], verifiedProgress: '' });
    await until(() => engine.status().goal?.state === 'blocked');
    const goal = engine.status().goal!;
    assert.equal(goal.terminal?.reason, 'cannot_execute');
    assert.match(goal.terminal!.detail, /no floating tree is visible/);
    assert.equal(goal.counters?.questionRefusals, 2);
    assert.ok(!notices.some((n) => /confirm which tree|Let me know/i.test(n.text)), 'raw planner questions never reach a notice');
  });

  it('retires an answer command: nothing is applied, revived, replaced or authorized', async () => {
    const planner = new ScriptedPlanner();
    const { engine, notices, store } = makeEngine({ planner });
    await engine.submit('goal A', OWNER);
    await until(() => planner.waiting === 1);
    const before = engine.status().goal!;
    const r = engine.answer('yes', 'q1', 'chat');
    assert.equal(r.status, 'rejected');
    assert.equal(r.status === 'rejected' && r.reason, 'no_pending_clarification');
    assert.equal(engine.status().goal?.id, before.id);
    assert.equal(engine.status().goal?.state, 'planning');
    assert.equal(planner.requests.length, 1);
    assert.ok(notices.some((n) => /Reply not applied: no question is pending/.test(n.text)));
    assert.equal(store.ofType('answer_retired').length, 1);
    await engine.stop('owner_stop', 'chat');
    assert.equal(engine.answer('yes', undefined, 'chat').status, 'rejected');
    assert.equal(engine.status().goal?.state, 'cancelled');
    assert.equal(planner.requests.length, 1);
  });
});

describe('lifecycle interruption', () => {
  it('ends ownership on death/disconnect/dimension change and the next goal starts fresh', async () => {
    for (const reason of ['death', 'disconnected', 'kicked', 'dimension_change'] as const) {
      const planner = new ScriptedPlanner();
      const { engine } = makeEngine({ planner });
      await engine.submit('guard the door', OWNER);
      await until(() => planner.waiting === 1);
      await engine.endOwnership(reason, `lifecycle: ${reason}`);
      const ended = engine.status().goal;
      assert.equal(ended?.state, 'failed');
      assert.equal(ended?.terminal?.reason, reason);
      assert.equal(ended?.pendingClarification, undefined);
      assert.equal(engine.answer('the front one', undefined, 'chat').status, 'rejected');
      const next = await engine.submit('come here', OWNER);
      assert.equal(next.status === 'admitted' && next.replacedGoalId, undefined);
    }
  });

  it('closes admission before awaiting cleanup: no goal is admitted while shutdown is pending (MB-FND-002)', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('first goal', OWNER);
    await until(() => planner.waiting === 1);
    let release: () => void = () => undefined;
    engine.registerCleanup(engine.currentEpoch, () => new Promise<void>((r) => (release = r)));
    const shutdown = engine.shutdown();
    const during = engine.submit('second goal', OWNER);
    release();
    await shutdown;
    const result = await during;
    assert.equal(result.status === 'rejected' && result.reason, 'shutting_down');
    assert.equal(engine.hasActiveGoal, false);
    assert.equal(planner.requests.length, 1);
    assert.equal(engine.status().goal?.instruction, 'first goal');
    assert.equal(engine.status().goal?.terminal?.reason, 'shutdown');
  });

  it('a replacement already waiting on cleanup when shutdown starts is superseded', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('first goal', OWNER);
    await until(() => planner.waiting === 1);
    let release: () => void = () => undefined;
    engine.registerCleanup(engine.currentEpoch, () => new Promise<void>((r) => (release = r)));
    const replacement = engine.submit('replacement goal', OWNER);
    await tick(5);
    const shutdown = engine.shutdown();
    release();
    await shutdown;
    assert.deepEqual(await replacement, { status: 'superseded' });
    assert.equal(engine.hasActiveGoal, false);
    assert.equal(planner.requests.length, 1);
    assert.equal(engine.answer('anything', undefined, 'chat').status, 'rejected');
  });

  it('shutdown cancels active work and refuses further instructions', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('build a bridge', OWNER);
    await until(() => planner.waiting === 1);
    await engine.shutdown();
    assert.equal(engine.status().goal?.terminal?.reason, 'shutdown');
    const after = await engine.submit('anything', OWNER);
    assert.equal(after.status === 'rejected' && after.reason, 'shutting_down');
  });
});

describe('proposal validation and limits', () => {
  const plan = (capabilities: string[], extra: Record<string, unknown> = {}): PlannerProposal =>
    ({
      version: 1,
      disposition: 'plan',
      interpretation: 'gather wood for tools',
      outcome: { kind: 'finite', outcome: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: false } },
      tasks: [
        {
          objective: 'Obtain wood.',
          decisionInstruction: 'Choose a visible log and acquire it.',
          allowedCapabilities: capabilities,
          targetSelectors: [{ kind: 'registry', key: '#minecraft:logs' }],
          parameters: {},
          completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: true },
        },
      ],
      morePlanningNeeded: true,
      ...extra,
    }) as PlannerProposal;

  it('rejects plans that reference unimplemented capabilities with bounded repair turns, then blocks (no action)', async () => {
    const planner = new ScriptedPlanner();
    const { engine, store } = makeEngine({ planner, registry: FACTS });
    await engine.submit('get wood', OWNER);
    for (let turn = 1; turn <= 3; turn += 1) {
      await until(() => planner.waiting === 1);
      if (turn > 1) assert.match(planner.requests.at(-1)?.rejection?.problems.join(' ') ?? '', /not implemented: move_near, mine_block/);
      if (turn > 1) assert.equal(planner.requests.at(-1)?.turnKind, 'repair');
      planner.respond(plan(['move_near', 'mine_block']));
    }
    await until(() => engine.status().goal?.state === 'blocked');
    assert.equal(engine.status().goal?.terminal?.reason, 'capability_not_ready');
    assert.match(engine.status().goal?.terminal?.detail ?? '', /move_near, mine_block/);
    assert.equal(engine.status().goal?.counters?.repairs, 2);
    assert.equal(engine.status().goal?.plannerTurns, 3, 'repair turns count toward the turn limit');
    assert.equal(store.ofType('planner_proposal_rejected').length, 3);
    assert.equal(store.ofType('task_admitted').length, 0);
  });

  it('accepts a valid plan form but reports execution not ready when capabilities exist', async () => {
    const planner = new ScriptedPlanner();
    const capabilities = new StaticCapabilityRegistry({
      catalogVersion: 'test-1',
      capabilities: [
        {
          id: 'mine_block',
          family: 'mining',
          purpose: 'Mine one observed block.',
          parameters: [],
          preconditions: [],
          effects: [],
          supportedPredicates: ['inventory_delta'],
          timeoutMs: 10_000,
          cancellation: 'stops digging',
          limitations: [],
        },
      ],
    });
    const { engine } = makeEngine({ planner, capabilities, registry: FACTS });
    await engine.submit('get wood', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond(plan(['mine_block']));
    await until(() => engine.status().goal?.state === 'blocked');
    assert.match(engine.status().goal?.terminal?.detail ?? '', /plan accepted.*skill execution adapters are not installed/);
    assert.notEqual(engine.status().goal?.state, 'completed');
  });

  it('rejects injected executable fields and schema-invalid proposals before any action; repairs are bounded', async () => {
    const planner = new ScriptedPlanner();
    const { engine, store } = makeEngine({ planner, registry: FACTS });
    await engine.submit('do something clever', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond({ ...plan(['mine_block']), code: 'bot.dig()' });
    await until(() => planner.waiting === 1 && planner.requests.length === 2);
    assert.match(planner.requests[1]?.rejection?.problems.join(' ') ?? '', /forbidden field/);
    planner.respond({ ...plan(['mine_block']), interpretation: 'run this: function go() { bot.dig(block) }' });
    await until(() => planner.waiting === 1 && planner.requests.length === 3);
    assert.match(planner.requests[2]?.rejection?.problems.join(' ') ?? '', /code-bearing/);
    planner.respond({ ...plan(['mine_block']), disposition: 'do_it_anyway' });
    await until(() => engine.status().goal?.state === 'blocked');
    assert.equal(engine.status().goal?.terminal?.reason, 'invalid_proposal');
    assert.deepEqual(store.ofType('planner_proposal_rejected').map((e) => e['kind']), ['forbidden', 'forbidden', 'schema']);
    assert.equal(store.ofType('task_admitted').length, 0);
  });

  it('answers knowledge queries as unavailable and enforces the planner turn limit', async () => {
    const planner = new ScriptedPlanner();
    const knowledge: KnowledgePort = {
      readiness: () => ({ ready: false, detail: 'none' }),
      answer: async (queries) => queries.map((query) => ({ status: 'unavailable' as const, query, detail: 'not installed' })),
    };
    const { engine } = makeEngine({
      planner,
      knowledge,
      limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 2, plannerTimeoutMs: 1_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 200 },
    });
    await engine.submit('craft a pickaxe', OWNER);
    const needInfo: PlannerProposal = { version: 1, disposition: 'needs_information', interpretation: 'need recipe', queries: [{ kind: 'recipe', output: 'minecraft:wooden_pickaxe' }] };
    await until(() => planner.waiting === 1);
    planner.respond(needInfo);
    await until(() => planner.requests.length === 2);
    assert.equal(planner.requests[1]?.knowledge[0]?.status, 'unavailable');
    planner.respond(needInfo);
    await until(() => engine.status().goal?.state === 'blocked');
    assert.equal(engine.status().goal?.terminal?.reason, 'limit_exhausted');
  });

  it('fails a planner turn that exceeds its timeout', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({
      planner,
      limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 30, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 200 },
    });
    await engine.submit('anything', OWNER);
    await until(() => engine.status().goal?.state === 'failed');
    assert.equal(engine.status().goal?.terminal?.reason, 'planner_error');
  });

  it('reports cannot_execute with the exact missing prerequisite', async () => {
    const planner = new ScriptedPlanner();
    const { engine } = makeEngine({ planner });
    await engine.submit('fly to the moon', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond({ version: 1, disposition: 'cannot_execute', interpretation: 'travel to the moon', missing: 'Minecraft has no moon dimension to travel to', missingCapabilities: [], verifiedProgress: '' });
    await until(() => engine.status().goal?.state === 'blocked');
    assert.equal(engine.status().goal?.terminal?.reason, 'cannot_execute');
    assert.match(engine.status().goal?.terminal?.detail ?? '', /no moon dimension/);
  });
});
