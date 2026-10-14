import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { freshTaskContext, suitableArmor, suitableTool } from '../src/survival/upkeep.ts';
import { cleanupRoots, harness, slot, NOW0, SESSION_OW } from './survival-helpers.ts';

after(cleanupRoots);

describe('Oct13 bounded upkeep', () => {
  it('accepts only recent task facts from the same connection and dimension', () => {
    const c = { connectionEpoch: 1, dimension: 'minecraft:overworld', observedAtMs: NOW0, harvest: [], retain: [], reserveKeys: [], requiredFreeSlots: 2 };
    const fence = { connectionEpoch: 1, dimension: SESSION_OW };
    assert.ok(freshTaskContext(c, fence, NOW0));
    for (const value of [{ ...c, connectionEpoch: 2 }, { ...c, dimension: 'the_nether' }, { ...c, observedAtMs: NOW0 - 5_001 }, { ...c, observedAtMs: NOW0 + 1 }, { ...c, requiredFreeSlots: 37 }]) assert.equal(freshTaskContext(value, fence, NOW0), undefined);
  });

  it('never calls a duplicate worn, custom or unknown stack a healthy selectable spare', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('iron_pickaxe'), 37: slot('iron_pickaxe', 1, [{ type: 'damage', data: 249 }]), 38: slot('stone_pickaxe') });
    const inv = h.service.inventory(1)!;
    const cfg = h.service.config()!;
    assert.equal(suitableTool(inv, ['minecraft:iron_pickaxe', 'minecraft:stone_pickaxe'], cfg)?.key, 'minecraft:stone_pickaxe');
    assert.equal(suitableTool(inv, ['minecraft:iron_pickaxe'], cfg), undefined, 'equip-by-key could select the worn copy');
    h.packets.setSlot(37, slot('iron_pickaxe', 1, [{ type: 'custom_name', data: 'precious' }]));
    assert.equal(suitableTool(h.service.inventory(1)!, ['minecraft:iron_pickaxe'], cfg), undefined);
    inv.stacks.forEach((s) => s.meta = { metadata: 'unknown' });
    assert.equal(suitableTool(inv, ['minecraft:stone_pickaxe'], cfg), undefined);
  });

  it('selects healthy ordinary armor and preserves protected or worn gear', () => {
    const h = harness();
    h.packets.inventory({ 20: slot('iron_helmet', 1, [{ type: 'damage', data: 164 }]) });
    assert.equal(suitableArmor(h.service.inventory(1)!, h.service.config()!), undefined);
    h.packets.setSlot(20, slot('iron_helmet'));
    assert.deepEqual(suitableArmor(h.service.inventory(1)!, h.service.config()!), { key: 'minecraft:iron_helmet', slot: 'head' });
    h.packets.setSlot(5, slot('iron_helmet', 1, [{ type: 'custom_name', data: 'owned keepsake' }]));
    assert.equal(suitableArmor(h.service.inventory(1)!, h.service.config()!), undefined);
  });
});
