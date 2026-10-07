// MB-FLOW-001 A3/A6 construction logic (pure): small_shelter_v1 blueprint,
// code-verified shelter criteria and observed vacant site selection.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENTRANCE_ACCEPT, PHASES, checkSite, entranceInterior, entranceOutside, findSites, judgeCells, smallShelterCells, verifyShelter, type Facing, type SiteProbe, type V3, type VoxelTruth } from '../src/autonomy/blueprint.ts';

const PLANKS = /_planks$/;
const inTag = (tag: string, key: string) => (tag === '#minecraft:planks' ? PLANKS.test(key) : tag === '#minecraft:logs' ? /_log$/.test(key) : tag === '#minecraft:wooden_doors' ? /_door$/.test(key) : false);
const k = (p: V3) => `${p.x},${p.y},${p.z}`;
const ORIGIN = { x: 10, y: 64, z: 20 };

/** World map for verification: key -> block; missing entries are unknown. */
function truthFrom(map: Map<string, string>): (p: V3) => VoxelTruth {
  return (p) => {
    const v = map.get(k(p));
    return v ? { key: v, evidence: 'visible' } : { evidence: 'unknown' };
  };
}

/** A fully built shelter map for a facing. */
function builtMap(cells: ReturnType<typeof smallShelterCells>): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of cells) {
    if (c.role === 'wall' || c.role === 'roof') m.set(k(c.at), 'minecraft:oak_planks');
    else if (c.role === 'entrance') m.set(k(c.at), 'minecraft:air');
    else if (c.role === 'aid') m.set(k(c.at), 'minecraft:air');
  }
  for (const c of cells) if (c.role === 'workstation' || c.role === 'storage') m.set(k(c.at), c.accept[0]!);
  return m;
}

describe('small_shelter_v1 blueprint', () => {
  for (const facing of ['north', 'south', 'east', 'west'] as Facing[]) {
    it(`3x3 interior facing ${facing}: walls 2 high, a 1x2 entrance, full roof, one aid and three furnishings inside the footprint`, () => {
      const cells = smallShelterCells(ORIGIN, 3, facing);
      const by = (role: string) => cells.filter((c) => c.role === role);
      assert.equal(by('wall').length, 16 * 2 - 2);
      assert.equal(by('entrance').length, 2);
      assert.equal(by('roof').length, 25);
      assert.equal(by('aid').length, 1);
      assert.equal(by('workstation').length + by('storage').length, 3);
      assert.equal(by('roof').filter((c) => c.phase === PHASES.roofHole).length, 1, 'exactly one roof cell waits for the aid removal');
      const aid = by('aid')[0]!;
      const hole = by('roof').find((c) => c.phase === PHASES.roofHole)!;
      assert.deepEqual({ x: hole.at.x, z: hole.at.z }, { x: aid.at.x, z: aid.at.z }, 'the roof hole is above the aid column');
      for (const c of cells) {
        assert.ok(c.at.x >= ORIGIN.x && c.at.x < ORIGIN.x + 5 && c.at.z >= ORIGIN.z && c.at.z < ORIGIN.z + 5, 'inside the approved footprint');
        assert.ok(c.at.y >= ORIGIN.y && c.at.y <= ORIGIN.y + 2);
      }
      const entrance = by('entrance');
      assert.deepEqual(entrance.map((c) => c.accept), [[...ENTRANCE_ACCEPT], [...ENTRANCE_ACCEPT]]);
      const inner = entranceInterior({ origin: ORIGIN, size: { outerX: 5, outerZ: 5, wallHeight: 2 }, entranceFacing: facing });
      assert.ok(!cells.some((c) => (c.role === 'workstation' || c.role === 'storage' || c.role === 'aid') && k(c.at) === k(inner)), 'the cell behind the entrance stays free');
      const outside = entranceOutside({ origin: ORIGIN, size: { outerX: 5, outerZ: 5, wallHeight: 2 }, entranceFacing: facing });
      const e0 = entrance.find((c) => c.at.y === ORIGIN.y)!;
      assert.equal(Math.abs(outside.x - e0.at.x) + Math.abs(outside.z - e0.at.z), 1, 'the approach is adjacent to the entrance');
    });
  }

  it('2x2 interior re-uses the aid position for a furnishing (removed before furnishing)', () => {
    const cells = smallShelterCells(ORIGIN, 2, 'north');
    const aid = cells.find((c) => c.role === 'aid')!;
    assert.ok(cells.some((c) => c.role === 'workstation' && k(c.at) === k(aid.at)));
  });
});

