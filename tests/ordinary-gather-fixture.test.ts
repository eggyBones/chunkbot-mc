// Credential-free fixture prerequisite audit against both exact release
// recipe/harvest datasets. This does not execute a task or imply acceptance.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAYOUT } from '../scripts/ordinary-goal-live-check.ts';
import { smallShelterCells } from '../src/autonomy/blueprint.ts';
import { VersionKnowledge, mechanicsDatasetFor } from '../src/knowledge/knowledge.ts';
import { RecipeBook, planPlacement } from '../src/knowledge/recipes.ts';

describe('ordinary gather-house fixture prerequisites', () => {
  for (const version of ['26.1.2', '26.2']) it(`${version}: source logs and exposed stone support the current shelter and every prerequisite`, () => {
    const data = mechanicsDatasetFor(version);
    assert.ok(data);
    const book = new RecipeBook(data);
    const stock = new Map<string, number>([['minecraft:oak_log', LAYOUT.gather.trunks.length * 5]]);
    const craft = (output: string, grid: 2 | 3, times = 1) => {
      for (let n = 0; n < times; n += 1) {
        const recipe = book.recipesFor(output).find((r) => r.family === 'crafting' && planPlacement(r, grid, stock).ok);
        assert.ok(recipe, `${output} has an affordable ${grid}x${grid} recipe on ${version}`);
        const placement = planPlacement(recipe, grid, stock);
        assert.ok(placement.ok);
        for (const item of placement.placement.cells) stock.set(item.item, stock.get(item.item)! - 1);
        stock.set(output, (stock.get(output) ?? 0) + recipe.output.count);
      }
    };
    craft('minecraft:oak_planks', 2, 30);
    craft('minecraft:crafting_table', 2, 2); // working bench plus furnishing; no bench retrieval assumed
    craft('minecraft:stick', 2);
    craft('minecraft:wooden_pickaxe', 3);
    const knowledge = new VersionKnowledge({ version });
    const tool = knowledge.answerOne({ kind: 'tool', forBlock: 'minecraft:stone' });
    assert.equal(tool.status, 'known');
    assert.ok(tool.status === 'known' && (tool.data as { harvestTools: string[] }).harvestTools.includes('minecraft:wooden_pickaxe'), 'crafted tool can harvest the exposed stone');
    const stone = LAYOUT.gather.stone;
    stock.set('minecraft:cobblestone', (stone.x2 - stone.x1 + 1) * (stone.z2 - stone.z1 + 1));
    craft('minecraft:furnace', 3);
    craft('minecraft:chest', 3);
    const cells = smallShelterCells({ x: 216, y: -60, z: 216 }, 3, 'north');
    const materialCount = cells.filter((c) => ['wall', 'roof', 'aid'].includes(c.role)).length;
    assert.ok(stock.get('minecraft:oak_planks')! >= materialCount, `${stock.get('minecraft:oak_planks')} planks cover all ${materialCount} construction placements including the aid`);
    for (const cell of cells.filter((c) => ['wall', 'roof', 'aid'].includes(c.role))) assert.ok(cell.accept.some((s) => book.matches(s, 'minecraft:oak_planks')), 'planks are accepted by the actual construction default');
    for (const furnishing of cells.filter((c) => c.role === 'workstation' || c.role === 'storage')) assert.ok(furnishing.accept.some((s) => (stock.get(s) ?? 0) > 0));
  });
});
