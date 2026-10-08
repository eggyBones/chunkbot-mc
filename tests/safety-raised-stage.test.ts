// H7 proposed geometry: unchanged full clone, optional raised stage. Pure
// voxel/body guards and installed physics; no world, RCON, secrets or joins.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { Vec3 } from 'vec3';
import { guardMutationVolume, guardedStageMutation, insideMutationBox, mobArenaPlan, mobTrialOrigin, SAFETY_BASE_LAYOUT, SAFETY_RAISED_LAYOUT, SAFETY_TRIAL_BOX, trialEntitySelector, verifyArena, waterArenaPlan, type ArenaFill, type TrialBox, type TrialLayout } from '../src/safety/trial-arena.ts';
import { findFluidExits, findRetreatTargets, fluidState, hasSafeFluidSupport } from '../src/safety/geometry.ts';
import { isBlockVisible, isEntityVisible, type WorldView } from '../src/perception/visibility.ts';

const require = createRequire(import.meta.url);
const raised = SAFETY_RAISED_LAYOUT;
const each = (box: TrialBox, visit: (x: number, y: number, z: number) => void) => {
  for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) visit(x, y, z);
};
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
function voxel(plan: readonly ArenaFill[]) {
  const blocks = new Map<string, string>();
  for (const f of plan) each(f.box, (x, y, z) => { const k = key(x, y, z); assert.ok(!blocks.has(k), `overlap ${k}`); blocks.set(k, f.block); });
  const view: WorldView = { blockAt: (x, y, z) => {
    const name = blocks.get(key(x, y, z)) ?? 'air';
    return { name, stateId: name === 'air' ? 0 : 1, shapes: name === 'air' || name === 'water' ? [] : [[0, 0, 0, 1, 1, 1]], ...(name === 'water' ? { level: 0 } : {}) };
  } };
  const read = async (command: string) => {
    const p = /^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/.exec(command);
    if (p) return blocks.get(key(Number(p[1]), Number(p[2]), Number(p[3]))) === p[4] ? 'Test passed' : 'Test failed';
    const m = /^execute if blocks ((?:-?\d+ ){8}-?\d+) all$/.exec(command); assert.ok(m, `unexpected read ${command}`);
    const ns = m[1]!.split(' ').map(Number); const b = ns.slice(0, 6) as TrialBox; let same = true;
    each(b, (x, y, z) => { if (blocks.get(key(x, y, z)) !== blocks.get(key(x + ns[6]! - b[0], y + ns[7]! - b[1], z + ns[8]! - b[2]))) same = false; });
    return same ? 'Test passed. Count: 1' : 'Test failed';
  };
  return { blocks, view, read };
}
const intersects = (a: TrialBox, b: TrialBox) => [0, 1, 2].every((i) => a[i]! < b[i + 3]! && a[i + 3]! > b[i]!);
const body = (x: number, y: number, z: number, width: number, height: number): TrialBox => [x - width / 2, y, z - width / 2, x + width / 2, y + height, z + width / 2];
const extent = (layout: TrialLayout): TrialBox => layout.mutation.map((n, i) => i >= 3 ? n + 1 : n) as TrialBox;
const entityRead = (bodies: readonly TrialBox[]) => async (command: string) => {
  assert.ok(command.includes(trialEntitySelector(raised.mutation)));
  return command.includes('@e[') && bodies.some((b) => intersects(b, extent(raised))) ? 'Test passed. Count: 1' : 'Test failed';
};

