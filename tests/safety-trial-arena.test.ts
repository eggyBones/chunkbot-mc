import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arenaChecks, arenaShellPlan, insideMutationBox, insideTrialBox, mobArenaPlan, mobStageRefusals, MOB_TRIAL_ORIGIN, parseTrialUuid, refuseForeignOccupants, SAFETY_MUTATION_BOX, SAFETY_TRIAL_BOX, serverUnprovokedWolf, verifyArena, waterArenaPlan, type ArenaCheck, type TrialBox, type TrialSummon } from '../src/safety/trial-arena.ts';
import { findFluidExits, findRetreatTargets, fluidState } from '../src/safety/geometry.ts';
import { isBlockVisible, isEntityVisible, type WorldView } from '../src/perception/visibility.ts';
import { planSafety } from '../src/safety/policy.ts';
import { mob, policyCtx, self } from './safety-helpers.ts';

const fills = mobArenaPlan();
const within = (b: TrialBox, x: number, y: number, z: number) => x >= b[0] && y >= b[1] && z >= b[2] && x <= b[3] && y <= b[4] && z <= b[5];
const at = (x: number, y: number, z: number) => fills.find((f) => within(f.box, x, y, z))?.block ?? 'air';
const cells = (b: TrialBox, fn: (x: number, y: number, z: number) => boolean) => {
  for (let x = b[0]; x <= b[3]; x += 1) for (let y = b[1]; y <= b[4]; y += 1) for (let z = b[2]; z <= b[5]; z += 1) if (!fn(x, y, z)) return false;
  return true;
};
const verify = (c: ArenaCheck, read = at) => c.block ? read(...c.target) === c.block : cells(c.source, (x, y, z) => read(x, y, z) === read(x + c.target[0] - c.source[0], y + c.target[1] - c.source[1], z + c.target[2] - c.source[2]));

