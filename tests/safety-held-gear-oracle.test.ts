// W-R11: `serverHeldGear` must read the ACTUAL installed 26.x player NBT replies
// structurally. The R18 O8D staging (both releases) refused a genuinely
// equipped bot because routine armour wear adds a nested
// `components: {"minecraft:damage": 1}` compound. The exact raw replies below
// are copied verbatim from the immutable R18 report readbacks:
//   261 .../2026-10-09T01-45-54-344Z-ordinary-goals/report.json (scenario O8D, atMs 1791510436544/545)
//   262 .../2026-10-09T01-45-54-736Z-26.2-ordinary-goals/report.json (scenario O8D, atMs 1791510436714/715)
// Every other reply is marked synthetic. No combat/readiness policy is tested
// or changed here: this is only the server-gear representation oracle.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serverHeldGear } from '../scripts/lib/ordinary-safety-oracles.ts';

// ---- actual R18 readbacks (identical on 26.1.2 and 26.2)
const R18_INVENTORY = 'Chunkbot has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]';
const R18_EQUIPMENT = 'Chunkbot has the following entity data: {head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_chestplate"}}';
const R18_SELECTED = 'Chunkbot has the following entity data: 0';

const EQUIPPED = { mainHand: 'minecraft:iron_sword', head: 'minecraft:iron_helmet', chest: 'minecraft:iron_chestplate', selectedSlot: 0 };
const data = (body: string) => `Chunkbot has the following entity data: ${body}`;
/** True when a reply would satisfy the harness's full sword/helmet/chestplate staging check. */
const ready = (g: ReturnType<typeof serverHeldGear>) => Boolean(g && g.mainHand === EQUIPPED.mainHand && g.head === EQUIPPED.head && g.chest === EQUIPPED.chest);

describe('serverHeldGear: actual R18 O8D worn-stack replies', () => {
  it('reads the exact actual replies: damaged (worn) armour keeps its known identity, the sword is the selected slot', () => {
    assert.deepEqual(serverHeldGear(R18_INVENTORY, R18_EQUIPMENT, R18_SELECTED), EQUIPPED);
  });

  it('the R16 undamaged format still parses identically (no regression)', () => {
    const r16 = data('{head: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}');
    assert.deepEqual(serverHeldGear(R18_INVENTORY, r16, R18_SELECTED), EQUIPPED);
  });

  it('other normal nested components (synthetic) are tolerated without changing the top-level identity', () => {
    const eq = data('{head: {components: {"minecraft:damage": 3, "minecraft:enchantments": {"minecraft:protection": 1}, "minecraft:custom_name": "Lid \\"A\\""}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:trim": {material: "minecraft:iron", pattern: "minecraft:coast"}, "minecraft:profile": {id: [I; 1, -2, 3, 4]}}, count: 1, id: "minecraft:iron_chestplate"}}');
    const inv = data('[{components: {"minecraft:damage": 40}, count: 1, Slot: 0b, id: "minecraft:iron_sword"}, {count: 64, Slot: 1b, id: "minecraft:dirt"}]');
    assert.deepEqual(serverHeldGear(inv, eq, R18_SELECTED), EQUIPPED);
  });
});

