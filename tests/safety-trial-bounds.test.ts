// Credential-free W-H5 regressions for the ACTUAL harness guard/voxel reads.
// RCON selectors model both official releases' delta+1, bounding-box overlap
// semantics. No real fixture, lease, secret, inference or entity filtering.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { guardMutationVolume, insideMutationBox, mobArenaPlan, SAFETY_MUTATION_BOX, SAFETY_TRIAL_BOX, trialEntitySelector, verifyArena, waterArenaPlan, type ArenaFill, type TrialBox } from '../src/safety/trial-arena.ts';
import { parseEntityTest } from '../src/safety/trial-journal.ts';
import { fluidState, hasSafeFluidSupport, isStandable } from '../src/safety/geometry.ts';
import { isEntityVisible, type WorldView } from '../src/perception/visibility.ts';

const require = createRequire(import.meta.url);
interface Body { type: string; name?: string; tag?: string; box: TrialBox }
const intersects = (a: TrialBox, b: TrialBox) => [0, 1, 2].every((i) => a[i]! < b[i + 3]! && a[i + 3]! > b[i]!);
const body = (x: number, y: number, z: number, width = 0.6, height = 1.8): TrialBox => [x - width / 2, y, z - width / 2, x + width / 2, y + height, z + width / 2];
const selectorBox = (selector: string): TrialBox => {
  const ns = Object.fromEntries([...selector.matchAll(/(?:^|,)(x|y|z|dx|dy|dz)=(-?\d+)/g)].map((m) => [m[1], Number(m[2])]));
  for (const k of ['x', 'y', 'z', 'dx', 'dy', 'dz']) assert.ok(Number.isFinite(ns[k]), `missing bound ${k}`);
  assert.ok(ns.dx! >= 0 && ns.dy! >= 0 && ns.dz! >= 0);
  return [ns.x!, ns.y!, ns.z!, ns.x! + ns.dx! + 1, ns.y! + ns.dy! + 1, ns.z! + ns.dz! + 1];
};
const entityServer = (entities: readonly Body[], commands: string[]) => async (command: string): Promise<string> => {
  commands.push(command);
  const m = /^execute if entity @(e|a)\[([^\]]+)\]$/.exec(command);
  assert.ok(m, `unexpected/mutating guard command ${command}`);
  const selector = m[2]!; const box = selectorBox(selector);
  const excluded = [...selector.matchAll(/type=!(\w+)/g)].map((t) => t[1]);
  const tag = /tag=!(\w+)/.exec(selector)?.[1];
  const name = /name=!(\w+)/.exec(selector)?.[1];
  const found = entities.filter((e) => (m[1] === 'e' || e.type === 'player') && !excluded.includes(e.type) && (!tag || e.tag !== tag) && (!name || e.name !== name) && intersects(e.box, box));
  return found.length ? `Test passed. Count: ${found.length}` : 'Test failed';
};
const guard = (entities: readonly Body[], commands: string[] = []) => guardMutationVolume(entityServer(entities, commands), 'cbsafe_test', 'Chunkbot', () => {});

