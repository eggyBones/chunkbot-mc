// Recipe and tag model over the generated version dataset. One normalized form
// serves both knowledge answers and the crafting/furnace skills, so what the
// planner is told and what the executor places are the same data.
import type { RawIngredient, RawRecipe, VanillaData } from './vanilla-data.ts';

export type RecipeFamily = 'crafting' | 'cooking' | 'stonecutting' | 'smithing' | 'special';

/** Where a recipe is performed. `inventory_2x2` is the player's own crafting grid. */
export type Workstation =
  | 'inventory_2x2'
  | 'minecraft:crafting_table'
  | 'minecraft:furnace'
  | 'minecraft:blast_furnace'
  | 'minecraft:smoker'
  | 'minecraft:campfire'
  | 'minecraft:stonecutter'
  | 'minecraft:smithing_table';

export interface IngredientSpec {
  /** How the recipe names it: an item key, a `#tag`, or `a|b` for an explicit list. */
  label: string;
  /** Concrete item keys accepted in one slot (tag expanded). */
  options: string[];
}

export interface NormalizedRecipe {
  id: string;
  type: string;
  family: RecipeFamily;
  /** Workstations that can perform it (a 2x2 recipe also works at a crafting table). */
  workstations: Workstation[];
  output: { key: string; count: number };
  /** Crafting grid shape (shaped recipes); row-major cells, null = empty. */
  grid?: { width: number; height: number; cells: Array<IngredientSpec | null> };
  /** Aggregated ingredient requirements for one execution of the recipe. */
  ingredients: Array<{ spec: IngredientSpec; count: number }>;
  cookingTicks?: number;
  /** True when every slot of a tag ingredient matches independently (vanilla tag ingredients). */
  mixingAllowed: boolean;
}

const CRAFTING_TYPES = new Set(['minecraft:crafting_shaped', 'minecraft:crafting_shapeless', 'minecraft:crafting_transmute']);
const COOKING_STATION: Record<string, Workstation> = {
  'minecraft:smelting': 'minecraft:furnace',
  'minecraft:blasting': 'minecraft:blast_furnace',
  'minecraft:smoking': 'minecraft:smoker',
  'minecraft:campfire_cooking': 'minecraft:campfire',
};

export class RecipeBook {
  readonly data: VanillaData;
  private readonly tagCache = new Map<string, string[]>();
  private readonly byOutput = new Map<string, NormalizedRecipe[]>();
  private readonly all: NormalizedRecipe[] = [];
  private readonly fuelTable = new Map<string, number>();

  constructor(data: VanillaData) {
    this.data = data;
    for (const raw of data.recipes) {
      const recipe = this.normalize(raw);
      if (!recipe) continue;
      this.all.push(recipe);
      const list = this.byOutput.get(recipe.output.key) ?? [];
      list.push(recipe);
      this.byOutput.set(recipe.output.key, list);
    }
    // Fuel table: later additions override earlier ones; removals apply last (vanilla builder order).
    for (const fuel of data.fuels) {
      for (const item of this.expand(fuel.target)) this.fuelTable.set(item, fuel.burnTicks);
    }
    for (const removed of data.fuelRemovals) for (const item of this.expand(removed)) this.fuelTable.delete(item);
  }

  get version(): string {
    return this.data.provenance.minecraftVersion;
  }

  get recipeCount(): number {
    return this.all.length;
  }

  hasTag(tag: string): boolean {
    return (tag.startsWith('#') ? tag.slice(1) : tag) in this.data.itemTags;
  }

  /** Expands an item key or `#tag` to concrete item keys (recursive, cycle-safe). */
  expand(keyOrTag: string, seen: Set<string> = new Set()): string[] {
    if (!keyOrTag.startsWith('#')) return [keyOrTag];
    const tag = keyOrTag.slice(1);
    const cached = this.tagCache.get(tag);
    if (cached) return cached;
    if (seen.has(tag)) return [];
    seen.add(tag);
    const out = new Set<string>();
    for (const value of this.data.itemTags[tag] ?? []) for (const item of this.expand(value, seen)) out.add(item);
    const list = [...out];
    this.tagCache.set(tag, list);
    return list;
  }

  spec(raw: RawIngredient): IngredientSpec {
    const parts = Array.isArray(raw) ? raw : [raw];
    const options = [...new Set(parts.flatMap((p) => this.expand(p)))];
    return { label: parts.join('|'), options };
  }

