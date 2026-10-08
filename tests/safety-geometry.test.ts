// MB-FLOW-003-C11 (offline): local fluid/ceiling/exit/retreat geometry over a voxel world.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deepWaterStepCost, findFluidExits, findOpenColumn, findRetreatTargets, fluidState, hasSafeFluidSupport, isStandable } from '../src/safety/geometry.ts';
import { pool } from './safety-helpers.ts';
import { FakeWorld, flatWorld } from './skill-fakes.ts';

const all = () => true;

describe('fluid state (local estimate)', () => {
  it('standing on the floor of 2-deep water is submerged with open headroom', () => {
    const w = pool(2);
    const f = fluidState(w, { x: 0.5, y: 0, z: 0.5 });
    assert.equal(f.feetIn, 'water');
    assert.equal(f.eyeIn, 'water'); // eye 1.62 < surface 1 + 8/9
    assert.equal(f.headroom, 'open');
    assert.ok(f.surfaceDy !== null && f.surfaceDy > 0 && f.surfaceDy < 0.5);
    assert.equal(f.wadeable, false);
  });

  it('one block of water over solid ground is wadeable, not deep', () => {
    const w = pool(1);
    const f = fluidState(w, { x: 0.5, y: 0, z: 0.5 });
    assert.equal(f.feetIn, 'water');
    assert.equal(f.eyeIn, 'none');
    assert.equal(f.wadeable, true);
    assert.equal(f.support, 'solid');
  });

  it('floating at the surface of 4-deep water: eyes out, feet at swimming depth', () => {
    const w = pool(4);
    const f = fluidState(w, { x: 0.5, y: 2.3, z: 0.5 });
    assert.equal(f.eyeIn, 'none');
    assert.equal(f.feetIn, 'water');
    assert.equal(f.wadeable, false);
    assert.equal(f.fluidTopY, 3);
  });

  it('a solid ceiling above the submerged eye is reported as ceiling, never open', () => {
    const w = pool(4);
    w.set(0, 3, 0, 'stone');
    const f = fluidState(w, { x: 0.5, y: 0, z: 0.5 });
    assert.equal(f.eyeIn, 'water');
    assert.equal(f.headroom, 'ceiling');
    assert.equal(f.surfaceDy, null);
  });

  it('W-C11-R7: actual translated surface bobs retain the four-deep column and shore exits', () => {
    const w = pool(4, 3);
    // Server scene floor -60 translated by +60 into this loaded fake world.
    for (const pos of [
      { x: 0.8762083584, y: 3.73802231455, z: 0.5 },
      { x: 1.1394, y: 3.8394, z: 0.5 },
      { x: 0.5, y: 4.2, z: 0.5 },
    ]) {
      const f = fluidState(w, pos);
      assert.equal(f.feetIn, 'none', 'actual body samples clear the surface');
      assert.equal(f.eyeIn, 'none');
      assert.equal(f.columnFluid, 'water');
      assert.equal(f.depth, 4);
      assert.equal(f.fluidTopY, 3);
      assert.equal(f.wadeable, false);
      assert.equal(hasSafeFluidSupport({ ...f, onGround: false }), false);
      const exits = findFluidExits(w, pos, 'water', { radius: 10, visible: all });
      assert.ok(exits.length > 0);
      assert.ok(exits.every((e) => Math.abs(e.x) >= 4 || Math.abs(e.z) >= 4), 'exit remains at the rim, never the bob');
    }
  });

  it('stable support accepts dry/shallow ground and refuses airborne, lava and missing column evidence', () => {
    const dry = fluidState(pool(4, 3), { x: 4.5, y: 4, z: 0.5 });
    assert.equal(dry.columnFluid, 'none', 'does not scan through solid dry ground');
    assert.equal(hasSafeFluidSupport({ ...dry, onGround: true }), true);
    assert.equal(hasSafeFluidSupport({ ...dry, onGround: false }), false);
    const wade = fluidState(pool(1), { x: 0.5, y: 0, z: 0.5 });
    assert.equal(hasSafeFluidSupport({ ...wade, onGround: true }), true);
    assert.equal(hasSafeFluidSupport({ ...wade, columnFluid: 'lava', onGround: true }), false);
    const w = pool(4);
    const missingFloor = { blockAt: (x: number, y: number, z: number) => y < 0 ? null : w.blockAt(x, y, z) };
    const unknown = fluidState(missingFloor, { x: 0.5, y: 3.84, z: 0.5 });
    assert.equal(unknown.support, 'unknown');
    assert.equal(unknown.depth, null, 'a partial column does not assert its complete depth');
    assert.equal(unknown.wadeable, null);
    assert.equal(hasSafeFluidSupport({ ...unknown, onGround: true }), false);
    assert.equal(fluidState({ blockAt: () => null }, { x: 0.5, y: 0, z: 0.5 }).columnFluid, 'unknown');
    const shallow = pool(1);
    const missingTop = { blockAt: (x: number, y: number, z: number) => y >= 1 ? null : shallow.blockAt(x, y, z) };
    assert.equal(fluidState(missingTop, { x: 0.5, y: 0, z: 0.5 }).wadeable, null, 'unloaded surface cannot prove shallow wading');
  });

  it('waterlogged blocks and kelp count as water; unloaded columns are unknown', () => {
    const w = new FakeWorld({ min: -4, max: 4 });
    w.fill(-4, -1, -4, 4, -1, 4, 'stone');
    w.set(0, 0, 0, 'kelp_plant', []);
    w.set(0, 1, 0, 'kelp', []);
    assert.equal(fluidState(w, { x: 0.5, y: 0, z: 0.5 }).eyeIn, 'water');
    const view = { blockAt: (x: number, y: number, z: number) => (x === 0 && z === 0 && y >= 0 && y <= 1 ? { name: 'oak_slab', shapes: [], waterlogged: true } : w.blockAt(x, y, z)) };
    assert.equal(fluidState(view, { x: 0.5, y: 0, z: 0.5 }).feetIn, 'water');
    const unloaded = { blockAt: () => null };
    assert.equal(fluidState(unloaded, { x: 0.5, y: 0, z: 0.5 }).feetIn, 'none');
  });
});

