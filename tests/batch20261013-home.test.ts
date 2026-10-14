import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vec3 } from 'vec3';
import { describe, it } from 'node:test';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { ShelterInspector, constructionSkills, evaluateStructure } from '../src/skills/construction.ts';
import { confirmInventory } from '../src/skills/common.ts';
import { craftItem } from '../src/skills/crafting.ts';
import { isBlockVisible, faceNormal, type BlockView } from '../src/perception/visibility.ts';
import type { ResolveContext, ExecuteContext } from '../src/skills/definition.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';
import { AutonomyControl } from '../src/autonomy/control.ts';
import { HomeProjectService } from '../src/autonomy/home.ts';
import { canonicalProject, judgeCells, materialRequirements, smallShelterCells, verifyShelter } from '../src/autonomy/blueprint.ts';

const origin = { x: 10, y: 64, z: 10 };
const matches = (tag: string, key: string) => tag === '#minecraft:planks' && key.endsWith('_planks');
const scope = { worldProfile: 'home-offline', worldRevision: 1, botProfile: 'test-bot' };
const clock = { now: () => 100_000, sleep: async () => {} };
const cells = smallShelterCells(origin, 3, 'north');
function harness(store?: ConstructorParameters<typeof AutonomyControl>[0]['store']) {
  const root = resolve('var/home-offline');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(`${root}/project-`);
  const create = () => {
    const control = new AutonomyControl({ scope, rootDir: dir, endpoint: 'offline.invalid:1', rebindEndpoint: false, clock, ...(store ? { store } : {}) });
    control.open();
    return { control, home: new HomeProjectService({ control, clock, record: () => {} }) };
  };
  return { dir, create, ...create() };
}

describe('Oct13 home prerequisites and durable project fencing (no inference/world)', () => {
  it('allocates a stack once across walls/roof/aid and never invents material from unknown cells', () => {
    const verdicts = judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches);
    const r = materialRequirements(verdicts, new Map([['minecraft:oak_planks', 40]]), matches);
    const structural = r.filter((x) => ['wall', 'roof', 'aid'].includes(x.role));
    assert.equal(structural.reduce((n, x) => n + x.count, 0), 56);
    assert.equal(structural.reduce((n, x) => n + x.held, 0), 40);
    assert.equal(structural.reduce((n, x) => n + x.missing, 0), 16);
    const unknown = materialRequirements(judgeCells(cells, () => ({ evidence: 'unknown' }), matches), new Map(), matches);
    assert.equal(unknown.reduce((n, x) => n + x.missing, 0), 0);
    assert.ok(unknown.some((x) => x.unknownCells > 0));
  });

  it('binds structural material while keeping crafting table/furnace/chest requirements exact', () => {
    const r = materialRequirements(judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches), new Map([['minecraft:oak_planks', 64]]), matches, 'minecraft:cobblestone');
    assert.equal(r.find((x) => x.role === 'wall')?.held, 0);
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:crafting_table'));
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:furnace'));
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:chest'));
  });

  it('serializes approval/checkpoint/verification and ignores a stale project writer', async () => {
    const h = harness();
    try {
      const [a, duplicate] = await Promise.all([h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] }), h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] })]);
      assert.equal(a.ok, true);
      assert.equal(duplicate.ok, false);
      if (!a.ok) return;
      const v = verifyShelter(cells, judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches));
      const wall = cells.find((c) => c.role === 'wall')!;
      await Promise.all([h.home.checkpoint({ projectId: a.project.id, at: wall.at, to: 'minecraft:oak_planks', confirmedAtMs: 1_000, capability: 'build_home' }), h.home.verified(v, a.project.id)]);
      assert.equal(h.home.project()?.checkpoints.length, 1);
      assert.equal(await h.home.checkpoint({ projectId: 'proj-other', at: wall.at, to: 'minecraft:stone', confirmedAtMs: 1_000, capability: 'build_home' }), false);
      await h.home.interrupted('stop', 'proj-other');
      assert.equal(h.home.project()?.state, 'building');
      assert.equal(await h.home.checkpoint({ projectId: a.project.id, at: { x: 1, y: 2, z: 3 }, to: 'minecraft:stone', confirmedAtMs: 1_000, capability: 'build_home' }), false);
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('reloads a partial project as history, with no action replay or current inventory claim', async () => {
    const h = harness();
    try {
      const a = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] });
      assert.ok(a.ok);
      if (!a.ok) return;
      await h.home.checkpoint({ projectId: a.project.id, at: cells.find((c) => c.role === 'wall')!.at, to: 'minecraft:oak_planks', confirmedAtMs: 1_000, capability: 'build_home' });
      await h.home.interrupted('stop', a.project.id);
      await h.home.flush(); await h.control.close();
      const next = h.create();
      try {
        assert.equal(next.home.project()?.id, a.project.id);
        assert.equal(next.home.project()?.state, 'interrupted');
        assert.equal(next.home.project()?.checkpoints.length, 1);
        assert.equal(next.home.summary()?.verified, null);
        assert.equal(next.home.project()?.verified, undefined);
      } finally { await next.home.flush(); await next.control.close(); }
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('refuses a truncated canonical checklist and a cancelled queued admission', async () => {
    const h = harness();
    try {
      const cancelled = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] }, () => false);
      assert.equal(cancelled.ok, false);
      assert.equal(h.home.project(), undefined);
      const a = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] });
      assert.ok(a.ok);
      if (!a.ok) return;
      const p = structuredClone(a.project);
      p.cells.pop();
      assert.equal(canonicalProject(p), false);
      assert.equal(await h.control.setHome(p, 'tampered-checklist'), false);
      assert.match(h.control.persistence().detail, /canonical blueprint/);
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

