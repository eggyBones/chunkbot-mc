// Furnace family (furnace, blast furnace, smoker): insert input or fuel, wait
// for processing while observing the open interface, and take items out.
// Slots: 0 input, 1 fuel, 2 output; window properties 0 fuel left, 1 fuel
// total, 2 cook progress, 3 cook total (server craft_progress_bar packets).
// Closing the interface does not stop cooking: an already-loaded furnace keeps
// processing in the world, and cancellation reports the contents it last saw.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import { admittedParameters, clientCounts, countsRecord, json, mk, namedTargetUnavailable, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type ExecuteContext, type SkillDefinition, type SkillResult, type Unavailable } from './definition.ts';
import { interfaceBlock, moveItems, openInterface, regionCounts, slotStack, type Win } from './interfaces.ts';
import { HandleRefSchema, ItemKeySchema } from './refs.ts';
import type { ConfirmedWindow } from '../execution/actuator.ts';

const FURNACES = /^(furnace|blast_furnace|smoker)$/;
const SLOT = { input: 0, fuel: 1, output: 2 } as const;
const STATION_RECIPE: Record<string, string> = { furnace: 'minecraft:smelting', blast_furnace: 'minecraft:blasting', smoker: 'minecraft:smoking' };

interface FurnaceState {
  input: { key: string; count: number } | null;
  fuel: { key: string; count: number } | null;
  output: { key: string; count: number } | null;
}

function furnaceState(c: ConfirmedWindow): FurnaceState {
  return { input: slotStack(c, 0), fuel: slotStack(c, 1), output: slotStack(c, 2) };
}

function properties(ctx: ExecuteContext, windowId: number): Record<string, number> {
  const out: Record<string, number> = {};
  const names = ['fuelLeft', 'fuelTotal', 'cookProgress', 'cookTotal'];
  for (let p = 0; p < 4; p += 1) {
    const e = ctx.session.evidence.latest('window_property', (x) => x.windowId === windowId && x.property === p);
    if (e) out[names[p] as string] = e.value;
  }
  return out;
}

function recordFurnace(ctx: ExecuteContext, block: { x: number; y: number; z: number }, state: FurnaceState): void {
  const contents: Record<string, number> = {};
  for (const [slot, s] of Object.entries(state)) if (s) contents[`${slot}:${s.key}`] = s.count;
  ctx.services.ledger.add({ kind: 'container', dimension: String(ctx.session.bot.game.dimension), ...block, contents, atMs: ctx.services.clock.now(), actionId: ctx.candidate.id, via: ctx.candidate.capability });
}

/** Furnace-type blocks eligible for this task: the named ones if the task names targets. */
function visibleFurnaces(ctx: Parameters<SkillDefinition['resolve']>[0]) {
  const scope = targetScope(ctx);
  return ctx.snapshot.blocks.filter((b) => FURNACES.test(b.key.replace('minecraft:', '')) && scope.allows(b.handle));
}

function namedFurnaceMissing(ctx: Parameters<SkillDefinition['resolve']>[0]) {
  const scope = targetScope(ctx);
  return scope.named && visibleFurnaces(ctx).length === 0 ? namedTargetUnavailable(scope, 'furnace') : undefined;
}

function stateEvidence(s: FurnaceState): JsonValue {
  return json(s);
}

