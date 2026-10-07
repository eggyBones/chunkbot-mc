// MB-FLOW-003 contract: config defaults are bounded and hysteretic, the
// attempt ceiling cannot be raised by config, durable episode schemas are
// strict (no executable leftovers), and the survival predicate composes with
// the existing bounded predicate vocabulary shape.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GATED_LATER_SLICES,
  RecoveryEpisodeSchema,
  SURVIVAL_BOUNDS,
  SURVIVAL_ROUTINES,
  SurvivalConfigSchema,
  SurvivalStatePredicateSchema,
  SurvivalStoreBodySchema,
  type RecoveryEpisode,
} from '../src/contracts/survival.ts';

const NOW = 1_700_000_000_000;

export function sampleEpisode(over: Partial<RecoveryEpisode> = {}): RecoveryEpisode {
  return {
    episodeId: 'rep-0001',
    incidentFactId: 'mf-0001',
    originalIncidentFactId: 'mf-0001',
    relatedIncidentFactIds: [],
    openedAtMs: NOW,
    updatedAtMs: NOW,
    occurredAtMs: NOW,
    phase: 'awaiting_respawn',
    status: 'pending',
    site: { source: 'client_position_at_death_event', dimension: 'minecraft:overworld', at: { x: 1, y: 64, z: 2 }, observedAtMs: NOW },
    cause: { kind: 'unknown', hazard: 'unknown' },
    lastAlive: { source: 'server_packets', frozenAt: 'combat_kill_packet', capturedAtMs: NOW, ageMsAtDeath: 5, stacks: [], clearingPacketsAfterFreeze: 0 },
    regained: [],
    attempts: [],
    maxAttempts: 2,
    budget: { plannerTurns: 0, tasks: 0, replans: 0, admissions: 0, activeMs: 0 },
    hazards: [],
    detail: '',
    ...over,
  };
}

describe('survival contract', () => {
  it('config defaults are bounded with hysteresis', () => {
    const c = SurvivalConfigSchema.parse({});
    assert.equal(c.enabled, true);
    assert.ok(c.food.eatUntil > c.food.eatAtOrBelow);
    assert.ok(c.health.restUntil > c.health.restAtOrBelow);
    assert.ok(c.inventory.targetFreeSlots > c.inventory.minFreeSlots);
    assert.equal(c.recovery.maxAttempts, 2);
    assert.ok(c.resupply.reserves.every((r) => r.high > r.low));
  });

  it('recovery attempts cannot exceed the absolute ceiling of two', () => {
    assert.equal(SURVIVAL_BOUNDS.maxAttemptsCeiling, 2);
    assert.throws(() => SurvivalConfigSchema.parse({ recovery: { maxAttempts: 3 } }));
    assert.throws(() => RecoveryEpisodeSchema.parse(sampleEpisode({ maxAttempts: 3 as 2 })));
  });

  it('reserve without hysteresis is rejected', () => {
    assert.throws(() => SurvivalConfigSchema.parse({ resupply: { reserves: [{ key: 'minecraft:bread', low: 4, high: 4 }] } }));
  });

  it('episodes are strict: no executable handles, leases or action replay fields', () => {
    assert.ok(RecoveryEpisodeSchema.safeParse(sampleEpisode()).success);
    const withHandle = { ...sampleEpisode(), snapshotHandle: 'drp-1' };
    assert.equal(RecoveryEpisodeSchema.safeParse(withHandle).success, false);
    const withLease = { ...sampleEpisode(), lease: { id: 'x' } };
    assert.equal(RecoveryEpisodeSchema.safeParse(withLease).success, false);
  });

  it('store body bounds episodes', () => {
    const body = { scope: { worldProfile: 'w', worldRevision: 1, botProfile: 'b' }, createdAtMs: NOW, episodes: Array.from({ length: SURVIVAL_BOUNDS.episodes + 1 }, (_, i) => sampleEpisode({ episodeId: `rep-${String(i).padStart(4, '0')}` })), interrupted: [], nextEpisode: 1, evicted: 0 };
    assert.equal(SurvivalStoreBodySchema.safeParse(body).success, false);
  });

  it('survival_state predicate is a closed schema over routine names', () => {
    assert.ok(SurvivalStatePredicateSchema.safeParse({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }).success);
    assert.equal(SurvivalStatePredicateSchema.safeParse({ predicate: 'survival_state', routine: 'collect_logs', expect: 'concluded' }).success, false);
    assert.equal(SurvivalStatePredicateSchema.safeParse({ predicate: 'survival_state', routine: 'eat', expect: 'concluded', extra: 1 }).success, false);
  });

  it('routines are scheduling policies; gated slices are not routines', () => {
    for (const g of GATED_LATER_SLICES) assert.equal((SURVIVAL_ROUTINES as readonly string[]).includes(g), false);
  });
});
