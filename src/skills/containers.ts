// Container family: read and transfer items through visible block containers
// (chest, barrel, trapped chest, shulker box, hopper, dispenser, dropper).
import { z } from 'zod';
import { admittedParameters, clientCounts, json, matchesHints, mk, namedTargetUnavailable, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type Unavailable } from './definition.ts';
import { interfaceBlock, moveItems, openInterface, regionCounts } from './interfaces.ts';
import { HandleRefSchema, ItemKeySchema } from './refs.ts';

const CONTAINERS = /^(chest|trapped_chest|barrel|hopper|dropper|dispenser|([a-z_]+_)?shulker_box)$/;

function visibleContainers(ctx: Parameters<SkillDefinition['resolve']>[0]) {
  return ctx.snapshot.blocks.filter((b) => b.label === 'container' && CONTAINERS.test(b.key.replace('minecraft:', '')));
}

export const inspectContainer: SkillDefinition<{ container: { snapshotId: string; handle: string } }> = {
  descriptor: {
    id: 'inspect_container',
    family: 'transfer',
    purpose: 'Open a visible container within reach, read its server-confirmed contents, and close it.',
    parameters: [{ name: 'container', type: 'handle', description: '{snapshotId, handle} of the visible container block', required: true }],
    targets: ['container'],
    preconditions: ['container visible and within reach', 'not blocked (e.g. a chest under a solid block does not open)'],
    effects: ['none in the world'],
    supportedPredicates: ['container_state'],
    timeoutMs: 10_000,
    cancellation: 'stop closes the container window',
    limitations: ['ender chest contents are per-player'],
    evidence: ['server window contents'],
  },
  params: z.object({ container: HandleRefSchema }).strict(),
  resolve(ctx) {
    const scope = targetScope(ctx);
    const containers = visibleContainers(ctx).filter((c) => scope.allows(c.handle));
    if (scope.named && containers.length === 0) return { drafts: [], unavailable: [namedTargetUnavailable(scope, 'container')] };
    const drafts: CandidateDraft[] = containers
      .filter((c) => c.inReach)
      .slice(0, 4)
      .map((c) => ({ parameters: { container: { snapshotId: ctx.snapshot.id, handle: c.handle } }, description: `look inside ${c.key} at ${c.at.x},${c.at.y},${c.at.z}` }));
    return { drafts, unavailable: drafts.length ? [] : [{ reason: containers.length ? 'out_of_reach' : 'no_container_in_reach', detail: containers.length ? 'the container is not within reach' : 'no visible container within reach' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    if (session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const block = interfaceBlock(services, session, params.container, CONTAINERS);
    if ('error' in block) return precondition(block.error, block.detail);
    const win = await openInterface(act, block);
    const confirmed = await act.confirmWindow();
    act.closeWindow(win as never);
    if (!confirmed) return failed('no_server_sync', 'container resync failed');
    const contents = regionCounts(confirmed, 0, win.inventoryStart);
    services.ledger.add({ kind: 'container', dimension: String(session.bot.game.dimension), x: block.x, y: block.y, z: block.z, contents, atMs: services.clock.now(), actionId: ctx.candidate.id, via: 'inspect_container' });
    return {
      status: 'succeeded',
      effect: `${mk(block.name)} at ${block.x},${block.y},${block.z} contains ${Object.entries(contents).map(([k, v]) => `${v} ${k.replace('minecraft:', '')}`).join(', ') || 'nothing'} (server-confirmed)`,
      confirmation: 'server_sync',
      evidence: { container: mk(block.name), at: { x: block.x, y: block.y, z: block.z }, contents, slots: win.inventoryStart },
    };
  },
};

export const containerTransfer: SkillDefinition<{ container: { snapshotId: string; handle: string }; direction: 'deposit' | 'withdraw'; item: string; count: number }> = {
  descriptor: {
    id: 'container_transfer',
    family: 'transfer',
    purpose: 'Deposit items from the inventory into, or withdraw items from, a visible container within reach.',
    parameters: [
      { name: 'container', type: 'handle', description: '{snapshotId, handle} of the visible container block', required: true },
      { name: 'direction', type: 'string', description: 'deposit or withdraw', required: true, enum: ['deposit', 'withdraw'] },
      { name: 'item', type: 'registry_key', description: 'item to move', required: true },
      { name: 'count', type: 'integer', description: 'how many', required: true, minimum: 1, maximum: 1728 },
    ],
    targets: ['container', 'inventory_item'],
    preconditions: ['container visible and within reach', 'enough items at the source and room at the destination'],
    effects: ['items move between inventory and container (server-confirmed counts)'],
    supportedPredicates: ['container_state', 'inventory_amount'],
    timeoutMs: 60_000,
    cancellation: 'stop fences further clicks and closes the container; items already moved stay moved; a cursor stack returns to the inventory on close',
    limitations: ['moves whole/partial stacks with single clicks; hoppers and dispensers have few slots'],
    evidence: ['server window resync before/after (container and inventory regions)'],
  },
  params: z.object({ container: HandleRefSchema, direction: z.enum(['deposit', 'withdraw']), item: ItemKeySchema, count: z.number().int().min(1).max(1728) }).strict(),
  resolve(ctx) {
    // Primary target: the named container if the task names one; admitted
    // direction/item/count bound every candidate's effect (MB-SKL-005/008).
    const scope = targetScope(ctx);
    const admitted = admittedParameters(ctx, containerTransfer.params).values as { direction?: 'deposit' | 'withdraw'; item?: string; count?: number };
    const eligible = visibleContainers(ctx).filter((c) => scope.allows(c.handle));
    if (scope.named && eligible.length === 0) return { drafts: [], unavailable: [namedTargetUnavailable(scope, 'container')] };
    const inReach = eligible.filter((c) => c.inReach);
    if (inReach.length === 0) {
      return { drafts: [], unavailable: [{ reason: eligible.length ? 'out_of_reach' : 'no_container_in_reach', detail: eligible.length ? 'the container is not within reach' : 'no visible container within reach', evidence: eligible[0] ? { handle: eligible[0].handle, distance: eligible[0].distance } : {} }] };
    }
    const counts = clientCounts(ctx.session.bot);
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    const wantedCount = (key: string) => admitted.count ?? ctx.hints.outputs.find((o) => o.key === key)?.count;
    for (const c of inReach.slice(0, 2)) {
      const ref = { snapshotId: ctx.snapshot.id, handle: c.handle };
      if (admitted.direction !== 'withdraw') {
        const items = admitted.item ? [admitted.item] : [...counts.keys()].filter((k) => ctx.hints.keys.length > 0 && matchesHints(k, ctx.hints, ctx.services));
        for (const key of items) {
          const have = counts.get(key) ?? 0;
          const n = wantedCount(key) ?? have;
          if (have < n || n <= 0) {
            unavailable.push({ reason: 'not_enough_items', detail: `inventory has ${have} ${key}; the task wants ${n} deposited`, evidence: { item: key, have, wanted: n } });
            continue;
          }
          drafts.push({ parameters: { container: ref, direction: 'deposit', item: key, count: n }, description: `deposit ${n} ${key} into ${c.key}` });
        }
      }
      if (admitted.direction !== 'deposit') {
        const rec = ctx.services.ledger.latestContainer(ctx.snapshot.dimension, c.at.x, c.at.y, c.at.z);
        for (const [key, have] of Object.entries(rec?.contents ?? {})) {
          if (admitted.item ? admitted.item !== key : ctx.hints.keys.length === 0 || !matchesHints(key, ctx.hints, ctx.services)) continue;
          const n = wantedCount(key) ?? have;
          if (have < n || n <= 0) continue;
          drafts.push({ parameters: { container: ref, direction: 'withdraw', item: key, count: n }, description: `withdraw ${n} ${key} from ${c.key} (contents observed earlier; revalidated when opened)` });
        }
      }
    }
    if (drafts.length === 0 && unavailable.length === 0) unavailable.push({ reason: 'nothing_to_transfer', detail: 'no matching item in the inventory or in known container contents' });
    return { drafts: drafts.slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    if (session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const block = interfaceBlock(services, session, params.container, CONTAINERS);
    if ('error' in block) return precondition(block.error, block.detail);
    const item = mk(params.item);
    const win = await openInterface(act, block);
    const before = await act.confirmWindow();
    if (!before) return failed('no_server_sync', 'container resync failed');
    const containerEnd = win.inventoryStart;
    const cBefore = regionCounts(before, 0, containerEnd);
    const iBefore = regionCounts(before, containerEnd, win.inventoryEnd);
    const source = params.direction === 'deposit' ? iBefore : cBefore;
    if ((source[item] ?? 0) < params.count) {
      act.closeWindow(win as never);
      return precondition('not_enough_items', `${params.direction === 'deposit' ? 'inventory' : 'container'} has ${source[item] ?? 0} ${item}`, { containerContents: cBefore });
    }
    const from: [number, number] = params.direction === 'deposit' ? [containerEnd, win.inventoryEnd] : [0, containerEnd];
    const destSlots = params.direction === 'deposit' ? Array.from({ length: containerEnd }, (_, i) => i) : Array.from({ length: win.inventoryEnd - containerEnd }, (_, i) => containerEnd + i);
    await moveItems(act, win, item, params.count, from, destSlots, (n) =>
      ctx.progress({ clickedSoFar: n, item, direction: params.direction, note: 'items moved by accepted clicks per the client model; server contents are confirmed by inspect_container' }),
    );
    await act.sleep(150);
    const after = await act.confirmWindow();
    act.closeWindow(win as never);
    if (!after) return failed('no_server_sync', 'container resync failed after transfer');
    const cAfter = regionCounts(after, 0, containerEnd);
    const moved = params.direction === 'deposit' ? (cAfter[item] ?? 0) - (cBefore[item] ?? 0) : (cBefore[item] ?? 0) - (cAfter[item] ?? 0);
    services.ledger.add({ kind: 'container', dimension: String(session.bot.game.dimension), x: block.x, y: block.y, z: block.z, contents: cAfter, atMs: services.clock.now(), actionId: ctx.candidate.id, via: 'container_transfer' });
    ctx.progress({ moved, item, direction: params.direction }, 'server_sync');
    const evidence = { item, direction: params.direction, requested: params.count, movedConfirmed: moved, containerBefore: cBefore, containerAfter: cAfter };
    if (moved <= 0) return failed('transfer_not_confirmed', `server shows no ${item} moved`, evidence, 'server_sync');
    return { status: moved >= params.count ? 'succeeded' : 'partial', effect: `${params.direction === 'deposit' ? 'deposited' : 'withdrew'} ${moved} ${item} (server-confirmed container contents)`, confirmation: 'server_sync', evidence: json(evidence) as Record<string, never> };
  },
};