describe('W-H4/H5 sealed staging within the original clone', () => {
  it('has no overlapping regions, no expanded blocks, a luminous floor and a sealed eight-high interior', () => {
    const seen = new Set<string>();
    for (const f of fills) {
      assert.ok(insideTrialBox(f.box));
      cells(f.box, (x, y, z) => {
        const key = `${x},${y},${z}`;
        assert.ok(!seen.has(key), `overlap ${key}`); seen.add(key); return true;
      });
    }
    assert.equal(seen.size, 29 * 25 * 14);
    assert.deepEqual(SAFETY_MUTATION_BOX, [240, -61, 196, 268, -48, 220]);
    assert.deepEqual(SAFETY_TRIAL_BOX, [240, -61, 190, 270, -48, 220]);
    assert.ok(cells([241, -57, 197, 267, -57, 219], (x, y, z) => at(x, y, z) === 'sea_lantern'));
    assert.ok(cells([241, -56, 197, 267, -49, 219], (x, y, z) => at(x, y, z) === 'air'));
    assert.ok(cells([240, -48, 196, 268, -48, 220], (x, y, z) => at(x, y, z) === 'sea_lantern'));
    assert.equal(insideTrialBox([239, -60, 190, 270, -48, 220]), false);
    assert.throws(() => arenaChecks({ box: [240, -61, 190, 271, -48, 220], block: 'air' }), /outside/);
  });

  it('whole-volume server comparisons detect isolated blast damage, missing roof/floor and interior obstructions', () => {
    const checks = fills.flatMap(arenaChecks);
    assert.ok(checks.every((c) => verify(c)));
    for (const p of [[240, -55, 205], [268, -52, 201], [255, -54, 196], [249, -50, 220], [251, -48, 208], [258, -57, 206], [255, -60, 205], [249, -55, 208]] as const) {
      const corrupt = (x: number, y: number, z: number) => x === p[0] && y === p[1] && z === p[2] ? at(x, y, z) === 'air' ? 'stone' : 'air' : at(x, y, z);
      assert.ok(checks.some((c) => !verify(c, corrupt)), `single corrupt voxel ${p}`);
    }
    for (const c of checks) {
      assert.ok(insideMutationBox(c.source));
      if (!c.block) {
        const end: TrialBox = [...c.target, c.target[0] + c.source[3] - c.source[0], c.target[1] + c.source[4] - c.source[1], c.target[2] + c.source[5] - c.source[2]];
        assert.ok(insideMutationBox(end), 'comparison never reads backup/outside scene');
      }
    }
  });

  it('the real harness verifier issues only bounded server reads and refuses damaged staging, foreign occupants and unknown replies', async () => {
    const commands: string[] = [];
    const server = (read: typeof at) => async (command: string) => {
      commands.push(command);
      const m = /^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/.exec(command);
      const box = /^execute if blocks ((?:-?\d+ ){8}-?\d+) all$/.exec(command);
      assert.ok(m || box, `unexpected/mutating command ${command}`);
      if (m) return read(Number(m[1]), Number(m[2]), Number(m[3])) === m[4] ? 'Test passed' : 'Test failed';
      const ns = box![1]!.split(' ').map(Number);
      const source = ns.slice(0, 6) as TrialBox; const target = ns.slice(6) as [number, number, number];
      assert.ok(insideTrialBox(source));
      return verify({ source, target }, read) ? 'Test passed. Count: 1' : 'Test failed';
    };
    assert.equal(await verifyArena(server(at)), 26);
    assert.equal(commands.length, 26);
    assert.equal(await verifyArena(server(at), arenaShellPlan()), 15, 'water uses the SAME sealed/lighted shell; no mob staging assumptions or pool writes');
    await assert.rejects(verifyArena(server((x, y, z) => x === 240 && y === -55 && z === 205 ? 'air' : at(x, y, z))), /staging_unready/);
    for (const unknown of ['Command failed', 'No entity was found', '', 'Test passed. Count: 0']) await assert.rejects(verifyArena(async () => unknown), /staging_unready/);
    assert.doesNotThrow(() => refuseForeignOccupants('Test failed'));
    for (const occupied of ['Test passed. Count: 1', 'Test passed', 'Command failed', '']) assert.throws(() => refuseForeignOccupants(occupied), /foreign arena occupants/);
  });

  it('opaque walls hide exterior entities while preserving visible threats and real retreat geometry in every bearing', () => {
    const world: WorldView = { blockAt: (x, y, z) => {
      const name = at(x, y, z);
      return { name, stateId: name === 'air' ? 0 : 1, shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    } };
    const p = MOB_TRIAL_ORIGIN;
    const eye = { ...p, y: p.y + 1.62 };
    assert.equal(isEntityVisible(world, eye, { ...p, x: 271 }, 1.95), false);
    assert.equal(isEntityVisible(world, eye, { ...p, z: 189.5 }, 1.95), false);
    assert.equal(isEntityVisible(world, eye, { ...p, y: -47 }, 1.95), false, 'opaque luminous ceiling also excludes exterior threats above');
    assert.equal(isEntityVisible(world, eye, { ...p, x: p.x + 2.5 }, 1.95), true);
    for (let i = 0; i < 32; i += 1) {
      const theta = i * Math.PI / 16;
      const threat = { x: p.x + 3 * Math.cos(theta), y: p.y, z: p.z + 3 * Math.sin(theta) };
      const legs = findRetreatTargets(world, p, { threats: [threat], separation: 8, legMax: 6, allowed: (x, _y, z) => Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) <= 12, visible: (x, y, z) => isBlockVisible(world, eye, x, y, z) });
      assert.ok(legs.length > 0, `retreat bearing ${i}`);
      assert.ok(legs.some((t) => t.clearance >= 8), 'existing separation is attainable in every bearing');
      assert.ok(legs.every((t) => at(t.x, t.y - 1, t.z) === 'sea_lantern'));
      for (const t of legs) for (let step = 0; step <= 20; step += 1) {
        const x = Math.floor(p.x + (t.x + 0.5 - p.x) * step / 20);
        const z = Math.floor(p.z + (t.z + 0.5 - p.z) * step / 20);
        assert.equal(at(x, -57, z), 'sea_lantern', 'entire straight retreat corridor has dry solid support');
        assert.equal(at(x, -56, z), 'air'); assert.equal(at(x, -55, z), 'air');
      }
    }
  });

  it('the shared water shell preserves the four-deep pool, observed bobs, east bank and ceiling blocker', () => {
    const waterWorld = (lid = false): WorldView => ({ blockAt: (x, y, z) => {
      const name = waterArenaPlan(lid).find((f) => within(f.box, x, y, z))?.block ?? 'air';
      return { name, stateId: name === 'air' ? 0 : 1, shapes: name === 'air' || name === 'water' ? [] : [[0, 0, 0, 1, 1, 1]], ...(name === 'water' ? { level: 0 } : {}) };
    } });
    const world = waterWorld();
    for (const y of [-56.26197768545145, -56.1606]) {
      const p = { x: 255.5, y, z: 205.5 };
      const f = fluidState(world, p, 1.62);
      assert.equal(f.feetIn, 'none'); assert.equal(f.eyeIn, 'none');
      assert.equal(f.columnFluid, 'water'); assert.equal(f.depth, 4);
      const eye = { ...p, y: p.y + 1.62 };
      const exits = findFluidExits(world, p, 'water', { radius: 8, max: 32, visible: (x, y, z) => isBlockVisible(world, eye, x, y, z), allowed: () => true });
      assert.ok(exits.some((e) => e.x === 259 && e.y === -56 && e.z === 205), 'the observed dry east bank remains a valid reachable target');
    }
    assert.equal(fluidState(waterWorld(true), { x: 255.5, y: -60, z: 205.5 }, 1.62).headroom, 'ceiling');
  });

  it('only exact server UUID IntArrays and proven current wolf anger/target evidence establish identity/control', () => {
    for (const suffix of ['[I; 0, 1, -1, -2147483648]', '[I;0,1,-1,-2147483648]']) assert.equal(parseTrialUuid(`Zombie has the following entity data: ${suffix}`), '00000000-0000-0001-ffff-ffff80000000');
    for (const s of ['', 'Command failed', 'x: [I; 0, 1, 2, 3]', 'Zombie has the following entity data: [I; 0, 1, 2, 2147483648]', 'Zombie has the following entity data: [I; 0, 1, 2]', 'Zombie has the following entity data: [I; 0, 1, 2, 3]\nCommand failed']) assert.equal(parseTrialUuid(s), undefined, s);
    const anger = 'Wolf has the following entity data: -1L';
    assert.equal(serverUnprovokedWolf(anger, 'Test failed'), true);
    for (const s of ['Wolf has the following entity data: 0L', 'Wolf has the following entity data: 100L', 'Wolf has the following entity data: -1', 'No elements matching anger_end_time', 'Command failed']) assert.equal(serverUnprovokedWolf(s, 'Test failed'), false);
    for (const s of ['Test passed', 'Test passed. Count: 1', 'No elements matching', 'Command failed']) assert.equal(serverUnprovokedWolf(anger, s), false);
  });
});

