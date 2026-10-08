// Metadata is copied from the filtered snapshot, at every context size. It
// describes observation scope/freshness; it supplies no target or authority.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObservationSnapshotSchema, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import { buildState, snapshotSummary } from '../src/decision/context.ts';
import { renderObservation } from '../src/planner/prompt.ts';

const snapshot: ObservationSnapshot = ObservationSnapshotSchema.parse({
  id: 'snap-0111', connectionEpoch: 17, goalEpoch: 43, takenAtMs: 1_791_480_123_457,
  dimension: 'overworld', self: { at: { x: 0, y: -60, z: 0 }, health: 20, food: 20 },
  inventory: Array.from({ length: 30 }, (_, i) => ({ key: `minecraft:item_${i}`, count: i + 1 })),
  equipment: {}, owner: { visible: false },
  entities: Array.from({ length: 10 }, (_, i) => ({ handle: `ent-${i}`, key: 'minecraft:cow', at: { x: i, y: -60, z: 0 }, distance: i })),
  blocks: Array.from({ length: 100 }, (_, i) => ({ handle: `blk-${i}`, key: 'minecraft:stone', at: { x: i, y: -61, z: 0 }, distance: i })),
  drops: [], frontiers: [], blockSummary: [],
  remembered: [{ anchorId: 'anchor-old', label: 'old visible site', dimension: 'overworld', at: { x: 9, y: -60, z: 9 }, observedAtMs: 123, source: 'observed' }],
});
const spec: TaskSpec = { objective: 'Inspect visible surroundings.', decisionInstruction: 'Choose an offered action.', allowedCapabilities: ['look'], targetSelectors: [], parameters: {}, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } };
const metadata = (o: Record<string, unknown>) => ({ snapshotId: o['snapshotId'], takenAtMs: o['takenAtMs'], connectionEpoch: o['connectionEpoch'], goalEpoch: o['goalEpoch'] });
const expected = { snapshotId: snapshot.id, takenAtMs: snapshot.takenAtMs, connectionEpoch: snapshot.connectionEpoch, goalEpoch: snapshot.goalEpoch };

describe('filtered observation metadata', () => {
  for (const level of [0, 1, 2] as const) {
    it(`survives decision context trimming level ${level} without substituting historical time or exposing hidden owner positions`, () => {
      const summary = snapshotSummary(snapshot, level) as Record<string, unknown>;
      const state = buildState({ spec, mode: 'complete', snapshot, catalogVersion: 'test', mechanicsVersion: '26.2', completion: null, recentOutcomes: [], unavailable: [], remaining: { decisions: 7, spendUsd: null }, round: 2 }, level) as Record<string, unknown>;
      assert.deepEqual(metadata(summary), expected);
      assert.deepEqual(metadata(state['observation'] as Record<string, unknown>), expected);
      assert.equal((summary['inventory'] as unknown[]).length, [24, 12, 6][level]);
      assert.equal((summary['entities'] as unknown[]).length, [8, 4, 2][level]);
      assert.deepEqual(summary['owner'], { visible: false });
      assert.ok(!('blocks' in summary) && !('groups' in summary), 'metadata adds no spatial payload to the decision summary');
      assert.notDeepEqual(metadata(summary), { ...expected, takenAtMs: 123 }, 'remembered evidence cannot supply current time');
      assert.notDeepEqual(metadata(summary), { ...expected, goalEpoch: 42 }, 'a different goal epoch must not compare equal');
    });
  }

  it('preserves exact metadata for every planner block-trimming level and keeps missing observations unavailable', () => {
    for (const maxBlocks of [96, 48, 24, 12, 6, 3]) {
      const observation = renderObservation(snapshot, maxBlocks) as Record<string, unknown>;
      assert.deepEqual(metadata(observation), expected);
      assert.equal((observation['blocks'] as unknown[]).length, maxBlocks);
      assert.deepEqual(observation['owner'], { visible: false });
      assert.equal((observation['remembered'] as Array<Record<string, unknown>>)[0]!['source'], 'observed');
      assert.notDeepEqual(metadata(observation), { ...expected, connectionEpoch: 16 });
    }
    assert.deepEqual(renderObservation(null), { available: false, detail: 'no current observation (not connected or perception unavailable)' });
  });
});
