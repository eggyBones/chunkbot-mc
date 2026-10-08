// MB-FLOW-003 integration helpers: allowance candidate filter, canonical
// support GoalSource shape, code-task TaskSpec composition, disabled/no-scope
// composition and the exact-version item registry.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ActionCandidate } from '../src/contracts/action.ts';
import { TaskSpecSchema } from '../src/contracts/task.ts';
import { minecraftDataRegistry } from '../src/survival/registry.ts';
import { allowedUnderAllowance, createSurvivalService, librarySeed, supportGoalSource, supportTaskSpec } from '../src/survival/wiring.ts';
import { assessInput, cleanupRoots, harness, slot, tempRoot } from './survival-helpers.ts';

after(cleanupRoots);

const cand = (capability: string, parameters: Record<string, unknown>) => ({ id: `act-${capability}`, capability, parameters }) as unknown as ActionCandidate;

describe('survival wiring', () => {
  it('filters candidates to allowed capabilities and items only', () => {
    const allowed = { allowed: true as const, allowanceId: 'lha-1', capabilities: ['eat_safe_food'], items: ['minecraft:bread'], detail: '' };
    const out = allowedUnderAllowance([cand('eat_safe_food', { item: 'minecraft:bread' }), cand('eat_safe_food', { item: 'minecraft:golden_apple' }), cand('mine_block', {})], allowed);
    assert.deepEqual(out.map((c) => `${c.capability}:${String((c.parameters as Record<string, unknown>)['item'])}`), ['eat_safe_food:minecraft:bread']);
    assert.deepEqual(allowedUnderAllowance([cand('eat_safe_food', { item: 'minecraft:bread' })], { allowed: false, reason: 'x', detail: '' }), []);
  });

  it('builds the canonical support GoalSource and a valid code-task TaskSpec', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(20, 10);
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'propose');
    const p = (d as { proposal: Parameters<typeof supportGoalSource>[0] }).proposal;
    const src = supportGoalSource(p, 1);
    assert.equal(src.kind, 'support');
    assert.match(src.routine, /^[a-z][a-z0-9_]{1,47}$/);
    const t = supportTaskSpec(p);
    assert.ok(t);
    // Everything but the (writer-added) survival_state completion already parses as a TaskSpec.
    assert.ok(TaskSpecSchema.safeParse({ ...t.spec, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' } }).success);
  });

  it('composition: absent/disabled config is off; missing scope keeps recovery blocked', () => {
    const base = { minecraftVersion: '26.1.2', limits: { lowHealth: 8, travelRadius: 128 }, now: () => 1 };
    assert.equal(createSurvivalService({ ...base, survival: undefined, scope: undefined, dataDir: undefined }), undefined);
    assert.equal(createSurvivalService({ ...base, survival: { enabled: false }, scope: undefined, dataDir: undefined }), undefined);
    const unscoped = createSurvivalService({ ...base, survival: {}, scope: undefined, dataDir: tempRoot() });
    assert.equal(unscoped?.status(1).store.state, 'unscoped');
    const scoped = createSurvivalService({ ...base, survival: {}, scope: { worldProfile: 'w', worldRevision: 1, botProfile: 'b' }, dataDir: tempRoot() });
    assert.equal(scoped?.status(1).store.state, 'empty');
    void scoped?.close();
  });

  it('C12: createSurvivalService passes the application sessionId through (own-session checkpoint records keep their state)', async () => {
    const base = { minecraftVersion: '26.1.2', limits: { lowHealth: 8, travelRadius: 128 }, now: () => 1_000 };
    const dataDir = tempRoot();
    const scope = { worldProfile: 'w', worldRevision: 1, botProfile: 'b' };
    const s = createSurvivalService({ ...base, survival: {}, scope, dataDir, sessionId: 'run-s1' });
    assert.ok(s);
    const counters = { plannerTurns: 1, knowledgeRounds: 0, repairs: 0, retries: 0, clarifications: 0, replans: 0, windows: 1, tasksAdmitted: 1, preparationTurns: 0, lookaheads: 0 };
    s.persistCheckpoint({ version: 1, goalId: 'goal-wire1', sessionId: 'run-s1', connectionEpoch: 1, dimension: 'overworld', instruction: 'x', publicOutcome: 'x', outcome: { kind: 'persistent', maintain: { predicate: 'near_target', target: { kind: 'owner' }, within: 4 } }, outcomeCanonical: 'x', admissionBaseline: { capturedAtMs: 1, counts: null, detail: 'x' }, anchor: null, counters: counters as never, caps: { plannerTurns: 20, tasks: 64, replans: 8 }, admittedTasks: 1, deadlineAtMs: 5_000, grounding: [], counts: [], removal: [], route: null, verifiedEffects: [], continuations: { used: 0, max: 2 }, interruptions: [{ reason: 'death', atMs: 1, epoch: 1 }], state: 'held', stateReason: 'waiting:recovery_open', stateAtMs: 1 });
    assert.equal(s.status(2).checkpoints?.[0]?.state, 'held');
    await s.close();
  });

  it('library seed is labeled with unknown metadata', () => {
    const seed = librarySeed({ inventory: { slots: [null, { name: 'bread', count: 2 }] }, quickBarSlot: 1, health: 20, food: 18 });
    assert.deepEqual(seed.stacks, [{ slot: 1, key: 'minecraft:bread', count: 2, meta: { metadata: 'unknown' } }]);
  });

  it('item facts come from the exact configured version', () => {
    const a = minecraftDataRegistry('26.1.2');
    const b = minecraftDataRegistry('26.2');
    assert.equal(a?.maxDurability('minecraft:iron_pickaxe'), 250);
    assert.equal(b?.food('minecraft:bread')?.foodPoints, 5);
    assert.equal(a?.food('minecraft:iron_pickaxe'), undefined);
  });
});