  /** Item keys the given selector (`minecraft:x` or `#minecraft:tag`) covers. */
  matches(selector: string, itemKey: string): boolean {
    return selector.startsWith('#') ? this.expand(selector).includes(itemKey) : selector === itemKey;
  }

  recipesFor(outputKey: string): NormalizedRecipe[] {
    return this.byOutput.get(outputKey) ?? [];
  }

  /** Recipes consuming an item (or any member of a tag). */
  recipesUsing(keyOrTag: string): NormalizedRecipe[] {
    const items = new Set(this.expand(keyOrTag));
    return this.all.filter((r) => r.ingredients.some((i) => i.spec.options.some((o) => items.has(o))));
  }

  cookingFor(inputKey: string): NormalizedRecipe[] {
    return this.all.filter((r) => r.family === 'cooking' && r.ingredients.some((i) => i.spec.options.includes(inputKey)));
  }

  fuelTicks(itemKey: string): number | undefined {
    return this.fuelTable.get(itemKey);
  }

  fuelEntries(): Array<{ target: string; burnTicks: number }> {
    return this.data.fuels.filter((f) => !this.data.fuelRemovals.includes(f.target));
  }

  private normalize(raw: RawRecipe): NormalizedRecipe | undefined {
    const result = typeof raw.result === 'string' ? { id: raw.result } : raw.result;
    if (!result?.id) return undefined;
    const output = { key: result.id, count: result.count ?? 1 };
    const aggregate = (cells: Array<IngredientSpec | null>) => {
      const map = new Map<string, { spec: IngredientSpec; count: number }>();
      for (const c of cells) {
        if (!c) continue;
        const entry = map.get(c.label) ?? { spec: c, count: 0 };
        entry.count += 1;
        map.set(c.label, entry);
      }
      return [...map.values()];
    };
    if (raw.type === 'minecraft:crafting_shaped' && Array.isArray(raw.pattern) && raw.key) {
      const height = raw.pattern.length;
      const width = Math.max(...raw.pattern.map((row) => row.length));
      const specs = new Map<string, IngredientSpec>();
      for (const [ch, ing] of Object.entries(raw.key)) specs.set(ch, this.spec(ing));
      const cells: Array<IngredientSpec | null> = [];
      for (const row of raw.pattern) for (let x = 0; x < width; x += 1) cells.push(specs.get(row[x] ?? ' ') ?? null);
      return {
        id: raw.id,
        type: raw.type,
        family: 'crafting',
        workstations: width <= 2 && height <= 2 ? ['inventory_2x2', 'minecraft:crafting_table'] : ['minecraft:crafting_table'],
        output,
        grid: { width, height, cells },
        ingredients: aggregate(cells),
        mixingAllowed: true,
      };
    }
    if (CRAFTING_TYPES.has(raw.type)) {
      const parts: RawIngredient[] =
        raw.type === 'minecraft:crafting_transmute' ? [raw.input, raw.material].filter((x): x is RawIngredient => x !== undefined) : (raw.ingredients ?? []);
      if (parts.length === 0) return undefined;
      const cells = parts.map((p) => this.spec(p));
      return {
        id: raw.id,
        type: raw.type,
        family: 'crafting',
        workstations: cells.length <= 4 ? ['inventory_2x2', 'minecraft:crafting_table'] : ['minecraft:crafting_table'],
        output,
        ingredients: aggregate(cells),
        mixingAllowed: true,
      };
    }
    const station = COOKING_STATION[raw.type];
    if (station && raw.ingredient !== undefined) {
      const recipe: NormalizedRecipe = {
        id: raw.id,
        type: raw.type,
        family: 'cooking',
        workstations: [station],
        output,
        ingredients: [{ spec: this.spec(raw.ingredient), count: 1 }],
        mixingAllowed: true,
      };
      if (typeof raw.cookingtime === 'number') recipe.cookingTicks = raw.cookingtime;
      return recipe;
    }
    if (raw.type === 'minecraft:stonecutting' && raw.ingredient !== undefined) {
      return {
        id: raw.id,
        type: raw.type,
        family: 'stonecutting',
        workstations: ['minecraft:stonecutter'],
        output,
        ingredients: [{ spec: this.spec(raw.ingredient), count: 1 }],
        mixingAllowed: true,
      };
    }
    if (raw.type === 'minecraft:smithing_transform') {
      const parts = [raw.template, raw.base, raw.addition].filter((x): x is RawIngredient => x !== undefined);
      return {
        id: raw.id,
        type: raw.type,
        family: 'smithing',
        workstations: ['minecraft:smithing_table'],
        output,
        ingredients: parts.map((p) => ({ spec: this.spec(p), count: 1 })),
        mixingAllowed: true,
      };
    }
    // Special/dynamic recipes (dyeing, firework, banner copy, repair, ...): output known, inputs dynamic.
    return { id: raw.id, type: raw.type, family: 'special', workstations: ['minecraft:crafting_table'], output, ingredients: [], mixingAllowed: false };
  }
}

