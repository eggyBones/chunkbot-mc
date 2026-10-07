// MB-FLOW-003 R1: own-death capture from server packets. The last-alive
// inventory is frozen at the earliest own-death signal BEFORE the clearing slot
// updates; the server's own death GlobalPos refines the client estimate; fresh
// respawn state needs respawn + full sync + positive health; unknown cause and
// metadata stay unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDeathMessage, hazardOf } from '../src/survival/death-cause.ts';
import { SurvivalTracker, type TrackerEvent } from '../src/survival/tracker.ts';
import { OW, Packets, empty, registry, slot } from './survival-helpers.ts';

function attached(opts: { selfId?: number } = {}) {
  const p = new Packets();
  const t = new SurvivalTracker();
  const events: TrackerEvent[] = [];
  t.subscribe((e) => events.push(e));
  let now = 1_000;
  const pos = { dimension: OW, at: { x: 10.3, y: 64, z: -5.7 } };
  t.attach(p.client, { connectionEpoch: 1, registry, now: () => now, selfPosition: () => pos, ...(opts.selfId !== undefined ? { selfEntityId: () => opts.selfId } : {}) });
  return { p, t, events, tick: (ms: number) => (now += ms), pos };
}

describe('survival tracker', () => {
  it('parses server slot metadata: damage patch, registry max durability, enchantments', () => {
    const { p, t } = attached();
    p.login();
    p.inventory({ 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 230 }]), 37: slot('diamond_sword', 1, [{ type: 'enchantments', data: {} }]), 38: slot('bread', 5) });
    const inv = t.inventory();
    assert.ok(inv && inv.fullSync && inv.source === 'server_packets');
    const pick = inv.stacks.find((s) => s.key === 'minecraft:iron_pickaxe');
    assert.deepEqual(pick?.meta, { metadata: 'server_slot', maxDurability: 250, damage: 230 });
    const sword = inv.stacks.find((s) => s.key === 'minecraft:diamond_sword');
    assert.equal(sword?.meta.damage, 0, 'no damage patch on a stated slot means damage 0');
    assert.equal(sword?.meta.enchanted, true);
    assert.equal(inv.stacks.find((s) => s.key === 'minecraft:bread')?.meta.maxDurability, undefined);
  });

  it('freezes last-alive at the own combat-kill packet before the clearing slot updates', () => {
    const { p, t, events, tick } = attached();
    p.login(42);
    p.inventory({ 36: slot('iron_pickaxe'), 37: slot('bread', 3) });
    p.health(6, 12);
    tick(50);
    p.kill(42, 'death.attack.lava');
    p.setSlot(36, empty);
    p.setSlot(37, empty);
    p.health(0, 12);
    const d = events.find((e) => e.type === 'death_captured');
    assert.ok(d && d.type === 'death_captured');
    assert.equal(d.death.lastAlive.frozenAt, 'combat_kill_packet');
    assert.equal(d.death.lastAlive.clearingPacketsAfterFreeze, 2);
    assert.deepEqual(d.death.lastAlive.stacks.map((s) => `${s.key}x${s.count}`).sort(), ['minecraft:bread x3', 'minecraft:iron_pickaxe x1'].map((x) => x.replace(' ', '')).sort());
    assert.deepEqual(d.death.cause, { kind: 'server_message', translationKey: 'death.attack.lava', hazard: 'lava' });
    assert.equal(d.death.site.source, 'client_position_at_death_event');
    // The current inventory honestly reflects the server clearing.
    assert.equal(t.inventory()?.stacks.length, 0);
  });

  it('a kill packet for another player is ignored', () => {
    const { p, events } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread') });
    p.kill(7, 'death.attack.mob');
    assert.equal(events.some((e) => e.type === 'death_captured'), false);
  });

  it('without a kill packet it freezes at zero health and labels the cause unknown', () => {
    const { p, events } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread', 2) });
    p.health(0, 20);
    const d = events.find((e) => e.type === 'death_captured');
    assert.ok(d && d.type === 'death_captured');
    assert.equal(d.death.lastAlive.frozenAt, 'zero_health_packet');
    assert.deepEqual(d.death.cause, { kind: 'unknown', hazard: 'unknown' });
    assert.equal(d.death.lastAlive.stacks.length, 1);
  });

  it('the death lifecycle event guarantees a capture when the library fired first', () => {
    const { p, t } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread', 2) });
    const d = t.ensureDeathCaptured();
    assert.equal(d?.lastAlive.frozenAt, 'death_event');
    assert.equal(t.ensureDeathCaptured()?.captureId, d?.captureId, 'idempotent per death');
  });

  it('respawn GlobalPos refines the site; fresh state needs full sync and positive health', () => {
    const { p, t, events } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread', 2) });
    p.kill(42, 'death.fell.accident.generic');
    p.health(0, 20);
    p.respawn({ dimensionName: OW, location: { x: 12, y: 63, z: -6 } });
    const refined = events.find((e) => e.type === 'death_location_refined');
    assert.ok(refined && refined.type === 'death_location_refined');
    assert.equal(refined.site.source, 'server_death_location');
    assert.deepEqual(refined.site.at, { x: 12.5, y: 63, z: -5.5 });
    assert.ok((refined.site.clientEstimateOffBy ?? 0) > 0);
    assert.equal(t.life, 'respawned_awaiting_sync');
    assert.equal(events.some((e) => e.type === 'respawn_ready'), false);
    p.inventory({});
    assert.equal(events.some((e) => e.type === 'respawn_ready'), false, 'health not yet positive');
    p.health(20, 20);
    const ready = events.find((e) => e.type === 'respawn_ready');
    assert.ok(ready && ready.type === 'respawn_ready');
    assert.equal(ready.inventory.stacks.length, 0);
    assert.equal(t.life, 'alive');
  });

  it('a respawn without a death (dimension travel) is not a death', () => {
    const { p, t, events } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread', 2) });
    p.respawn();
    assert.equal(events.some((e) => e.type === 'death_captured'), false);
    assert.equal(t.life, 'alive');
  });

  it('deathContext maps to the memory DeathContext shape of the SAME capture', () => {
    const { p, t } = attached();
    p.login(42);
    p.inventory({ 36: slot('bread', 2), 37: slot('bread', 1) });
    p.kill(42, 'death.attack.mob');
    p.health(0);
    const ctx = t.deathContext();
    assert.equal(ctx.inventory.source, 'server_sync');
    assert.deepEqual(ctx.inventory.items, [{ key: 'minecraft:bread', count: 3 }]);
    assert.equal(ctx.accuracy, 'client_position_at_death_event');
  });

  it('ready seed is labeled and never claims server packets', () => {
    const p = new Packets();
    const t = new SurvivalTracker();
    t.attach(p.client, { connectionEpoch: 2, registry, now: () => 5, selfPosition: () => undefined, seed: { stacks: [{ slot: 36, key: 'minecraft:bread', count: 1, meta: { metadata: 'unknown' } }] } });
    assert.equal(t.inventory()?.source, 'ready_seed');
    p.inventory({ 36: slot('bread', 4) });
    assert.equal(t.inventory()?.source, 'server_packets');
  });

  it('classifies vanilla death keys and drops names', () => {
    assert.equal(hazardOf('death.attack.outOfWorld'), 'void');
    assert.equal(hazardOf('death.attack.drown'), 'drowning');
    assert.equal(hazardOf('death.attack.player'), 'player');
    assert.equal(hazardOf('death.attack.genericKill'), 'command');
    assert.equal(classifyDeathMessage('{"translate":"death.attack.inFire","with":["bot"]}').hazard, 'fire');
    assert.equal(classifyDeathMessage({ text: '' }).kind, 'unknown');
    assert.equal(classifyDeathMessage({ translate: 'evil key; drop table' }).kind, 'unknown');
  });
});
