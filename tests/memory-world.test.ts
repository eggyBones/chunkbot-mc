// MB-MEM-001 recorder over the REAL perception/ledger/server-evidence adapters
// (installedMemoryWorld): only line-of-sight observations are remembered (no
// hidden resources), a destroyed workstation is revised only from a
// server-stated, directly observable voxel (never from a client prediction),
// and server-confirmed ledger effects become verified facts/checkpoints.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { sequentialIds, type ObservationSnapshot } from '../src/contracts/index.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { installedMemoryWorld } from '../src/memory/world.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { Clock, OVERWORLD, cleanupRoots, harness, outcome } from './memory-helpers.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3 } from './skill-fakes.ts';

after(cleanupRoots);

const stateOf = (name: string) => REGISTRY_26_1_2.blocksByName[name]?.defaultState as number;

function scene() {
  const clock = new Clock();
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { loaded: 16 });
  fake.fill(-10, -1, -10, 10, -1, 10, 'grass_block');
  fake.setBlock(3, 0, 0, 'crafting_table');
  fake.setBlock(-3, 0, 2, 'oak_log');
  // Diamond ore hidden behind a wall.
  fake.fill(-5, 0, 5, 5, 3, 5, 'stone_bricks');
  fake.setBlock(0, 0, 7, 'diamond_ore');
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const perception = new PerceptionService({ session: () => session, clock, ids: sequentialIds(), observationRadius: 16, travelRadius: 64, rays: 3000 });
  const ledger = new EvidenceLedger(clock, () => 1);
  const h = harness({ clock });
  h.memory.attachWorld(installedMemoryWorld({ session: () => session, perception, ledger, clock }));
  const serverSays = (x: number, y: number, z: number, name: string) => {
    fake.setBlock(x, y, z, name);
    client.emit('block_change', { location: vec3(x, y, z), type: stateOf(name) });
  };
  return { h, fake, perception, ledger, session, evidence, serverSays, clock };
}

describe('memory recorder over installed perception', () => {
  it('remembers visible workstations/resources only (never hidden ore) and revises a destroyed workstation only from server-stated observation', async () => {
    const s = scene();
    s.perception.take(1) as ObservationSnapshot;
    s.h.memory.ingestObservation();
    const facts = s.h.memory.facts();
    const table = facts.find((f) => f.key === 'minecraft:crafting_table');
    assert.equal(table?.source, 'observation');
    assert.deepEqual(table?.location, { dimension: OVERWORLD, at: { x: 3, y: 0, z: 0 } });
    assert.ok(facts.some((f) => f.key === 'minecraft:oak_log' && f.category === 'resource'));
    assert.equal(facts.some((f) => f.key === 'minecraft:diamond_ore'), false, 'hidden ore is never remembered');

    // Client-side prediction only (no server statement): memory is not revised.
    s.evidence.notePrediction(3, 0, 0);
    s.fake.setBlock(3, 0, 0, 'air');
    s.clock.advance(1_000);
    s.perception.take(1);
    s.h.memory.ingestObservation();
    assert.equal(s.h.memory.facts().find((f) => f.key === 'minecraft:crafting_table')?.status, 'active');

    // The server states the table is gone: directly observable empty voxel -> invalid.
    s.serverSays(3, 0, 0, 'air');
    s.clock.advance(1_000);
    s.perception.take(1);
    s.h.memory.ingestObservation();
    const after = s.h.memory.facts().find((f) => f.key === 'minecraft:crafting_table');
    assert.equal(after?.status, 'invalid');
    assert.match(after?.statusDetail ?? '', /observed air/);
    await s.h.memory.close();
  });

  it('server-confirmed ledger entries of an action become verified facts; client-only arrival records nothing durable', async () => {
    const s = scene();
    s.h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'set up a furnace here' });
    const before = s.h.memory.facts().length;
    s.h.memory.recordOutcome(outcome({ capability: 'move_near', goalId: 'goal-0001', confirmation: 'client_only' }));
    assert.equal(s.h.memory.facts().filter((f) => f.source === 'verified_skill').length, 0);
    s.ledger.add({ kind: 'block_changed', x: 1, y: 0, z: -2, from: 'minecraft:air', to: 'minecraft:furnace', atMs: s.clock.now(), actionId: 'act-0aaa' });
    s.ledger.setResult('act-0aaa', { dimension: OVERWORLD, x: 1, y: 0, z: -2, key: 'minecraft:furnace' });
    s.h.memory.recordOutcome({ ...outcome({ capability: 'place_block', goalId: 'goal-0001' }), actionId: 'act-0aaa' });
    const furnace = s.h.memory.facts().find((f) => f.key === 'minecraft:furnace');
    assert.equal(furnace?.source, 'verified_skill');
    assert.equal(furnace?.evidence.at(-1)?.confirmation, 'server_packet');
    assert.equal(s.h.memory.facts().find((f) => f.category === 'project')?.project?.checkpoints.length, 1);
    assert.ok(s.h.memory.facts().length > before);
    await s.h.memory.close();
  });

  it('death context comes from the live position and the best available inventory evidence, labeled by source and age', async () => {
    const s = scene();
    s.fake.give(36, 'iron_pickaxe', 1);
    s.perception.take(1);
    s.clock.advance(30_000);
    const ctx = installedMemoryWorld({ session: () => s.session, perception: s.perception, ledger: s.ledger, clock: s.clock }).deathContext();
    assert.equal(ctx.accuracy, 'client_position_at_death_event');
    assert.equal(ctx.inventory.source, 'client_model', 'no server-confirmed inventory was available, so the client view is labeled as such');
    assert.deepEqual(ctx.inventory.items, [{ key: 'minecraft:iron_pickaxe', count: 1 }]);
    const fact = s.h.memory.captureDeath(ctx);
    assert.equal(fact?.death?.lastAliveInventory.ageMsAtDeath, 30_000);
    await s.h.memory.close();
  });
});