/** Production definitions against a bounded fake voxel/packet/inventory port.
 * This is mechanism coverage, not a real planner/Jev or server acceptance run. */
async function constructionHarness(interior: 2 | 3 = 3) {
  const h = harness();
  const fake = fakeMineflayerBot(fakeClient(), { at: { x: 12.5, y: 64, z: 11.5 }, dimension: 'overworld' });
  fake.fill(-30, 63, -30, 30, 63, 30, 'grass_block');
  let now = 100_000;
  let seq = 1;
  let mode: 'confirm' | 'silent' | 'abort' | 'unexpected' = 'confirm';
  const packetClock = { now: () => now, sleep: async () => {} };
  let connectionEpoch = 1;
  const ledger = new EvidenceLedger(packetClock, () => connectionEpoch);
  const knowledge = new VersionKnowledge({ version: '26.1.2' });
  const facts = new Map<string, { seq: number; stateId: number; atMs: number; x: number; y: number; z: number }>();
  const journal: Array<{ seq: number; stateId: number; atMs: number; x: number; y: number; z: number }> = [];
  const evidence = {
    get seq() { return seq; }, predictionPending: () => false,
    serverBlock: (x: number, y: number, z: number) => facts.get(`${x},${y},${z}`),
    since: (after: number, kind: string, match: (p: typeof journal[number]) => boolean = () => true) => kind === 'block_change' ? journal.filter((p) => p.seq > after && match(p)) : [],
  };
  const session = { bot: fake.bot, evidence, get connectionEpoch() { return connectionEpoch; } };
  const world = { blockAt: (x: number, y: number, z: number) => fake.bot.blockAt(new Vec3(x, y, z)) as unknown as BlockView | null };
  const services = {
    clock: packetClock, ledger, knowledge, limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 },
    perception: { world: () => world, blockVisibleNow: (x: number, y: number, z: number) => isBlockVisible(world, { x: fake.bot.entity.position.x, y: fake.bot.entity.position.y + 1.62, z: fake.bot.entity.position.z }, x, y, z), withinTravel: () => true, travelBounds: () => undefined },
  } as unknown as ResolveContext['services'];
  let inspector = new ShelterInspector(() => session as never, services);
  let skills = constructionSkills({ home: h.home, inspector, interior, maxSiteDistance: 16 });
  const byId = (id: string) => skills.find((s) => s.descriptor.id === id)!;
  const approval = await h.home.approve({ origin, interior, facing: 'north', dimension: 'overworld', checks: ['fake port only'] });
  assert.ok(approval.ok);
  const abort = new AbortController();
  let sends = 0;
  const confirmWindow = async () => ({ windowId: 0, slots: new Map(fake.bot.inventory.slots.flatMap((s, i) => s ? [[i, { key: `minecraft:${s.name}`, count: s.count }] as const] : [])), cursor: null });
  Object.assign(fake.bot, { pathfinder: { setMovements: () => {}, isMoving: () => false } });
  const act = {
    bot: fake.bot, session, signal: abort.signal,
    fence: () => { if (abort.signal.aborted) throw new Error('revoked'); },
    window: () => fake.bot.inventory, confirmWindow,
    selectHotbar: (slot: number) => { fake.bot.quickBarSlot = slot; },
    sleep: async (ms: number) => { now += ms; },
    setPathGoal: (goal: { x: number; y: number; z: number }) => { fake.bot.entity.position.x = goal.x + 0.5; fake.bot.entity.position.y = goal.y; fake.bot.entity.position.z = goal.z + 0.5; },
    clearPathGoal: () => {}, lookAt: async () => {},
    startDig: async (block: { position: { x: number; y: number; z: number } }) => {
      sends += 1;
      const dest = block.position;
      fake.setBlock(dest.x, dest.y, dest.z, 'air');
      const fact = { x: dest.x, y: dest.y, z: dest.z, seq: ++seq, atMs: ++now, stateId: 0 };
      journal.push(fact); facts.set(`${dest.x},${dest.y},${dest.z}`, fact);
    },
    waitServer: async (kind: string, match: (p: typeof journal[number]) => boolean, after: number) => evidence.since(after, kind, match)[0],
    useOnBlock: async (support: { x: number; y: number; z: number }, face: Parameters<typeof faceNormal>[0]) => {
      sends += 1;
      if (mode === 'abort') { abort.abort(); throw new Error('revoked'); }
      if (mode === 'silent') return;
      const n = faceNormal(face);
      const dest = { x: support.x + n.x, y: support.y + n.y, z: support.z + n.z };
      const held = fake.bot.heldItem!;
      fake.setBlock(dest.x, dest.y, dest.z, mode === 'unexpected' ? 'glass' : held.name);
      held.count -= 1;
      if (held.count === 0) fake.bot.inventory.slots[36 + fake.bot.quickBarSlot] = null;
      const fact = { ...dest, seq: ++seq, atMs: ++now, stateId: world.blockAt(dest.x, dest.y, dest.z)!.stateId };
      journal.push(fact); facts.set(`${dest.x},${dest.y},${dest.z}`, fact);
    },
  };
  const resolveSkill = (id: string, parameters: Record<string, unknown> = {}, outputs: ResolveContext['hints']['outputs'] = []) => {
    const ctx = {
      task: { objective: 'complete home', decisionInstruction: 'one grounded step', allowedCapabilities: [id], targetSelectors: [], parameters, completion: { predicate: 'structure_state', structure: 'home', expect: 'complete' } },
      hints: { parameters, outputs, keys: [], handles: [], targetKeys: [], primaryHandles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], memoryRefs: [] },
      snapshot: { id: 'obs-test', dimension: 'overworld', self: { at: fake.bot.entity.position }, owner: { visible: false }, blocks: [] }, session, services,
    } as unknown as ResolveContext;
    return { ctx, result: byId(id).resolve(ctx) };
  };
  const execute = async (id: string, parameters: Record<string, unknown>) => byId(id).execute({ act, session, services, candidate: { id: `action-${sends + 1}` }, owner: { kind: 'goal', goalId: 'goal-home', goalEpoch: 1 }, progress: () => {} } as unknown as ExecuteContext, byId(id).params.parse(parameters));
  const reopen = async () => {
    await h.home.flush(); await h.control.close();
    const next = h.create();
    h.control = next.control; h.home = next.home;
    connectionEpoch += 1;
    ledger.invalidate('disconnect');
    facts.clear(); journal.length = 0;
    inspector = new ShelterInspector(() => session as never, services);
    skills = constructionSkills({ home: h.home, inspector, interior, maxSiteDistance: 16 });
  };
  return { ...h, get home() { return h.home; }, get control() { return h.control; }, fake, get skills() { return skills; }, get inspector() { return inspector; }, reopen, services, session, act, byId, resolveSkill, execute, get sends() { return sends; }, setMode: (next: typeof mode) => { mode = next; } };
}

