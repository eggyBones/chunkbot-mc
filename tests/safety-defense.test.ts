// MB-FLOW-003-C13 (offline, module level): the tracker's self-id filtering and
// the REAL defend/retreat-planning path through the real lease/actuator over a
// Mineflayer-shaped bot (installed 26.1.2 registry), with a scripted server
// that answers each `attack` packet with a damage_event and finally the death
// status. Defeat is claimed ONLY from the server death status; a target that
// leaves sight is not a defeat; players are never attacked; readiness is
// rechecked before every attack. Module evidence, not fixture acceptance.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SafetyTracker, parseSafetySlot } from '../src/safety/tracker.ts';
import { registryFactsOf } from '../src/safety/adapter.ts';
import { ownerAuthority, runtime, scene, stopPhysics, until } from './safety-session.ts';
import { REGISTRY_26_1_2 } from './skill-fakes.ts';
import { EventEmitter } from 'node:events';

after(stopPhysics);

const reg = registryFactsOf(REGISTRY_26_1_2);
const id = (name: string) => (REGISTRY_26_1_2.itemsByName[name] as { id: number }).id;
const slot = (name: string, damage = 0) => ({ itemCount: 1, itemId: id(name), components: damage ? [{ type: 'damage', data: damage }] : [] });

describe('safety tracker (server statements, self-id filtered)', () => {
  it('own air only from metadata addressed to the bot; other entities never change it', () => {
    const src = new EventEmitter();
    const t = new SafetyTracker();
    t.attach(src, { connectionEpoch: 1, registry: () => reg, now: () => 5 });
    src.emit('login', { entityId: 7 });
    src.emit('entity_metadata', { entityId: 99, metadata: [{ key: 1, type: 'varint', value: 12 }] });
    assert.equal(t.air, null, 'a drowning mob does not set the bot air (installed Mineflayer would)');
    assert.equal(t.counts.otherEntityAirIgnored, 1);
    src.emit('entity_metadata', { entityId: 7, metadata: [{ key: 1, type: 'varint', value: 280 }] });
    src.emit('entity_metadata', { entityId: 7, metadata: [{ key: 1, type: 'varint', value: 260 }] });
    const air = t.air as { value: number; previous: number | null } | null;
    assert.deepEqual([air?.value, air?.previous], [260, 280]);
    src.emit('respawn', {});
    assert.equal(t.air, null, 'new life: unknown again');
  });

  it('equipment durability from the server component patch; damage events attribute the cause', () => {
    const src = new EventEmitter();
    const t = new SafetyTracker();
    t.attach(src, { connectionEpoch: 1, registry: () => reg, now: () => 5 });
    src.emit('login', { entityId: 7 });
    assert.equal(t.item(36), null, 'nothing before a full sync');
    const items = new Array(46).fill(null);
    items[36] = slot('iron_sword', 50);
    items[6] = slot('iron_chestplate');
    src.emit('window_items', { windowId: 0, stateId: 1, items });
    assert.deepEqual(t.item(36), { key: 'minecraft:iron_sword', slot: 36, maxDurability: 250, remainingUses: 200, metadata: 'server_slot' });
    assert.equal(t.item(6)?.remainingUses, 240, 'no damage patch = damage 0 (server stated the slot)');
    src.emit('set_slot', { windowId: 0, slot: 36, item: { itemCount: 0 } });
    assert.equal(t.item(36), null);
    src.emit('damage_event', { entityId: 8, sourceTypeId: 3, sourceCauseId: 51, sourceDirectId: 51 });
    assert.equal(t.damage.length, 0, 'damage to others ignored');
    src.emit('damage_event', { entityId: 7, sourceTypeId: 3, sourceCauseId: 51, sourceDirectId: 51 });
    assert.equal(t.damage[0]?.causeEntityId, 50);
    assert.equal(parseSafetySlot(slot('dirt'), reg)?.maxDurability, null);
  });
});