describe('deep-water path policy (C11 exclusionAreasStep)', () => {
  it('refuses swimming-depth and head-level water, allows wading', () => {
    const deep = pool(2);
    assert.equal(deepWaterStepCost(deep, 0, 1, 0), 100, 'head-level / unsupported water');
    assert.equal(deepWaterStepCost(deep, 0, 0, 0), 0, 'feet block over solid floor (head block decides)');
    const shallow = pool(1);
    assert.equal(deepWaterStepCost(shallow, 0, 0, 0), 0);
    assert.equal(deepWaterStepCost(shallow, 0, 1, 0), 0, 'air above shallow water');
    const w = flatWorld(4);
    w.set(0, 0, 0, 'bubble_column', []);
    assert.equal(deepWaterStepCost(w, 0, 0, 0), 100, 'bubble columns are always refused');
  });
});

describe('exits and open columns', () => {
  it('finds a visible dry exit at the pool rim one step above the water top', () => {
    const w = pool(3);
    const exits = findFluidExits(w, { x: 0.5, y: 1.3, z: 0.5 }, 'water', { radius: 10, visible: all });
    assert.ok(exits.length > 0);
    const e = exits[0]!;
    assert.equal(e.y, 3);
    assert.ok(Math.abs(e.x) === 5 || Math.abs(e.z) === 5, 'exit is just outside the pool');
    assert.ok(isStandable(w, e.x, e.y, e.z));
  });

  it('refuses unseen exits and exits outside the admitted bounds', () => {
    const w = pool(3);
    assert.equal(findFluidExits(w, { x: 0.5, y: 1.3, z: 0.5 }, 'water', { radius: 10, visible: () => false }).length, 0);
    assert.equal(findFluidExits(w, { x: 0.5, y: 1.3, z: 0.5 }, 'water', { radius: 10, visible: all, allowed: () => false }).length, 0);
    assert.equal(findFluidExits(w, { x: 0.5, y: 1.3, z: 0.5 }, 'water', { radius: 3, visible: all }).length, 0, 'rim beyond the radius');
  });

  it('a cliff two blocks above the water top is not an exit', () => {
    const w = pool(3);
    w.fill(-32, 3, -32, 32, 3, 32, 'dirt');
    for (let x = -4; x <= 4; x += 1) for (let z = -4; z <= 4; z += 1) w.set(x, 3, z, 'air', []);
    assert.equal(findFluidExits(w, { x: 0.5, y: 1.3, z: 0.5 }, 'water', { radius: 10, visible: all }).length, 0);
  });

  it('under a ceiling, finds the nearest open column through water at eye level', () => {
    const w = pool(4);
    for (let x = -4; x <= 1; x += 1) for (let z = -4; z <= 4; z += 1) w.set(x, 3, z, 'stone');
    const col = findOpenColumn(w, { x: 0.5, y: 0, z: 0.5 }, 'water', 5);
    assert.ok(col);
    assert.equal(col.x, 2);
    assert.equal(findOpenColumn(w, { x: 0.5, y: 0, z: 0.5 }, 'water', 1), undefined, 'none within 1 block');
  });
});

describe('retreat targets', () => {
  it('increase separation from every threat, stay dry and inside the admitted bounds', () => {
    const w = flatWorld(30);
    const threats = [{ x: 4, y: 0, z: 0 }];
    const t = findRetreatTargets(w, { x: 0.5, y: 0, z: 0.5 }, { threats, separation: 14, legMax: 16, visible: all });
    assert.ok(t.length > 0);
    assert.ok(t[0]!.x < 0, 'retreats away from the threat');
    for (const c of t) assert.ok(c.clearance > 3.5 + 2);
    const bounded = findRetreatTargets(w, { x: 0.5, y: 0, z: 0.5 }, { threats, separation: 14, legMax: 16, visible: all, allowed: (x) => x > 0 });
    for (const c of bounded) assert.ok(c.x > 0);
  });

  it('never retreats into or beside water', () => {
    const w = flatWorld(30);
    for (let x = -20; x <= -1; x += 1) for (let z = -20; z <= 20; z += 1) w.setFluid(x, -1, z, 'water');
    const t = findRetreatTargets(w, { x: 0.5, y: 0, z: 0.5 }, { threats: [{ x: 4, y: 0, z: 0 }], separation: 14, legMax: 16, visible: all });
    for (const c of t) assert.ok(c.x >= 1, `target ${c.x},${c.z} must not be in the water side`);
  });

  it('boxed in: no target', () => {
    const w = flatWorld(30);
    for (let x = -20; x <= 20; x += 1) for (let z = -20; z <= 20; z += 1) if (Math.abs(x) > 2 || Math.abs(z) > 2) w.fill(x, 0, z, x, 2, z, 'stone');
    assert.equal(findRetreatTargets(w, { x: 0.5, y: 0, z: 0.5 }, { threats: [{ x: 2, y: 0, z: 0 }], separation: 14, legMax: 16, visible: all }).length, 0);
  });
});