describe('registered home entry points and generic prerequisite handoff', () => {
  it('empty inventory reports the complete deficits and exact furnishing recipes; the generic craft resolver unlocks the early table', async () => {
    const h = await constructionHarness();
    try {
      const request = h.resolveSkill('inspect_home').result.drafts[0]!;
      const inspected = await h.execute('inspect_home', request.parameters);
      assert.equal(inspected.confirmation, 'server_sync');
      h.fake.give(36, 'oak_planks', 10); // a newer server inventory reading changes the deficits
      await confirmInventory(h.act as never, h.services); // like PredicateEngine.evaluate: new inventory object each round
      const plannerFeedback = h.resolveSkill('inspect_home').result;
      assert.equal(plannerFeedback.drafts.length, 0, 'one inspection yields resolver feedback instead of repeated inference');
      assert.equal(plannerFeedback.unavailable?.[0]?.reason, 'home_inspection_ready');
      const updated = plannerFeedback.unavailable?.[0]?.evidence?.requirements as unknown as Array<{ role: string; held: number; missing: number }>;
      assert.equal(updated.filter((x) => ['wall', 'roof', 'aid'].includes(x.role)).reduce((n, x) => n + x.held, 0), 10);
      assert.equal(updated.filter((x) => ['wall', 'roof', 'aid'].includes(x.role)).reduce((n, x) => n + x.missing, 0), 46, 'feedback uses the newer inventory, not the inspection action old stock');
      assert.ok(plannerFeedback.unavailable?.[0]?.evidence?.recipes);
      const r = inspected.evidence!.requirements as unknown as Array<{ role: string; count: number; missing: number }>;
      assert.equal(r.filter((x) => ['wall', 'roof', 'aid'].includes(x.role)).reduce((n, x) => n + x.count, 0), 56);
      const recipes = inspected.evidence!.recipes as unknown as Array<{ output: string; ingredients: Array<{ count: number }>; workstations: string[] }>;
      assert.equal(recipes.find((r) => r.output === 'minecraft:crafting_table')?.ingredients.reduce((n, i) => n + i.count, 0), 4);
      assert.equal(recipes.find((r) => r.output === 'minecraft:furnace')?.ingredients.reduce((n, i) => n + i.count, 0), 8);
      assert.equal(recipes.find((r) => r.output === 'minecraft:chest')?.ingredients.reduce((n, i) => n + i.count, 0), 8);
      assert.equal(h.resolveSkill('build_home').result.drafts.length, 0);
      const before = evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete');
      assert.notEqual(before.status, 'satisfied');
      // Simulated gathered log; the REAL generic craft resolver chooses its
      // version-correct 2x2 recipe. No finished building materials are seeded.
      h.fake.give(36, 'oak_log', 1);
      const craftContext = h.resolveSkill('inspect_home', {}, [{ key: 'minecraft:oak_planks', count: 4 }]).ctx;
      const craft = craftItem.resolve(craftContext);
      assert.equal(craft.drafts[0]?.parameters['output'], 'minecraft:oak_planks');
      assert.equal(craft.drafts[0]?.parameters['count'], 4);
      assert.equal(craft.drafts[0]?.parameters['workstation'], null);
      h.fake.give(36, 'oak_planks', 4); // simulate the independently tested generic craft port result
      const tableCraft = craftItem.resolve(h.resolveSkill('inspect_home', {}, [{ key: 'minecraft:crafting_table', count: 1 }]).ctx);
      assert.equal(tableCraft.drafts[0]?.parameters['output'], 'minecraft:crafting_table');
      h.fake.give(36, 'crafting_table', 1);
      const table = h.resolveSkill('build_home', { material: 'minecraft:cobblestone' }).result.drafts.find((d) => d.parameters['action'] === 'place')!;
      assert.equal(table.parameters['item'], 'minecraft:crafting_table', 'a structural material does not replace the table');
      const placed = await h.execute('build_home', table.parameters);
      assert.equal(placed.status, 'succeeded');
      assert.equal(placed.confirmation, 'server_packet');
      assert.equal(h.home.project()?.checkpoints[0]?.to, 'minecraft:crafting_table');
      assert.notEqual(evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete').status, 'satisfied', 'a prerequisite or site cannot complete the house goal');
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  for (const mode of ['silent', 'abort', 'unexpected'] as const) it(`${mode} placement never invents a successful accepted block`, async () => {
    const h = await constructionHarness();
    try {
      h.fake.give(36, 'crafting_table', 1);
      const d = h.resolveSkill('build_home').result.drafts.find((d) => d.parameters['action'] === 'place')!;
      h.setMode(mode);
      if (mode === 'abort') await assert.rejects(h.execute('build_home', d.parameters), /revoked/);
      else assert.notEqual((await h.execute('build_home', d.parameters)).status, 'succeeded');
      assert.equal(h.sends, 1);
      assert.notEqual(evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete').status, 'satisfied');
      if (mode !== 'unexpected') { assert.equal(h.home.project()?.checkpoints.length, 0); assert.equal(h.home.project()?.unknownEffects, 1); }
      else assert.equal(h.home.project()?.checkpoints[0]?.to, 'minecraft:glass', 'unexpected confirmed effects are retained honestly');
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('a stale project ID or a forged later-phase roof step sends no command', async () => {
    const h = await constructionHarness();
    try {
      h.fake.give(36, 'crafting_table', 1);
      const d = h.resolveSkill('build_home').result.drafts.find((d) => d.parameters['action'] === 'place')!;
      assert.equal((await h.execute('build_home', { ...d.parameters, projectId: 'proj-stale' })).reason, 'project_changed');
      const roofIndex = h.home.project()!.cells.findIndex((c) => c.role === 'roof');
      assert.equal((await h.execute('build_home', { ...d.parameters, cell: roofIndex })).reason, 'construction_step_changed');
      assert.equal(h.sends, 0);
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});


describe('complete construction geometry with production executors on fake ports', () => {
  for (const interior of [3, 2] as const) it(`${interior}x${interior} interior builds every cell and continues a restarted partial project from fresh truth`, async () => {
    const h = await constructionHarness(interior);
    try {
      const projectId = h.home.project()!.id;
      // These are simulated generic acquisition results. Real full gathering
      // acceptance still requires Codex/Jev and an exclusively leased world.
      h.fake.give(36, 'oak_planks', 64);
      h.fake.give(37, 'crafting_table', 1);
      h.fake.give(38, 'furnace', 1);
      h.fake.give(39, 'chest', 1);
      let restarted = false;
      for (let step = 0; step < 150; step += 1) {
        const evaluation = evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete', projectId);
        if (evaluation.status === 'satisfied') break;
        const r = h.resolveSkill('build_home').result;
        assert.ok(r.drafts.length, `${step}: ${JSON.stringify(r.unavailable)}; ${evaluation.detail}`);
        const d = r.drafts[0]!;
        const result = await h.execute('build_home', d.parameters);
        assert.equal(result.status, 'succeeded', `${step}: ${result.reason} ${result.effect}`);
        if (interior === 2 && result.evidence?.removed === 'minecraft:crafting_table') h.fake.give(37, 'crafting_table', 1); // simulate the generic pickup of the removed own table
        if (!restarted && (interior === 3 ? h.home.project()!.checkpoints.length >= 8 : h.home.project()!.checkpoints.some((c) => c.to === 'minecraft:air'))) {
          await h.home.interrupted('offline stop', projectId);
          const before = h.sends;
          await h.reopen();
          assert.equal(h.sends, before, 'restart issues no saved action');
          assert.equal(h.home.project()?.id, projectId);
          restarted = true;
        }
      }
      const final = evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete', projectId);
      assert.equal(final.status, 'satisfied', final.detail);
      assert.ok(restarted);
      assert.equal(h.home.project()?.id, projectId);
      assert.equal(evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete', 'proj-other').status, 'unsatisfied');
      const entry = { x: origin.x + Math.floor((interior + 2) / 2), y: origin.y, z: origin.z + 1 };
      h.fake.setBlock(entry.x, entry.y, entry.z, 'glass');
      assert.notEqual(evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete', projectId).status, 'satisfied', 'a blocked non-blueprint aisle invalidates practical completion');
      assert.ok(h.home.project()!.checkpoints.every((c) => h.home.project()!.cells.some((cell) => JSON.stringify(cell.at) === JSON.stringify(c.at))), 'no construction outside the footprint');
    } finally { await h.control.flush(); await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});


describe('scoped construction adverse ownership', () => {
  it('a second control in the SAME process cannot steal the first project writer lock', async () => {
    const h = harness();
    const second = h.create();
    try {
      assert.equal(second.home.writable(), false);
      assert.equal(second.control.persistence().state, 'read_only');
      await second.control.close();
      assert.equal(h.home.writable(), true);
      assert.equal((await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] })).ok, true);
    } finally { await second.home.flush(); await second.control.close(); await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('correct-looking third-party construction is foreign, and an old aid cannot be mined after restart', async () => {
    const h = await constructionHarness();
    try {
      const p = h.home.project()!;
      for (const c of p.cells) if (c.role === 'wall' || c.role === 'roof') h.fake.setBlock(c.at.x, c.at.y, c.at.z, 'oak_planks');
      const foreign = h.resolveSkill('build_home').result;
      assert.ok(foreign.unavailable?.some((u) => u.reason === 'foreign_block_in_blueprint'));
      assert.equal(foreign.drafts.length, 0);
      for (const c of p.cells.filter((c) => c.role !== 'entrance' && c.role !== 'aid')) {
        const item = c.role === 'wall' || c.role === 'roof' ? 'minecraft:oak_planks' : c.accept[0]!;
        h.fake.setBlock(c.at.x, c.at.y, c.at.z, item.replace('minecraft:', ''));
        await h.home.checkpoint({ projectId: p.id, at: c.at, to: item, confirmedAtMs: 100_000, capability: 'build_home' });
      }
      const aid = p.cells.find((c) => c.role === 'aid')!;
      h.fake.setBlock(aid.at.x, aid.at.y, aid.at.z, 'oak_planks');
      await h.home.checkpoint({ projectId: p.id, at: aid.at, to: 'minecraft:oak_planks', confirmedAtMs: 100_000, capability: 'build_home' });
      await h.reopen();
      const r = h.resolveSkill('build_home').result;
      assert.ok(r.unavailable?.some((u) => u.reason === 'aid_identity_unproven'), JSON.stringify(r.unavailable));
      assert.equal(r.drafts.length, 0);
      assert.equal(h.sends, 0);
      assert.notEqual(evaluateStructure(h.home, h.inspector, () => h.session as never, 'complete').status, 'satisfied');
    } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});


it('a failed durable site write cannot certify approval from its in-memory project', async () => {
  const h = harness({ beforeRename: () => { throw new Error('offline disk fault'); } });
  try {
    const approval = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] });
    assert.equal(approval.ok, false);
    assert.ok(h.home.project(), 'the control has an uncommitted in-memory value');
    assert.equal(h.home.writable(), false);
    const result = evaluateStructure(h.home, {} as ShelterInspector, () => undefined, 'site_approved');
    assert.equal(result.status, 'unknown');
    assert.match(result.detail, /not writable/);
  } finally { await h.home.flush(); await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
});
