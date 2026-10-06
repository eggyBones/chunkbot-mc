// Maintained regressions for MB-SKL-010: placement against ordinary and
// interactive supports, an occupied destination, an unexpected interface, and
// stop during the attempt. Runs the REAL place_block definition, executor,
// actuator lease and interface gate against a fake server that applies the
// vanilla rule: using an interactive block opens it unless the player sneaks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type ActionCandidate, type ObservationSnapshot } from '../src/contracts/index.ts';
import { SkillExecutorImpl, clearSharedControls } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import type { SkillServices } from '../src/skills/definition.ts';
import { placeBlock } from '../src/skills/placement.ts';
import { taskHints } from '../src/execution/candidates.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3, type FakeClient } from './skill-fakes.ts';

// Protocol face order (down, up, north, south, west, east).
const NORMALS = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
] as const;
const INTERACTIVE = new Set(['furnace', 'chest', 'crafting_table']);

interface ServerOptions {
  /** Simulates a server that does not see the shift input (to prove the unexpected-interface path). */
  ignoreSneak?: boolean;
  /** Delay before the server answers a use packet. */
  replyDelayMs?: number;
}

function placementScene(server: ServerOptions = {}) {
  let sneaking = false;
  const inputs: boolean[] = [];
  const client: FakeClient = fakeClient((name, data) => {
    if (name === 'player_input') {
      sneaking = Boolean((data['inputs'] as { shift?: boolean }).shift);
      inputs.push(sneaking);
    }
    if (name === 'window_click' && data['stateId'] === -1) {
      setImmediate(() => client.emit('window_items', { windowId: Number(data['windowId']), stateId: 5, items: slotsAsNotch() }));
    }
    if (name === 'block_dig' && typeof data['sequence'] === 'number') {
      const sequenceId = data['sequence'];
      setImmediate(() => client.emit('acknowledge_player_digging', { sequenceId }));
    }
    if (name === 'block_place') {
      const loc = data['location'] as { x: number; y: number; z: number };
      const n = NORMALS[Number(data['direction'])] as readonly [number, number, number];
      const sequenceId = data['sequence'];
      const support = fake.bot.blockAt(loc)?.name ?? 'air';
      const shiftSeen = sneaking && !server.ignoreSneak;
      setTimeout(() => {
        if (INTERACTIVE.has(support) && !shiftSeen) {
          client.emit('open_window', { windowId: 3, inventoryType: 14 });
          (fake.bot as { currentWindow: unknown }).currentWindow = { id: 3, type: 'minecraft:furnace' };
        } else {
          const held = fake.bot.inventory.slots[36 + fake.bot.quickBarSlot];
          const dest = { x: loc.x + n[0], y: loc.y + n[1], z: loc.z + n[2] };
          if (held && REGISTRY_26_1_2.blocksByName[held.name]) {
            fake.setBlock(dest.x, dest.y, dest.z, held.name);
            held.count -= 1;
            if (held.count === 0) fake.bot.inventory.slots[36 + fake.bot.quickBarSlot] = null;
            client.emit('block_change', { location: dest, type: REGISTRY_26_1_2.blocksByName[held.name]?.defaultState });
          }
        }
        client.emit('acknowledge_player_digging', { sequenceId });
      }, server.replyDelayMs ?? 0);
    }
  });
  const fake = fakeMineflayerBot(client);
  const slotsAsNotch = () =>
    Array.from({ length: 46 }, (_, i) => {
      const s = fake.bot.inventory.slots[i];
      return s ? { itemCount: s.count, itemId: REGISTRY_26_1_2.itemsByName[s.name]?.id } : { itemCount: 0 };
    });
  const controls: Record<string, boolean> = {};
  Object.assign(fake.bot, {
    lookAt: () => Promise.resolve(),
    setQuickBarSlot: (i: number) => {
      fake.bot.quickBarSlot = i;
    },
    setControlState: (c: string, on: boolean) => {
      if (controls[c] === on) return;
      controls[c] = on;
      // 26.1.x: sneak travels in player_input (Mineflayer newPlayerInputPacket).
      if (c === 'sneak') client.write('player_input', { inputs: { shift: on } });
    },
    clearControlStates: () => {
      for (const c of Object.keys(controls)) (fake.bot as unknown as { setControlState(c: string, on: boolean): void }).setControlState(c, false);
    },
    closeWindow: (w: { id: number }) => {
      client.write('close_window', { windowId: w.id });
      (fake.bot as { currentWindow: unknown }).currentWindow = null;
    },
  });
  fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const ids = sequentialIds();
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids, observationRadius: 12, travelRadius: 64 });
  const services: SkillServices = {
    perception,
    knowledge: new VersionKnowledge({ version: '26.1.2' }),
    ledger: new EvidenceLedger(systemClock, () => 1),
    clock: systemClock,
    limits: { observationRadius: 12, travelRadius: 64, ownerLossMs: 1_000 },
  };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => clearSharedControls(fake.bot as never) });
  const executor = new SkillExecutorImpl({ registry: new SkillRegistry([placeBlock]), leases, session: () => session, services, goalEpoch: () => 1, store: new MemoryRunStore(), settleMs: 20 });
  const run = (parameters: Record<string, unknown>, signal = new AbortController().signal) =>
    executor.execute({ id: 'act-0001', capability: 'place_block', parameters, snapshotId: 'snap-0001', connectionEpoch: 1, goalEpoch: 1, description: 'p', criteria: [], preconditions: [], timeoutMs: 15_000 } as ActionCandidate, signal, { kind: 'diagnostic', diagnosticId: 'diag-1' });
  return { fake, client, session, perception, services, leases, run, inputs };
}