describe('W-H5 complete mutation-volume occupancy', () => {
  it('covers the inclusive last voxel on every axis, including a single-block volume', () => {
    assert.deepEqual(selectorBox(trialEntitySelector(SAFETY_TRIAL_BOX)), [240, -61, 190, 271, -47, 221], 'original dx30 already includes block270 in both official releases');
    assert.deepEqual(selectorBox(trialEntitySelector(SAFETY_MUTATION_BOX)), [240, -61, 196, 269, -47, 221]);
    assert.deepEqual(selectorBox(trialEntitySelector([268, -48, 220, 268, -48, 220])), [268, -48, 220, 269, -47, 221]);
    assert.throws(() => trialEntitySelector([240, -61, 196, 271, -48, 220]), /outside/);
    assert.throws(() => trialEntitySelector([240, -61, 196, 268.5, -48, 220]), /outside/);
    assert.throws(() => trialEntitySelector([268, -48, 220, 240, -61, 196]), /outside/);
  });

  it('preserves known boundary animals while refusing the SAME species anywhere intersecting staging', async () => {
    for (const release of ['26.1.2', '26.2']) {
      const data = require('minecraft-data')(release);
      const pig = data.entitiesByName.pig; const horse = data.entitiesByName.zombie_horse;
      const ambient: Body[] = [
        { type: 'pig', box: body(261.2505221197028, -60, 193.80199476947251, pig.width, pig.height) },
        { type: 'zombie_horse', box: body(270.5, -60, 208.5, horse.width, horse.height) },
      ];
      const original = JSON.stringify(ambient); const commands: string[] = [];
      assert.equal(parseEntityTest(await entityServer(ambient, [])(`execute if entity @e[${trialEntitySelector(SAFETY_TRIAL_BOX)}]`)), true, 'old complete clone correctly found these bodies');
      await guard(ambient, commands);
      assert.equal(commands.length, 2);
      assert.equal(JSON.stringify(ambient), original, 'no kill/relocation or identity exemption');
      for (const e of ambient) await assert.rejects(guard([{ ...e, box: body(255.5, -56, 205.5, pig.width, pig.height) }]), /foreign arena occupants present/);
      await assert.rejects(guard([{ type: 'unknown', box: body(255.5, -56, 205.5) }]), /present/, 'unrecognized species still refuse');
    }
  });

  it('refuses outside-center bodies overlapping ALL six faces, edges/corners and the last cell', async () => {
    const volume = selectorBox(trialEntitySelector(SAFETY_MUTATION_BOX));
    for (const axis of [0, 1, 2]) for (const end of [false, true]) {
      const b: TrialBox = [254, -56, 204, 255, -55, 205];
      const face = volume[axis + (end ? 3 : 0)]!;
      b[axis] = end ? face - 0.1 : face - 0.9;
      b[axis + 3] = end ? face + 0.9 : face + 0.1;
      const center = (b[axis]! + b[axis + 3]!) / 2;
      assert.ok(end ? center > face : center < face, 'discriminates center-only filtering');
      await assert.rejects(guard([{ type: 'unknown', box: b }]), /present/, `axis${axis}/${end}`);
    }
    await assert.rejects(guard([{ type: 'pig', box: [268.9, -47.1, 220.9, 269.9, -46.1, 221.9] }]), /present/, 'outside center across three last-block faces');
    await assert.rejects(guard([{ type: 'giant', box: body(270.2, -56, 205.5, 3) }]), /present/, 'no guessed maximum species width');
    await guard([{ type: 'pig', box: [269, -56, 204, 270, -55, 205] }]); // touching only, no colliding volume
  });

  it('other players overlap-refuse; only owned summons/bot and declared item/xp types are excluded', async () => {
    const inside = body(255.5, -56, 205.5);
    await guard([{ type: 'zombie', tag: 'cbsafe_test', box: inside }, { type: 'player', name: 'Chunkbot', box: inside }, { type: 'item', box: inside }, { type: 'experience_orb', box: inside }]);
    const commands: string[] = [];
    await assert.rejects(guard([{ type: 'player', name: 'Jake', box: [268.9, -56, 204, 269.5, -54.2, 204.6] }], commands), /present/);
    assert.equal(commands.length, 2, 'players query is required, not skipped by @e type exclusion');
    await assert.rejects(guard([{ type: 'zombie', tag: 'cbsafe_old', box: inside }]), /present/, 'old run tags are foreign');
  });

  it('refuses concatenated/unknown replies before mutations and keeps exact partial evidence; reads never overlap', async () => {
    for (const bad of ['', 'Command failed', 'Test failed\nTest failed', 'Test failedTest passed. Count: 1', 'Test passed. Count: 0', '12 force loaded chunks were foundTest failed']) {
      let calls = 0; let mutations = 0; const evidence: string[] = [];
      await assert.rejects((async () => {
        await guardMutationVolume(async () => { calls += 1; return bad; }, 'cbsafe_test', 'Chunkbot', (_kind, _command, reply) => { evidence.push(reply); });
        mutations += 1;
      })(), /unreadable/);
      assert.equal(calls, 1); assert.equal(mutations, 0); assert.deepEqual(evidence, [bad]);
    }
    let busy = false; const order: string[] = [];
    await guardMutationVolume(async (command) => {
      assert.equal(busy, false); busy = true; order.push(command);
      await new Promise<void>((resolve) => setTimeout(resolve, 2)); busy = false; return 'Test failed';
    }, 'cbsafe_test', 'Chunkbot', (kind) => { order.push(kind); });
    assert.deepEqual(order.map((s) => s.startsWith('execute') ? 'read' : s), ['read', 'entities', 'read', 'players']);
    await assert.rejects(guardMutationVolume(async () => { throw new Error('must not read'); }, 'x,tag=!foreign', 'Chunkbot', () => {}), /invalid staging identity/);
  });
});

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const each = (box: TrialBox, visit: (x: number, y: number, z: number) => void) => {
  for (let x = box[0]; x <= box[3]; x += 1) for (let y = box[1]; y <= box[4]; y += 1) for (let z = box[2]; z <= box[5]; z += 1) visit(x, y, z);
};
const apply = (world: Map<string, string>, plan: readonly ArenaFill[]) => {
  for (const f of plan) { assert.ok(insideMutationBox(f.box)); each(f.box, (x, y, z) => world.set(key(x, y, z), f.block)); }
};
const worldView = (blocks: Map<string, string>): WorldView => ({ blockAt: (x, y, z) => {
  const name = blocks.get(key(x, y, z));
  return name === undefined ? null : { name, stateId: name === 'air' ? 0 : 1, shapes: name === 'air' || name === 'water' ? [] : [[0, 0, 0, 1, 1, 1]], ...(name === 'water' ? { level: 0 } : {}) };
} });
const blockServer = (blocks: Map<string, string>) => async (command: string) => {
  const m = /^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/.exec(command);
  if (m) return blocks.get(key(Number(m[1]), Number(m[2]), Number(m[3]))) === m[4] ? 'Test passed' : 'Test failed';
  const compare = /^execute if blocks ((?:-?\d+ ){8}-?\d+) all$/.exec(command);
  assert.ok(compare, `unexpected/mutating verifier ${command}`);
  const ns = compare[1]!.split(' ').map(Number); const b = ns.slice(0, 6) as TrialBox;
  let same = true;
  each(b, (x, y, z) => { if (blocks.get(key(x, y, z)) !== blocks.get(key(x + ns[6]! - b[0], y + ns[7]! - b[1], z + ns[8]! - b[2]))) same = false; });
  return same ? 'Test passed. Count: 1' : 'Test failed';
};

