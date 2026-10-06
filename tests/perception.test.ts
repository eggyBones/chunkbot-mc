import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findFrontiers } from '../src/perception/frontiers.ts';
import { discoverVisible, isBlockVisible, isEntityVisible, lineOfSight, sphereDirections } from '../src/perception/visibility.ts';
import { FakeWorld, flatWorld } from './skill-fakes.ts';

const EYE = { x: 0.5, y: 1.62, z: 0.5 }; // standing on the floor at y=0
const BOTTOM_SLAB = [[0, 0, 0, 1, 0.5, 1]];

function scene(): FakeWorld {
  const w = flatWorld(40);
  w.fill(-3, 0, 6, 3, 3, 6, 'stone_bricks'); // wall at z=6
  w.set(1, 1, 6, 'glass'); // window
  w.set(0, 0, 8, 'diamond_ore'); // behind the wall
  w.set(1, 1, 8, 'emerald_block'); // behind the window
  w.fill(-1, -3, -1, 1, -2, 1, 'stone');
  w.set(0, -3, 0, 'iron_ore'); // buried under the floor
  return w;
}

describe('line-of-sight perception policy', () => {
  it('walls occlude blocks; glass windows do not; buried blocks are never discovered', () => {
    const w = scene();
    assert.equal(isBlockVisible(w, EYE, 0, 0, 8), false, 'ore behind the wall');
    assert.equal(isBlockVisible(w, EYE, 1, 1, 8), true, 'block behind glass');
    assert.equal(isBlockVisible(w, EYE, 0, 0, 6), true, 'the wall itself');
    const seen = discoverVisible(w, EYE, 24, sphereDirections(2400));
    const names = new Set([...seen.values()].map((h) => h.block.name));
    assert.ok(names.has('stone_bricks') && names.has('glass') && names.has('emerald_block'));
    assert.ok(!names.has('diamond_ore'), 'hidden ore not discovered');
    assert.ok(!names.has('iron_ore') && !names.has('stone'), 'buried blocks not discovered');
  });

  it('partial shapes block only where they are; unloaded terrain counts as not visible', () => {
    const w = flatWorld(10);
    w.set(0, 0, 3, 'stone_slab', BOTTOM_SLAB);
    // A ray at eye height passes over a bottom slab, a ray near the ground does not.
    assert.equal(lineOfSight(w, EYE, { x: 0.5, y: 1.62, z: 6.5 }), true);
    assert.equal(lineOfSight(w, EYE, { x: 0.5, y: 0.1, z: 4.5 }), false);
    assert.equal(lineOfSight(w, EYE, { x: 0.5, y: 1.62, z: 20.5 }), false, 'beyond the loaded bounds');
  });

  it('entities and drops follow the same occlusion rule (sampled box points)', () => {
    const w = scene();
    assert.equal(isEntityVisible(w, EYE, { x: 0.5, y: 0, z: 9.5 }, 1.4), false, 'cow behind the wall');
    assert.equal(isEntityVisible(w, EYE, { x: -5.5, y: 0, z: 9.5 }, 1.4), true, 'cow beside the wall');
    assert.equal(isEntityVisible(w, EYE, { x: 0.5, y: 0, z: 3.5 }, 0.25), true, 'drop in front');
  });

  it('frontiers are reachable, seen, inside travel bounds, and never pass through walls', () => {
    const w = scene();
    const seen = discoverVisible(w, EYE, 24, sphereDirections(2400));
    const visited: Array<{ x: number; y: number; z: number }> = [];
    const { frontiers } = findFrontiers(w, { x: 0.5, y: 0, z: 0.5 }, {
      radius: 20,
      travelAnchor: { x: 0.5, y: 0, z: 0.5 },
      travelRadius: 14,
      floorSeen: (x, y, z) => seen.has(`${x},${y},${z}`),
      visited,
    });
    assert.ok(frontiers.length >= 3, `found ${frontiers.length}`);
    for (const f of frontiers) {
      assert.ok(Math.hypot(f.at.x - 0.5, f.at.z - 0.5) <= 14, 'inside travel radius');
      assert.ok(!(f.at.x > -4 && f.at.x < 4 && f.at.z > 6 && f.at.z < 9), 'not in the walled-off pocket via the wall');
    }
    assert.equal(new Set(frontiers.map((f) => f.direction)).size, frontiers.length, 'one per compass sector');
  });
});