describe('serverHeldGear: identity is top-level only (synthetic impostors)', () => {
  it('a nested id inside components is never the stack id', () => {
    // Top-level stack is a leather cap; a component carries an iron_helmet id.
    const eq = data('{head: {components: {"minecraft:container": [{slot: 0, item: {count: 1, id: "minecraft:iron_helmet"}}]}, count: 1, id: "minecraft:leather_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}');
    const g = serverHeldGear(R18_INVENTORY, eq, R18_SELECTED);
    assert.equal(g?.head, 'minecraft:leather_helmet');
    assert.equal(ready(g), false);
  });

  it('a stack without its own top-level id is unknown even if a nested id exists', () => {
    const eq = data('{head: {components: {"minecraft:damage": 1, id: "minecraft:iron_helmet"}, count: 1}, chest: {count: 1, id: "minecraft:iron_chestplate"}}');
    assert.equal(serverHeldGear(R18_INVENTORY, eq, R18_SELECTED), null);
  });

  it('a nested Slot inside components does not make an item held', () => {
    const inv = data('[{count: 1, Slot: 3b, id: "minecraft:iron_sword", components: {"minecraft:custom_data": {Slot: 0b}}}]');
    const g = serverHeldGear(inv, R18_EQUIPMENT, R18_SELECTED);
    assert.equal(g?.mainHand, null, 'the sword is carried in slot 3, the selected slot 0 is empty');
    assert.equal(ready(g), false);
  });

  it('offhand is not chest armour; carried/legacy armour slots are not worn gear', () => {
    const offhand = data('{head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, offhand: {count: 1, id: "minecraft:iron_chestplate"}}');
    assert.equal(serverHeldGear(R18_INVENTORY, offhand, R18_SELECTED)?.chest, null);
    const legacy = data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword"}, {count: 1, Slot: 103b, id: "minecraft:iron_helmet"}, {count: 1, Slot: 102b, id: "minecraft:iron_chestplate"}]');
    const g = serverHeldGear(legacy, data('{}'), R18_SELECTED);
    assert.deepEqual(g, { mainHand: 'minecraft:iron_sword', head: null, chest: null, selectedSlot: 0 });
    const carried = data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword"}, {count: 1, Slot: 9b, id: "minecraft:iron_chestplate"}]');
    assert.equal(serverHeldGear(carried, data('{head: {count: 1, id: "minecraft:iron_helmet"}}'), R18_SELECTED)?.chest, null);
  });

  it('a normal off-hand stack (synthetic 64 torches) is not mistaken for armour and does not void the reply', () => {
    const eq = data('{head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_chestplate"}, offhand: {count: 64, id: "minecraft:torch"}}');
    assert.deepEqual(serverHeldGear(R18_INVENTORY, eq, R18_SELECTED), EQUIPPED);
  });

  it('the sword must be in the ACTUAL selected slot', () => {
    for (const sel of ['1', '4', '8']) assert.equal(serverHeldGear(R18_INVENTORY, R18_EQUIPMENT, data(sel))?.mainHand, null, `selected ${sel}`);
  });
});

