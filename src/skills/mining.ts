// Resource family: mine a visible admitted block with a valid tool, and pick up
// a visible dropped item. Effects are confirmed by SERVER packets:
//   - break: a server block_change at the position to a different state
//     (Mineflayer's dig promise resolves on its own optimistic air update);
//   - drops: server-spawned item entities near the block with item metadata;
//   - pickup: a server `collect` packet naming the bot as collector, then a
//     server inventory resync.
import { Vec3 } from 'vec3';
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import { visibleFaces } from '../perception/visibility.ts';
import { sessionWorld, eyeOf, BLOCK_REACH } from '../perception/perception.ts';
import { admittedParameters, chooseTool, clientCounts, confirmInventory, countsRecord, ensureInHand, eyeDistanceToBlock, json, liveBlock, liveEntity, mk, namedTargetUnavailable, pos3, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type Unavailable } from './definition.ts';
import { distanceTo, goals, navigate } from './navigation.ts';
import { HandleRefSchema } from './refs.ts';

const LIQUID = /^(water|lava|bubble_column)$/;

/** Item keys a task wants that come from breaking a block (block itself, or its drops). */
function blockMatchesHints(name: string, keys: string[], drops: string[], book: { matches(sel: string, key: string): boolean } | undefined): boolean {
  if (keys.length === 0) return true;
  const block = mk(name);
  return keys.some((h) => {
    const m = (k: string) => (h.startsWith('#') ? Boolean(book?.matches(h, k)) : h === k);
    return m(block) || drops.some(m);
  });
}

