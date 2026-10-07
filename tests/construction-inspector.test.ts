// MB-FLOW-001-C3/C4 construction source corrections, on a fake voxel world and
// fake session (no Minecraft connection, no inference).
//
// C3: pending client predictions and unloaded chunks are UNKNOWN before any
//     server fact or cached observation; a cached observation needs the same
//     connection/generation/dimension, a loaded chunk and unchanged data.
// C4: a far missing wall yields a move to a safe observed stand point within
//     reach of THAT cell (never an already-arrived no-op); an admitted material
//     is binding and carried in the draft parameters.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HomeProject, TaskSpec } from '../src/contracts/index.ts';
import { smallShelterCells } from '../src/autonomy/blueprint.ts';
import { ShelterInspector, constructionSkills, evaluateStructure } from '../src/skills/construction.ts';
import { isBlockVisible } from '../src/perception/visibility.ts';
import { FakeWorld, REGISTRY_26_1_2 } from './skill-fakes.ts';

const blocksByStateId: Record<number, { name: string }> = {};
for (const [name, b] of Object.entries(REGISTRY_26_1_2.blocksByName)) if (b) blocksByStateId[b.defaultState] = { name };
const stateOf = (name: string) => REGISTRY_26_1_2.blocksByName[name]!.defaultState;

interface Env {
  world: FakeWorld;
  visible: Set<string> | 'los';
  facts: Map<string, { stateId: number; seq: number; atMs: number }>;
  pending: Set<string>;
  own: Set<string>;
  invalidations: unknown[];
  position: { x: number; y: number; z: number };
  inventory: Array<{ name: string; count: number }>;
  seq: number;
  dimension: string;
  loaded: boolean;
}

function env(over: Partial<Env> = {}): Env {
  const world = new FakeWorld({ min: -40, max: 40 });
  world.fill(-40, -1, -40, 40, -1, 40, 'grass_block');
  return { world, visible: 'los', facts: new Map(), pending: new Set(), own: new Set(), invalidations: [], position: { x: 0.5, y: 0, z: 0.5 }, inventory: [{ name: 'oak_planks', count: 64 }], seq: 1, dimension: 'overworld', loaded: true, ...over };
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

function wire(e: Env) {
  const bot = {
    entity: { position: e.position },
    entities: {},
    game: { get dimension() { return e.dimension; } },
    registry: { blocksByStateId },
    inventory: { items: () => e.inventory },
  };
  const session = { bot, connectionEpoch: 1, evidence: { get seq() { return e.seq; }, serverBlock: (x: number, y: number, z: number) => e.facts.get(key(x, y, z)), predictionPending: (x: number, y: number, z: number) => e.pending.has(key(x, y, z)) } } as never;
  const worldView = { blockAt: (x: number, y: number, z: number) => (e.loaded ? e.world.blockAt(x, y, z) : null) };
  const eye = () => ({ x: e.position.x, y: e.position.y + 1.62, z: e.position.z });
  const services = {
    perception: {
      world: () => worldView,
      blockVisibleNow: (x: number, y: number, z: number) => (e.visible === 'los' ? e.loaded && isBlockVisible(worldView, eye(), x, y, z) : e.visible.has(key(x, y, z))),
      withinTravel: () => true,
      travelBounds: () => ({ anchor: { x: 0, y: 0, z: 0 }, radius: 128 }),
    },
    ledger: { ownBlockChange: (x: number, y: number, z: number) => e.own.has(key(x, y, z)), invalidations: e.invalidations, latestOwnChange: () => undefined },
    knowledge: { recipes: { matches: (tag: string, k: string) => (tag === '#minecraft:planks' ? /_planks$/.test(k) : tag === '#minecraft:logs' ? /_log$/.test(k) : false) } },
    clock: { now: () => 0 },
    limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 },
  } as never;
  return { session, services };
}

