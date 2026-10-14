import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import type { MemoryFact } from '../src/contracts/memory.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import type { ExecuteContext, ResolveContext } from '../src/skills/definition.ts';
import { freshTaskContext, suitableArmor, suitableTool, type UpkeepTaskContext } from '../src/survival/upkeep.ts';
import { fakeMineflayerBot, type FakeClient } from './skill-fakes.ts';
import { assessInput, cleanupRoots, harness, slot, snapshot, ID, NOW0, SESSION_OW, type Harness, type Slot } from './survival-helpers.ts';

after(cleanupRoots);

const approved = () => ({ id: 'mf-9001', category: 'container', label: 'approved supplies', source: 'owner_statement', status: 'active', location: { dimension: SESSION_OW, at: { x: 2, y: 64, z: 0 } } }) as MemoryFact;
function admission(h: Harness, routine: string) {
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  const p = (d as { proposal: SurvivalProposal }).proposal;
  assert.equal(p.routine, routine);
  const owner = { goalId: 'goal-upk7', goalEpoch: 7 };
  h.service.onSupportAdmitted({ ...owner, proposalId: p.proposalId, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  return { p, owner, fence: { ...owner, connectionEpoch: 1, dimension: SESSION_OW } };
}

/** Real service/raw packet metadata and real skill execution over a credential-
 * free fake window. No server socket, provider, fixture or production controls. */
function executionHarness(player: Record<number, Slot>, chest: Record<number, Slot> = {}, options: Parameters<typeof harness>[0] = {}) {
  let current: { id: number; inventoryStart: number; inventoryEnd: number; slots: Array<{ name: string; count: number; stackSize: number; raw: Slot } | null>; selectedItem: { name: string; count: number; stackSize: number; raw: Slot } | null } | undefined;
  const h = harness({ ...options, containerLayout: () => ({ id: current?.id ?? 0, inventoryStart: current?.inventoryStart ?? 9 }) });
  const client = h.packets.client as unknown as FakeClient;
  const fake = fakeMineflayerBot(client, { dimension: SESSION_OW, at: { x: 0.5, y: 64, z: 0.5 } });
  fake.setBlock(2, 64, 0, 'chest');
  const rawToLocal = (s: Slot | undefined) => !s?.itemCount ? null : { name: Object.keys(ID).find((k) => ID[k] === s.itemId)!, count: s.itemCount, stackSize: 64, raw: structuredClone(s) };
  const localToRaw = (s: ReturnType<typeof rawToLocal>): Slot => s ? { ...s.raw, itemCount: s.count } : { itemCount: 0 };
  const inventory = fake.bot.inventory as unknown as NonNullable<typeof current>;
  inventory.slots = Array.from({ length: 46 }, (_, i) => rawToLocal(player[i]));
  inventory.selectedItem = null;
  const evidence = new ServerEvidence(client, { items: Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, { name }])), entitiesByName: { item: { id: 71 } } }, h.clock.now);
  evidence.attach();
  const log: string[] = [];
  let stateId = 0;
  let cancelled = false;
  const hooks: { afterConfirm?: (windowId: number) => void; onSleep?: (ms: number) => void; afterClick?: () => void } = {};
  const fence = () => { if (cancelled) throw new Error('cancelled lease'); };
  const act = {
    bot: fake.bot, fence,
    window: () => current ?? inventory,
    confirmWindow: async () => {
      fence();
      const w = current ?? inventory;
      client.emit('window_items', { windowId: w.id, stateId: ++stateId, items: w.slots.map(localToRaw), carriedItem: localToRaw(w.selectedItem) });
      const entry = evidence.since(evidence.seq - 1, 'window_items')[0]!;
      hooks.afterConfirm?.(w.id);
      return { windowId: w.id, seq: entry.seq, atMs: entry.atMs, slots: new Map(entry.slots.map((s) => [s.slot, { key: s.key, count: s.count }])), cursor: null };
    },
    openBlockWindow: async () => {
      fence(); log.push('open');
      current = { id: 3, inventoryStart: 27, inventoryEnd: 63, slots: Array.from({ length: 63 }, (_, i) => i < 27 ? rawToLocal(chest[i]) : inventory.slots[9 + i - 27] ?? null), selectedItem: null };
      fake.bot.currentWindow = current;
      return current;
    },
    closeWindow: () => {
      fence(); log.push('close');
      if (current) for (let i = 0; i < 36; i++) inventory.slots[i + 9] = current.slots[i + 27] ?? null;
      current = undefined; fake.bot.currentWindow = null;
    },
    click: async (index: number, button: number) => {
      fence(); log.push(`click:${index}`);
      const w = current ?? inventory;
      if (!w.selectedItem) { w.selectedItem = w.slots[index] ?? null; w.slots[index] = null; }
      else {
        const n = button === 1 ? 1 : w.selectedItem.count;
        const dest = w.slots[index];
        if (dest) dest.count += n;
        else w.slots[index] = { ...w.selectedItem, count: n };
        w.selectedItem.count -= n;
        if (!w.selectedItem.count) w.selectedItem = null;
      }
      hooks.afterClick?.();
    },
    clearPathGoal: () => { fence(); log.push('clear'); },
    selectHotbar: (n: number) => { fence(); fake.bot.quickBarSlot = n; },
    sleep: async (ms: number) => { fence(); h.clock.advance(ms); hooks.onSleep?.(ms); fence(); },
    useHeldItem: () => { fence(); log.push('use'); },
    releaseHeldItem: () => { log.push('release'); },
  };
  const blocks = [{ handle: 'blk-approved', key: 'minecraft:chest', at: { x: 2, y: 64, z: 0 }, inReach: true, distance: 2, label: 'container' }];
  let threat = false;
  const liveSnapshot = () => snapshot({ goalEpoch: 7, takenAtMs: h.clock.now(), blocks: blocks as never, entities: threat ? [{ key: 'minecraft:zombie', distance: 2 }] as never : [] });
  const ledger = { setInventory: () => undefined, add: (value: { kind: string }) => log.push(`ledger:${value.kind}`) };
  const services = { clock: h.clock, ledger, perception: { latest: liveSnapshot, snapshot: async () => liveSnapshot(), resolve: () => ({ target: { kind: 'block', x: 2, y: 64, z: 0, name: 'chest' } }), withinTravel: () => true }, limits: { travelRadius: 128 } } as unknown as ExecuteContext['services'];
  const ctx = { act, session: { bot: fake.bot, evidence, connectionEpoch: 1 }, services, owner: { kind: 'goal', goalId: 'goal-upk7', goalEpoch: 7 }, candidate: { id: 'act-test1', timeoutMs: 30_000 }, progress: (value: unknown, provenance: string) => log.push(`progress:${provenance}`) } as unknown as ExecuteContext;
  const skills = survivalSkills(h.service);
  const run = (id: string, params: unknown = {}) => skills.find((s) => s.descriptor.id === id)!.execute(ctx, params);
  const resolve = (id: string) => skills.find((s) => s.descriptor.id === id)!.resolve({ ...ctx, snapshot: liveSnapshot(), hints: { keys: [], handles: [], parameters: {}, outputs: [] }, task: {} } as unknown as ResolveContext);
  h.packets.inventory(player); h.packets.health(20, 20);
  return { h, run, resolve, hooks, log, cancel: () => { cancelled = true; }, threaten: () => { threat = true; }, inventory };
}

