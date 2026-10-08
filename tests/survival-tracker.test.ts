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
  it('S-C12-R4: packet-time collected facts survive destroy without becoming live authority; id reuse and connection/life changes clear them', () => {
    const { p, t } = attached();
    p.login();
    p.spawnItem(68, slot('bread', 64));
    p.collect(68, 64);
    p.destroy(68);
    assert.equal(t.dropStack(68), undefined);
    const saved = t.collectedStack(68)!;
    assert.equal(saved.key, 'minecraft:bread');
    assert.equal(saved.count, 64);
    saved.key = 'minecraft:dirt';
    saved.meta.digest = 'changed';
    assert.equal(t.collectedStack(68)?.key, 'minecraft:bread', 'callers receive independent copies');
    assert.notEqual(t.collectedStack(68)?.meta.digest, 'changed');
    p.spawnItemWithoutStack(68);
    assert.equal(t.collectedStack(68), undefined, 'a reused id never inherits the previous collect');
    assert.equal(t.dropStack(68), undefined);
    p.collect(68, 1);
    assert.equal(t.collectedStack(68), undefined, 'unknown stack remains unknown');
    p.spawnOther(69);
    p.collect(69, 1);
    p.destroy(69);
    assert.equal(t.collectedKind(69), 'non_item');
    assert.equal(t.collectedStack(69), undefined);
    p.spawnItem(70, slot('bread', 4));
    p.collect(70, 4, 99);
    p.destroy(70);
    assert.equal(t.collectedStack(70), undefined, 'another collector does not create own-collect history');
    p.spawnItem(71, slot('bread', 4));
    p.collect(71, 4);
    p.respawn();
    assert.equal(t.collectedStack(71), undefined);
    p.spawnItem(72, slot('bread', 4));
    p.collect(72, 4);
    p.login();
    assert.equal(t.collectedStack(72), undefined);
    for (let id = 100; id <= 356; id += 1) {
      p.spawnItem(id, slot('bread', 1));
      p.collect(id, 1);
      p.destroy(id);
    }
    assert.equal(t.collectedStack(100), undefined, 'history is bounded to 256 recent entities');
    assert.equal(t.collectedStack(356)?.count, 1);
    t.attach(p.client, { connectionEpoch: 2, registry, now: () => 2_000, selfPosition: () => undefined });
    assert.equal(t.collectedStack(356), undefined, 'replacement connection has no old packet facts');
  });
  it('parses server slot metadata: damage patch, registry max durability, enchantments', () => {
    const { p, t } = attached();
    p.login();
    p.inventory({ 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 230 }]), 37: slot('diamond_sword', 1, [{ type: 'enchantments', data: {} }]), 38: slot('bread', 5) });
    const inv = t.inventory();
    assert.ok(inv && inv.fullSync && inv.source === 'server_packets');
    const pick = inv.stacks.find((s) => s.key === 'minecraft:iron_pickaxe');
    assert.equal(pick?.meta.metadata, 'server_slot');
    assert.equal(pick?.meta.maxDurability, 250);
    assert.equal(pick?.meta.damage, 230);
    assert.match(pick?.meta.digest ?? '', /^[0-9a-f]{16}$/, 'server identity digest');
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

  it('records server-stated drop stacks with identity; never from labels; cleared on destroy/respawn', () => {
    const { p, t } = attached();
    p.login(42);
    p.spawnItem(500, slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: { sharpness: 3 } } }]));
    p.spawnItem(501, slot('bread', 64));
    p.spawnItemWithoutStack(502);
    const sword = t.dropStack(500);
    assert.equal(sword?.key, 'minecraft:diamond_sword');
    assert.equal(sword?.meta.enchanted, true);
    assert.equal(t.dropStack(501)?.count, 64);
    assert.equal(t.dropStack(502), undefined, 'no stated stack: unknown');
    // A different enchantment is a different identity.
    p.spawnItem(503, slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: { sharpness: 1 } } }]));
    assert.notEqual(t.dropStack(503)?.meta.digest, sword?.meta.digest);
    p.destroy(501);
    assert.equal(t.dropStack(501), undefined);
    p.respawn();
    assert.equal(t.dropStack(500), undefined, 'respawn restarts the entity space');
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

  it('S-C12-R3: emits distinct stated-item and unknown own collects; known non-items and other collectors stay excluded', () => {
    const { p, t, events } = attached();
    p.login(42);
    p.spawnItem(800, slot('bread', 4), { x: 10, y: 64, z: 11 });
    p.collect(800, 4);
    p.collect(801, 3); // no server announcement of any kind
    p.spawnOther(802);
    p.collect(802, 1);
    p.collect(803, 4, 99);
    const collects = events.filter((e) => e.type === 'own_item_collect' || e.type === 'own_unknown_collect');
    assert.equal(collects.length, 2);
    assert.equal(collects[0]?.type, 'own_item_collect');
    assert.equal(collects[0]?.facts?.key, 'minecraft:bread');
    assert.equal(collects[0]?.facts?.count, 4);
    assert.deepEqual(collects[0]?.firstSeenAt, { x: 10, y: 64, z: 11 });
    assert.deepEqual(collects[1], { type: 'own_unknown_collect', connectionEpoch: 1, entityId: 801, count: 3, facts: undefined, firstSeenAt: undefined, atMs: 1_000 });
    assert.equal(t.collectedKind(801), 'unknown');
    assert.equal(t.collectedKind(802), 'non_item');
    p.destroy(800, 801, 802);
    assert.equal(t.collectedKind(802), 'non_item', 'settlement still knows the server-announced kind after destroy');
  });
});