describe('H7 opt-in raised staging inside unchanged original restoration', () => {
  it('partitions 7,250 cells, preserves all 6,204 untouched originals and restores the entire 13,454-block clone', async () => {
    const original = new Map<string, string>(); each(SAFETY_TRIAL_BOX, (x, y, z) => original.set(key(x, y, z), `original_${x}_${y}_${z}`));
    assert.equal(original.size, 13_454);
    for (const plan of [mobArenaPlan(raised), waterArenaPlan(false, raised), waterArenaPlan(true, raised)]) {
      const v = voxel(plan); assert.equal(v.blocks.size, 7_250);
      for (const f of plan) assert.ok(insideMutationBox(f.box, raised));
      const scene = new Map(original); for (const [k, b] of v.blocks) scene.set(k, b);
      let untouched = 0; for (const [k, b] of original) if (!v.blocks.has(k)) { assert.equal(scene.get(k), b); untouched++; }
      assert.equal(untouched, 6_204);
      assert.ok(await verifyArena(v.read, plan, raised) >= 26);
      for (const [k, b] of original) scene.set(k, b); assert.deepEqual(scene, original);
      // A single missing bottom voxel invalidates the proposed raised floor.
      v.blocks.set(key(255, -57, 205), 'air'); await assert.rejects(verifyArena(v.read, plan, raised), /staging_unready/);
    }
    assert.equal(insideMutationBox([240, -58, 196, 268, -48, 220], raised), false, 'old bottom layer cannot be silently written');
  });

  it('uses opaque geometry and production retreat planning in all 32 bearings with four-high clearance', () => {
    const { view } = voxel(mobArenaPlan(raised)); const p = mobTrialOrigin(raised); const eye = { ...p, y: p.y + 1.62 };
    assert.equal(isEntityVisible(view, eye, { x: 253.5, y: -60, z: 201.5 }, 1.6), false, 'below-floor horse is physically obscured, not filtered');
    assert.equal(isEntityVisible(view, eye, { ...p, x: 271 }, 1.95), false);
    assert.equal(isEntityVisible(view, eye, { ...p, x: p.x + 3 }, 1.95), true);
    for (let i = 0; i < 32; i++) {
      const theta = i * Math.PI / 16; const threat = { x: p.x + 3 * Math.cos(theta), y: p.y, z: p.z + 3 * Math.sin(theta) };
      const targets = findRetreatTargets(view, p, { threats: [threat], separation: 8, legMax: 6, allowed: (x, _y, z) => Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) <= 12, visible: (x, y, z) => isBlockVisible(view, eye, x, y, z) });
      assert.ok(targets.some((t) => t.clearance >= 8), `unchanged separation attainable at bearing ${i}`);
      for (const t of targets) for (let step = 0; step <= 20; step++) {
        const x = Math.floor(p.x + (t.x + 0.5 - p.x) * step / 20); const z = Math.floor(p.z + (t.z + 0.5 - p.z) * step / 20);
        assert.equal(view.blockAt(x, p.y - 1, z)?.name, 'sea_lantern');
        for (let y = p.y; y < -48; y++) assert.equal(view.blockAt(x, y, z)?.name, 'air');
      }
    }
  });

  it('preserves four-deep bob tracking, actual dry east-bank targeting and solid ceiling blocker', () => {
    const { view } = voxel(waterArenaPlan(false, raised));
    for (const y of [-52.26197768545145, -52.1606]) {
      const p = { x: 255.5, y, z: 205.5 }; const f = fluidState(view, p); const eye = { ...p, y: y + 1.62 };
      assert.equal(f.feetIn, 'none'); assert.equal(f.eyeIn, 'none'); assert.equal(f.columnFluid, 'water'); assert.equal(f.depth, 4);
      assert.equal(hasSafeFluidSupport({ ...f, onGround: false }), false);
      const targets = findFluidExits(view, p, 'water', { radius: 8, max: 32, visible: (x, fy, z) => isBlockVisible(view, eye, x, fy, z), allowed: () => true });
      assert.ok(targets.some((t) => t.x === 259 && t.y === -52 && t.z === 205));
    }
    assert.equal(hasSafeFluidSupport({ ...fluidState(view, { x: 259.37, y: -52, z: 205.5 }), onGround: true }), true);
    assert.equal(fluidState(voxel(waterArenaPlan(true, raised)).view, { x: 255.5, y: -56, z: 205.5 }).headroom, 'ceiling');
  });

  it('guard admits space above saved bodies, refuses SAME bodies when overlapping, unknown tall bodies and all six inclusive faces', async () => {
    for (const version of ['26.1.2', '26.2']) {
      const horse = require('minecraft-data')(version).entitiesByName.zombie_horse;
      const saved = body(253.5, -60, 201.5, horse.width, horse.height);
      assert.equal(intersects(saved, extent(SAFETY_BASE_LAYOUT)), true, 'retained position is a concrete original-layout obstruction');
      assert.equal(intersects(saved, extent(raised)), false);
      const snapshot = JSON.stringify(saved);
      await guardMutationVolume(entityRead([saved]), 'run', 'Chunkbot', () => {}, raised);
      assert.equal(JSON.stringify(saved), snapshot, 'no animal mutation');
      const overlap = body(253.5, -58.5, 201.5, horse.width, horse.height);
      await assert.rejects(guardMutationVolume(entityRead([overlap]), 'run', 'Chunkbot', () => {}, raised), /present/);
    }
    await assert.rejects(guardMutationVolume(entityRead([body(253.5, -60, 201.5, 2, 3.1)]), 'run', 'Chunkbot', () => {}, raised), /present/, 'unknown species/height cannot be exempted');
    for (const axis of [0, 1, 2]) for (const upper of [false, true]) {
      const b: TrialBox = [254, -52, 204, 255, -51, 205]; const face = extent(raised)[axis + (upper ? 3 : 0)]!;
      b[axis] = face - (upper ? 0.1 : 0.9); b[axis + 3] = face + (upper ? 0.9 : 0.1);
      await assert.rejects(guardMutationVolume(entityRead([b]), 'run', 'Chunkbot', () => {}, raised), /present/);
    }
  });

  it('actual per-mutation seam stops a later fill/heal when a foreign body arrives after the first fill', async () => {
    let bodies: TrialBox[] = []; const writes: string[] = []; const order: string[] = [];
    const read = async (command: string) => { order.push('read'); return entityRead(bodies)(command); };
    const write = async (command: string) => { writes.push(command); order.push('write'); bodies = [body(255.5, -52, 205.5, 0.6, 1.8)]; return 'Filled'; };
    const first = `fill ${mobArenaPlan(raised)[0]!.box.join(' ')} minecraft:dirt`;
    await guardedStageMutation(read, write, first, 'run', 'Chunkbot', () => {}, raised);
    for (const next of ['fill 255 -52 205 255 -52 205 minecraft:air', 'effect give Chunkbot minecraft:instant_health 1 4 true']) await assert.rejects(guardedStageMutation(read, write, next, 'run', 'Chunkbot', () => {}, raised), /present/);
    assert.deepEqual(writes, [first]); assert.deepEqual(order, ['read', 'read', 'write', 'read', 'read']);
    await assert.rejects(guardedStageMutation(async () => 'Test failedTest passed', write, 'clear Chunkbot', 'run', 'Chunkbot', () => {}, raised), /unreadable/);
    assert.equal(writes.length, 1, 'unknown evidence cannot authorize another mutation');
  });
});