export const furnaceInsert: SkillDefinition<{ furnace: { snapshotId: string; handle: string }; slot: 'input' | 'fuel'; item: string; count: number }> = {
  descriptor: {
    id: 'furnace_insert',
    family: 'processing',
    purpose: 'Put a number of an inventory item into the input or fuel slot of a visible furnace, blast furnace or smoker within reach.',
    parameters: [
      { name: 'furnace', type: 'handle', description: '{snapshotId, handle} of the visible furnace-type block', required: true },
      { name: 'slot', type: 'string', description: 'which slot to fill', required: true, enum: ['input', 'fuel'] },
      { name: 'item', type: 'registry_key', description: 'item to insert', required: true },
      { name: 'count', type: 'integer', description: 'how many', required: true, minimum: 1, maximum: 64 },
    ],
    targets: ['workstation', 'inventory_item'],
    preconditions: ['furnace visible and within reach', 'fuel slot: item has a vanilla burn time', 'input slot: a cooking recipe for this station accepts the item', 'slot empty or holding the same item'],
    effects: ['items move into the furnace slot (server-confirmed); processing starts when input and fuel are present'],
    supportedPredicates: ['container_state'],
    timeoutMs: 20_000,
    cancellation: 'stop fences further clicks and closes the furnace window; items already inserted stay in the furnace',
    limitations: ['does not wait for processing (use furnace_wait)'],
    evidence: ['server resync of furnace slots before/after', 'server window properties'],
  },
  params: z.object({ furnace: HandleRefSchema, slot: z.enum(['input', 'fuel']), item: ItemKeySchema, count: z.number().int().min(1).max(64) }).strict(),
  resolve(ctx) {
    const missing = namedFurnaceMissing(ctx);
    if (missing) return { drafts: [], unavailable: [missing] };
    const furnaces = visibleFurnaces(ctx);
    const unavailable: Unavailable[] = [];
    const admitted = admittedParameters(ctx, furnaceInsert.params).values as { slot?: 'input' | 'fuel'; item?: string; count?: number };
    const inReach = furnaces.find((f) => f.inReach);
    if (!inReach) {
      unavailable.push({ reason: furnaces.length ? 'out_of_reach' : 'workstation_required', detail: furnaces.length ? 'nearest furnace is out of reach' : 'no visible furnace', evidence: { workstation: 'minecraft:furnace', visible: json(furnaces.slice(0, 3).map((f) => ({ handle: f.handle, distance: f.distance }))) } });
      return { drafts: [], unavailable };
    }
    const station = inReach.key.replace('minecraft:', '');
    const counts = clientCounts(ctx.session.bot);
    const book = ctx.services.knowledge.recipes;
    const drafts: CandidateDraft[] = [];
    const ref = { snapshotId: ctx.snapshot.id, handle: inReach.handle };
    const wantedOutputs = ctx.hints.outputs.map((o) => o.key);
    const inputs = new Set<string>();
    for (const [key, n] of admitted.slot === 'fuel' ? [] : counts) {
      if (admitted.item && admitted.item !== key) continue;
      const recipes = (book?.cookingFor(key) ?? []).filter((r) => r.type === STATION_RECIPE[station]);
      if (recipes.length === 0) continue;
      const relevant = admitted.item ? true : wantedOutputs.length === 0 ? ctx.hints.keys.length === 0 || ctx.hints.keys.includes(key) : recipes.some((r) => wantedOutputs.includes(r.output.key));
      if (!relevant) continue;
      inputs.add(key);
      const want = admitted.count ?? ctx.hints.outputs.find((o) => recipes.some((r) => r.output.key === o.key))?.count ?? n;
      if (n < want && admitted.count !== undefined) {
        unavailable.push({ reason: 'not_enough_items', detail: `have ${n} ${key}; the task admits ${want}`, evidence: { have: n, wanted: want } });
        continue;
      }
      drafts.push({ parameters: { furnace: ref, slot: 'input', item: key, count: Math.min(n, want, 64) }, description: `load ${Math.min(n, want, 64)} ${key} into ${inReach.key} input` });
    }
    const fuels = admitted.slot === 'input' ? [] : [...counts.entries()].filter(([k]) => book?.fuelTicks(k) !== undefined && !inputs.has(k) && (!admitted.item || admitted.item === k)).sort((a, b) => (book?.fuelTicks(b[0]) ?? 0) - (book?.fuelTicks(a[0]) ?? 0));
    for (const [key, n] of fuels.slice(0, 2)) {
      const ticks = book?.fuelTicks(key) ?? 200;
      const need = admitted.count ?? Math.max(1, Math.ceil((ctx.hints.outputs[0]?.count ?? 1) * 200 / ticks));
      if (n < need && admitted.count !== undefined) continue;
      drafts.push({ parameters: { furnace: ref, slot: 'fuel', item: key, count: Math.min(n, need, 64) }, description: `fuel ${inReach.key} with ${Math.min(n, need, 64)} ${key} (${ticks} ticks each)` });
    }
    if (fuels.length === 0 && admitted.slot !== 'input') unavailable.push({ reason: 'fuel_missing', detail: 'no furnace fuel in the inventory', evidence: { exampleFuels: (book?.fuelEntries() ?? []).slice(0, 6).map((f) => f.target) } });
    if (inputs.size === 0 && admitted.slot !== 'fuel') unavailable.push({ reason: 'no_smeltable_input', detail: 'no inventory item has a cooking recipe for this station matching the task', evidence: { station: inReach.key, wanted: wantedOutputs.slice(0, 4) } });
    return { drafts: drafts.slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    if (session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const block = interfaceBlock(services, session, params.furnace, FURNACES);
    if ('error' in block) return precondition(block.error, block.detail);
    const item = mk(params.item);
    const book = services.knowledge.recipes;
    if (params.slot === 'fuel' && book?.fuelTicks(item) === undefined) return precondition('not_fuel', `${item} is not a furnace fuel in ${book?.version ?? 'installed'} data`);
    if (params.slot === 'input' && !(book?.cookingFor(item) ?? []).some((r) => r.type === STATION_RECIPE[block.name])) {
      return precondition('not_processable_here', `no ${STATION_RECIPE[block.name]?.replace('minecraft:', '')} recipe accepts ${item}`);
    }
    if ((clientCounts(session.bot).get(item) ?? 0) < params.count) return precondition('not_enough_items', `need ${params.count} ${item}`);
    const win = await openInterface(act, block);
    const before = await act.confirmWindow();
    if (!before) return failed('no_server_sync', 'furnace resync failed');
    const slotIndex = SLOT[params.slot];
    const occupied = slotStack(before, slotIndex);
    if (occupied && occupied.key !== item) {
      act.closeWindow(win as never);
      return precondition('slot_occupied', `${params.slot} slot holds ${occupied.key} x${occupied.count}`, { furnace: stateEvidence(furnaceState(before)) });
    }
    await moveItems(act, win, item, params.count, [win.inventoryStart, win.inventoryEnd], [slotIndex], (n) => ctx.progress({ clickedSoFar: n, item, slot: params.slot }));
    await act.sleep(150);
    const after = await act.confirmWindow();
    act.closeWindow(win as never);
    if (!after) return failed('no_server_sync', 'furnace resync failed after insert');
    // Count what left the player inventory (server-confirmed). The furnace may
    // already have consumed a fuel item, so the slot delta can be smaller.
    const invBefore = regionCounts(before, win.inventoryStart, win.inventoryEnd)[item] ?? 0;
    const invAfter = regionCounts(after, win.inventoryStart, win.inventoryEnd)[item] ?? 0;
    const inserted = invBefore - invAfter;
    const slotDelta = (slotStack(after, slotIndex)?.key === item ? slotStack(after, slotIndex)!.count : 0) - (occupied?.count ?? 0);
    const state = furnaceState(after);
    recordFurnace(ctx, block, state);
    if (inserted > 0) services.ledger.add({ kind: 'consumed', item, count: inserted, atMs: services.clock.now(), via: `furnace_insert:${params.slot}` });
    ctx.progress({ inserted, furnace: stateEvidence(state) }, 'server_sync');
    const evidence = { inserted, slotDelta, alreadyBurning: inserted - slotDelta, slot: params.slot, furnace: stateEvidence(state), properties: json(properties(ctx, win.id)) };
    if (inserted <= 0) return failed('server_rejected_insert', `server shows no ${item} added to the ${params.slot} slot`, evidence, 'server_sync');
    return { status: inserted >= params.count ? 'succeeded' : 'partial', effect: `inserted ${inserted} ${item} into the ${params.slot} slot of ${mk(block.name)} (server-confirmed)`, confirmation: 'server_sync', evidence };
  },
};

export const furnaceWait: SkillDefinition<{ furnace: { snapshotId: string; handle: string }; untilOutputAtLeast: number; maxWaitMs: number }> = {
  descriptor: {
    id: 'furnace_wait',
    family: 'processing',
    purpose: 'Stand at a loaded furnace with its interface open and wait (no inference) until the output slot holds a number of items, input/fuel runs out, or the wait limit passes.',
    parameters: [
      { name: 'furnace', type: 'handle', description: '{snapshotId, handle} of the furnace-type block', required: true },
      { name: 'untilOutputAtLeast', type: 'integer', description: 'stop when the output slot has at least this many', required: true, minimum: 1, maximum: 64 },
      { name: "maxWaitMs", type: "integer", description: "wait limit", required: false, minimum: 1_000, maximum: 590_000 },
    ],
    targets: ['workstation'],
    preconditions: ['furnace visible and within reach'],
    effects: ['none in the world (observation); processing is the furnace\'s own'],
    supportedPredicates: ['container_state', 'smelting_result'],
    timeoutMs: 600_000,
    cancellation: 'stop closes the interface immediately; the furnace keeps processing in the world and its last observed contents are reported',
    limitations: ['progress is observed only while the interface is open', 'does not refill input or fuel'],
    evidence: ['server output-slot updates and progress properties'],
  },
  // The wait limit passing while the furnace still processes is healthy waiting (output/fuel/input end it otherwise).
  sustained: { windowElapsed: (o) => o.status === 'partial' && o.reason === 'wait_limit' },
  params: z.object({ furnace: HandleRefSchema, untilOutputAtLeast: z.number().int().min(1).max(64), maxWaitMs: z.number().int().min(1_000).max(590_000).default(120_000) }).strict(),
  resolve(ctx) {
    const missing = namedFurnaceMissing(ctx);
    if (missing) return { drafts: [], unavailable: [missing] };
    const furnaces = visibleFurnaces(ctx).filter((f) => f.inReach);
    const admitted = admittedParameters(ctx, furnaceWait.params).values as { untilOutputAtLeast?: number; maxWaitMs?: number };
    const drafts: CandidateDraft[] = [];
    for (const f of furnaces.slice(0, 2)) {
      const rec = ctx.services.ledger.latestContainer(ctx.snapshot.dimension, f.at.x, f.at.y, f.at.z);
      const loaded = rec && Object.keys(rec.contents).some((k) => k.startsWith('input:'));
      if (!loaded) continue;
      const want = admitted.untilOutputAtLeast ?? ctx.hints.outputs[0]?.count ?? 1;
      drafts.push({ parameters: { furnace: { snapshotId: ctx.snapshot.id, handle: f.handle }, untilOutputAtLeast: Math.min(64, want), maxWaitMs: admitted.maxWaitMs ?? 120_000 }, description: `wait at ${f.key} until ${Math.min(64, want)} outputs are ready` });
    }
    return { drafts, unavailable: drafts.length ? [] : [{ reason: 'no_loaded_furnace', detail: 'no visible furnace in reach is known to hold input' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    if (session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const block = interfaceBlock(services, session, params.furnace, FURNACES);
    if ('error' in block) return precondition(block.error, block.detail);
    const win: Win = await openInterface(act, block);
    const first = await act.confirmWindow();
    if (!first) return failed('no_server_sync', 'furnace resync failed');
    let state = furnaceState(first);
    const started = services.clock.now();
    let lastChange = started;
    let lastOutput = state.output?.count ?? 0;
    let lastProgress = -1;
    const finish = async (result: SkillResult): Promise<SkillResult> => {
      recordFurnace(ctx, block, state);
      act.closeWindow(win as never);
      return result;
    };
    // Intentional wait: event-driven on server slot/property packets, with a coarse guard poll.
    while (true) {
      const seq = session.evidence.seq;
      ctx.progress({ furnace: stateEvidence(state), waitedMs: services.clock.now() - started }, 'server_packet');
      if ((state.output?.count ?? 0) >= params.untilOutputAtLeast) {
        return finish({ status: 'succeeded', effect: `output slot holds ${state.output?.count} ${state.output?.key} (server-observed)`, confirmation: 'server_packet', evidence: { furnace: stateEvidence(state), waitedMs: services.clock.now() - started, properties: json(properties(ctx, win.id)) } });
      }
      const props = properties(ctx, win.id);
      const lit = (props['fuelLeft'] ?? 0) > 0;
      if (!state.input && !lit) {
        return finish({ status: (state.output?.count ?? 0) > 0 ? 'partial' : 'failed', reason: 'input_exhausted', effect: `input is empty; output ${state.output?.count ?? 0}`, confirmation: 'server_packet', evidence: { furnace: stateEvidence(state) } });
      }
      if (state.input && !lit && !state.fuel && services.clock.now() - lastChange > 3_000) {
        return finish({ status: (state.output?.count ?? 0) > 0 ? 'partial' : 'failed', reason: 'fuel_exhausted', effect: `no fuel left with ${state.input.count} input remaining; output ${state.output?.count ?? 0}`, confirmation: 'server_packet', evidence: { furnace: stateEvidence(state) } });
      }
      if (services.clock.now() - started > params.maxWaitMs) {
        return finish({ status: 'partial', reason: 'wait_limit', effect: `wait limit reached; output ${state.output?.count ?? 0}`, confirmation: 'server_packet', evidence: { furnace: stateEvidence(state), properties: json(props) } });
      }
      await act.waitServer('set_slot', (e) => e.windowId === win.id && e.slot <= 2, seq, 1_000);
      for (const e of session.evidence.since(seq, 'set_slot', (x) => x.windowId === win.id && x.slot <= 2)) {
        if (e.slot === 0) state = { ...state, input: e.stack };
        if (e.slot === 1) state = { ...state, fuel: e.stack };
        if (e.slot === 2) state = { ...state, output: e.stack };
        lastChange = services.clock.now();
      }
      const progress = properties(ctx, win.id)['cookProgress'] ?? -1;
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastChange = services.clock.now();
      }
      if ((state.output?.count ?? 0) !== lastOutput) lastOutput = state.output?.count ?? 0;
    }
  },
};

export const furnaceTake: SkillDefinition<{ furnace: { snapshotId: string; handle: string }; slot: 'output' | 'input' | 'fuel' }> = {
  descriptor: {
    id: 'furnace_take',
    family: 'processing',
    purpose: 'Take all items from the output (or input/fuel) slot of a visible furnace-type block into the inventory.',
    parameters: [
      { name: 'furnace', type: 'handle', description: '{snapshotId, handle} of the furnace-type block', required: true },
      { name: 'slot', type: 'string', description: 'slot to empty', required: true, enum: ['output', 'input', 'fuel'] },
    ],
    targets: ['workstation'],
    preconditions: ['furnace visible and within reach', 'slot not empty', 'inventory has room'],
    effects: ['items move to the inventory (server-confirmed)'],
    supportedPredicates: ['smelting_result', 'inventory_amount', 'inventory_delta'],
    timeoutMs: 15_000,
    cancellation: 'stop closes the furnace window; items not yet taken stay in the furnace',
    limitations: ['takes the whole slot (shift-click)'],
    evidence: ['server resync of furnace and inventory before/after'],
  },
  params: z.object({ furnace: HandleRefSchema, slot: z.enum(['output', 'input', 'fuel']) }).strict(),
  resolve(ctx) {
    const missing = namedFurnaceMissing(ctx);
    if (missing) return { drafts: [], unavailable: [missing] };
    const drafts: CandidateDraft[] = [];
    const slot = (admittedParameters(ctx, furnaceTake.params).values['slot'] as 'output' | 'input' | 'fuel' | undefined) ?? 'output';
    for (const f of visibleFurnaces(ctx).filter((x) => x.inReach)) {
      const rec = ctx.services.ledger.latestContainer(ctx.snapshot.dimension, f.at.x, f.at.y, f.at.z);
      const hasOutput = rec ? Object.keys(rec.contents).some((k) => k.startsWith('output:')) : false;
      if (slot !== 'output' || hasOutput || ctx.hints.outputs.length > 0) drafts.push({ parameters: { furnace: { snapshotId: ctx.snapshot.id, handle: f.handle }, slot }, description: `take ${slot} from ${f.key}${rec ? '' : ' (contents not yet observed)'}` });
    }
    return { drafts: drafts.slice(0, 3), unavailable: drafts.length ? [] : [{ reason: 'no_furnace_output_known', detail: 'no visible furnace in reach is known to hold output' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    if (session.bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const block = interfaceBlock(services, session, params.furnace, FURNACES);
    if ('error' in block) return precondition(block.error, block.detail);
    const win = await openInterface(act, block);
    const before = await act.confirmWindow();
    if (!before) return failed('no_server_sync', 'furnace resync failed');
    const slot = SLOT[params.slot];
    const stack = slotStack(before, slot);
    if (!stack) {
      recordFurnace(ctx, block, furnaceState(before));
      act.closeWindow(win as never);
      return precondition('slot_empty', `${params.slot} slot is empty`, { furnace: stateEvidence(furnaceState(before)) });
    }
    const invBefore = regionCounts(before, win.inventoryStart, win.inventoryEnd);
    await act.click(slot, 0, 1, win.id); // shift-click: whole slot to inventory
    await act.sleep(150);
    const after = await act.confirmWindow();
    act.closeWindow(win as never);
    if (!after) return failed('no_server_sync', 'furnace resync failed after take');
    const left = slotStack(after, slot);
    const taken = stack.count - (left?.key === stack.key ? left.count : 0);
    const invAfter = regionCounts(after, win.inventoryStart, win.inventoryEnd);
    const gained = (invAfter[stack.key] ?? 0) - (invBefore[stack.key] ?? 0);
    const state = furnaceState(after);
    recordFurnace(ctx, block, state);
    if (params.slot === 'output' && gained > 0) services.ledger.add({ kind: 'smelted_collected', output: stack.key, count: gained, atMs: services.clock.now() });
    ctx.progress({ taken: gained, item: stack.key }, 'server_sync');
    const evidence = { item: stack.key, takenFromSlot: taken, inventoryGained: gained, furnace: stateEvidence(state), inventoryAfter: countsRecord(new Map(Object.entries(invAfter)), [stack.key]) };
    if (gained <= 0) return failed('take_not_confirmed', `server inventory shows no ${stack.key} gained`, evidence, 'server_sync');
    return { status: left ? 'partial' : 'succeeded', effect: `took ${gained} ${stack.key} from the ${params.slot} slot (server-confirmed)`, confirmation: 'server_sync', evidence };
  },
};
