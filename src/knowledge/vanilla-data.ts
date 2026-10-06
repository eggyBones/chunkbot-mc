// Shape of the generated version dataset (src/knowledge/data/vanilla-<version>.ts).
// Produced by scripts/extract-version-data.ts from the official server jar; the
// recipe objects keep Mojang's JSON fields so nothing is reinterpreted at
// extraction time.

/** A recipe ingredient: an item key, a `#tag`, or a list of alternatives. */
export type RawIngredient = string | string[];

export interface RawRecipe {
  id: string;
  type: string;
  category?: string;
  group?: string;
  // crafting_shaped (smithing_trim uses `pattern` for the trim pattern key)
  pattern?: string[] | string;
  key?: Record<string, RawIngredient>;
  // crafting_shapeless
  ingredients?: RawIngredient[];
  // cooking, stonecutting, transmute
  ingredient?: RawIngredient;
  input?: RawIngredient;
  material?: RawIngredient;
  cookingtime?: number;
  experience?: number;
  // smithing
  base?: RawIngredient;
  addition?: RawIngredient;
  template?: RawIngredient;
  result?: { id: string; count?: number; components?: unknown } | string;
  [extra: string]: unknown;
}

export interface VanillaData {
  provenance: {
    minecraftVersion: string;
    serverJarSha1: string;
    innerJarSha1: string;
    sources: string[];
    extractor: string;
    baseSmeltTicks: number;
    recipeTypeCounts: Record<string, number>;
  };
  recipes: RawRecipe[];
  /** Item tag key (without `#`) -> raw values (items or `#tags`). */
  itemTags: Record<string, string[]>;
  /** Item key or `#tag` -> burn time in game ticks (20 ticks = 1 second). */
  fuels: Array<{ target: string; burnTicks: number }>;
  /** Tags removed from the fuel table after the additions (e.g. non-flammable wood). */
  fuelRemovals: string[];
}
