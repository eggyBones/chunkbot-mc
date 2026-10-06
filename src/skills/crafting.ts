// Crafting family: craft any version-correct crafting recipe from the server
// jar data, in the 2x2 inventory grid or at a visible crafting table in reach.
//
// Mineflayer's bot.craft is a chain of awaited clicks with an optimistic
// result-slot write; cancelling its outer promise does not stop later clicks.
// This executor issues every click through the fenced actuator, waits for the
// SERVER's result slot before taking it, and confirms produced/consumed counts
// with a server resync. A missing ingredient or table is returned as evidence;
// gathering ingredients or placing a table are separate planner-chosen steps.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import type { Actuator } from '../execution/actuator.ts';
import { countsDiff, inventoryFromConfirmed, type Counts } from '../execution/ledger.ts';
import { planPlacement, type NormalizedRecipe } from '../knowledge/recipes.ts';
import { BLOCK_REACH, sessionWorld, eyeOf } from '../perception/perception.ts';
import { visibleFaces, type FaceName } from '../perception/visibility.ts';
import { admittedParameters, clientCounts, eyeDistanceToBlock, json, liveBlock, mk, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type SkillServices, type Unavailable } from './definition.ts';
import { HandleRefSchema, ItemKeySchema } from './refs.ts';

type Win = { id: number; slots: Array<{ name: string; count: number; stackSize: number; type: number } | null>; inventoryStart: number; inventoryEnd: number; selectedItem: unknown; updateSlot(i: number, item: unknown): void };

function windowCounts(win: Win): Counts {
  const counts: Counts = new Map();
  for (let s = win.inventoryStart; s < win.inventoryEnd; s += 1) {
    const it = win.slots[s];
    if (it) counts.set(mk(it.name), (counts.get(mk(it.name)) ?? 0) + it.count);
  }
  return counts;
}

function craftingRecipes(services: SkillServices, output: string, recipeId?: string): NormalizedRecipe[] {
  return (services.knowledge.recipes?.recipesFor(output) ?? []).filter((r) => r.family === 'crafting' && r.ingredients.length > 0 && (!recipeId || r.id === recipeId));
}

/** Max crafts possible with these counts for one recipe and grid. */
function maxCrafts(recipe: NormalizedRecipe, grid: 2 | 3, counts: Counts, cap: number): number {
  const pool = new Map(counts);
  let n = 0;
  while (n < cap) {
    const p = planPlacement(recipe, grid, pool);
    if (!p.ok) break;
    for (const [k, c] of Object.entries(p.placement.consumes)) pool.set(k, (pool.get(k) ?? 0) - c);
    n += 1;
  }
  return n;
}

/** Puts the cursor stack into the inventory region (stack onto matching, else an empty slot). */
async function putCursorAway(act: Actuator, win: Win, windowId: number): Promise<boolean> {
  const held = win.selectedItem as { name: string; count: number; stackSize: number } | null;
  if (!held) return true;
  let target: number | undefined;
  for (let s = win.inventoryStart; s < win.inventoryEnd; s += 1) {
    const it = win.slots[s];
    if (it && it.name === held.name && it.count + held.count <= it.stackSize) {
      target = s;
      break;
    }
  }
  if (target === undefined) for (let s = win.inventoryStart; s < win.inventoryEnd; s += 1) if (!win.slots[s]) target ??= s;
  if (target === undefined) return false;
  await act.click(target, 0, 0, windowId);
  return true;
}