describe('serverHeldGear: malformed, duplicate, ambiguous, truncated or misnested replies fail closed (null)', () => {
  const cases: Array<[string, string, string, string]> = [
    // duplicates / doubled fields
    [data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword", id: "minecraft:diamond_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'duplicate top-level id'],
    [data('[{count: 1, count: 1, Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'doubled count'],
    [data('[{count: 1, Slot: 0b, Slot: 1b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'doubled Slot'],
    [R18_INVENTORY, data('{head: {count: 1, id: "minecraft:iron_helmet"}, head: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}'), R18_SELECTED, 'duplicate head slot'],
    [R18_INVENTORY, data('{head: {components: {"minecraft:damage": 1, "minecraft:damage": 2}, count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}'), R18_SELECTED, 'duplicate nested component key'],
    [data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword"}, {count: 1, Slot: 0b, id: "minecraft:stone_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'two stacks claim the selected slot'],
    // count
    [data('[{count: 0, Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'zero count'],
    [data('[{count: -1, Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'negative count'],
    [data('[{count: 1.5f, Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'non-integer count'],
    [data('[{count: "1", Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'string count'],
    [data('[{Slot: 0b, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'missing count'],
    [R18_INVENTORY, data('{head: {count: 2, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}'), R18_SELECTED, 'worn armour stack of two'],
    // identity / slot fields
    [data('[{count: 1, Slot: 0, id: "minecraft:iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'Slot without byte type'],
    [data('[{count: 1, Slot: 0b, id: minecraft:iron_sword}]'), R18_EQUIPMENT, R18_SELECTED, 'unquoted id'],
    [data('[{count: 1, Slot: 0b, id: "iron_sword"}]'), R18_EQUIPMENT, R18_SELECTED, 'non-namespaced id'],
    [data('[{count: 1, Slot: 0b, id: 7}]'), R18_EQUIPMENT, R18_SELECTED, 'numeric id'],
    // misnesting / unexpected structure
    [data('{count: 1, Slot: 0b, id: "minecraft:iron_sword"}'), R18_EQUIPMENT, R18_SELECTED, 'Inventory not a list'],
    [data('["minecraft:iron_sword"]'), R18_EQUIPMENT, R18_SELECTED, 'Inventory entry not a compound'],
    [R18_INVENTORY, data('[{count: 1, id: "minecraft:iron_helmet"}]'), R18_SELECTED, 'equipment not a compound'],
    [R18_INVENTORY, data('{head: "minecraft:iron_helmet", chest: {count: 1, id: "minecraft:iron_chestplate"}}'), R18_SELECTED, 'worn slot not a stack compound'],
    [R18_INVENTORY, data('{helmet: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}'), R18_SELECTED, 'unknown equipment slot name'],
    [R18_INVENTORY, data('{head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet", chest: {count: 1, id: "minecraft:iron_chestplate"}}}'), R18_SELECTED, 'chest misnested inside head'],
    // truncated / trailing / unterminated
    [R18_INVENTORY, R18_EQUIPMENT.slice(0, -1), R18_SELECTED, 'truncated equipment'],
    [R18_INVENTORY, data('{head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:damage": 1'), R18_SELECTED, 'equipment cut inside a component'],
    [R18_INVENTORY.slice(0, -2), R18_EQUIPMENT, R18_SELECTED, 'truncated Inventory'],
    [R18_INVENTORY, `${R18_EQUIPMENT}}`, R18_SELECTED, 'extra closing brace'],
    [R18_INVENTORY, `${R18_EQUIPMENT} trailing`, R18_SELECTED, 'trailing text'],
    [data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword}]'), R18_EQUIPMENT, R18_SELECTED, 'unterminated string'],
    [data('[{count: 1, Slot: 0b, id: "minecraft:iron_sword",}]'), R18_EQUIPMENT, R18_SELECTED, 'dangling comma'],
    // unreadable
    [R18_INVENTORY, 'Found no elements matching equipment', R18_SELECTED, 'unreadable equipment'],
    ['No entity was found', R18_EQUIPMENT, R18_SELECTED, 'unreadable Inventory'],
    // selected slot invalid / inconsistent
    [R18_INVENTORY, R18_EQUIPMENT, 'Found no elements matching SelectedItemSlot', 'unreadable selected slot'],
    [R18_INVENTORY, R18_EQUIPMENT, data('9'), 'selected slot out of hotbar range'],
    [R18_INVENTORY, R18_EQUIPMENT, data('-1'), 'negative selected slot'],
    [R18_INVENTORY, R18_EQUIPMENT, data('0b'), 'selected slot with a type suffix'],
    [R18_INVENTORY, R18_EQUIPMENT, data('0, 1'), 'two selected slots'],
    [R18_INVENTORY, R18_EQUIPMENT, data('0.0'), 'fractional selected slot'],
    [R18_INVENTORY, R18_EQUIPMENT, data(''), 'empty selected slot'],
  ];
  for (const [inv, eq, sel, why] of cases) {
    it(why, () => assert.equal(serverHeldGear(inv, eq, sel), null));
  }

  it('oversized replies are refused before parsing (bounded)', () => {
    const huge = data(`[${Array.from({ length: 5000 }, (_, i) => `{count: 1, Slot: ${i % 100}b, id: "minecraft:stone"}`).join(', ')}]`);
    assert.equal(serverHeldGear(huge, R18_EQUIPMENT, R18_SELECTED), null);
    const deep = data(`{head: {components: ${'{a: '.repeat(64)}1${'}'.repeat(64)}, count: 1, id: "minecraft:iron_helmet"}}`);
    assert.equal(serverHeldGear(R18_INVENTORY, deep, R18_SELECTED), null);
  });
});
