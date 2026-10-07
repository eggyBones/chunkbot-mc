// MB-LOC-001-C5: blocker labels come from OBSERVED geometry only. The world view
// is consulted solely for chunk loadedness; hidden (unseen) terrain is never
// named, and an observed wall/drop is named even if the world view disagrees.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BlockView, WorldView } from '../src/perception/visibility.ts';
import { classifyBlocker, type SeenVoxel } from '../src/locator/terrain.ts';

const FULL = [[0, 0, 0, 1, 1, 1]] as const;
const self = { x: 0.5, y: 64, z: 0.5 };
const EAST = 0;

/** Loaded everywhere; contents are deliberately misleading (a world of stone). */
const misleadingWorld: WorldView = { blockAt: () => ({ name: 'stone', stateId: 1, shapes: FULL }) as BlockView };

function seenFrom(entries: Array<[number, number, number, string]>): Map<string, SeenVoxel> {
  const m = new Map<string, SeenVoxel>();
  for (const [x, y, z, name] of entries) m.set(`${x},${y},${z}`, { block: { name, shapes: name === 'lava' || name === 'water' ? [] : [[0, 0, 0, 1, 1, 1]] } });
  return m;
}

function floor(x1: number, x2: number, y: number, z1 = -12, z2 = 12): Array<[number, number, number, string]> {
  const out: Array<[number, number, number, string]> = [];
  for (let x = x1; x <= x2; x += 1) for (let z = z1; z <= z2; z += 1) out.push([x, y, z, 'grass_block']);
  return out;
}

describe('MB-LOC-001-C5 observed-only blocker labels', () => {
  it('hidden terrain is never named: a world full of stone with an observed open floor is not a wall or drop', () => {
    const r = classifyBlocker(misleadingWorld, self, EAST, seenFrom(floor(-2, 20, 63)), { direction: 'east' });
    assert.notEqual(r.reason, 'wall');
    assert.notEqual(r.reason, 'cliff_drop');
    assert.equal(r.evidence.wallRays, 0);
  });

  it('an observed two-high wall face is a wall (from seen voxels, regardless of the world view)', () => {
    const wall: Array<[number, number, number, string]> = [];
    for (let z = -12; z <= 12; z += 1) for (let y = 64; y <= 66; y += 1) wall.push([4, y, z, 'stone']);
    const emptyWorld: WorldView = { blockAt: () => ({ name: 'air', stateId: 0, shapes: [] }) };
    const r = classifyBlocker(emptyWorld, self, EAST, seenFrom([...floor(-2, 3, 63), ...wall]), { direction: 'east' });
    assert.equal(r.reason, 'wall', r.detail);
    assert.equal(r.evidence.wallRays, 5);
    const above = classifyBlocker(emptyWorld, self, EAST, seenFrom([...floor(-2, 3, 63), ...wall]), { direction: 'east', elevation: 'above' });
    assert.equal(above.reason, 'vertical_separation');
  });

  it('an observed lower floor more than 3 below walk level, beyond the edge, is a cliff drop; within 3 it is walkable', () => {
    const deep = classifyBlocker(misleadingWorld, self, EAST, seenFrom([...floor(-2, 2, 63), ...floor(6, 20, 57)]), { direction: 'east' });
    assert.equal(deep.reason, 'cliff_drop', deep.detail);
    const shallow = classifyBlocker(misleadingWorld, self, EAST, seenFrom([...floor(-2, 2, 63), ...floor(3, 20, 61)]), { direction: 'east' });
    assert.notEqual(shallow.reason, 'cliff_drop');
  });

  it('columns with nothing observed are reported as unobserved, not as an invented wall or drop', () => {
    const r = classifyBlocker(misleadingWorld, self, EAST, seenFrom(floor(-2, 2, 63)), { direction: 'east' });
    assert.equal(r.reason, 'unobserved_terrain', r.detail);
  });

  it('observed lava wins; unloaded chunks are reported from loadedness only', () => {
    const lava = classifyBlocker(misleadingWorld, self, EAST, seenFrom([...floor(-2, 2, 63), ...floor(3, 8, 63).map(([x, y, z]) => [x, y, z, 'lava'] as [number, number, number, string])]), { direction: 'east' });
    assert.equal(lava.reason, 'hazard_lava');
    const unloaded: WorldView = { blockAt: (x) => (x >= 3 ? null : ({ name: 'air', stateId: 0, shapes: [] } as BlockView)) };
    assert.equal(classifyBlocker(unloaded, self, EAST, seenFrom(floor(-2, 2, 63))).reason, 'unloaded_terrain');
  });

  it('the world view is consulted only for loadedness (null vs non-null), never for block names', () => {
    const names: string[] = [];
    const spy: WorldView = {
      blockAt: () =>
        new Proxy({ name: 'stone', stateId: 1, shapes: FULL } as unknown as BlockView, {
          get(target, prop) {
            if (prop === 'name' || prop === 'shapes') names.push(String(prop));
            return (target as unknown as Record<string | symbol, unknown>)[prop];
          },
        }),
    };
    classifyBlocker(spy, self, EAST, seenFrom([...floor(-2, 2, 63), ...floor(6, 20, 57)]), { direction: 'east' });
    assert.deepEqual(names, [], 'no block content read from the world view');
  });
});
