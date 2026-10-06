// Placement and interaction family: place an inventory block against a visible
// face, interact (right-click) with a visible block, and use the held item.
// Effects are confirmed by server block changes, window openings, inventory
// resyncs or health packets; "no observed effect" is reported honestly.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import { BLOCK_REACH, sessionWorld, eyeOf } from '../perception/perception.ts';
import { faceNormal, visibleFaces, type FaceName } from '../perception/visibility.ts';
import { admittedParameters, clientCounts, json, confirmInventory, ensureInHand, eyeDistanceToBlock, liveBlock, matchesHints, mk, namedTargetUnavailable, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type Unavailable } from './definition.ts';
import { FaceSchema, HandleRefSchema, ItemKeySchema } from './refs.ts';
import { countsDiff } from '../execution/ledger.ts';
import { createRequire } from 'node:module';

/** Blocks whose right-click opens/uses them (installed mineflayer-pathfinder data); placing against them needs sneaking. */
const INTERACTABLE = new Set<string>(createRequire(import.meta.url)('mineflayer-pathfinder/lib/interactable.json') as string[]);

const REPLACEABLE = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|tall_seagrass|short_dry_grass|tall_dry_grass|leaf_litter)$/;

function stateName(bot: { registry: unknown }, stateId: number): string {
  return (bot.registry as { blocksByStateId: Record<number, { name: string } | undefined> }).blocksByStateId[stateId]?.name ?? `state_${stateId}`;
}

/**
 * A collidable entity (player, mob, vehicle; not items or orbs) whose box
 * intersects the voxel: the vanilla server refuses to place a block there.
 * Returns only a coarse kind, never coordinates.
 */
export function occupyingEntity(bot: { entities: Record<string, unknown>; entity: unknown }, x: number, y: number, z: number): string | undefined {
  for (const raw of Object.values(bot.entities)) {
    const e = raw as { name?: string; type?: string; position?: { x: number; y: number; z: number }; width?: number; height?: number } | undefined;
    if (!e?.position || raw === bot.entity) continue;
    if (e.name === 'item' || e.name === 'experience_orb' || e.type === 'orb' || e.name === 'arrow') continue;
    const w = (e.width ?? 0.6) / 2;
    const h = e.height ?? 1.8;
    if (x + 1 > e.position.x - w && x < e.position.x + w && z + 1 > e.position.z - w && z < e.position.z + w && y + 1 > e.position.y && y < e.position.y + h) return e.type === 'player' ? 'player' : (e.name ?? 'entity');
  }
  return undefined;
}

/** Whether the voxel would intersect the bot's own hitbox (0.6 x 1.8). */
function intersectsBot(p: { x: number; y: number; z: number }, x: number, y: number, z: number): boolean {
  return x + 1 > p.x - 0.3 && x < p.x + 0.3 && z + 1 > p.z - 0.3 && z < p.z + 0.3 && y + 1 > p.y && y < p.y + 1.8;
}