const summon = (entityId: number, key: string, extra: Partial<TrialSummon> = {}): TrialSummon => ({ tag: 'cbsafe_test_target', uuid: `uuid-${entityId}`, entityId, key: `minecraft:${key}`, visible: true, ...extra });

describe('W-H4 exact visible scenario prerequisites', () => {
  it('admits distinct unarmed retreat, equipped engaging defense, creeper avoidance and fresh neutral controls', () => {
    const z = mob('zombie', 2.5, { entityId: 50, aggressive: true });
    const armed = self(); const unarmed = self({ equipment: { ...armed.equipment, mainHand: null, armor: [], hotbar: [] } });
    for (const gate of ['M1', 'M4'] as const) assert.deepEqual(mobStageRefusals(gate, [summon(50, 'zombie')], [z], planSafety(unarmed, [z], policyCtx()), 1000), []);
    for (const gate of ['M2', 'M2b'] as const) assert.deepEqual(mobStageRefusals(gate, [summon(50, 'zombie')], [z], planSafety(armed, [z], policyCtx()), 1000), []);
    const c = mob('creeper', 5, { entityId: 60 });
    assert.deepEqual(mobStageRefusals('M3', [summon(60, 'creeper', { effectFree: true })], [c], planSafety(armed, [c], policyCtx()), 1000), []);
    const w = mob('wolf', 2, { entityId: 70, aggressive: false });
    assert.deepEqual(mobStageRefusals('M3b', [summon(71, 'cow'), summon(70, 'wolf', { unprovoked: true })], [w], planSafety(armed, [w], policyCtx()), 1000), []);
  });

  it('refuses the actual extra-melee/group contamination, natural spider/cloud, wrong tag identity and non-engaging gear', () => {
    const z = mob('zombie', 2.5, { entityId: 50, aggressive: true });
    const target = summon(50, 'zombie');
    const check = (visible: typeof z[], targets = [target]) => mobStageRefusals('M2b', targets, visible, planSafety(self(), visible, policyCtx()), 1000);
    for (const extra of [mob('zombie', 3, { aggressive: true }), mob('spider', 2, { aggressive: true }), mob('area_effect_cloud', 4)]) assert.ok(check([z, extra]).includes('unexpected_visible_entity'));
    assert.ok(check([{ ...z, aggressive: false }]).includes('policy_prerequisite_defend'));
    assert.ok(check([z], [{ ...target, entityId: 51 }]).includes('target_not_currently_visible'));
    assert.ok(check([z], [{ ...target, visible: false }]).includes('summon_identity_or_visibility'));
    assert.ok(check([{ ...z, observedAtMs: 499 }]).includes('stale_visible_evidence'));
    assert.ok(check([{ ...z, observedAtMs: 1001 }]).includes('stale_visible_evidence'));
    const worn = self({ health: 9 });
    assert.ok(mobStageRefusals('M2', [target], [z], planSafety(worn, [z], policyCtx()), 1000).includes('policy_prerequisite_defend'));
  });

  it('neutral control fails real damage/aggression, absent server anger evidence and unexpected hostiles', () => {
    const w = mob('wolf', 2, { entityId: 70, aggressive: false });
    const targets = [summon(71, 'cow'), summon(70, 'wolf', { unprovoked: true })];
    for (const change of [{ damagedSelfAtMs: 900 }, { aggressive: true }]) {
      const visible = [{ ...w, ...change }];
      assert.ok(mobStageRefusals('M3b', targets, visible, planSafety(self(), visible, policyCtx()), 1000).includes('neutral_control_has_hazard'));
    }
    assert.ok(mobStageRefusals('M3b', targets.map(({ unprovoked: _unused, ...t }) => t), [w], planSafety(self(), [w], policyCtx()), 1000).includes('server_neutral_anger_unverified'));
    const contaminated = [w, mob('zombie', 2)];
    assert.ok(mobStageRefusals('M3b', targets, contaminated, planSafety(self(), contaminated, policyCtx()), 1000).includes('unexpected_visible_entity'));
  });
});
