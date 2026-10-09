// MB-FLOW-003-C11 W-G1/W-G2 SOURCE mechanics (offline, installed stack):
// the integrity-pinned vendored prismarine-physics (26.2 compat build; the
// same package also serves 26.1.2) simulated over real block states of each
// exact version's minecraft-data. Proves the client-physics premise of the
// escape pattern: holding jump in water rises to the surface; with controls
// released (e.g. after a follow path is cleared) the body sinks and the eyes
// stay under water. This is CLIENT physics evidence only; server movement
// acceptance, air ticks and drowning damage remain fixture (W1) evidence.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { Vec3 } from 'vec3';
import { fluidState, hasSafeFluidSupport } from '../src/safety/geometry.ts';
import { fluidHazards } from '../src/safety/policy.ts';
import { config, self } from './safety-helpers.ts';

const require = createRequire(import.meta.url);
const { Physics, PlayerState } = require('prismarine-physics') as {
  Physics: (mcData: unknown, world: unknown) => { simulatePlayer(state: unknown, world: unknown): unknown };
  PlayerState: new (bot: unknown, control: Record<string, boolean>) => { pos: Vec3; vel: Vec3; isInWater: boolean; onGround: boolean; apply(bot: unknown): void };
};

function rig(version: string, depth: number, ceilingAt?: number) {
  const mcData = require('minecraft-data')(version);
  const Block = require('prismarine-block')(mcData);
  const water = mcData.blocksByName.water.minStateId as number;
  const stone = mcData.blocksByName.stone.defaultState as number;
  const stateAt = (x: number, y: number, z: number): number => {
    if (y < 0) return stone;
    if (ceilingAt !== undefined && y === ceilingAt) return stone;
    if (Math.abs(x) <= 6 && Math.abs(z) <= 6 && y < depth) return water;
    return 0;
  };
  const world = {
    getBlock(pos: Vec3) {
      const p = pos.floored();
      const b = Block.fromStateId(stateAt(p.x, p.y, p.z), 0);
      b.position = p;
      return b;
    },
  };
  const view = {
    blockAt(x: number, y: number, z: number) {
      const id = stateAt(x, y, z);
      const b = Block.fromStateId(id, 0);
      return { name: b.name, shapes: b.shapes ?? [], ...(b.name === 'water' ? { level: id - water } : {}) };
    },
  };
  const physics = Physics(mcData, world);
  const bot = {
    version,
    entity: { position: new Vec3(0.5, 0, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: true, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, attributes: {}, yaw: 0, pitch: 0, effects: {} },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    inventory: { slots: [] as unknown[] },
  };
  const run = (ticks: number, control: Record<string, boolean>) => {
    for (let i = 0; i < ticks; i += 1) {
      const s = new PlayerState(bot, { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...control });
      physics.simulatePlayer(s, world);
      s.apply(bot);
    }
    return bot.entity.position.clone();
  };
  return { bot, run, view };
}

for (const version of ['26.1.2', '26.2']) {
  describe(`installed physics, ${version}`, () => {
    it('W-C11-R7: near-surface body samples are dry, but released controls sink and held jump never proves an exit', () => {
      const { run, view, bot } = rig(version, 4);
      bot.entity.position.set(0.8762083584, 3.73802231455, 0.5);
      bot.entity.onGround = false;
      const fact = () => ({ ...fluidState(view, bot.entity.position), onGround: bot.entity.onGround, source: 'local_estimate' as const });
      assert.equal(fact().feetIn, 'none');
      assert.deepEqual(fluidHazards(self({ fluid: fact() }), config()).map((h) => h.kind), ['deep_water']);
      for (let t = 0; t < 160; t += 1) {
        run(1, { jump: true });
        assert.equal(hasSafeFluidSupport(fact()), false, `a bob is not a grounded exit at tick ${t}`);
        assert.ok(fluidHazards(self({ fluid: fact() }), config()).length > 0, 'no hazard-free surface frame');
      }
      run(160, {});
      assert.equal(fact().eyeIn, 'water', 'release inside the pool re-submerges');
    });

    it('released controls settle on dry land or genuine one-block wading', () => {
      for (const dry of [true, false]) {
        const { run, view, bot } = rig(version, 1);
        bot.entity.position.set(dry ? 8.5 : 0.5, 0, 0.5);
        run(40, {});
        const f = { ...fluidState(view, bot.entity.position), onGround: bot.entity.onGround };
        assert.equal(hasSafeFluidSupport(f), true);
        assert.equal(f.columnFluid, dry ? 'none' : 'water');
        assert.equal(fluidHazards(self({ fluid: { ...f, source: 'local_estimate' } }), config()).length, 0);
      }
    });
    it('held jump surfaces from the floor of 5-deep water within 60 ticks (3 s)', () => {
      const { run, view, bot } = rig(version, 5);
      assert.equal(fluidState(view, bot.entity.position).eyeIn, 'water', 'starts submerged');
      let surfacedAt: number | undefined;
      for (let t = 1; t <= 120; t += 1) {
        const p = run(1, { jump: true });
        if (surfacedAt === undefined && fluidState(view, p).eyeIn === 'none') surfacedAt = t;
      }
      assert.ok(surfacedAt !== undefined && surfacedAt <= 60, `surfaced at tick ${surfacedAt}`);
      // Holding jump keeps the eyes at/above the surface (bobbing), never sinking back to the floor.
      const samples: boolean[] = [];
      for (let t = 0; t < 40; t += 1) samples.push(fluidState(view, run(1, { jump: true })).eyeIn === 'none');
      assert.ok(samples.filter(Boolean).length >= 20, `eyes out in ${samples.filter(Boolean).length}/40 ticks while holding jump`);
    });

    it('released controls sink a surfaced body: eyes under water again (the reported failure mode)', () => {
      const { run, view } = rig(version, 5);
      run(120, { jump: true });
      let p = run(1, {});
      let submergedAt: number | undefined;
      for (let t = 1; t <= 200 && submergedAt === undefined; t += 1) {
        p = run(1, {});
        if (fluidState(view, p).eyeIn === 'water') submergedAt = t;
      }
      assert.ok(submergedAt !== undefined, 'eyes go under water without jump');
      run(400, {});
      assert.ok(fluidState(view, run(1, {})).eyeIn === 'water', 'stays submerged with no controller');
    });

    it('under a solid ceiling held jump cannot surface (why a blind jump is refused)', () => {
      const { run, view } = rig(version, 5, 4);
      run(200, { jump: true });
      const f = fluidState(view, run(1, { jump: true }));
      assert.equal(f.eyeIn, 'water');
      assert.equal(f.headroom, 'ceiling');
    });
  });
}