/** Grid slot index (1-based within the crafting window) for a cell of a w-wide grid. */
export function gridSlot(gridWidth: 2 | 3, x: number, y: number): number {
  return 1 + x + gridWidth * y;
}

export interface CraftPlacement {
  /** Window grid slot -> concrete item key. */
  cells: Array<{ slot: number; item: string }>;
  /** Items consumed per craft. */
  consumes: Record<string, number>;
}

export type PlacementResult =
  | { ok: true; placement: CraftPlacement }
  | { ok: false; missing: Array<{ ingredient: string; need: number; have: number; options: string[] }> };

/**
 * Chooses concrete inventory items for one execution of a crafting recipe in a
 * grid of `gridWidth` (2 for the inventory, 3 for a crafting table). Tag
 * ingredients match per slot, so mixed members are allowed (vanilla behavior).
 */
export function planPlacement(recipe: NormalizedRecipe, gridWidth: 2 | 3, inventory: ReadonlyMap<string, number>): PlacementResult {
  const remaining = new Map(inventory);
  const wanted: Array<{ slot: number; spec: IngredientSpec }> = [];
  if (recipe.grid) {
    if (recipe.grid.width > gridWidth || recipe.grid.height > gridWidth) return { ok: false, missing: [] };
    recipe.grid.cells.forEach((spec, i) => {
      if (!spec) return;
      const x = i % recipe.grid!.width;
      const y = Math.floor(i / recipe.grid!.width);
      wanted.push({ slot: gridSlot(gridWidth, x, y), spec });
    });
  } else {
    const cells = recipe.ingredients.flatMap((ing) => Array.from({ length: ing.count }, () => ing.spec));
    if (cells.length > gridWidth * gridWidth) return { ok: false, missing: [] };
    cells.forEach((spec, i) => wanted.push({ slot: 1 + i, spec }));
  }
  // Most constrained ingredients first so a shared item is not used up by a flexible slot.
  const order = [...wanted].sort((a, b) => a.spec.options.length - b.spec.options.length);
  const cells: Array<{ slot: number; item: string }> = [];
  const shortfall = new Map<string, { ingredient: string; need: number; have: number; options: string[] }>();
  for (const w of order) {
    let best: string | undefined;
    let bestCount = 0;
    for (const option of w.spec.options) {
      const n = remaining.get(option) ?? 0;
      if (n > bestCount) {
        best = option;
        bestCount = n;
      }
    }
    if (!best) {
      const entry = shortfall.get(w.spec.label) ?? {
        ingredient: w.spec.label,
        need: 0,
        have: w.spec.options.reduce((sum, o) => sum + (inventory.get(o) ?? 0), 0),
        options: w.spec.options.slice(0, 8),
      };
      entry.need += 1;
      shortfall.set(w.spec.label, entry);
      continue;
    }
    remaining.set(best, bestCount - 1);
    cells.push({ slot: w.slot, item: best });
  }
  if (shortfall.size > 0) {
    // Report total need per ingredient for one craft.
    for (const entry of shortfall.values()) {
      entry.need = wanted.filter((w) => w.spec.label === entry.ingredient).length;
    }
    return { ok: false, missing: [...shortfall.values()] };
  }
  const consumes: Record<string, number> = {};
  for (const c of cells) consumes[c.item] = (consumes[c.item] ?? 0) + 1;
  cells.sort((a, b) => a.slot - b.slot);
  return { ok: true, placement: { cells, consumes } };
}