function armedScene(opts: { zombieAt?: number; player?: boolean } = {}) {
  const sc = scene({ pool: false });
  sc.fake.give(36, 'iron_sword', 1);
  const rt = runtime(sc.session, ownerAuthority);
  rt.service.attachConnection(sc.client, { connectionEpoch: 1, registry: () => REGISTRY_26_1_2 });
  sc.client.emit('login', { entityId: 1 });
  const items = new Array(46).fill(null);
  items[36] = slot('iron_sword');
  items[5] = slot('iron_helmet');
  items[6] = slot('iron_chestplate');
  sc.client.emit('window_items', { windowId: 0, stateId: 1, items });
  sc.client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
  const z = sc.fake.addEntity({ id: 50, type: opts.player ? 'player' : 'hostile', name: opts.player ? 'player' : 'zombie', at: { x: 0.5 + (opts.zombieAt ?? 2.2), y: 0, z: 0.5 }, height: 1.95 });
  return { sc, rt, z };
}

describe('defend_against_threat (real skill, scripted server)', () => {
  it('defends a single supported zombie with verified gear; defeat only from the server death status', async () => {
    const { sc, rt } = armedScene();
    let attacks = 0;
    const origWrite = sc.client.write.bind(sc.client);
    sc.client.write = (name: string, data: Record<string, unknown>) => {
      origWrite(name, data);
      if (name === 'attack' && data['entityId'] === 50) {
        attacks += 1;
        setImmediate(() => {
          sc.client.emit('damage_event', { entityId: 50, sourceTypeId: 1, sourceCauseId: 2, sourceDirectId: 2 });
          if (attacks === 3) sc.client.emit('entity_status', { entityId: 50, entityStatus: 3 });
        });
      }
    };
    rt.service.tick();
    assert.equal(rt.service.hold()?.response, 'defend');
    assert.ok(await until(() => rt.service.hold() === null || rt.service.status(Date.now()).counters.defeatsConfirmed > 0, 10_000));
    const s = rt.service.status(Date.now());
    assert.equal(s.counters.defeatsConfirmed, 1);
    assert.equal(s.counters.hitsConfirmed, 3);
    assert.equal(attacks, 3, 'bounded: no attack after the death status');
    await rt.service.close();
  });

  it('a target that leaves sight is not a defeat; no pursuit', async () => {
    const { sc, rt, z } = armedScene();
    const origWrite = sc.client.write.bind(sc.client);
    sc.client.write = (name: string, data: Record<string, unknown>) => {
      origWrite(name, data);
      if (name === 'attack') setImmediate(() => sc.fake.fill(2, 0, -2, 2, 3, 2, 'stone')); // a wall hides it after the first hit
    };
    void z;
    rt.service.tick();
    assert.ok(await until(() => rt.service.hold() === null, 10_000));
    const s = rt.service.status(Date.now());
    assert.equal(s.counters.defeatsConfirmed, 0);
    const steps = (rt.service.episodes().at(-1)?.evidence['steps'] as Array<{ reason: string | null }>) ?? [];
    assert.equal(steps[0]?.reason, 'target_not_visible');
    await rt.service.close();
  });

  it('never attacks a player standing in reach', async () => {
    const { sc, rt } = armedScene({ player: true });
    const written: string[] = [];
    const origWrite = sc.client.write.bind(sc.client);
    sc.client.write = (name: string, data: Record<string, unknown>) => {
      written.push(name);
      origWrite(name, data);
    };
    rt.service.tick();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(written.includes('attack'), false);
    assert.equal(rt.service.hold(), null);
    await rt.service.close();
  });

  it('unarmed: the same zombie is avoided (retreat planned), never fought', async () => {
    const { sc, rt } = armedScene();
    const items = new Array(46).fill(null);
    sc.client.emit('window_items', { windowId: 0, stateId: 2, items });
    sc.fake.give(36, 'dirt', 1);
    const written: string[] = [];
    const origWrite = sc.client.write.bind(sc.client);
    sc.client.write = (name: string, data: Record<string, unknown>) => {
      written.push(name);
      origWrite(name, data);
    };
    rt.service.tick();
    assert.equal(rt.service.hold()?.response, 'retreat');
    await rt.service.close();
    assert.equal(written.includes('attack'), false);
  });
});