describe('MB-FLOW-001-C3 ShelterInspector opacity and freshness', () => {
  it('(1) an own ledger change + server fact + PENDING prediction is unknown (prediction is opaque first)', () => {
    const e = env();
    e.world.set(5, 0, 5, 'oak_planks');
    e.own.add(key(5, 0, 5));
    e.facts.set(key(5, 0, 5), { stateId: stateOf('oak_planks'), seq: 1, atMs: 0 });
    e.pending.add(key(5, 0, 5));
    const { session, services } = wire(e);
    const insp = new ShelterInspector(() => session, services);
    assert.equal(insp.truth({ x: 5, y: 0, z: 5 }).evidence, 'unknown');
    e.pending.clear();
    assert.equal(insp.truth({ x: 5, y: 0, z: 5 }).key, 'minecraft:oak_planks', 'decided once the server stated it');
  });

  it('(2) a cached visible block becomes unknown when its chunk is unloaded, and stays unknown after a reload with different data', () => {
    const e = env({ visible: new Set([key(6, 0, 6)]) });
    e.world.set(6, 0, 6, 'oak_planks');
    const { session, services } = wire(e);
    const insp = new ShelterInspector(() => session, services);
    assert.equal(insp.truth({ x: 6, y: 0, z: 6 }).evidence, 'visible');
    e.visible = new Set();
    assert.equal(insp.truth({ x: 6, y: 0, z: 6 }).evidence, 'seen_this_connection', 'still loaded and unchanged: labeled as an earlier observation');
    e.loaded = false;
    assert.equal(insp.truth({ x: 6, y: 0, z: 6 }).evidence, 'unknown', 'unloaded chunk certifies nothing');
    e.loaded = true;
    e.world.set(6, 0, 6, 'stone');
    assert.equal(insp.truth({ x: 6, y: 0, z: 6 }).evidence, 'unknown', 'the cache was dropped; unseen changed data is never certified');
  });

  it('a lifecycle generation change, a dimension change or a newer server statement voids cached observations', () => {
    const e = env({ visible: new Set([key(7, 0, 7)]) });
    e.world.set(7, 0, 7, 'oak_planks');
    const { session, services } = wire(e);
    const insp = new ShelterInspector(() => session, services);
    insp.truth({ x: 7, y: 0, z: 7 });
    e.visible = new Set();
    e.invalidations.push({});
    assert.equal(insp.truth({ x: 7, y: 0, z: 7 }).evidence, 'unknown');
    e.visible = new Set([key(7, 0, 7)]);
    insp.truth({ x: 7, y: 0, z: 7 });
    e.visible = new Set();
    e.facts.set(key(7, 0, 7), { stateId: stateOf('oak_planks'), seq: 99, atMs: 0 });
    e.seq = 50;
    assert.equal(insp.truth({ x: 7, y: 0, z: 7 }).evidence, 'unknown', 'a later server statement supersedes the cached observation');
    e.facts.clear();
    e.visible = new Set([key(7, 0, 7)]);
    insp.truth({ x: 7, y: 0, z: 7 });
    e.visible = new Set();
    e.dimension = 'the_nether';
    assert.equal(insp.truth({ x: 7, y: 0, z: 7 }).evidence, 'unknown', 'another dimension never reuses the cache');
  });

  it('server-complete gate: a built shelter verifies complete only while every cell is decided; one pending voxel makes it unknown', () => {
    const e = env();
    const origin = { x: 10, y: 0, z: 10 };
    const cells = smallShelterCells(origin, 3, 'north');
    for (const c of cells) {
      if (c.role === 'wall' || c.role === 'roof') e.world.set(c.at.x, c.at.y, c.at.z, 'oak_planks');
      if (c.role === 'workstation' || c.role === 'storage') e.world.set(c.at.x, c.at.y, c.at.z, c.accept[0]!.replace('minecraft:', ''));
    }
    e.visible = new Set(cells.map((c) => key(c.at.x, c.at.y, c.at.z)));
    const project = { id: 'proj-test', origin, size: { outerX: 5, outerZ: 5, wallHeight: 2 }, entranceFacing: 'north', cells, dimension: 'overworld', checkpoints: [], state: 'building' } as unknown as HomeProject;
    const home = { project: () => project, writable: () => true, verified: async () => project } as never;
    const { session, services } = wire(e);
    const insp = new ShelterInspector(() => session, services);
    assert.equal(evaluateStructure(home, insp, () => session, 'complete').status, 'satisfied');
    const wall = cells.find((c) => c.role === 'wall')!;
    e.pending.add(key(wall.at.x, wall.at.y, wall.at.z));
    assert.equal(evaluateStructure(home, insp, () => session, 'complete').status, 'unknown', 'a pending prediction never certifies a completed house');
  });
});