describe('W-H5 bounded staging and unchanged original restoration', () => {
  it('all mob/water/ceiling fills partition exactly 10,150 cells and preserve ALL 3,304 outside-strip cells', async () => {
    const original = new Map<string, string>();
    each(SAFETY_TRIAL_BOX, (x, y, z) => original.set(key(x, y, z), `original_${x}_${y}_${z}`));
    assert.equal(original.size, 13_454);
    for (const plan of [mobArenaPlan(), waterArenaPlan(), waterArenaPlan(true)]) {
      const world = new Map(original); const touched = new Set<string>();
      for (const f of plan) each(f.box, (x, y, z) => { const k = key(x, y, z); assert.ok(!touched.has(k), `overlapping final regions ${k}`); touched.add(k); });
      assert.equal(touched.size, 10_150);
      apply(world, plan);
      for (const [k, value] of original) if (!touched.has(k)) assert.equal(world.get(k), value);
      assert.equal(original.size - touched.size, 3_304);
      await verifyArena(blockServer(world), plan);
      // Whole original backup is restored, not just the smaller staging box.
      for (const [k, value] of original) world.set(k, value);
      assert.deepEqual(world, original);
    }
  });

  it('the actual verifier refuses boundary blast holes, pool corruption, missing banks/floor/lid and unknown blocks', async () => {
    for (const lid of [false, true]) {
      const plan = waterArenaPlan(lid); const world = new Map<string, string>(); apply(world, plan);
      for (const p of [[268, -50, 210], [255, -54, 196], [255, -48, 210], [259, -57, 205], [255, -61, 205], [255, -59, 205], [255, -57, 205]] as const) {
        const broken = new Map(world); broken.set(key(p[0], p[1], p[2]), 'air');
        await assert.rejects(verifyArena(blockServer(broken), plan), /staging_unready/, `missing voxel ${p}`);
      }
      await assert.rejects(verifyArena(async () => 'Test failedTest passed', plan), /staging_unready/);
      await assert.rejects(verifyArena(blockServer(world), [{ box: [240, -61, 195, 268, -48, 220], block: 'air' }]), /outside staging/, 'no verifier expansion into untouched strips');
    }
  });

  it('retains real dry bank support, deep bobs and ceiling limits while opaque geometry hides untouched exterior animals', () => {
    const blocks = new Map<string, string>(); apply(blocks, waterArenaPlan()); const world = worldView(blocks);
    for (const y of [-56.26197768545145, -56.1606]) {
      const f = fluidState(world, { x: 255.5, y, z: 205.5 });
      assert.equal(f.depth, 4); assert.equal(f.columnFluid, 'water');
      assert.equal(hasSafeFluidSupport({ ...f, onGround: false }), false);
    }
    const bank = { x: 259.37, y: -56, z: 205.5 };
    assert.equal(isStandable(world, 259, -56, 205), true);
    assert.equal(hasSafeFluidSupport({ ...fluidState(world, bank), onGround: true }), true);
    assert.equal(fluidState({ blockAt: () => null }, bank).support, 'unknown');
    for (const plan of [mobArenaPlan(), waterArenaPlan(), waterArenaPlan(true)]) {
      const cells = new Map<string, string>(); apply(cells, plan); const w = worldView(cells);
      const eye = { x: 255.5, y: -54.38, z: 205.5 };
      assert.equal(isEntityVisible(w, eye, { x: 270.5, y: -60, z: 208.5 }, 1.6), false);
      assert.equal(isEntityVisible(w, eye, { x: 261.250522, y: -60, z: 193.801995 }, 0.9), false);
    }
    apply(blocks, waterArenaPlan(true));
    assert.equal(fluidState(world, { x: 255.5, y: -60, z: 205.5 }).headroom, 'ceiling');
  });
});