export const craftItem: SkillDefinition<{ output: string; count: number; recipeId?: string | undefined; workstation?: { snapshotId: string; handle: string } | null | undefined }> = {
  descriptor: {
    id: 'craft_item',
    family: 'crafting',
    purpose: 'Craft an item from a version-correct crafting recipe using inventory ingredients, in the 2x2 inventory grid or at a visible crafting table within reach.',
    parameters: [
      { name: 'output', type: 'registry_key', description: 'item to craft (see recipe knowledge)', required: true },
      { name: 'count', type: 'integer', description: 'how many output items are wanted (rounded up to whole crafts)', required: true, minimum: 1, maximum: 576 },
      { name: 'recipeId', type: 'string', description: 'specific recipe id when several produce the output', required: false },
      { name: 'workstation', type: 'handle', description: '{snapshotId, handle} of a visible crafting_table for 3x3 recipes', required: false },
    ],
    targets: ['workstation', 'inventory_item'],
    preconditions: ['ingredients in inventory (tag ingredients accept any member)', '3x3 recipes need a visible crafting table within reach', 'room for the output'],
    effects: ['ingredients consumed and outputs added (server-confirmed counts)'],
    supportedPredicates: ['crafting_result', 'inventory_amount', 'inventory_delta'],
    timeoutMs: 120_000,
    cancellation: 'stop fences every click (no click is sent after revocation) and closes the table/inventory so grid and cursor items return; completed crafts stay',
    limitations: [
      'does not gather ingredients or place a table',
      'special dynamic recipes (dyeing, fireworks, banner copy, repair) are not executed',
      'secondary workstation: a crafting table the task names, else any visible table within reach',
    ],
    evidence: ['server result-slot update per craft', 'server resync diff of produced/consumed items'],
  },
  params: z
    .object({
      output: ItemKeySchema,
      count: z.number().int().min(1).max(576),
      recipeId: z.string().max(200).optional(),
      workstation: HandleRefSchema.nullable().optional(),
    })
    .strict(),
  resolve(ctx) {
    const { services, snapshot, session, hints } = ctx;
    const counts = clientCounts(session.bot);
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    const admitted = admittedParameters(ctx, craftItem.params).values as { output?: string; count?: number; recipeId?: string; workstation?: { snapshotId: string; handle: string } | null };
    // Outputs: an admitted output/count is exact; otherwise the completion predicate's
    // quantities, minus what is already held for possession outcomes (no overproduction).
    const outputs = admitted.output
      ? [{ key: admitted.output, count: admitted.count ?? 1, exact: admitted.count !== undefined }]
      : hints.outputs
          .filter((o) => !o.key.startsWith('#'))
          .map((o) => ({ key: o.key, count: o.possess ? Math.max(0, o.count - (counts.get(o.key) ?? 0)) : o.count, exact: false }));
    if (outputs.length === 0) return { drafts, unavailable: [{ reason: 'no_output_named', detail: 'the task names no item to craft' }] };
    // Secondary mechanical target policy: a crafting table the task names (if any)
    // is the only eligible workstation; otherwise any visible table within reach.
    const scope = targetScope(ctx);
    const allTables = snapshot.blocks.filter((b) => b.key === 'minecraft:crafting_table');
    const namedTables = allTables.filter((t) => scope.named && scope.current.has(t.handle));
    const tables = admitted.workstation ? allTables.filter((t) => t.handle === admitted.workstation?.handle && snapshot.id === admitted.workstation?.snapshotId) : namedTables.length ? namedTables : allTables;
    const tableInReach = tables.find((t) => t.inReach);
    for (const out of outputs.slice(0, 4)) {
      if (out.count <= 0) {
        unavailable.push({ reason: 'already_satisfied', detail: `already holds the wanted ${out.key}`, evidence: { held: counts.get(out.key) ?? 0 } });
        continue;
      }
      const recipes = craftingRecipes(services, out.key, admitted.recipeId);
      if (recipes.length === 0) {
        const other = services.knowledge.recipes?.recipesFor(out.key).map((r) => r.type.replace('minecraft:', '')) ?? [];
        unavailable.push({ reason: 'no_crafting_recipe', detail: `no crafting recipe produces ${out.key}`, evidence: { otherRecipeTypes: [...new Set(other)].slice(0, 6) } });
        continue;
      }
      let best: { missing: Array<{ ingredient: string; need: number; have: number }>; recipe: string } | undefined;
      for (const recipe of recipes) {
        const inventoryOk = recipe.workstations.includes('inventory_2x2');
        const grid: 2 | 3 = inventoryOk ? 2 : 3;
        const crafts = Math.ceil(out.count / recipe.output.count);
        const possible = maxCrafts(recipe, grid, counts, crafts);
        if (possible === 0 || (out.exact && possible < crafts)) {
          const p = planPlacement(recipe, grid, counts);
          if (!p.ok && (!best || p.missing.length < best.missing.length)) best = { missing: p.missing.map(({ ingredient, need, have }) => ({ ingredient, need, have })), recipe: recipe.id };
          else if (p.ok && !best) {
            // Enough for some crafts, but fewer than the exact admitted count: report the shortfall.
            best = { missing: [{ ingredient: `ingredients for ${crafts} crafts`, need: crafts, have: possible }], recipe: recipe.id };
          }
          continue;
        }
        if (!inventoryOk && !tableInReach) {
          unavailable.push({
            reason: 'workstation_required',
            detail: `${out.key} needs a crafting table within reach`,
            evidence: { workstation: 'minecraft:crafting_table', visibleTables: json(tables.slice(0, 3).map((t) => ({ handle: t.handle, distance: t.distance }))), recipe: recipe.id },
          });
          continue;
        }
        drafts.push({
          parameters: { output: out.key, count: Math.min(out.count, possible * recipe.output.count), recipeId: recipe.id, workstation: inventoryOk ? null : { snapshotId: snapshot.id, handle: (tableInReach as { handle: string }).handle } },
          description: `craft ${Math.min(out.count, possible * recipe.output.count)} ${out.key} (${recipe.id}${inventoryOk ? ', inventory grid' : ', crafting table'})`,
          criteria: [`${possible < crafts ? `ingredients for ${possible} of ${crafts} crafts` : 'all ingredients present'}`],
        });
        break;
      }
      if (best && !drafts.some((d) => d.parameters['output'] === out.key)) {
        unavailable.push({ reason: 'missing_ingredients', detail: `not enough ingredients for ${out.key}`, evidence: { recipe: best.recipe, missing: json(best.missing) } });
      }
    }
    return { drafts: drafts.slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    const output = mk(params.output);
    const recipes = craftingRecipes(services, output, params.recipeId);
    if (recipes.length === 0) return precondition('no_crafting_recipe', `no crafting recipe produces ${output}${params.recipeId ? ` with id ${params.recipeId}` : ''}`);
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');

    // Workstation (3x3) validation.
    let table: { x: number; y: number; z: number; face: FaceName } | undefined;
    if (params.workstation) {
      const live = liveBlock(services, session, params.workstation.snapshotId, params.workstation.handle);
      if ('error' in live) return precondition(live.error, live.detail);
      if (live.name !== 'crafting_table') return precondition('not_a_crafting_table', `${params.workstation.handle} is ${live.name}`);
      const d = eyeDistanceToBlock(bot, live.x, live.y, live.z);
      if (d > BLOCK_REACH) return precondition('out_of_reach', `crafting table is ${d.toFixed(1)} blocks away`, { distance: Math.round(d * 10) / 10 });
      const faces = visibleFaces(sessionWorld(session), eyeOf(bot), live.x, live.y, live.z);
      if (faces.length === 0) return precondition('not_visible', 'crafting table is not visible');
      table = { x: live.x, y: live.y, z: live.z, face: faces[0] as FaceName };
    }
    const grid: 2 | 3 = table ? 3 : 2;
    const usable = recipes.filter((r) => (grid === 2 ? r.workstations.includes('inventory_2x2') : true));
    if (usable.length === 0) {
      return precondition('workstation_required', `${output} needs a crafting table (3x3 grid)`, { workstation: 'minecraft:crafting_table' });
    }

    // Server-confirmed starting inventory.
    const before = await act.confirmWindow();
    if (!before) return failed('no_server_sync', 'inventory resync failed');
    const beforeView = inventoryFromConfirmed(before, 9, services.clock.now());
    let recipe: NormalizedRecipe | undefined;
    let crafts = 0;
    let missing: unknown = null;
    for (const r of usable) {
      const wanted = Math.ceil(params.count / r.output.count);
      const n = maxCrafts(r, grid, beforeView.counts, wanted);
      if (n > 0) {
        recipe = r;
        crafts = n;
        break;
      }
      const p = planPlacement(r, grid, beforeView.counts);
      if (!p.ok) missing ??= p.missing;
    }
    if (!recipe) return precondition('missing_ingredients', `not enough ingredients to craft ${output}`, { missing: json(missing), inventory: json(Object.fromEntries(beforeView.counts)) });
    const wantedCrafts = Math.ceil(params.count / recipe.output.count);

    // Open the interface.
    let win: Win;
    let windowId: number;
    if (table) {
      const opened = await act.openBlockWindow(table, table.face);
      win = opened as unknown as Win;
      windowId = win.id;
      if (!String((opened as unknown as { type: string }).type).startsWith('minecraft:crafting')) return failed('wrong_interface', `opened ${(opened as unknown as { type: string }).type}`);
    } else {
      win = bot.inventory as unknown as Win;
      windowId = 0;
      act.usedInventoryGrid = true;
    }
    const resultKeyOf = (seq: number) => session.evidence.since(seq, 'set_slot', (e) => e.windowId === windowId && e.slot === 0).at(-1)?.stack?.key ?? null;
    let completed = 0;
    let lastResultSeq = 0;
    for (let i = 0; i < crafts; i += 1) {
      const plan = planPlacement(recipe, grid, windowCounts(win));
      if (!plan.ok) break;
      // Place one ingredient per grid cell, holding each item stack while filling its cells.
      const byItem = new Map<string, number[]>();
      for (const cell of plan.placement.cells) byItem.set(cell.item, [...(byItem.get(cell.item) ?? []), cell.slot]);
      const placeSeq = session.evidence.seq;
      for (const [item, cells] of byItem) {
        let pending = [...cells];
        while (pending.length > 0) {
          let source: number | undefined;
          for (let s = win.inventoryStart; s < win.inventoryEnd; s += 1) if (win.slots[s] && mk(win.slots[s]!.name) === item) source ??= s;
          if (source === undefined) throw new Error(`ingredient ${item} vanished from the window model`);
          await act.click(source, 0, 0, windowId); // pick up the stack
          while (pending.length > 0 && win.selectedItem) {
            await act.click(pending.shift() as number, 1, 0, windowId); // place one
          }
          if (win.selectedItem) await act.click(source, 0, 0, windowId); // return the rest
        }
      }
      // Wait for the SERVER to compute the result slot.
      const result = await act.waitServer('set_slot', (e) => e.windowId === windowId && e.slot === 0 && e.stack?.key === output, placeSeq, 2_000);
      if (!result) {
        const got = resultKeyOf(placeSeq);
        return failed('no_recipe_result', `server did not offer ${output} for the placed ingredients (result slot: ${got ?? 'empty'})`, { craftsCompleted: completed });
      }
      lastResultSeq = result.seq;
      await act.click(0, 0, 0, windowId); // take the result onto the cursor
      // The server consumes one of each grid ingredient; mirror it in the local model.
      for (const cell of plan.placement.cells) {
        const it = win.slots[cell.slot];
        if (!it) continue;
        if (it.count <= 1) win.updateSlot(cell.slot, null);
        else it.count -= 1;
      }
      if (!(await putCursorAway(act, win, windowId))) return failed('inventory_full', 'no room for the crafted item', { craftsCompleted: completed });
      completed += 1;
      ctx.progress({ craftsCompleted: completed, output, lastResultServerSeq: lastResultSeq });
    }
    // Authoritative after-state from the server.
    const after = await act.confirmWindow();
    if (table) act.closeWindow(win as never);
    if (!after) return failed('no_server_sync', 'post-craft resync failed', { craftsCompleted: completed });
    const afterView = inventoryFromConfirmed(after, windowId === 0 ? 9 : win.inventoryStart, services.clock.now());
    const gridLeft = windowId === 0 ? [1, 2, 3, 4].filter((s) => after.slots.has(s)).length : 0;
    if (gridLeft > 0 || after.cursor) act.closeInventory(); // returns stray grid/cursor items
    const diff = countsDiff(beforeView.counts, afterView.counts);
    const produced = diff[output] ?? 0;
    const consumed: Record<string, number> = {};
    for (const [k, v] of Object.entries(diff)) if (v < 0) consumed[k] = -v;
    if (produced > 0) services.ledger.add({ kind: 'crafted', output, count: produced, consumed, atMs: services.clock.now() });
    for (const [k, v] of Object.entries(consumed)) services.ledger.add({ kind: 'consumed', item: k, count: v, atMs: services.clock.now(), via: 'craft_item' });
    const evidence: Record<string, JsonValue> = {
      recipe: recipe.id,
      workstation: table ? 'minecraft:crafting_table' : 'inventory_2x2',
      craftsRequested: wantedCrafts,
      craftsCompleted: completed,
      produced,
      consumed,
      yieldPerCraft: recipe.output.count,
    };
    if (produced <= 0) return failed('craft_not_confirmed', `server inventory shows no new ${output}`, evidence, 'server_sync');
    const full = completed >= wantedCrafts && produced >= params.count;
    return {
      status: full ? 'succeeded' : 'partial',
      effect: `crafted ${produced} ${output} via ${recipe.id} (${completed}/${wantedCrafts} crafts, server-confirmed); consumed ${Object.entries(consumed).map(([k, v]) => `${v} ${k.replace('minecraft:', '')}`).join(', ')}`,
      confirmation: 'server_sync',
      evidence,
      ...(full ? {} : { reason: 'insufficient_ingredients_for_full_count' }),
    };
  },
};
