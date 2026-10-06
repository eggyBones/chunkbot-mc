// Inventory family: inspect (server-confirmed), select/equip, and drop items.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import { admittedParameters, clientCounts, confirmInventory, countsRecord, ensureInHand, json, matchesHints, mk } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition } from './definition.ts';
import { ItemKeySchema } from './refs.ts';

const SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8, off_hand: 45 } as const;
type EquipSlot = 'hand' | keyof typeof SLOT_INDEX;

/** Equipment slot an item naturally goes to (by item kind), if any. */
export function naturalSlot(key: string): EquipSlot | undefined {
  const n = key.replace(/^minecraft:/, '');
  if (/_helmet$|^turtle_helmet$|_head$|_skull$|^carved_pumpkin$/.test(n)) return 'head';
  if (/_chestplate$|^elytra$/.test(n)) return 'torso';
  if (/_leggings$/.test(n)) return 'legs';
  if (/_boots$/.test(n)) return 'feet';
  if (n === 'shield') return 'off_hand';
  return undefined;
}

export const inspectInventory: SkillDefinition<Record<string, never>> = {
  descriptor: {
    id: 'inspect_inventory',
    family: 'inventory',
    purpose: 'Read the inventory and equipment as confirmed by a server resync (not the optimistic client model).',
    parameters: [],
    targets: ['none'],
    preconditions: ['connected; no other interface open'],
    effects: ['none (observation only)'],
    supportedPredicates: ['inventory_amount', 'inventory_delta', 'equipped'],
    timeoutMs: 5_000,
    cancellation: 'nothing to undo',
    limitations: ['reports at most 41 stacks'],
    evidence: ['server window resync of the player inventory'],
  },
  params: z.object({}).strict(),
  resolve() {
    return { drafts: [{ parameters: {}, description: 'confirm the inventory with the server' }] };
  },
  async execute(ctx) {
    if (ctx.session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const view = await confirmInventory(ctx.act, ctx.services);
    if (!view) return failed('no_server_sync', 'the server did not answer the inventory resync');
    const equipment: Record<string, JsonValue> = {};
    for (const [name, slot] of Object.entries(SLOT_INDEX)) equipment[name] = view.slots.get(slot)?.key ?? null;
    const held = ctx.session.bot.quickBarSlot ?? 0;
    equipment['hand'] = view.slots.get(36 + held)?.key ?? null;
    return {
      status: 'succeeded',
      effect: `server-confirmed inventory: ${[...view.counts.entries()].map(([k, n]) => `${k.replace('minecraft:', '')} x${n}`).join(', ') || 'empty'}`,
      confirmation: 'server_sync',
      evidence: { counts: countsRecord(view.counts), equipment, cursor: json(view.cursor) },
    };
  },
};

export const equipItem: SkillDefinition<{ item: string; slot: EquipSlot }> = {
  descriptor: {
    id: 'equip_item',
    family: 'inventory',
    purpose: 'Hold an inventory item in the main hand, or wear/hold it in an armor or off-hand slot.',
    parameters: [
      { name: 'item', type: 'registry_key', description: 'item key present in the inventory', required: true },
      { name: 'slot', type: 'string', description: 'equipment slot', required: true, enum: ['hand', 'off_hand', 'head', 'torso', 'legs', 'feet'] },
    ],
    targets: ['inventory_item'],
    preconditions: ['item in inventory', 'armor slots accept only matching armor (server rule)'],
    effects: ['item moves to the slot (server-confirmed)'],
    supportedPredicates: ['equipped'],
    timeoutMs: 10_000,
    cancellation: 'stop prevents further clicks; a stack held on the cursor returns to the inventory when the inventory is closed',
    limitations: ['uses window clicks; the server may reject an invalid slot, which is reported'],
    evidence: ['server inventory resync of the target slot'],
  },
  params: z.object({ item: ItemKeySchema, slot: z.enum(['hand', 'off_hand', 'head', 'torso', 'legs', 'feet']) }).strict(),
  resolve(ctx) {
    const counts = clientCounts(ctx.session.bot);
    const drafts: CandidateDraft[] = [];
    const completion = ctx.task.completion;
    const admitted = admittedParameters(ctx, equipItem.params).values as { item?: string; slot?: EquipSlot };
    const wantSlot = admitted.slot ?? (completion.predicate === 'equipped' ? completion.slot : undefined);
    const alreadyEquipped: string[] = [];
    for (const [key] of counts) {
      if (admitted.item ? admitted.item !== key : !matchesHints(key, ctx.hints, ctx.services) || ctx.hints.keys.length === 0) continue;
      const slot = wantSlot ?? naturalSlot(key) ?? 'hand';
      if (slot !== 'hand' && slot !== 'off_hand' && naturalSlot(key) !== slot) continue; // the server rejects other armor slots
      // Already in that slot in the current observation: equipping again has no effect (no candidate).
      if (ctx.snapshot.equipment[slot] === key) {
        alreadyEquipped.push(`${key} in ${slot}`);
        continue;
      }
      drafts.push({ parameters: { item: key, slot }, description: `equip ${key} in ${slot}` });
    }
    return {
      drafts: drafts.slice(0, 6),
      unavailable: drafts.length
        ? []
        : alreadyEquipped.length
          ? [{ reason: 'already_equipped', detail: `already equipped: ${alreadyEquipped.slice(0, 3).join(', ')}`, evidence: { equipped: alreadyEquipped.slice(0, 4) } }]
          : [{ reason: 'item_not_in_inventory', detail: 'no inventory item matches the task', evidence: { wanted: ctx.hints.keys.slice(0, 8) } }],
    };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const key = mk(params.item);
    if ((clientCounts(bot).get(key) ?? 0) === 0) return precondition('item_not_in_inventory', `${key} is not in the inventory`);
    if (params.slot === 'hand') {
      const r = await ensureInHand(act, services, key);
      return r.ok
        ? r.confirmed
          ? { status: 'succeeded', effect: `${key} held in main hand (${r.detail})`, confirmation: 'server_sync', evidence: { slot: 'hand', hotbar: r.hotbar ?? null, serverConfirmed: true } }
          : { status: 'partial', reason: 'not_server_confirmed', effect: `${key} appears held per the client model (${r.detail}); the server did not confirm it`, confirmation: 'client_only', evidence: { slot: 'hand', hotbar: r.hotbar ?? null, serverConfirmed: false } }
        : failed('equip_failed', r.detail);
    }
    const natural = naturalSlot(key);
    if (params.slot !== 'off_hand' && natural !== params.slot) return precondition('wrong_slot', `${key} cannot be worn in ${params.slot}`);
    const dest = SLOT_INDEX[params.slot];
    let source: number | undefined;
    for (let s = 9; s <= 44; s += 1) {
      const it = bot.inventory.slots[s];
      if (it && mk(it.name) === key) source = s;
    }
    if (source === undefined) return precondition('item_not_in_inventory', `${key} not found in the main inventory/hotbar`);
    act.usedInventoryGrid = true;
    await act.click(source, 0, 0, 0);
    await act.click(dest, 0, 0, 0);
    if ((bot.inventory as unknown as { selectedItem: unknown }).selectedItem) await act.click(source, 0, 0, 0);
    const view = await confirmInventory(act, services);
    if (!view) return failed('no_server_confirmation', `no server inventory resync after moving ${key} to ${params.slot}`, { slot: params.slot }, 'none');
    const now = view.slots.get(dest)?.key ?? null;
    if (now !== key) return failed('server_rejected_equip', `server reports ${now ?? 'empty'} in ${params.slot}`, {}, 'server_sync');
    return { status: 'succeeded', effect: `${key} equipped in ${params.slot} (server-confirmed)`, confirmation: 'server_sync', evidence: { slot: params.slot, windowSlot: dest } };
  },
};

export const dropItem: SkillDefinition<{ item: string; count: number }> = {
  descriptor: {
    id: 'drop_item',
    family: 'transfer',
    purpose: 'Drop a number of an inventory item on the ground in front of the bot.',
    parameters: [
      { name: 'item', type: 'registry_key', description: 'item key in the inventory', required: true },
      { name: 'count', type: 'integer', description: 'how many to drop', required: true, minimum: 1, maximum: 2304 },
    ],
    targets: ['inventory_item'],
    preconditions: ['enough of the item in the inventory'],
    effects: ['items leave the inventory and appear as dropped item entities near the bot'],
    supportedPredicates: ['inventory_amount'],
    timeoutMs: 25_000,
    cancellation: 'stop prevents further drop clicks; already-dropped items stay on the ground',
    limitations: ['dropping near a player is not proof they received it; receipt is claimed only from a server collect packet naming them'],
    evidence: ['server inventory resync delta', 'server item_spawn near the bot', 'collect packets for the dropped entities'],
  },
  params: z.object({ item: ItemKeySchema, count: z.number().int().min(1).max(2304) }).strict(),
  resolve(ctx) {
    const counts = clientCounts(ctx.session.bot);
    const drafts: CandidateDraft[] = [];
    const admitted = admittedParameters(ctx, dropItem.params).values as { item?: string; count?: number };
    if (ctx.hints.keys.length === 0 && !admitted.item) return { drafts, unavailable: [{ reason: 'no_item_named', detail: 'the task names no item to drop' }] };
    for (const [key, n] of counts) {
      if (admitted.item ? admitted.item !== key : !matchesHints(key, ctx.hints, ctx.services)) continue;
      const wanted = admitted.count ?? ctx.hints.outputs.find((o) => o.key === key)?.count ?? n;
      if (admitted.count !== undefined && n < admitted.count) continue; // never a partial of an admitted count
      drafts.push({ parameters: { item: key, count: Math.min(n, wanted) }, description: `drop ${Math.min(n, wanted)} ${key}` });
    }
    return { drafts: drafts.slice(0, 4), unavailable: drafts.length ? [] : [{ reason: 'item_not_in_inventory', detail: 'none of the named items are in the inventory' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const key = mk(params.item);
    const before = await confirmInventory(act, services);
    if (!before) return failed('no_server_sync', 'inventory resync failed');
    const have = before.counts.get(key) ?? 0;
    if (have < params.count) return precondition('not_enough_items', `have ${have} ${key}, need ${params.count}`, { have });
    const startSeq = session.evidence.seq;
    let remaining = params.count;
    for (const [slot, stack] of [...before.slots.entries()].sort((a, b) => a[0] - b[0])) {
      if (remaining <= 0) break;
      if (stack.key !== key || slot < 9) continue;
      if (stack.count <= remaining) {
        await act.click(slot, 1, 4, 0); // drop whole stack
        remaining -= stack.count;
      } else {
        for (let i = 0; i < remaining; i += 1) await act.click(slot, 0, 4, 0); // drop one
        remaining = 0;
      }
      ctx.progress({ dropClicksFor: params.count - remaining });
    }
    await act.sleep(300);
    const after = await confirmInventory(act, services);
    const dropped = after ? have - (after.counts.get(key) ?? 0) : null;
    const spawned = session.evidence.since(startSeq, 'item_spawn', (e) => Math.hypot(e.x - bot.entity.position.x, e.z - bot.entity.position.z) < 4);
    const spawnedIds = spawned.map((s) => s.entityId);
    // Passive watch for a collect packet naming someone else (e.g. the owner).
    // Thrown items have a 40-tick (2 s) pickup delay in vanilla.
    await act.sleep(3_000);
    const collects = session.evidence.since(startSeq, 'collect', (e) => spawnedIds.includes(e.collectedEntityId));
    const owner = Object.values(bot.entities).find((e) => e && services.perception.isOwnerEntity(bot, e));
    const ownerCollected = collects.filter((c) => owner && c.collectorEntityId === owner.id).reduce((n, c) => n + c.count, 0);
    if (dropped !== null && dropped > 0) services.ledger.add({ kind: 'dropped', item: key, count: dropped, atMs: services.clock.now() });
    const status = dropped === params.count ? 'succeeded' : dropped && dropped > 0 ? 'partial' : 'failed';
    return {
      status,
      effect: `dropped ${dropped ?? 'unknown'} ${key} (server-confirmed); ${spawned.length} item entities spawned near the bot${ownerCollected ? `; owner collected ${ownerCollected} (server collect packet)` : '; no player pickup observed'}`,
      confirmation: after ? 'server_sync' : 'server_packet',
      evidence: { item: key, requested: params.count, droppedConfirmed: dropped, spawnedEntities: spawned.length, ownerCollected, otherCollects: collects.length - (ownerCollected ? 1 : 0) },
      ...(status === 'failed' ? { reason: 'drop_not_confirmed' } : {}),
    };
  },
};