function physicsRig(version: string, layout: TrialLayout, bob: boolean) {
  const data = require('minecraft-data')(version); const Block = require('prismarine-block')(data);
  const v = voxel(waterArenaPlan(false, layout)); const { Physics, PlayerState } = require('prismarine-physics');
  const world = { getBlock: (p: Vec3) => { const at = p.floored(); const name = v.view.blockAt(at.x, at.y, at.z)!.name; const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = at; return b; } };
  const physics = Physics(data, world);
  const bot = { version, entity: { position: new Vec3(bob ? 255.8762083584 : 255.5, bob ? layout.feetY - 0.26197768545 : layout.feetY - 4, 205.5), velocity: new Vec3(0, 0, 0), onGround: false, isInWater: true, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, attributes: {}, yaw: -Math.PI / 2, pitch: 0, effects: {} }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] } };
  const tick = (escape: boolean) => { const s = new PlayerState(bot, { forward: escape, back: false, left: false, right: false, jump: escape, sprint: escape, sneak: false }); physics.simulatePlayer(s, world); s.apply(bot); };
  return { bot, tick, view: v.view };
}
for (const version of ['26.1.2', '26.2']) describe(`H7 installed translated water physics (${version})`, () => {
  it('floor/bob escape and released dry settlement preserve trajectories within the same finite geometry', () => {
    for (const bob of [false, true]) {
      const base = physicsRig(version, SAFETY_BASE_LAYOUT, bob); const up = physicsRig(version, raised, bob);
      for (let t = 0; t < 180; t++) {
        const escape = base.bot.entity.position.x < 259.37;
        base.tick(escape); up.tick(escape);
        assert.ok(Math.abs(base.bot.entity.position.x - up.bot.entity.position.x) < 1e-9);
        assert.ok(Math.abs(base.bot.entity.position.y + 4 - up.bot.entity.position.y) < 1e-9);
      }
      assert.ok(up.bot.entity.position.x >= 259.37 && up.bot.entity.position.x < 262, 'actual local physics reaches east bank and settles');
      assert.equal(up.bot.entity.onGround, true);
      assert.equal(hasSafeFluidSupport({ ...fluidState(up.view, up.bot.entity.position), onGround: up.bot.entity.onGround }), true);
    }
  });
});