describe('MB-FLOW-001-C4 build_home resolver: specific stand points and binding material', () => {
  const origin = { x: 12, y: 0, z: 12 };
  const project = () => ({ id: 'proj-test', origin, size: { outerX: 5, outerZ: 5, wallHeight: 2 }, entranceFacing: 'north', cells: smallShelterCells(origin, 3, 'north'), dimension: 'overworld', checkpoints: [], state: 'approved' }) as unknown as HomeProject;
  const spec: TaskSpec = { objective: 'build the home', decisionInstruction: 'build', allowedCapabilities: ['build_home'], targetSelectors: [], parameters: {}, completion: { predicate: 'structure_state', structure: 'home', expect: 'complete' } };

  function resolve(e: Env, parameters: Record<string, unknown> = {}) {
    const p = project();
    const home = { project: () => p, writable: () => true, verified: async () => p } as never;
    const { session, services } = wire(e);
    const insp = new ShelterInspector(() => session, services);
    const build = constructionSkills({ home, inspector: insp, interior: 3, maxSiteDistance: 16 }).find((s) => s.descriptor.id === 'build_home')!;
    return build.resolve({ task: { ...spec, parameters: parameters as TaskSpec['parameters'] }, hints: { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: parameters as never, memoryRefs: [] }, snapshot: { self: { at: e.position } } as never, session, services });
  }

  it('far missing walls: a move to an observed safe stand point within reach of a SPECIFIC missing cell (not the current block)', () => {
    const e = env({ position: { x: 0.5, y: 0, z: 0.5 } });
    const r = resolve(e);
    const moves = r.drafts.filter((d) => d.parameters['action'] === 'reposition');
    assert.ok(moves.length > 0, JSON.stringify(r.unavailable));
    const d = moves[0]!;
    assert.equal(d.parameters['to'], 'near_cell');
    const stand = d.parameters['stand'] as { x: number; y: number; z: number };
    const cell = project().cells[d.parameters['cell'] as number]!;
    assert.ok(Math.hypot(cell.at.x + 0.5 - (stand.x + 0.5), cell.at.y + 0.5 - (stand.y + 1.62), cell.at.z + 0.5 - (stand.z + 0.5)) <= 3.7, 'the stand point is within reach of that cell');
    assert.ok(!(stand.x === 0 && stand.z === 0), 'never the block the bot already stands on');
    assert.ok(!project().cells.some((c) => c.at.x === stand.x && c.at.y === stand.y && c.at.z === stand.z && c.role !== 'aid'), 'never a blueprint position');
    assert.equal(e.world.blockAt(stand.x, stand.y - 1, stand.z)?.name, 'grass_block', 'solid observed ground under the stand point (no towering)');
  });

  it('near a wall: placement drafts land exactly on blueprint cells', () => {
    const e = env({ position: { x: 14.5, y: 0, z: 10.5 } });
    const r = resolve(e);
    const places = r.drafts.filter((d) => d.parameters['action'] === 'place');
    assert.ok(places.length > 0, JSON.stringify(r.unavailable));
    for (const d of places) assert.equal(d.parameters['item'], 'minecraft:oak_planks');
  });

  it('an admitted material is binding: it is carried in every draft and never substituted', () => {
    const e = env({ position: { x: 14.5, y: 0, z: 10.5 }, inventory: [{ name: 'oak_planks', count: 64 }, { name: 'cobblestone', count: 64 }] });
    const withCobble = resolve(e, { material: 'minecraft:cobblestone' });
    assert.ok(withCobble.drafts.length > 0);
    for (const d of withCobble.drafts) assert.equal(d.parameters['material'], 'minecraft:cobblestone');
    for (const d of withCobble.drafts.filter((x) => x.parameters['action'] === 'place')) assert.equal(d.parameters['item'], 'minecraft:cobblestone');
    const e2 = env({ position: { x: 14.5, y: 0, z: 10.5 } });
    const missing = resolve(e2, { material: 'minecraft:cobblestone' });
    assert.equal(missing.drafts.length, 0, 'planks are not substituted for the requested cobblestone');
    assert.ok(missing.unavailable?.some((u) => u.reason === 'requested_material_missing'));
  });
});
