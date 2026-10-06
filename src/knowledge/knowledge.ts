// Read-only, version-specific game knowledge. Answers come from INSTALLED data:
//   - minecraft-data for the configured version: items, blocks, hardness,
//     harvest tools, tool speed materials, block drops, foods;
//   - the generated dataset extracted from the official, SHA-1-verified server
//     jar OF THAT EXACT RELEASE: every recipe (crafting/cooking/stonecutting/
//     smithing), item tags, and vanilla fuel burn times. Datasets exist for
//     26.1.2 and (MB-SERVER-001) 26.2; one release's facts are never served as
//     another's.
// Queries describe what is POSSIBLE (recipes and requirements while ingredients
// or workstations are absent), not only what is craftable right now. Unknown
// mechanics are reported as unknown; a knowledge query never acts in the game.
import minecraftData from 'minecraft-data';
import type {
  CapabilityCatalog,
  JsonValue,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeResult,
  Readiness,
  RegistryFacts,
} from '../contracts/index.ts';
import { VANILLA_DATA as VANILLA_26_1_2 } from './data/vanilla-26.1.2.ts';
import { VANILLA_DATA as VANILLA_26_2 } from './data/vanilla-26.2.ts';
import type { VanillaData } from './vanilla-data.ts';
import { RecipeBook, type NormalizedRecipe } from './recipes.ts';

type McData = NonNullable<ReturnType<typeof minecraftData>>;

const LIST = 24;

/** Extracted mechanics datasets, keyed by the EXACT release whose official jar they came from. */
const DATASETS: ReadonlyMap<string, VanillaData> = new Map(
  [VANILLA_26_1_2, VANILLA_26_2].map((d) => [d.provenance.minecraftVersion, d] as const),
);

/** Releases with an extracted mechanics dataset (exact versions only). */
export function mechanicsVersions(): string[] {
  return [...DATASETS.keys()];
}

/**
 * Releases admitted to ANOTHER release's dataset after a bounded comparison
 * found their mechanics equal (release -> dataset release). Empty: no such
 * comparison has been made, so e.g. 26.1/26.1.1 get no mechanic answers.
 */
export const VERIFIED_EQUIVALENT_VERSIONS: Readonly<Record<string, string>> = {};

/** The mechanics dataset verified for this exact release, if any. */
export function mechanicsDatasetFor(version: string): VanillaData | undefined {
  return DATASETS.get(version) ?? DATASETS.get(VERIFIED_EQUIVALENT_VERSIONS[version] ?? '');
}

/** Whether a mechanics dataset is verified for this exact release. */
export function mechanicsVerifiedFor(version: string): boolean {
  return mechanicsDatasetFor(version) !== undefined;
}

const verifiedList = () => mechanicsVersions().join(', ');

function bounded<T>(list: readonly T[], max = LIST): { items: T[]; total: number; truncated: boolean } {
  return { items: list.slice(0, max), total: list.length, truncated: list.length > max };
}