function handleAt(snap: ObservationSnapshot, x: number, y: number, z: number): { snapshotId: string; handle: string } {
  const b = snap.blocks.find((t) => t.at.x === x && t.at.y === y && t.at.z === z);
  assert.ok(b, `block at ${x},${y},${z} visible`);
  return { snapshotId: snap.id, handle: b.handle };
}

describe('MB-SKL-010 placement against visible faces', () => {
  it('ordinary support: no sneak; server block change and item use confirm the placement', async () => {
    const s = placementScene();
    s.fake.setBlock(0, 0, 2, 'stone');
    s.fake.give(36, 'cobblestone', 4);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const o = await s.run({ item: 'minecraft:cobblestone', against: handleAt(snap, 0, 0, 2), face: 'up' });
    assert.equal(o.status, 'succeeded', o.effect);
    assert.equal(o.confirmation, 'server_packet');
    assert.deepEqual(o.evidence['at'], { x: 0, y: 1, z: 2 });
    assert.equal(o.evidence['itemUsed'], 1, 'server-synced inventory shows one item used');
    assert.equal(s.inputs.length, 0, 'no sneak against an ordinary block');
  });

  it('interactive support: holds sneak (player_input shift) across the server answer, then releases it', async () => {
    const s = placementScene({ replyDelayMs: 30 });
    s.fake.setBlock(0, 0, 2, 'furnace');
    s.fake.give(36, 'cobblestone', 4);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const o = await s.run({ item: 'minecraft:cobblestone', against: handleAt(snap, 0, 0, 2), face: 'up' });
    assert.equal(o.status, 'succeeded', o.effect);
    assert.deepEqual(s.inputs, [true, false], 'shift pressed before the use and released after the reply');
    const order = s.client.written.map((w) => (w.name === 'player_input' ? `shift=${String((w.data['inputs'] as { shift: boolean }).shift)}` : w.name)).filter((n) => /shift|block_place/.test(n));
    assert.deepEqual(order, ['shift=true', 'block_place', 'shift=false']);
    assert.equal(s.fake.bot.currentWindow, null, 'the furnace was not opened');
  });

  it('an interface opened instead of placing is attributed, closed and reported (not a success)', async () => {
    const s = placementScene({ ignoreSneak: true });
    s.fake.setBlock(0, 0, 2, 'furnace');
    s.fake.give(36, 'cobblestone', 4);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const o = await s.run({ item: 'minecraft:cobblestone', against: handleAt(snap, 0, 0, 2), face: 'up' });
    assert.equal(o.status, 'failed');
    assert.equal(o.reason, 'opened_interface_instead');
    assert.equal(s.fake.bot.currentWindow, null);
    assert.equal(s.client.written.filter((w) => w.name === 'close_window' && w.data['windowId'] === 3).length >= 1, true);
  });

  it('a destination occupied by another entity is refused before any packet, and generated candidates exclude it', async () => {
    const s = placementScene();
    s.fake.setBlock(0, 0, 2, 'stone');
    s.fake.give(36, 'cobblestone', 4);
    s.fake.addEntity({ id: 9, type: 'player', name: 'player', username: 'Owner', uuid: 'u', at: { x: 0.7, y: 1, z: 2.9 }, height: 1.8 }); // box overlaps voxel (0,1,2)
    const snap = s.perception.take(1) as ObservationSnapshot;
    const o = await s.run({ item: 'minecraft:cobblestone', against: handleAt(snap, 0, 0, 2), face: 'up' });
    assert.equal(o.status, 'precondition_failed');
    assert.equal(o.reason, 'destination_occupied_by_entity');
    assert.equal(s.client.written.filter((w) => w.name === 'block_place').length, 0);
    const t = { objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['place_block'], targetSelectors: [], parameters: { item: 'minecraft:cobblestone' }, completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:cobblestone' }, expect: 'minecraft:cobblestone' } } as const;
    const drafts = placeBlock.resolve({ task: t as never, hints: taskHints(t as never), snapshot: snap, session: s.session, services: s.services }).drafts;
    const stoneHandle = handleAt(snap, 0, 0, 2).handle;
    assert.ok(drafts.length > 0, 'other free faces remain');
    assert.equal(drafts.some((d) => (d.parameters['against'] as { handle: string }).handle === stoneHandle && d.parameters['face'] === 'up'), false, 'the occupied destination is not offered');
  });

  it('a named support reports why each face is excluded (out of reach; occupied by a player)', () => {
    const t = (snap: ObservationSnapshot, handle: string) =>
      ({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['place_block'], targetSelectors: [{ kind: 'observed', snapshotId: snap.id, handle }], parameters: { item: 'minecraft:cobblestone' }, completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:cobblestone' }, expect: 'minecraft:cobblestone' } }) as never;
    // Far: the live PL1 geometry (eye 4.3 from the furnace centre, reach limit 4.2).
    const far = placementScene();
    far.fake.setBlock(0, 0, 0, 'furnace');
    far.fake.give(36, 'cobblestone', 2);
    far.fake.bot.entity.position = vec3(4.7, 0, 0.5);
    let snap = far.perception.take(1) as ObservationSnapshot;
    let handle = handleAt(snap, 0, 0, 0).handle;
    let r = placeBlock.resolve({ task: t(snap, handle), hints: taskHints(t(snap, handle)), snapshot: snap, session: far.session, services: far.services });
    assert.equal(r.drafts.length, 0);
    assert.match(JSON.stringify(r.unavailable?.[0]?.evidence), /out_of_reach \(4\.3 > 4\.2\)/);
    // Near, with a player standing on the top destination: up excluded with its reason, east offered.
    const near = placementScene();
    near.fake.setBlock(0, 0, 0, 'furnace');
    near.fake.give(36, 'cobblestone', 2);
    near.fake.bot.entity.position = vec3(3.5, 0, 0.5);
    near.fake.addEntity({ id: 9, type: 'player', name: 'player', username: 'Owner', uuid: 'u', at: { x: 0.5, y: 1, z: 0.5 }, height: 1.8 });
    snap = near.perception.take(1) as ObservationSnapshot;
    handle = handleAt(snap, 0, 0, 0).handle;
    r = placeBlock.resolve({ task: t(snap, handle), hints: taskHints(t(snap, handle)), snapshot: snap, session: near.session, services: near.services });
    assert.deepEqual(r.drafts.map((d) => d.parameters['face']), ['east']);
  });

  it('stop during the sneak/reply window: cancelled, no later packets, shift released by shared cleanup, interface not left open', async () => {
    const s = placementScene({ replyDelayMs: 200 });
    s.fake.setBlock(0, 0, 2, 'furnace');
    s.fake.give(36, 'cobblestone', 4);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const abort = new AbortController();
    const done = s.run({ item: 'minecraft:cobblestone', against: handleAt(snap, 0, 0, 2), face: 'up' }, abort.signal);
    await new Promise((r) => setTimeout(r, 160)); // after shift + block_place, before the server reply
    abort.abort();
    const o = await done;
    assert.equal(o.status, 'cancelled');
    assert.equal(o.evidence['commandsAfterRevoke'], 0);
    assert.equal(s.inputs.at(-1), false, 'shift released');
    assert.ok(((o.evidence['cleanup'] as { clearMs: number }).clearMs) <= 250);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(s.fake.bot.currentWindow, null);
  });
});