export const placeBlock: SkillDefinition<{ item: string; against: { snapshotId: string; handle: string }; face: FaceName }> = {
  descriptor: {
    id: 'place_block',
    family: 'placement',
    purpose: 'Place a block item from the inventory against a visible face of a block within reach.',
    parameters: [
      { name: 'item', type: 'registry_key', description: 'placeable item in the inventory', required: true },
      { name: 'against', type: 'handle', description: '{snapshotId, handle} of the visible block to place against', required: true },
      { name: 'face', type: 'string', description: 'face of that block to place on', required: true, enum: ['up', 'down', 'north', 'south', 'west', 'east'] },
    ],
    targets: ['block', 'inventory_item'],
    preconditions: ['item in inventory', 'face visible and within reach', 'destination empty/replaceable and not occupied by the bot'],
    effects: ['new block at the destination (server-confirmed); one item consumed'],
    supportedPredicates: ['block_state'],
    timeoutMs: 15_000,
    cancellation: 'stop prevents the placement packet if not yet sent; a confirmed placement persists',
    limitations: ['does not choose where a structure should go; the planner/decision picks the face', 'directional state (stairs facing) follows the look direction'],
    evidence: ['server block_change at the destination', 'server inventory resync'],
  },
  params: z.object({ item: ItemKeySchema, against: HandleRefSchema, face: FaceSchema }).strict(),
  resolve(ctx) {
    const { session, services, snapshot, hints } = ctx;
    const bot = session.bot;
    const counts = clientCounts(bot);
    const admitted = admittedParameters(ctx, placeBlock.params).values as { item?: string; face?: FaceName };
    const items = [...counts.keys()].filter((k) => services.knowledge.blockInfo(k) && (admitted.item ? admitted.item === k : hints.keys.length > 0 && matchesHints(k, hints, services)));
    if (items.length === 0) return { drafts: [], unavailable: [{ reason: 'no_placeable_item', detail: 'no placeable inventory item matches the task', evidence: { wanted: hints.keys.slice(0, 6) } }] };
    const world = sessionWorld(session);
    const eye = eyeOf(bot);
    const p = bot.entity.position;
    const scope = targetScope(ctx);
    const sites: CandidateDraft[] = [];
    // For a NAMED support, every face's exclusion reason is reported (structured feedback).
    const faceReasons: Array<{ face: string; excluded: string }> = [];
    for (const hit of services.perception.seenBlocks(snapshot.id)?.values() ?? []) {
      if (hit.block.shapes.length === 0) continue;
      // Prefer plain faces: right-clicking an interactable block would use it instead of placing.
      if (INTERACTABLE.has(hit.block.name) && !scope.named) continue;
      const handle = services.perception.blockHandle(snapshot.id, hit.x, hit.y, hit.z);
      if (!handle || !scope.allows(handle)) continue;
      const d = eyeDistanceToBlock(bot, hit.x, hit.y, hit.z);
      if (d > BLOCK_REACH - 0.3) {
        if (scope.named) faceReasons.push({ face: 'all', excluded: `out_of_reach (${d.toFixed(1)} > ${(BLOCK_REACH - 0.3).toFixed(1)})` });
        continue;
      }
      const visible = visibleFaces(world, eye, hit.x, hit.y, hit.z);
      if (scope.named) for (const f of ['up', 'down', 'north', 'south', 'west', 'east']) if (!visible.includes(f as FaceName)) faceReasons.push({ face: f, excluded: 'not_visible' });
      for (const face of visible) {
        if (admitted.face && admitted.face !== face) continue;
        const n = faceNormal(face);
        const dx = hit.x + n.x;
        const dy = hit.y + n.y;
        const dz = hit.z + n.z;
        const dest = world.blockAt(dx, dy, dz);
        const occupant = dest && REPLACEABLE.test(dest.name) && !intersectsBot(p, dx, dy, dz) ? occupyingEntity(bot, dx, dy, dz) : undefined;
        const excluded = !dest ? 'destination_unloaded' : !REPLACEABLE.test(dest.name) ? `destination_holds_${dest.name}` : intersectsBot(p, dx, dy, dz) ? 'destination_occupied_by_bot' : occupant ? `destination_occupied_by_${occupant}` : undefined;
        if (excluded) {
          if (scope.named) faceReasons.push({ face, excluded });
          continue;
        }
        sites.push({
          parameters: { item: items[0] as string, against: { snapshotId: snapshot.id, handle }, face },
          description: `place ${items[0]} on the ${face} face of ${hit.block.name} at ${hit.x},${hit.y},${hit.z} (-> ${dx},${dy},${dz})`,
          score: (face === 'up' ? 10 : 0) - d,
        });
      }
    }
    sites.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const unavailable: Unavailable[] = sites.length
      ? []
      : [
          scope.named && scope.current.size === 0
            ? namedTargetUnavailable(scope, 'support block')
            : { reason: 'no_placement_site', detail: 'no visible free face within reach (faces whose space is occupied by the bot or another entity are excluded)', evidence: faceReasons.length ? { faces: json(faceReasons.slice(0, 12)) } : {} },
        ];
    return { drafts: sites.slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    const item = mk(params.item);
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const live = liveBlock(services, session, params.against.snapshotId, params.against.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    const d = eyeDistanceToBlock(bot, live.x, live.y, live.z);
    if (d > BLOCK_REACH) return precondition('out_of_reach', `${live.name} is ${d.toFixed(1)} blocks away`, { distance: Math.round(d * 10) / 10 });
    const world = sessionWorld(session);
    if (!visibleFaces(world, eyeOf(bot), live.x, live.y, live.z).includes(params.face)) return precondition('face_not_visible', `${params.face} face of ${live.name} is not visible`);
    const n = faceNormal(params.face);
    const dest = { x: live.x + n.x, y: live.y + n.y, z: live.z + n.z };
    const destBlock = world.blockAt(dest.x, dest.y, dest.z);
    if (!destBlock || !REPLACEABLE.test(destBlock.name)) return precondition('destination_occupied', `destination ${dest.x},${dest.y},${dest.z} holds ${destBlock?.name ?? 'unloaded'}`);
    if (intersectsBot(bot.entity.position, dest.x, dest.y, dest.z)) return precondition('destination_occupied_by_bot', 'the bot is standing in the destination');
    const occupant = occupyingEntity(bot as never, dest.x, dest.y, dest.z);
    if (occupant) return precondition('destination_occupied_by_entity', `a ${occupant} occupies the destination; the server would refuse the placement`, { occupant });
    const held = await ensureInHand(act, services, item);
    if (!held.ok) return precondition('item_not_in_inventory', held.detail);
    const before = await confirmInventory(act, services);
    const startSeq = session.evidence.seq;
    const sneak = INTERACTABLE.has(live.name);
    let change;
    try {
      if (sneak) {
        act.setSneak(true); // shift-use places against an interactable block instead of using it
        await act.sleep(120);
      }
      await act.useOnBlock(live, params.face);
      // Hold shift until the server has answered the use: a block change at the
      // destination, or an interface opened instead (then stop waiting).
      const deadline = services.clock.now() + 2_500;
      while (services.clock.now() < deadline) {
        change = session.evidence.since(startSeq, 'block_change', (e) => e.x === dest.x && e.y === dest.y && e.z === dest.z)[0];
        if (change || session.evidence.since(startSeq, 'open_window').length > 0) break;
        await act.sleep(25);
      }
      await act.sleep(150); // an interface opened instead would arrive with or just after the block updates
    } finally {
      if (sneak && act.lease.active) act.setSneak(false);
    }
    const opened = session.evidence.since(startSeq, 'open_window')[0];
    if (opened) {
      if (bot.currentWindow) act.closeWindow(bot.currentWindow as never);
      return failed('opened_interface_instead', `using ${live.name} opened ${opened.windowType} instead of placing; closed it`, { interface: opened.windowType }, 'server_packet');
    }
    if (!change) return failed('placement_unconfirmed', `server sent no block change at ${dest.x},${dest.y},${dest.z}`, {}, 'none');
    const placed = stateName(bot, change.stateId);
    if (REPLACEABLE.test(placed)) return failed('server_refused_placement', `server kept ${placed} at the destination`, {}, 'server_packet');
    ctx.progress({ placed: mk(placed), at: dest }, 'server_packet');
    services.ledger.add({ kind: 'block_changed', ...dest, from: mk(destBlock.name), to: mk(placed), atMs: change.atMs, actionId: ctx.candidate.id });
    services.ledger.setResult(ctx.candidate.id, { dimension: String(bot.game.dimension), ...dest, key: mk(placed) });
    services.perception.remember(`placed ${placed}`, dest, 'skill_result');
    const after = await confirmInventory(act, services);
    const used = before && after ? (before.counts.get(item) ?? 0) - (after.counts.get(item) ?? 0) : null;
    return {
      status: 'succeeded',
      effect: `placed ${mk(placed)} at ${dest.x},${dest.y},${dest.z} (server block change); ${item} used: ${used ?? 'unknown'}`,
      confirmation: 'server_packet',
      evidence: { placed: mk(placed), at: dest, against: { x: live.x, y: live.y, z: live.z, face: params.face }, itemUsed: used, priorResult: ctx.candidate.id },
    };
  },
};

export const interactBlock: SkillDefinition<{ target: { snapshotId: string; handle: string }; face?: FaceName | undefined; withItem?: string | null | undefined }> = {
  descriptor: {
    id: 'interact_block',
    family: 'interaction',
    purpose: 'Right-click (use) a visible block within reach, optionally holding an item first (e.g. a lever, door, button, bone meal on a plant, a bucket on water).',
    parameters: [
      { name: 'target', type: 'handle', description: '{snapshotId, handle} of the visible block', required: true },
      { name: 'face', type: 'string', description: 'face to click (default: first visible)', required: false, enum: ['up', 'down', 'north', 'south', 'west', 'east'] },
      { name: 'withItem', type: 'registry_key', description: 'item to hold while using, or omit for the current hand', required: false },
    ],
    targets: ['block'],
    preconditions: ['block visible and within reach'],
    effects: ['whatever the game does for that block/item: state change, opened interface, inventory change'],
    supportedPredicates: ['block_state', 'inventory_amount'],
    timeoutMs: 15_000,
    cancellation: 'stop prevents the use packet if not yet sent and closes any interface this action opened',
    limitations: ['an opened interface is closed immediately (use container/furnace skills to operate it)', 'reports no_observed_effect when the server shows no change'],
    evidence: ['server block_change at/near the block, open_window, or inventory resync diff'],
  },
  params: z.object({ target: HandleRefSchema, face: FaceSchema.optional(), withItem: ItemKeySchema.nullable().optional() }).strict(),
  resolve(ctx) {
    const { snapshot, hints } = ctx;
    const scope = targetScope(ctx);
    const admitted = admittedParameters(ctx, interactBlock.params).values as { face?: FaceName; withItem?: string | null };
    const drafts: CandidateDraft[] = snapshot.blocks
      .filter((b) => b.inReach && (scope.named ? scope.allows(b.handle) : hints.keys.length > 0 && matchesHints(b.key, hints, ctx.services)))
      .slice(0, 6)
      .map((b) => ({ parameters: { target: { snapshotId: snapshot.id, handle: b.handle }, ...(admitted.face ? { face: admitted.face } : {}), ...(admitted.withItem ? { withItem: admitted.withItem } : {}) }, description: `use ${b.key} at ${b.at.x},${b.at.y},${b.at.z}` }));
    return { drafts, unavailable: drafts.length ? [] : [scope.named ? namedTargetUnavailable(scope, 'block within reach') : { reason: 'no_visible_target', detail: 'no visible block within reach matches the task' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const live = liveBlock(services, session, params.target.snapshotId, params.target.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    const d = eyeDistanceToBlock(bot, live.x, live.y, live.z);
    if (d > BLOCK_REACH) return precondition('out_of_reach', `${live.name} is ${d.toFixed(1)} blocks away`);
    const faces = visibleFaces(sessionWorld(session), eyeOf(bot), live.x, live.y, live.z);
    const face = params.face ?? faces[0];
    if (!face || !faces.includes(face)) return precondition('face_not_visible', `${live.name} has no visible face to use`);
    if (params.withItem) {
      const held = await ensureInHand(act, services, mk(params.withItem));
      if (!held.ok) return precondition('item_not_in_inventory', held.detail);
    }
    const before = await confirmInventory(act, services);
    const startSeq = session.evidence.seq;
    await act.useOnBlock(live, face);
    await act.sleep(700);
    const changes = session.evidence.since(startSeq, 'block_change', (e) => Math.abs(e.x - live.x) <= 1 && Math.abs(e.y - live.y) <= 1 && Math.abs(e.z - live.z) <= 1);
    const opened = session.evidence.since(startSeq, 'open_window')[0];
    const evidence: Record<string, JsonValue> = { block: mk(live.name), at: { x: live.x, y: live.y, z: live.z } };
    if (opened) {
      evidence['openedInterface'] = opened.windowType;
      const w = bot.currentWindow;
      if (w) act.closeWindow(w as never);
    }
    evidence['blockChanges'] = changes.slice(0, 8).map((c) => ({ x: c.x, y: c.y, z: c.z, to: mk(stateName(bot, c.stateId)) }));
    const after = bot.currentWindow ? undefined : await confirmInventory(act, services);
    const diff = before && after ? countsDiff(before.counts, after.counts) : {};
    evidence['inventoryChange'] = diff;
    for (const c of changes) services.ledger.add({ kind: 'block_changed', x: c.x, y: c.y, z: c.z, from: c.x === live.x && c.y === live.y && c.z === live.z ? mk(live.name) : 'unknown', to: mk(stateName(bot, c.stateId)), atMs: c.atMs, actionId: ctx.candidate.id });
    if (!opened && changes.length === 0 && Object.keys(diff).length === 0) {
      return failed('no_observed_effect', `used ${mk(live.name)} but the server reported no block, interface or inventory change`, evidence, 'none');
    }
    return {
      status: 'succeeded',
      effect: `used ${mk(live.name)}: ${opened ? `opened ${opened.windowType} (closed); ` : ''}${changes.length} server block change(s); inventory change ${JSON.stringify(diff)}`,
      confirmation: 'server_packet',
      evidence,
    };
  },
};

export const useHeldItem: SkillDefinition<{ item?: string | undefined }> = {
  descriptor: {
    id: 'use_held_item',
    family: 'interaction',
    purpose: 'Use (right-click in the air) an inventory item, e.g. eat food; optionally selects the item first.',
    parameters: [{ name: 'item', type: 'registry_key', description: 'item to hold and use (default: current hand)', required: false }],
    targets: ['inventory_item'],
    preconditions: ['item in inventory; food requires hunger below full'],
    effects: ['item consumed/used per game rules (server-confirmed food/health/inventory change)'],
    supportedPredicates: ['inventory_amount'],
    timeoutMs: 10_000,
    cancellation: 'stop releases the use action immediately',
    limitations: ['reports no_observed_effect when the server shows no change'],
    evidence: ['server health/food packets', 'server inventory resync diff'],
  },
  params: z.object({ item: ItemKeySchema.optional() }).strict(),
  resolve(ctx) {
    const counts = clientCounts(ctx.session.bot);
    const food = ctx.session.bot.food ?? 20;
    const drafts: CandidateDraft[] = [];
    for (const [key] of counts) {
      if (ctx.hints.keys.length === 0 || !matchesHints(key, ctx.hints, ctx.services)) continue;
      const isFood = Boolean(ctx.services.knowledge.md?.foodsByName?.[key.replace('minecraft:', '')]);
      if (isFood && food >= 20) continue;
      drafts.push({ parameters: { item: key }, description: `use ${key}${isFood ? ' (eat)' : ''}` });
    }
    return { drafts: drafts.slice(0, 4), unavailable: drafts.length ? [] : [{ reason: food >= 20 ? 'not_hungry_or_no_item' : 'item_not_in_inventory', detail: 'no usable item matches the task' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    if (params.item) {
      const held = await ensureInHand(act, services, mk(params.item));
      if (!held.ok) return precondition('item_not_in_inventory', held.detail);
    }
    const heldKey = bot.heldItem ? mk(bot.heldItem.name) : null;
    if (!heldKey) return precondition('empty_hand', 'nothing in hand to use');
    const isFood = Boolean(services.knowledge.md?.foodsByName?.[heldKey.replace('minecraft:', '')]);
    if (isFood && (bot.food ?? 20) >= 20) return precondition('not_hungry', 'food is full; vanilla does not eat at full hunger');
    const before = await confirmInventory(act, services);
    const startSeq = session.evidence.seq;
    const foodBefore = bot.food ?? null;
    act.useHeldItem();
    try {
      await act.sleep(isFood ? 1_900 : 400);
    } finally {
      act.releaseHeldItem();
    }
    const health = session.evidence.since(startSeq, 'health').at(-1);
    const after = await confirmInventory(act, services);
    const diff = before && after ? countsDiff(before.counts, after.counts) : {};
    const evidence: Record<string, JsonValue> = { item: heldKey, foodBefore, foodAfter: health?.food ?? null, inventoryChange: diff };
    if (Object.keys(diff).length === 0 && (!health || health.food === foodBefore)) return failed('no_observed_effect', `used ${heldKey} with no server-confirmed change`, evidence);
    for (const [k, v] of Object.entries(diff)) if (v < 0) services.ledger.add({ kind: 'consumed', item: k, count: -v, atMs: services.clock.now(), via: 'use_held_item' });
    return { status: 'succeeded', effect: `used ${heldKey}: inventory ${JSON.stringify(diff)}${health ? `, food ${foodBefore} -> ${health.food}` : ''}`, confirmation: after ? 'server_sync' : 'server_packet', evidence };
  },
};