const strip = (key: string) => key.replace(/^#?minecraft:/, '');
const mk = (name: string) => `minecraft:${name}`;

/** Capability IDs that can execute each recipe family/workstation (from the registered catalog). */
export interface RecipeExecutionMap {
  crafting?: string;
  cooking?: string[];
}

export interface VersionKnowledgeOptions {
  version: string;
  /** Lazily supplies the implemented capability catalog (capability queries, executable flags). */
  catalog?: () => CapabilityCatalog;
  execution?: RecipeExecutionMap;
}

export class VersionKnowledge implements KnowledgePort, RegistryFacts {
  readonly version: string;
  readonly md: McData | undefined;
  readonly recipes: RecipeBook | undefined;
  private readonly options: VersionKnowledgeOptions;
  private readonly droppedBy = new Map<string, string[]>();

  constructor(options: VersionKnowledgeOptions) {
    this.options = options;
    this.version = options.version;
    this.md = minecraftData(options.version) ?? undefined;
    // Each recipe/tag/fuel dataset was extracted from, and verified against, one exact
    // server jar (26.1.2 or 26.2). A shared network protocol (26.1/26.1.1 are also
    // protocol 775) does NOT establish equal mechanics, so other releases get no
    // mechanic answers until a bounded comparison admits them in VERIFIED_EQUIVALENT_VERSIONS.
    const dataset = mechanicsDatasetFor(options.version);
    this.recipes = dataset ? new RecipeBook(dataset) : undefined;
    if (this.md) {
      for (const block of this.md.blocksArray) {
        for (const id of block.drops ?? []) {
          const item = this.md.items[typeof id === 'number' ? id : (id as { drop: number }).drop]?.name;
          if (!item) continue;
          const list = this.droppedBy.get(item) ?? [];
          if (list.length < LIST) list.push(block.name);
          this.droppedBy.set(item, list);
        }
      }
    }
  }

  readiness(): Readiness {
    if (!this.md) return { ready: false, detail: `no installed minecraft-data for ${this.version}` };
    if (!this.recipes) {
      return {
        ready: true,
        detail: `items/blocks/harvest from minecraft-data ${this.md.version.minecraftVersion}; recipe/fuel/tag mechanics are verified only for exactly ${verifiedList()} and are unavailable for ${this.version} (protocol compatibility is not mechanic equivalence)`,
      };
    }
    return {
      ready: true,
      detail: `items/blocks/harvest from minecraft-data ${this.md.version.minecraftVersion} (protocol compatibility); recipe/fuel/tag mechanics: ${this.recipes.recipeCount} entries extracted from the ${this.recipes.version} server jar, used only for exactly ${this.recipes.version}`,
    };
  }

  async answer(queries: readonly KnowledgeQuery[], signal: AbortSignal): Promise<KnowledgeResult[]> {
    const out: KnowledgeResult[] = [];
    for (const query of queries) {
      if (signal.aborted) break;
      out.push(this.answerOne(query));
    }
    return out;
  }

  answerOne(query: KnowledgeQuery): KnowledgeResult {
    try {
      switch (query.kind) {
        case 'item':
          return this.item(query);
        case 'recipe':
          return this.recipe(query);
        case 'harvest':
          return this.harvest(query, query.block);
        case 'tool':
          return this.harvest(query, query.forBlock);
        case 'smelting':
          return this.smelting(query);
        case 'fuel':
          return this.fuel(query);
        case 'tag':
          return this.tag(query);
        case 'uses':
          return this.uses(query);
        case 'capability':
          return this.capability(query);
      }
    } catch (error) {
      return { status: 'unavailable', query, detail: `knowledge error: ${error instanceof Error ? error.message.slice(0, 150) : String(error)}` };
    }
  }

  // ------------------------------------------------------------ helpers

  itemExists(key: string): boolean {
    return Boolean(this.md?.itemsByName[strip(key)]);
  }

  // ------------------------------------------------------------ RegistryFacts (planner reference validation)

  isItem(key: string): boolean {
    return !key.startsWith('#') && /^minecraft:[a-z0-9_./-]+$/.test(key) && this.itemExists(key);
  }

  isBlock(key: string): boolean {
    return !key.startsWith('#') && /^minecraft:[a-z0-9_./-]+$/.test(key) && Boolean(this.blockInfo(key));
  }

  /** Item tags from the verified dataset (block-only tags are not item selectors). */
  isTag(key: string): boolean {
    return key.startsWith('#') && Boolean(this.recipes?.hasTag(key));
  }

  craftable(output: string): boolean {
    return this.isItem(output) && Boolean(this.recipes?.recipesFor(mk(strip(output))).some((r) => r.family === 'crafting'));
  }

  cookingOutput(output: string): boolean {
    return this.isItem(output) && Boolean(this.recipes?.recipesFor(mk(strip(output))).some((r) => r.family === 'cooking'));
  }

  blockInfo(key: string) {
    return this.md?.blocksByName[strip(key)];
  }

  /** Item keys whose use as a tool makes this block drop its items (empty = any tool or hand). */
  harvestTools(blockKey: string): string[] {
    const block = this.blockInfo(blockKey);
    if (!block?.harvestTools || !this.md) return [];
    return Object.keys(block.harvestTools)
      .map((id) => this.md?.items[Number(id)]?.name)
      .filter((n): n is string => Boolean(n))
      .map(mk);
  }

  /** Tool speed multipliers for this block's material (higher is faster). */
  toolSpeeds(blockKey: string): Array<{ tool: string; multiplier: number }> {
    const block = this.blockInfo(blockKey);
    if (!block || !this.md) return [];
    const out: Array<{ tool: string; multiplier: number }> = [];
    // minecraft-data sometimes records only an `incorrect_for_*` tier tag as the
    // material (e.g. iron_ore); infer the mining category from the harvest tools.
    const parts = String(block.material ?? '')
      .split(';')
      .filter((p) => p && !p.startsWith('incorrect_for_'));
    if (parts.length === 0) {
      const category = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(this.harvestTools(blockKey)[0] ?? '')?.[1];
      if (category) parts.push(`mineable/${category}`);
    }
    for (const part of parts) {
      const speeds = (this.md.materials as Record<string, Record<string, number>> | undefined)?.[part];
      if (!speeds) continue;
      for (const [id, mult] of Object.entries(speeds)) {
        const name = this.md.items[Number(id)]?.name;
        if (name) out.push({ tool: mk(name), multiplier: mult });
      }
    }
    return out.sort((a, b) => b.multiplier - a.multiplier);
  }

  blockDrops(blockKey: string): string[] {
    const block = this.blockInfo(blockKey);
    if (!block || !this.md) return [];
    return (block.drops ?? [])
      .map((id) => this.md?.items[typeof id === 'number' ? id : (id as { drop: number }).drop]?.name)
      .filter((n): n is string => Boolean(n))
      .map(mk);
  }

  private recipeView(r: NormalizedRecipe): JsonValue {
    const executableBy =
      r.family === 'crafting'
        ? (this.options.execution?.crafting ?? null)
        : r.family === 'cooking' && r.workstations[0] !== 'minecraft:campfire'
          ? (this.options.execution?.cooking ?? []).join(',') || null
          : null;
    const view: Record<string, JsonValue> = {
      id: r.id,
      type: strip(r.type),
      yields: r.output.count,
      workstations: r.workstations,
      ingredients: r.ingredients.map((i) => ({
        count: i.count,
        accepts: i.spec.label,
        options: bounded(i.spec.options, 12).items,
        ...(i.spec.options.length > 12 ? { optionsTotal: i.spec.options.length } : {}),
      })),
      executableBy,
    };
    if (r.grid) view['pattern'] = { width: r.grid.width, height: r.grid.height };
    if (r.cookingTicks !== undefined) {
      view['cookingTicks'] = r.cookingTicks;
      view['fuel'] = 'requires furnace fuel; see the fuel query for burn times';
    }
    if (r.family === 'crafting') view['mixing'] = 'tag ingredients match per slot (members may be mixed)';
    if (r.family === 'special') view['note'] = 'dynamic/special recipe: inputs depend on item data; no generic executor';
    return view;
  }

  // ------------------------------------------------------------ query kinds

  private item(query: Extract<KnowledgeQuery, { kind: 'item' }>): KnowledgeResult {
    if (!this.md) return { status: 'unavailable', query, detail: `no installed data for ${this.version}` };
    const name = strip(query.key);
    const item = this.md.itemsByName[name];
    if (!item) return { status: 'unknown', query, detail: `${query.key} is not an item in the ${this.version} registry` };
    const key = mk(name);
    const food = this.md.foodsByName?.[name];
    const data: Record<string, JsonValue> = {
      key,
      displayName: item.displayName,
      stackSize: item.stackSize,
      placeableBlock: Boolean(this.md.blocksByName[name]),
    };
    if (item.maxDurability) data['maxDurability'] = item.maxDurability;
    if (food) data['food'] = { foodPoints: food.foodPoints, saturation: food.saturation };
    if (this.recipes) {
      data['fuelTicks'] = this.recipes.fuelTicks(key) ?? null;
      data['producedByRecipes'] = this.recipes.recipesFor(key).length;
      data['smeltsInto'] = [...new Set(this.recipes.cookingFor(key).map((r) => r.output.key))].slice(0, 8);
      const tags = Object.keys(this.recipes.data.itemTags).filter((t) => this.recipes!.expand(`#${t}`).includes(key));
      data['tags'] = bounded(tags.map((t) => `#${t}`), 16).items;
    }
    data['droppedByBlocks'] = bounded(this.droppedBy.get(name) ?? [], 12).items.map(mk);
    return { status: 'known', query, data };
  }

  private recipe(query: Extract<KnowledgeQuery, { kind: 'recipe' }>): KnowledgeResult {
    if (!this.recipes) return { status: 'unavailable', query, detail: `no verified recipe mechanics for ${this.version} (datasets verified for exactly ${verifiedList()} only)` };
    if (query.output.startsWith('#')) return { status: 'unknown', query, detail: 'recipe queries take one output item key, not a tag' };
    if (!this.itemExists(query.output)) return { status: 'unknown', query, detail: `${query.output} is not an item in the ${this.version} registry` };
    const key = mk(strip(query.output));
    const recipes = this.recipes.recipesFor(key);
    const dropped = this.droppedBy.get(strip(key)) ?? [];
    if (recipes.length === 0) {
      if (dropped.length > 0) {
        return {
          status: 'known',
          query,
          data: { output: key, recipes: [], obtainedBy: 'block drops (mining)', droppedByBlocks: bounded(dropped, 12).items.map(mk) },
        };
      }
      return { status: 'unknown', query, detail: `no recipe or block drop produces ${key} in installed data (other mechanics such as mob loot/trading are not modeled)` };
    }
    const list = bounded(recipes, 8);
    return {
      status: 'known',
      query,
      data: {
        output: key,
        recipeCount: list.total,
        recipes: list.items.map((r) => this.recipeView(r)),
        ...(dropped.length ? { alsoDroppedByBlocks: bounded(dropped, 8).items.map(mk) } : {}),
        source: `server jar ${this.recipes.version} recipe data`,
      },
    };
  }

  private harvest(query: Extract<KnowledgeQuery, { kind: 'harvest' } | { kind: 'tool' }>, blockKey: string): KnowledgeResult {
    if (!this.md) return { status: 'unavailable', query, detail: `no installed data for ${this.version}` };
    const block = this.blockInfo(blockKey);
    if (!block) return { status: 'unknown', query, detail: `${blockKey} is not a block in the ${this.version} registry` };
    const tools = this.harvestTools(blockKey);
    const speeds = this.toolSpeeds(blockKey);
    const data: Record<string, JsonValue> = {
      block: mk(block.name),
      hardness: block.hardness ?? null,
      breakable: block.diggable && block.hardness !== null && (block.hardness ?? 0) >= 0,
      requiresTool: tools.length > 0,
      harvestTools: bounded(tools, 12).items,
      fasterWith: bounded(speeds.map((s) => `${s.tool} x${s.multiplier}`), 12).items,
      drops: this.blockDrops(blockKey),
      dropsNote:
        tools.length > 0
          ? 'drops only when broken with one of harvestTools; otherwise the block breaks with no drop'
          : 'drops when broken by hand or any tool (silk touch/fortune variations are not modeled)',
      solid: block.boundingBox === 'block',
    };
    return { status: 'known', query, data };
  }

  private smelting(query: Extract<KnowledgeQuery, { kind: 'smelting' }>): KnowledgeResult {
    if (!this.recipes) return { status: 'unavailable', query, detail: `no verified recipe mechanics for ${this.version} (datasets verified for exactly ${verifiedList()} only)` };
    const key = mk(strip(query.input));
    const recipes = this.recipes.cookingFor(key);
    if (recipes.length === 0) return { status: 'unknown', query, detail: `no furnace/smoker/blast/campfire recipe takes ${key}` };
    return {
      status: 'known',
      query,
      data: {
        input: key,
        recipes: bounded(recipes, 8).items.map((r) => this.recipeView(r)),
        fuelNote: 'furnace-type stations also need fuel in the fuel slot (see fuel query)',
      },
    };
  }

  private fuel(query: Extract<KnowledgeQuery, { kind: 'fuel' }>): KnowledgeResult {
    if (!this.recipes) return { status: 'unavailable', query, detail: `no verified fuel mechanics for ${this.version} (datasets verified for exactly ${verifiedList()} only)` };
    const base = this.recipes.data.provenance.baseSmeltTicks;
    if (query.item) {
      const key = mk(strip(query.item));
      const ticks = this.recipes.fuelTicks(key);
      if (ticks === undefined) {
        return { status: 'known', query, data: { item: key, isFuel: false, note: 'not in the vanilla furnace fuel table' } };
      }
      return { status: 'known', query, data: { item: key, isFuel: true, burnTicks: ticks, itemsSmeltedPerUnit: Math.round((ticks / base) * 100) / 100 } };
    }
    const entries = bounded(this.recipes.fuelEntries().sort((a, b) => b.burnTicks - a.burnTicks), 32);
    return {
      status: 'known',
      query,
      data: {
        baseSmeltTicks: base,
        fuels: entries.items.map((f) => ({ target: f.target, burnTicks: f.burnTicks })),
        total: entries.total,
        excludedTags: this.recipes.data.fuelRemovals,
      },
    };
  }

  private tag(query: Extract<KnowledgeQuery, { kind: 'tag' }>): KnowledgeResult {
    if (!this.recipes) return { status: 'unavailable', query, detail: `no verified tag data for ${this.version} (datasets verified for exactly ${verifiedList()} only)` };
    if (!this.recipes.hasTag(query.key)) return { status: 'unknown', query, detail: `${query.key} is not an item tag in ${this.recipes.version} data` };
    const members = bounded(this.recipes.expand(query.key), 32);
    return { status: 'known', query, data: { tag: query.key, members: members.items, total: members.total } };
  }

  private uses(query: Extract<KnowledgeQuery, { kind: 'uses' }>): KnowledgeResult {
    if (!this.recipes) return { status: 'unavailable', query, detail: `no verified recipe mechanics for ${this.version} (datasets verified for exactly ${verifiedList()} only)` };
    const recipes = this.recipes.recipesUsing(query.ingredient);
    if (recipes.length === 0) return { status: 'unknown', query, detail: `no recipe consumes ${query.ingredient}` };
    const list = bounded(recipes, 24);
    return {
      status: 'known',
      query,
      data: { ingredient: query.ingredient, outputs: list.items.map((r) => ({ output: r.output.key, type: strip(r.type), workstations: r.workstations })), total: list.total },
    };
  }

  private capability(query: Extract<KnowledgeQuery, { kind: 'capability' }>): KnowledgeResult {
    const catalog = this.options.catalog?.();
    if (!catalog) return { status: 'unavailable', query, detail: 'capability catalog not installed' };
    const entry = catalog.capabilities.find((c) => c.id === query.id);
    if (!entry) return { status: 'unknown', query, detail: `${query.id} is not an implemented capability (catalog ${catalog.catalogVersion})` };
    return { status: 'known', query, data: JSON.parse(JSON.stringify(entry)) as JsonValue };
  }
}