describe('code-verified shelter criteria', () => {
  const cells = smallShelterCells(ORIGIN, 3, 'north');

  it('a complete shelter verifies complete and enclosed', () => {
    const v = verifyShelter(cells, judgeCells(cells, truthFrom(builtMap(cells)), inTag));
    assert.equal(v.status, 'complete');
    assert.equal(v.enclosed, 'satisfied');
    assert.equal(v.nextPhase, null);
  });

  it('a remaining construction aid keeps it incomplete (phase: remove aid); a missing roof cell is missing', () => {
    const m = builtMap(cells);
    const aid = cells.find((c) => c.role === 'aid')!;
    m.set(k(aid.at), 'minecraft:oak_planks');
    let v = verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag));
    assert.equal(v.status, 'incomplete');
    assert.equal(v.nextPhase, PHASES.aid);
    const roof = cells.find((c) => c.role === 'roof' && c.phase === PHASES.roof)!;
    m.set(k(aid.at), 'minecraft:air');
    m.set(k(roof.at), 'minecraft:air');
    v = verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag));
    assert.equal(v.enclosed, 'unsatisfied');
    assert.equal(v.missing, 1);
  });

  it('a foreign block at a blueprint position is reported, never accepted (no demolition)', () => {
    const m = builtMap(cells);
    const wall = cells.find((c) => c.role === 'wall')!;
    m.set(k(wall.at), 'minecraft:glass');
    const v = verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag));
    assert.equal(v.status, 'incomplete');
    assert.equal(v.foreign.length, 1);
    assert.equal(v.foreign[0]!.key, 'minecraft:glass');
  });

  it('an unobservable cell makes the verdict unknown — never satisfied', () => {
    const m = builtMap(cells);
    m.delete(k(cells[0]!.at));
    const v = verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag));
    assert.equal(v.status, 'unknown');
    assert.equal(v.unknown, 1);
  });

  it('a blocked entrance is foreign; vegetation in the entrance is passable', () => {
    const m = builtMap(cells);
    const e = cells.find((c) => c.role === 'entrance')!;
    m.set(k(e.at), 'minecraft:short_grass');
    assert.equal(verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag)).status, 'complete');
    m.set(k(e.at), 'minecraft:cobblestone');
    assert.equal(verifyShelter(cells, judgeCells(cells, truthFrom(m), inTag)).foreign.length, 1);
  });
});

describe('observed vacant site selection', () => {
  /** Flat grass at y=63 with air above; `blocks` overrides; `hidden` voxels are not visible. */
  function probe(blocks: Map<string, string> = new Map(), hidden: Set<string> = new Set()): SiteProbe {
    return {
      blockAt: (p) => blocks.get(k(p)) ?? (p.y === 63 ? 'minecraft:grass_block' : p.y > 63 ? 'minecraft:air' : 'minecraft:dirt'),
      visible: (p) => !hidden.has(k(p)),
      naturalGround: (key) => /^minecraft:(grass_block|dirt|stone)$/.test(key),
    };
  }

  it('flat visible natural ground with an empty volume is approved with recorded checks', () => {
    const r = checkSite(probe(), ORIGIN, 3, 'north');
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.checks.some((c) => /25\/25 ground blocks visible/.test(c)));
  });

  it('anything in the volume (no demolition), uneven or non-natural ground, hidden ground, or a nearby structure refuses the site', () => {
    const volume = new Map([[k({ x: 12, y: 65, z: 22 }), 'minecraft:oak_log']]);
    assert.match(String((checkSite(probe(volume), ORIGIN, 3, 'north') as { reason: string }).reason), /no demolition/);
    const planksFloor = new Map([[k({ x: 11, y: 63, z: 21 }), 'minecraft:oak_planks']]);
    assert.equal(checkSite(probe(planksFloor), ORIGIN, 3, 'north').ok, false);
    const hidden = new Set([k({ x: 14, y: 63, z: 24 })]);
    assert.match(String((checkSite(probe(new Map(), hidden), ORIGIN, 3, 'north') as { reason: string }).reason), /line of sight/);
    const chest = new Map([[k({ x: 8, y: 64, z: 20 }), 'minecraft:chest']]);
    assert.match(String((checkSite(probe(chest), ORIGIN, 3, 'north') as { reason: string }).reason), /structure block/);
  });

  it('findSites never proposes a footprint the bot stands in or outside the travel bounds', () => {
    const standing = { x: 0.5, y: 64, z: 0.5 };
    const sites = findSites(probe(), standing, 3, 8, (p) => Math.hypot(p.x - standing.x, p.z - standing.z) <= 6, 4);
    assert.ok(sites.length > 0);
    for (const s of sites) {
      assert.ok(!(standing.x >= s.origin.x && standing.x < s.origin.x + 5 && standing.z >= s.origin.z && standing.z < s.origin.z + 5));
      assert.ok(Math.hypot(s.origin.x + 2.5 - standing.x, s.origin.z + 2.5 - standing.z) <= 6);
    }
    assert.equal(findSites(probe(), standing, 3, 8, () => false, 4).length, 0);
  });
});