describe('Oct13 bounded upkeep', () => {
  it('the actual SkillRuntime composes every new mechanism into its single catalog/executor', async () => {
    const config = loadConfigFile(new URL('../config/examples/fixture.json', import.meta.url).pathname).config;
    const runtime = new SkillRuntime({ config, session: () => undefined, connectionEpoch: () => 1, goalEpoch: () => 7, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: { now: () => NOW0 }, ids: sequentialIds(), features: { survival: { config: {}, scope: undefined } } });
    try {
      for (const id of ['eat_safe_food', 'rest_in_place', 'equip_suitable_tool', 'equip_suitable_armor', 'move_to_approved_storage', 'inspect_approved_storage', 'store_surplus', 'withdraw_reserve']) {
        assert.ok(runtime.registry.has(id), id);
        assert.ok(runtime.registry.catalog().capabilities.some((c) => c.id === id), id);
      }
      assert.ok(runtime.survival);
    } finally { await runtime.survival?.close(); await runtime.closeSafety(); }
  });
  it('accepts only recent task facts from the same connection and dimension', () => {
    const c = { connectionEpoch: 1, dimension: 'minecraft:overworld', observedAtMs: NOW0, harvest: [], retain: [], reserveKeys: [], requiredFreeSlots: 2 };
    const fence = { connectionEpoch: 1, dimension: SESSION_OW };
    assert.ok(freshTaskContext(c, fence, NOW0));
    for (const value of [{ ...c, connectionEpoch: 2 }, { ...c, dimension: 'the_nether' }, { ...c, observedAtMs: NOW0 - 5_001 }, { ...c, observedAtMs: NOW0 + 1 }, { ...c, requiredFreeSlots: 37 }]) assert.equal(freshTaskContext(value, fence, NOW0), undefined);
  });

  it('never calls a duplicate worn, custom or unknown stack a healthy selectable spare', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('iron_pickaxe'), 37: slot('iron_pickaxe', 1, [{ type: 'damage', data: 249 }]), 38: slot('stone_pickaxe') });
    const inv = h.service.inventory(1)!;
    const cfg = h.service.config()!;
    assert.equal(suitableTool(inv, ['minecraft:iron_pickaxe', 'minecraft:stone_pickaxe'], cfg)?.key, 'minecraft:stone_pickaxe');
    assert.equal(suitableTool(inv, ['minecraft:iron_pickaxe'], cfg), undefined, 'equip-by-key could select the worn copy');
    h.packets.setSlot(37, slot('iron_pickaxe', 1, [{ type: 'custom_name', data: 'precious' }]));
    assert.equal(suitableTool(h.service.inventory(1)!, ['minecraft:iron_pickaxe'], cfg), undefined);
    inv.stacks.forEach((s) => s.meta = { metadata: 'unknown' });
    assert.equal(suitableTool(inv, ['minecraft:stone_pickaxe'], cfg), undefined);
  });

  it('selects healthy ordinary armor and preserves protected or worn gear', () => {
    const h = harness();
    h.packets.inventory({ 20: slot('iron_helmet', 1, [{ type: 'damage', data: 164 }]) });
    assert.equal(suitableArmor(h.service.inventory(1)!, h.service.config()!), undefined);
    h.packets.setSlot(20, slot('iron_helmet'));
    assert.deepEqual(suitableArmor(h.service.inventory(1)!, h.service.config()!), { key: 'minecraft:iron_helmet', slot: 'head' });
    h.packets.setSlot(5, slot('iron_helmet', 1, [{ type: 'custom_name', data: 'owned keepsake' }]));
    assert.equal(suitableArmor(h.service.inventory(1)!, h.service.config()!), undefined);
  });

  it('binds a replacement to the exact harvest set and rejects an unsuitable new spare', () => {
    const task: UpkeepTaskContext = { connectionEpoch: 1, dimension: SESSION_OW, observedAtMs: NOW0, harvest: [{ block: 'minecraft:diamond_ore', tools: ['minecraft:iron_pickaxe'] }], retain: ['minecraft:oak_log'], reserveKeys: [], requiredFreeSlots: 0 };
    const h = harness({ upkeepTaskContext: () => task });
    h.packets.inventory({ 36: slot('stone_pickaxe'), 37: slot('bread', 6) }); h.packets.health(20, 20);
    const a = admission(h, 'tool_upkeep');
    const p = { predicate: 'survival_state', routine: 'tool_upkeep', expect: 'satisfied' } as const;
    assert.equal(h.service.evaluateSurvivalState(p, a.owner).status, 'unsatisfied');
    h.packets.setSlot(38, slot('stone_pickaxe'));
    assert.equal(h.service.evaluateSurvivalState(p, a.owner).status, 'unsatisfied');
    h.packets.setSlot(38, slot('iron_pickaxe'));
    assert.equal(h.service.evaluateSurvivalState(p, a.owner).status, 'satisfied');
    assert.equal(h.service.evaluateSurvivalState(p, { ...a.owner, goalEpoch: 8 }).status, 'unknown');
  });

  it('non-food reserves need a real task; stale context cannot initiate unrelated restocking', () => {
    let task: UpkeepTaskContext = { connectionEpoch: 1, dimension: SESSION_OW, observedAtMs: NOW0, harvest: [], retain: [], reserveKeys: ['minecraft:cobblestone'], requiredFreeSlots: 0 };
    const h = harness({ config: { resupply: { reserves: [{ key: 'minecraft:cobblestone', low: 2, high: 6 }] } }, upkeepTaskContext: () => task });
    h.packets.inventory({}); h.packets.health(20, 20);
    assert.equal(h.service.assess(assessInput(h)).kind, 'propose');
    task = { ...task, reserveKeys: [] };
    assert.equal(h.service.assess(assessInput(h)).kind, 'none');
    task = { ...task, reserveKeys: ['minecraft:cobblestone'], observedAtMs: NOW0 - 5_001 };
    assert.equal(h.service.assess(assessInput(h)).kind, 'none');
  });

  it('approved storage binding requires exact durable approval and is withdrawn on move/removal/stop', () => {
    const h = harness();
    const full = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [i + 9, i ? slot('dirt', 64) : slot('bread', 8)]));
    h.packets.inventory(full); h.packets.health(20, 20);
    const fact = approved(); h.memory.factList.push(fact);
    h.memory.durability.set(fact.id, 'pending');
    assert.equal(h.service.assess(assessInput(h)).kind, 'blocked');
    h.memory.durability.set(fact.id, 'durable');
    const a = admission(h, 'inventory_room');
    assert.ok(!('error' in h.service.upkeepAuthority(a.fence)));
    fact.location!.at.x = 3;
    assert.equal((h.service.upkeepAuthority(a.fence) as { error: string }).error, 'storage_approval_changed');
    fact.location!.at.x = 2;
    h.service.onSupportTerminal({ ...a.owner, proposalId: a.p.proposalId, state: 'cancelled', reason: 'owner_stop', detail: 'stopped', counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: h.clock.now() });
    assert.equal((h.service.upkeepAuthority(a.fence) as { error: string }).error, 'not_upkeep_goal');
  });

  it('rest accumulates the configured no-gain window across local continuations and then stops', async () => {
    const x = executionHarness({ 36: slot('bread', 8) }, {}, { config: { health: { noRegenWindowMs: 5_000, maxRestMs: 10_000 } } });
    x.h.packets.health(10, 20); admission(x.h, 'rest');
    assert.equal((await x.run('rest_in_place', { windowMs: 2_000 })).status, 'succeeded');
    assert.equal((await x.run('rest_in_place', { windowMs: 2_000 })).status, 'succeeded');
    assert.equal((await x.run('rest_in_place', { windowMs: 2_000 })).reason, 'no_regeneration');
    assert.equal((await x.run('rest_in_place', { windowMs: 2_000 })).reason, 'rest_budget_exhausted');
    assert.equal(x.log.some((s) => s === 'progress:server_packet'), false);
  });

  it('rest reports actual server gains, stops on decreasing health, and cancellation cannot continue', async () => {
    const x = executionHarness({ 36: slot('bread', 8) });
    x.h.packets.health(10, 20); admission(x.h, 'rest');
    let tick = 0;
    x.hooks.onSleep = () => x.h.packets.health(++tick === 1 ? 11 : 10, 20);
    assert.equal((await x.run('rest_in_place', { windowMs: 2_000 })).reason, 'took_damage');
    assert.ok(x.log.includes('progress:server_packet'));
    x.hooks.onSleep = x.cancel;
    await assert.rejects(x.run('rest_in_place', { windowMs: 2_000 }), /cancelled lease/);
  });

  it('a threat arriving during food equip/resync prevents consumption', async () => {
    const x = executionHarness({ 36: slot('bread', 8) });
    x.h.packets.health(6, 10); admission(x.h, 'eat');
    x.hooks.afterConfirm = x.threaten;
    assert.equal((await x.run('eat_safe_food', { item: 'minecraft:bread' })).reason, 'threat_nearby');
    assert.equal(x.log.includes('use'), false);
  });

  it('withdrawal candidates come only from fresh approved server stock; transfer caps the real shortfall', async () => {
    const x = executionHarness({ 36: slot('bread', 1) }, { 0: slot('bread', 5), 1: slot('golden_apple'), 2: slot('rotten_flesh') });
    x.h.memory.factList.push(approved()); admission(x.h, 'resupply');
    assert.equal(x.resolve('withdraw_reserve').unavailable?.[0]?.reason, 'storage_inspection_required');
    assert.equal((await x.run('inspect_approved_storage', { container: { snapshotId: 'snap-1', handle: 'blk-approved' } })).status, 'succeeded');
    const offered = x.resolve('withdraw_reserve');
    assert.deepEqual(offered.drafts.map((d) => [d.parameters['item'], d.parameters['count']]), [['minecraft:bread', 5]]);
    const result = await x.run('withdraw_reserve', offered.drafts[0]!.parameters);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(x.h.service.inventory(1)!.stacks.filter((s) => s.key === 'minecraft:bread').reduce((n, s) => n + s.count, 0), 6);
    assert.equal(x.resolve('withdraw_reserve').drafts.length, 0);
    assert.ok(x.log.includes('progress:server_sync'));
  });

  it('approval withdrawn during the fresh inspection sends no transfer click', async () => {
    const x = executionHarness({ 36: slot('bread', 1) }, { 0: slot('bread', 64) });
    x.h.memory.factList.push(approved()); admission(x.h, 'resupply');
    x.hooks.afterConfirm = (id) => { if (id === 3) x.h.memory.factList.splice(0); };
    assert.equal((await x.run('withdraw_reserve', { container: { snapshotId: 'snap-1', handle: 'blk-approved' }, item: 'minecraft:bread', count: 5 })).reason, 'storage_approval_changed');
    assert.equal(x.log.some((s) => s.startsWith('click')), false);
    assert.ok(x.log.includes('close'));
  });

  it('a protected same-key container stack refuses the whole key before any click', async () => {
    const x = executionHarness({ 36: slot('bread', 1) }, { 0: slot('bread', 64), 1: slot('bread', 1, [{ type: 'custom_name', data: 'owner gift' }]) });
    x.h.memory.factList.push(approved()); admission(x.h, 'resupply');
    assert.equal((await x.run('withdraw_reserve', { container: { snapshotId: 'snap-1', handle: 'blk-approved' }, item: 'minecraft:bread', count: 5 })).reason, 'protected_item');
    assert.equal(x.log.some((s) => s.startsWith('click')), false);
  });

  it('oversized storage stock blocks instead of splitting a cursor stack beyond the shortfall', async () => {
    const x = executionHarness({ 36: slot('bread', 1) }, { 0: slot('bread', 64) });
    x.h.memory.factList.push(approved()); admission(x.h, 'resupply');
    assert.equal((await x.run('withdraw_reserve', { container: { snapshotId: 'snap-1', handle: 'blk-approved' }, item: 'minecraft:bread', count: 5 })).reason, 'reserve_stack_exceeds_shortfall');
    assert.equal(x.log.some((s) => s.startsWith('click')), false);
  });

  it('surplus deposit preserves task supplies and only succeeds on both server deltas', async () => {
    const player = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [9 + i, i === 0 ? slot('bread', 8) : i === 1 ? slot('oak_log', 64) : slot('dirt', 64)]));
    const task: UpkeepTaskContext = { connectionEpoch: 1, dimension: SESSION_OW, observedAtMs: NOW0, harvest: [], retain: ['minecraft:oak_log'], reserveKeys: [], requiredFreeSlots: 0 };
    const x = executionHarness(player, {}, { upkeepTaskContext: () => task });
    x.h.memory.factList.push(approved()); admission(x.h, 'inventory_room');
    const candidates = x.resolve('store_surplus').drafts;
    assert.deepEqual(candidates.map((c) => c.parameters['item']), ['minecraft:dirt']);
    const protectedResult = await x.run('store_surplus', { ...candidates[0]!.parameters, item: 'minecraft:oak_log' });
    assert.equal(protectedResult.reason, 'no_longer_surplus');
    assert.equal(x.log.some((s) => s.startsWith('click')), false);
    const result = await x.run('store_surplus', candidates[0]!.parameters);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.evidence?.['sourceDelta'], 64);
    assert.equal(result.evidence?.['destDelta'], 64);
  });

  it('shared dispatch guard refuses arbitrary transfers, protected recipes and excess recipe batches', () => {
    const h = harness(); h.packets.inventory({ 36: slot('bread', 1), 37: slot('oak_planks', 8, [{ type: 'custom_name', data: 'gift' }]) }); h.packets.health(20, 20);
    const a = admission(h, 'resupply');
    for (const capability of ['container_transfer', 'furnace_take', 'furnace_insert', 'drop_item', 'equip_item']) assert.equal(h.service.checkUpkeepCandidate(a.fence, { capability, parameters: {} }).allowed, false);
    h.packets.setSlot(38, slot('diamond_sword'));
    assert.equal(h.service.checkUpkeepCandidate(a.fence, { capability: 'mine_block', parameters: {} }).allowed, false, 'general mining must not choose a protected tool');
    assert.equal(h.service.checkUpkeepCandidate(a.fence, { capability: 'craft_item', parameters: { output: 'minecraft:bread', count: 5 } }, { inputs: ['minecraft:oak_planks'], outputCount: 1 }).allowed, false);
    assert.equal(h.service.checkUpkeepCandidate(a.fence, { capability: 'craft_item', parameters: { output: 'minecraft:bread', count: 5 } }, { inputs: ['minecraft:wheat'], outputCount: 3 }).allowed, false, 'batch rounds to 6, exceeding the five-item shortfall');
  });
});