export const mineBlock: SkillDefinition<{ target: { snapshotId: string; handle: string }; allowNoDrop: boolean }> = {
  descriptor: {
    id: 'mine_block',
    family: 'resource',
    purpose: 'Break one visible block within reach, selecting a valid harvest tool from the inventory; reports server-confirmed break and the drops the server spawned (does not pick them up).',
    parameters: [
      { name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible blk-* block', required: true },
      { name: 'allowNoDrop', type: 'boolean', description: 'break even without a valid harvest tool (no drop), e.g. to clear an obstruction', required: false },
    ],
    targets: ['block'],
    preconditions: ['block unchanged since observation and visible now', `within ${BLOCK_REACH} blocks of the eye`, 'a valid harvest tool in inventory when the block requires one', 'not the block supporting the bot and not next to liquid'],
    effects: ['block removed (server-confirmed)', 'drops spawned as item entities near the block'],
    supportedPredicates: ['block_state', 'inventory_delta', 'inventory_amount'],
    timeoutMs: 60_000,
    cancellation: 'stop sends dig-cancel immediately (block keeps its state); partial progress is lost',
    limitations: ['does not approach the block (use move_near)', 'silk touch/fortune not modeled', 'tool choice uses installed harvest data'],
    evidence: ['server block_change at the position', 'server item_spawn + item metadata near the block'],
  },
  params: z.object({ target: HandleRefSchema, allowNoDrop: z.boolean().default(false) }).strict(),
  resolve(ctx) {
    const { snapshot, services, session, hints } = ctx;
    const seen = services.perception.seenBlocks(snapshot.id);
    const bot = session.bot;
    const counts = clientCounts(bot);
    const book = services.knowledge.recipes;
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    const scope = targetScope(ctx);
    const allowNoDrop = (admittedParameters(ctx, mineBlock.params).values['allowNoDrop'] as boolean | undefined) ?? false;
    let outOfReach: { handle: string; key: string; distance: number } | undefined;
    let toolMissing: { key: string; validTools: string[] } | undefined;
    const feet = bot.entity.position.floored();
    for (const hit of seen?.values() ?? []) {
      const key = mk(hit.block.name);
      const info = services.knowledge.blockInfo(key);
      if (!info?.diggable || (info.hardness ?? -1) < 0) continue;
      const drops = services.knowledge.blockDrops(key);
      if (!scope.named && !blockMatchesHints(hit.block.name, hints.keys, drops, book)) continue;
      if (!scope.named && hints.keys.length === 0 && info.boundingBox !== 'block') continue;
      if (scope.named && !scope.current.size) continue;
      const handle = services.perception.blockHandle(snapshot.id, hit.x, hit.y, hit.z);
      if (!handle || !scope.allows(handle)) continue;
      if (hit.x === feet.x && hit.y === feet.y - 1 && hit.z === feet.z) continue;
      const d = eyeDistanceToBlock(bot, hit.x, hit.y, hit.z);
      if (d > BLOCK_REACH) {
        if (!outOfReach || d < outOfReach.distance) outOfReach = { handle, key, distance: Math.round(d * 10) / 10 };
        continue;
      }
      const tool = chooseTool(services, key, counts);
      if (tool.requiresTool && !tool.tool && !allowNoDrop) {
        toolMissing ??= { key, validTools: tool.validTools };
        continue;
      }
      drafts.push({
        parameters: { target: { snapshotId: snapshot.id, handle }, allowNoDrop },
        description: `mine ${key} at ${hit.x},${hit.y},${hit.z}${tool.tool ? ` with ${tool.tool}` : ' by hand'}`,
        criteria: [`drops ${drops.join(', ') || 'nothing'}`, `${Math.round(d * 10) / 10} blocks away`],
        preconditions: [tool.requiresTool ? `requires ${tool.validTools.slice(0, 3).join('/')}` : 'no tool required'],
        score: -d,
      });
    }
    if (drafts.length === 0) {
      if (toolMissing) unavailable.push({ reason: 'harvest_tool_missing', detail: `${toolMissing.key} drops nothing without a valid harvest tool`, evidence: { block: toolMissing.key, validTools: toolMissing.validTools.slice(0, 8) } });
      if (outOfReach) unavailable.push({ reason: 'out_of_reach', detail: `nearest matching block ${outOfReach.key} is ${outOfReach.distance} blocks away`, evidence: { handle: outOfReach.handle, distance: outOfReach.distance } });
      if (!toolMissing && !outOfReach) {
        unavailable.push(scope.named ? namedTargetUnavailable(scope, 'block to mine') : { reason: 'no_visible_target', detail: 'no visible block matching the task; explore or survey to find one', evidence: { keys: hints.keys.slice(0, 8) } });
      }
    }
    return { drafts: drafts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const { services, session, act } = ctx;
    const bot = session.bot;
    const live = liveBlock(services, session, params.target.snapshotId, params.target.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    const key = mk(live.name);
    const info = services.knowledge.blockInfo(key);
    if (!info?.diggable || (info.hardness ?? -1) < 0) return precondition('unbreakable', `${key} cannot be broken in survival`);
    const feet = bot.entity.position.floored();
    if (live.x === feet.x && live.y === feet.y - 1 && live.z === feet.z) return precondition('unsafe_support_block', 'refusing to break the block the bot stands on');
    const world = sessionWorld(session);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const n = world.blockAt(live.x + dx, live.y + dy, live.z + dz);
      if (n && LIQUID.test(n.name)) return precondition('adjacent_liquid', `${key} borders ${n.name}; breaking it could release liquid`);
    }
    const distance = eyeDistanceToBlock(bot, live.x, live.y, live.z);
    if (distance > BLOCK_REACH) return precondition('out_of_reach', `${key} is ${distance.toFixed(1)} blocks from the eye (reach ${BLOCK_REACH})`, { distance: Math.round(distance * 10) / 10 });
    const faces = visibleFaces(world, eyeOf(bot), live.x, live.y, live.z);
    if (faces.length === 0) return precondition('not_visible', `${key} at ${live.x},${live.y},${live.z} is not visible from here`);

    const counts = clientCounts(bot);
    const tool = chooseTool(services, key, counts);
    if (tool.requiresTool && !tool.tool && !params.allowNoDrop) {
      return precondition('harvest_tool_missing', `${key} requires one of ${tool.validTools.slice(0, 4).join(', ')} to drop items`, { validTools: tool.validTools.slice(0, 8) });
    }
    if (tool.tool) {
      const held = await ensureInHand(act, services, tool.tool);
      if (!held.ok) return failed('equip_failed', `could not hold ${tool.tool}: ${held.detail}`);
    }
    const face = faces[0] as string;
    const n = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }[face] as [number, number, number];
    await act.lookAt({ x: live.x + 0.5 + n[0] * 0.5, y: live.y + 0.5 + n[1] * 0.5, z: live.z + 0.5 + n[2] * 0.5 });
    const block = bot.blockAt(new Vec3(live.x, live.y, live.z));
    if (!block || block.name !== live.name) return precondition('target_changed', `block changed to ${block?.name ?? 'unloaded'} before digging`);
    const startSeq = session.evidence.seq;
    const predictionsBefore = session.evidence.predictionsNoted ?? 0;
    const digStarted = services.clock.now();
    const expectedMs = Math.round(bot.digTime(block));
    const dig = act.startDig(block);
    dig.catch(() => undefined);
    await Promise.race([dig, new Promise((resolve) => act.signal.addEventListener('abort', resolve, { once: true }))]);
    act.fence();
    const change = await act.waitServer('block_change', (e) => e.x === live.x && e.y === live.y && e.z === live.z, startSeq, 2_500);
    const digMs = services.clock.now() - digStarted;
    if (!change) return failed('unconfirmed_break', `dig finished locally but the server sent no block change for ${key}`, { expectedMs, digMs }, 'client_only');
    const newName = (bot.registry as unknown as { blocksByStateId: Record<number, { name: string } | undefined> }).blocksByStateId[change.stateId]?.name ?? `state_${change.stateId}`;
    if (change.stateId === live.stateId || newName === live.name) {
      return failed('server_rejected_break', `server kept ${key} at ${live.x},${live.y},${live.z}`, { expectedMs, digMs }, 'server_packet');
    }
    services.ledger.add({ kind: 'block_changed', x: live.x, y: live.y, z: live.z, from: key, to: mk(newName), atMs: change.atMs, actionId: ctx.candidate.id });
    ctx.progress({ blockBroken: key, at: { x: live.x, y: live.y, z: live.z }, becameServer: mk(newName) }, 'server_packet');
    // Server-spawned drops near the block (pickup is a separate skill).
    await act.sleep(400);
    const center = { x: live.x + 0.5, y: live.y + 0.5, z: live.z + 0.5 };
    const spawns = session.evidence.since(startSeq, 'item_spawn', (e) => Math.hypot(e.x - center.x, e.y - center.y, e.z - center.z) < 2.5);
    const drops: Array<{ entityId: number; key: string; count: number }> = [];
    for (const s of spawns) {
      const stack = session.evidence.latest('item_stack', (e) => e.entityId === s.entityId);
      if (stack) drops.push({ entityId: s.entityId, key: stack.stack.key, count: stack.stack.count });
    }
    const expected = services.knowledge.blockDrops(key);
    // Standing next to a drop, the server may auto-collect it (vanilla pickup); report only what a collect packet says.
    const autoCollected = session.evidence
      .since(startSeq, 'collect', (c) => drops.some((d) => d.entityId === c.collectedEntityId))
      .map((c) => ({ entityId: c.collectedEntityId, byBot: c.collectorEntityId === bot.entity.id, count: c.count }));
    for (const c of autoCollected) {
      const d = drops.find((x) => x.entityId === c.entityId);
      if (c.byBot && d) services.ledger.add({ kind: 'picked_up', item: d.key, count: c.count, atMs: services.clock.now() });
    }
    const evidence: Record<string, JsonValue> = {
      autoCollected: json(autoCollected),
      block: key,
      at: { x: live.x, y: live.y, z: live.z },
      serverState: mk(newName),
      tool: tool.tool,
      digMs,
      expectedDigMs: expectedMs,
      serverDrops: json(drops),
      expectedDrops: expected,
      // Client-model predictions marked during this dig (Mineflayer's local air), resolved by the server change above.
      clientPredictionsMarked: (session.evidence.predictionsNoted ?? 0) - predictionsBefore,
      predictionPendingAfter: session.evidence.predictionPending?.(live.x, live.y, live.z) ?? null,
    };
    const dropText = drops.length ? drops.map((d) => `${d.key} x${d.count}`).join(', ') : 'none observed';
    return {
      status: 'succeeded',
      effect: `broke ${key} at ${live.x},${live.y},${live.z} (server block change -> ${mk(newName)}); server-spawned drops: ${dropText}; ${autoCollected.some((c) => c.byBot) ? 'auto-collected by the bot (server collect packet)' : 'not yet picked up'}`,
      confirmation: 'server_packet',
      evidence,
    };
  },
};

export const pickupItem: SkillDefinition<{ target: { snapshotId: string; handle: string } }> = {
  descriptor: {
    id: 'pickup_item',
    family: 'resource',
    purpose: 'Walk onto a visible dropped item stack and collect it; success only when the server reports the bot as collector.',
    parameters: [{ name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible drp-* dropped item', required: true }],
    targets: ['drop'],
    preconditions: ['drop still present', 'inside the travel radius', 'safe walking path'],
    effects: ['item moves into the inventory (server collect packet + resync)'],
    supportedPredicates: ['inventory_delta', 'inventory_amount'],
    timeoutMs: 60_000,
    cancellation: 'stop clears the path goal and controls immediately',
    limitations: ['an item collected by another player or merged/despawned is reported as such, not as success', 'inventory must have room'],
    evidence: ['server collect packet (collector = bot)', 'server inventory resync delta'],
  },
  params: z.object({ target: HandleRefSchema }).strict(),
  resolve(ctx) {
    const { snapshot, hints, services } = ctx;
    const book = services.knowledge.recipes;
    const scope = targetScope(ctx);
    const drafts: CandidateDraft[] = snapshot.drops
      .filter((d) => (scope.named ? scope.allows(d.handle) : hints.keys.length === 0 || hints.keys.some((h) => (h.startsWith('#') ? book?.matches(h, d.key) : h === d.key))))
      .filter((d) => services.perception.withinTravel(d.at))
      .map((d) => ({ parameters: { target: { snapshotId: snapshot.id, handle: d.handle } }, description: `pick up ${d.key} ${d.label ?? ''} (${Math.round(d.distance)} blocks)`.replace('  ', ' '), score: -d.distance }));
    return {
      drafts: drafts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6),
      unavailable: drafts.length ? [] : [scope.named ? namedTargetUnavailable(scope, 'dropped item') : { reason: 'no_visible_drop', detail: 'no visible dropped item matching the task' }],
    };
  },
  async execute(ctx, params) {
    const { services, session, act } = ctx;
    const bot = session.bot;
    const live = liveEntity(services, session, params.target.snapshotId, params.target.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    if (live.record.target.kind !== 'drop') return precondition('wrong_target_kind', `${params.target.handle} is not a dropped item`);
    const item = live.record.target.item;
    const id = live.entityId;
    if (!services.perception.withinTravel(live.position)) return precondition('outside_travel_bounds', 'drop is outside the travel radius');
    const startSeq = session.evidence.seq;
    const before = await confirmInventory(act, services);
    const collectedBy = () => session.evidence.since(startSeq, 'collect', (e) => e.collectedEntityId === id)[0];
    const destroyed = () => session.evidence.since(startSeq, 'entity_destroy', (e) => e.entityIds.includes(id))[0];
    const position = () => bot.entities[id]?.position ?? live.position;
    const r = await navigate(act, {
      goal: new goals.GoalNear(live.position.x, live.position.y, live.position.z, 0),
      arrived: () => Boolean(collectedBy()),
      distance: () => distanceTo(bot, position()),
      timeoutMs: ctx.candidate.timeoutMs,
      stuckMs: 4_000,
      searchRadius: Math.min(services.limits.travelRadius, Math.ceil(distanceTo(bot, live.position)) + 16),
      ...(services.perception.travelBounds() ? { bounds: services.perception.travelBounds()! } : {}),
      inBounds: () => services.perception.withinTravel(bot.entity.position),
      abortIf: () => (destroyed() && !collectedBy() ? 'item_vanished' : collectedBy() && collectedBy()!.collectorEntityId !== bot.entity.id ? 'collected_by_other' : undefined),
    });
    // A collect packet can arrive right after the last poll.
    const collect = collectedBy() ?? (await act.waitServer('collect', (e) => e.collectedEntityId === id, startSeq, 1_000));
    if (!collect) {
      if (r.status === 'out_of_bounds') return failed('outside_travel_bounds', `stopped at the travel radius before collecting ${item}`, { finalDistance: r.finalDistance, position: pos3(bot.entity.position) });
      if (r.aborted === 'item_vanished') return failed('item_vanished', `${item} disappeared without being collected by the bot (merged or despawned)`);
      return failed(r.status === 'no_path' ? 'no_safe_path' : 'not_collected', `did not collect ${item} (${r.status}, ${r.finalDistance} blocks away)`, { finalDistance: r.finalDistance });
    }
    if (collect.collectorEntityId !== bot.entity.id) {
      return failed('collected_by_other', `${item} was collected by another entity (id ${collect.collectorEntityId})`, { collector: collect.collectorEntityId }, 'server_packet');
    }
    services.ledger.add({ kind: 'picked_up', item, count: collect.count, atMs: collect.atMs });
    ctx.progress({ collected: item, count: collect.count }, 'server_packet');
    const after = await confirmInventory(act, services);
    const delta = before && after ? (after.counts.get(item) ?? 0) - (before.counts.get(item) ?? 0) : null;
    return {
      status: 'succeeded',
      effect: `collected ${item} x${collect.count} (server collect packet); confirmed inventory change ${delta ?? 'unknown'}`,
      confirmation: after ? 'server_sync' : 'server_packet',
      evidence: { item, collectedCount: collect.count, confirmedDelta: delta, inventoryAfter: after ? countsRecord(after.counts, [item]) : null, position: pos3(bot.entity.position) },
    };
  },
};
