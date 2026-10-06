import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeResultSchema, type KnowledgeQuery } from '../src/contracts/index.ts';
import { VANILLA_DATA } from '../src/knowledge/data/vanilla-26.1.2.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { RecipeBook, planPlacement } from '../src/knowledge/recipes.ts';

const k = new VersionKnowledge({ version: '26.1.2', execution: { crafting: 'craft_item', cooking: ['furnace_insert'] } });
const book = new RecipeBook(VANILLA_DATA);
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const known = (q: KnowledgeQuery): Data => {
  const r = k.answerOne(q);
  assert.equal(KnowledgeResultSchema.safeParse(r).success, true, 'bounded contract shape');
  assert.equal(r.status, 'known', JSON.stringify(r));
  return (r as { data: Data }).data;
};

describe('version knowledge from installed data', () => {
  it('describes prerequisites while ingredients and workstations are absent', () => {
    const pick = known({ kind: 'recipe', output: 'minecraft:wooden_pickaxe' });
    const r = pick.recipes[0];
    assert.deepEqual(r.workstations, ['minecraft:crafting_table']);
    assert.ok(r.ingredients.some((i: Data) => i.accepts === '#minecraft:wooden_tool_materials' && i.count === 3 && i.options.includes('minecraft:cherry_planks')));
    assert.ok(r.ingredients.some((i: Data) => i.accepts === 'minecraft:stick' && i.count === 2));
    const armor = known({ kind: 'recipe', output: 'minecraft:iron_chestplate' });
    assert.equal(armor.recipes[0].ingredients[0].count, 8);
    const planks = known({ kind: 'recipe', output: 'minecraft:oak_planks' });
    assert.ok(planks.recipes[0].workstations.includes('inventory_2x2'));
    assert.equal(planks.recipes[0].yields, 4);
  });

  it('distinguishes stone from cobblestone through harvest and smelting rules', () => {
    const harvest = known({ kind: 'harvest', block: 'minecraft:stone' });
    assert.equal(harvest.requiresTool, true);
    assert.deepEqual(harvest.drops, ['minecraft:cobblestone']);
    const stone = known({ kind: 'recipe', output: 'minecraft:stone' });
    assert.ok(stone.recipes.some((x: Data) => x.type === 'smelting' && x.ingredients[0].accepts === 'minecraft:cobblestone'));
    const smelt = known({ kind: 'smelting', input: 'minecraft:raw_iron' });
    assert.ok(smelt.recipes.some((x: Data) => x.type === 'smelting'));
    const cobble = known({ kind: 'recipe', output: 'minecraft:cobblestone' });
    assert.ok(cobble.alsoDroppedByBlocks.includes('minecraft:stone'));
    const iron = known({ kind: 'tool', forBlock: 'minecraft:iron_ore' });
    assert.ok(!iron.harvestTools.includes('minecraft:wooden_pickaxe') && iron.harvestTools.includes('minecraft:stone_pickaxe'));
    assert.ok(String(iron.fasterWith[0]).includes('pickaxe'), 'tool category inferred from harvest tools, not the tier tag');
  });

  it('reads vanilla fuel burn times decoded from the server jar, including removals', () => {
    assert.equal(book.fuelTicks('minecraft:coal'), 1600);
    assert.equal(book.fuelTicks('minecraft:oak_planks'), 300);
    assert.equal(book.fuelTicks('minecraft:stick'), 100);
    assert.equal(book.fuelTicks('minecraft:crimson_planks'), undefined, 'non-flammable wood removed');
    assert.equal(book.fuelTicks('minecraft:cobblestone'), undefined);
    assert.equal(known({ kind: 'fuel', item: 'minecraft:cobblestone' }).isFuel, false);
  });

  it('keeps unknown mechanics unknown', () => {
    assert.equal(k.answerOne({ kind: 'recipe', output: 'minecraft:not_a_thing' }).status, 'unknown');
    assert.equal(k.answerOne({ kind: 'smelting', input: 'minecraft:dirt' }).status, 'unknown');
    assert.equal(k.answerOne({ kind: 'tag', key: '#minecraft:no_such_tag' }).status, 'unknown');
    const other = new VersionKnowledge({ version: '1.21.11' });
    assert.equal(other.answerOne({ kind: 'recipe', output: 'minecraft:stick' }).status, 'unavailable', 'no recipe dataset for another version');
  });

  it('plans grid placement from inventory with tag members mixed per slot, or reports what is missing', () => {
    const [recipe] = book.recipesFor('minecraft:crafting_table');
    assert.ok(recipe);
    const mixed = planPlacement(recipe, 2, new Map([['minecraft:oak_planks', 2], ['minecraft:birch_planks', 2]]));
    assert.equal(mixed.ok, true);
    if (mixed.ok) assert.deepEqual(mixed.placement.cells.map((c) => c.slot), [1, 2, 3, 4]);
    const short = planPlacement(recipe, 2, new Map([['minecraft:oak_planks', 3]]));
    assert.equal(short.ok, false);
    if (!short.ok) assert.deepEqual(short.missing.map((m) => [m.ingredient, m.need, m.have]), [['#minecraft:planks', 4, 3]]);
    const [pickaxe] = book.recipesFor('minecraft:wooden_pickaxe');
    assert.ok(pickaxe);
    assert.equal(planPlacement(pickaxe, 2, new Map([['minecraft:oak_planks', 3], ['minecraft:stick', 2]])).ok, false, '3x3 does not fit the 2x2 grid');
    const table = planPlacement(pickaxe, 3, new Map([['minecraft:oak_planks', 3], ['minecraft:stick', 2]]));
    assert.equal(table.ok, true);
    if (table.ok) assert.deepEqual(table.placement.cells.map((c) => c.slot), [1, 2, 3, 5, 8]);
  });
});
