import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CapabilityDescriptorSchema,
  GoalRecordSchema,
  KnowledgeQuerySchema,
  ObservationSnapshotSchema,
  PlannerProposalSchema,
  TargetSelectorSchema,
  TaskSpecSchema,
} from '../src/contracts/index.ts';

const step = {
  objective: 'Obtain enough wood for the currently planned tool prerequisites.',
  decisionInstruction: 'Choose an admitted visible log or dropped log and acquire it.',
  allowedCapabilities: ['move_near', 'mine_block', 'pickup_item'],
  targetSelectors: [{ kind: 'registry', key: '#minecraft:logs' }],
  completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3 },
};

describe('shared contracts', () => {
  it('accepts a generic task step with no task-type enum', () => {
    const parsed = TaskSpecSchema.parse(step);
    assert.deepEqual(parsed.allowedCapabilities, ['move_near', 'mine_block', 'pickup_item']);
    assert.ok(!('type' in parsed) && !('intent' in parsed));
    assert.throws(() => TaskSpecSchema.parse({ ...step, type: 'collect_logs' }));
    assert.throws(() => TaskSpecSchema.parse({ ...step, code: 'bot.dig(block)' }));
  });

  it('bounds planner windows to the architecture limit', () => {
    const plan = (n: number) => ({
      version: 1,
      disposition: 'plan',
      interpretation: 'x',
      outcome: { kind: 'persistent', maintain: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } },
      tasks: Array.from({ length: n }, () => step),
      morePlanningNeeded: false,
    });
    assert.equal(PlannerProposalSchema.safeParse(plan(8)).success, true);
    assert.equal(PlannerProposalSchema.safeParse(plan(9)).success, false);
    assert.equal(PlannerProposalSchema.safeParse({ ...plan(1), disposition: 'do_it_anyway' }).success, false);
  });

  it('cannot invent entity IDs or hidden coordinates in selectors', () => {
    assert.equal(TargetSelectorSchema.safeParse({ kind: 'entity_id', id: 42 }).success, false);
    assert.equal(TargetSelectorSchema.safeParse({ kind: 'owner_destination', dimension: 'overworld', at: { x: 1, y: 2, z: 3 } }).success, false);
    assert.equal(
      TargetSelectorSchema.safeParse({ kind: 'owner_destination', dimension: 'overworld', at: { x: 1, y: 2, z: 3 }, ownerText: 'meet me at 1 2 3' }).success,
      true,
    );
  });

  it('keeps goals as free text with code-owned state', () => {
    const goal = GoalRecordSchema.parse({
      id: 'goal-0001',
      epoch: 1,
      instruction: 'anything at all, phrased however the owner likes',
      origin: { surface: 'chat', principal: 'owner' },
      state: 'planning',
      admittedAtMs: 0,
      updatedAtMs: 0,
      plannerTurns: 0,
    });
    assert.equal(goal.progress, '');
    assert.throws(() => GoalRecordSchema.parse({ ...goal, id: 'model-made-id' }));
  });

  it('validates knowledge queries and capability descriptors', () => {
    assert.equal(KnowledgeQuerySchema.safeParse({ kind: 'recipe', output: 'minecraft:iron_chestplate' }).success, true);
    assert.equal(KnowledgeQuerySchema.safeParse({ kind: 'recipe', output: 'iron chestplate' }).success, false);
    assert.equal(
      CapabilityDescriptorSchema.safeParse({
        id: 'Move Near',
        family: 'movement',
        purpose: 'x',
        parameters: [],
        preconditions: [],
        effects: [],
        supportedPredicates: [],
        timeoutMs: 1,
        cancellation: 'x',
        limitations: [],
      }).success,
      false,
    );
  });

  it('rejects hidden-world fields in observation snapshots', () => {
    const snapshot = {
      id: 'snap-0001',
      connectionEpoch: 1,
      goalEpoch: 1,
      takenAtMs: 0,
      dimension: 'overworld',
      self: { at: { x: 0, y: 0, z: 0 }, health: 20, food: 20 },
      inventory: [],
      equipment: {},
      owner: { visible: false },
      entities: [],
      blocks: [],
      drops: [],
      remembered: [],
    };
    assert.equal(ObservationSnapshotSchema.safeParse(snapshot).success, true);
    assert.equal(ObservationSnapshotSchema.safeParse({ ...snapshot, seed: '12345' }).success, false);
    assert.equal(ObservationSnapshotSchema.safeParse({ ...snapshot, allPlayers: [] }).success, false);
  });

  it('keeps Minecraft library objects out of contracts, goals, commands, and telemetry', () => {
    for (const dir of ['src/contracts', 'src/goals', 'src/commands', 'src/telemetry']) {
      for (const file of readdirSync(dir)) {
        const text = readFileSync(join(dir, file), 'utf8');
        assert.doesNotMatch(text, /from ['"](mineflayer|minecraft-protocol|prismarine-[a-z-]+|minecraft-data)['"]/, `${dir}/${file}`);
      }
    }
  });
});
