// MB-LOC-002 F3/L5: legitimate detours around OBSERVED obstacles are allowed
// (even when they briefly increase the distance to the owner), but they are
// bounded and need eventual progress; without observed geometry the bot never
// wanders. Dry routes only: water is avoided by walking around it on land
// (crossing/deep water is the safety assignment's gate).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Vec } from '../src/perception/visibility.ts';
import { MAX_DETOUR_BLOCKS, MAX_DETOUR_STEPS, runRoute } from '../src/locator/route-runner.ts';
import { FULL, runWindows, sim, type ProcWorld } from './locator-sim.ts';

type Detour = { side: number; steps: number; blocks: number; obstacle: string; outcome: string };
const detoursOf = (evidence: unknown): Detour[] => ((evidence as { detours?: Detour[] }).detours ?? []);

/** A two-block-thick stone wall across x = 12..13 from z -zHalf..zHalf, with an optional gap (z1..z2). */
function wall(zHalf: number, gap?: [number, number]) {
  return (w: ProcWorld) =>
    w.features.push((x, y, z) => (x >= 12 && x <= 13 && Math.abs(z) <= zHalf && y >= 64 && y <= 70 && !(gap && z >= gap[0] && z <= gap[1]) ? { name: 'stone', stateId: 3, shapes: FULL } : undefined));
}

describe('MB-LOC-002 bounded detour around observed obstacles', () => {
  it('a wall much wider than the view (ends 60 blocks to either side): the bot detours along it (distance briefly grows), gets around and reaches the owner', async () => {
    // The owner is 40 blocks east, behind the wall and out of sight (beyond the 24-block simulated sight).
    const owner = { x: 40.5, y: 64, z: 0.5 };
    const s = sim({ ownerAt: owner, obstacles: wall(60) });
    const distances: number[] = [Math.hypot(owner.x - s.self.x, owner.z - s.self.z)];
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      const r = await original(t, w, b, o);
      distances.push(Math.hypot(owner.x - s.self.x, owner.z - s.self.z));
      return r;
    };
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'succeeded', JSON.stringify(results.map((r) => [r.status, r.reason, r.effect.slice(0, 160)])));
    assert.equal(last.reason, 'owner_reached');
    const grew = distances.some((d, i) => i > 0 && d > distances[i - 1]! + 1);
    assert.ok(grew, `some detour step increased the distance to the owner (no always-decreasing-distance rule): ${distances.map((d) => d.toFixed(1)).join(' -> ')}`);
    const all = results.flatMap((r) => detoursOf(r.evidence));
    // The episode ends either 'cleared' (past the obstacle with a forward frontier) or 'cue_changed' (after rounding
    // the end, the nearby owner's cue rotated more than 90 degrees from the episode frame): both mean it got around.
    assert.ok(all.some((d) => d.obstacle === 'wall' && (d.outcome === 'cleared' || d.outcome === 'cue_changed')), `a wall detour got around: ${JSON.stringify(all)}`);
    assert.ok(all.every((d) => d.side === all[0]!.side), `one committed side, no ping-pong: ${JSON.stringify(all)}`);
    for (const d of all) assert.ok(d.steps <= MAX_DETOUR_STEPS && d.blocks <= MAX_DETOUR_BLOCKS + 32, `bounded episode ${JSON.stringify(d)}`);
  });

  it('a far owner behind a wall 70 blocks wide: one-sided wall following, around the end, then straight on (cleared)', async () => {
    const owner = { x: 120.5, y: 64, z: 0.5 };
    const s = sim({ ownerAt: owner, obstacles: wall(70) });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.reason, 'owner_reached', JSON.stringify(results.map((r) => [r.status, r.reason])));
    const all = results.flatMap((r) => detoursOf(r.evidence));
    assert.ok(all.some((d) => d.outcome === 'cleared'), JSON.stringify(all));
    assert.ok(all.every((d) => d.side === all[0]!.side), `one committed side: ${JSON.stringify(all)}`);
  });

  it('a wall with no way around within the detour budget: the specific observed blocker, bounded sideways walking, no crossing', async () => {
    const s = sim({ ownerAt: { x: 300.5, y: 64, z: 0.5 }, obstacles: wall(2_000) });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'failed');
    assert.equal(last.reason, 'wall', last.effect);
    assert.match(last.effect, /bounded detour/);
    const ds = detoursOf(last.evidence);
    assert.ok(ds.length >= 1 && ds.every((d) => d.outcome !== 'cleared'), JSON.stringify(ds));
    assert.ok(s.self.x < 12, 'never crossed the wall');
    // The whole attempt is bounded: per-window episodes x per-episode budget (+ one frontier step of slack).
    assert.ok(Math.abs(s.self.z) <= 3 * (MAX_DETOUR_BLOCKS + 24), `sideways walking bounded (z ${s.self.z.toFixed(1)})`);
    assert.ok(results.length <= 3, `no endless windows (${results.length})`);
  });

  it('a lake across the cue with dry land around it: a dry detour along the shore, never standing in water', async () => {
    const lake = (w: ProcWorld) => w.features.push((x, y, z) => (x >= 10 && x <= 40 && z >= -60 && z <= 30 && y === 63 ? { name: 'water', stateId: 8, shapes: [] } : undefined));
    const owner = { x: 90.5, y: 64, z: 0.5 };
    const s = sim({ ownerAt: owner, obstacles: lake });
    const wet: Vec[] = [];
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      const r = await original(t, w, b, o);
      const f = s.world.blockAt(Math.floor(s.self.x), Math.floor(s.self.y) - 1, Math.floor(s.self.z));
      if (f?.name === 'water') wet.push({ ...s.self });
      return r;
    };
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(wet.length, 0, 'never on water');
    assert.ok(last.status === 'succeeded' || last.reason === 'water_crossing', JSON.stringify(results.map((r) => [r.status, r.reason])));
    if (last.status === 'succeeded') assert.ok(Math.hypot(owner.x - s.self.x, owner.z - s.self.z) <= 3.25);
  });

  it('no observed obstacle (nothing observed ahead): no detour and no wandering; a declarative blocker', async () => {
    // The floor ends at x >= 3 with nothing below: nothing is observed ahead (unobserved terrain), not an observed wall/drop.
    const s = sim({ ownerAt: { x: 300.5, y: 64, z: 0.5 } });
    s.world.floorAt = (x) => (x >= 3 ? null : 63);
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.notEqual(r.reason, 'route_window_elapsed');
    assert.equal(detoursOf(r.evidence).length, 0, 'no detour without observed geometry');
    assert.ok(Math.abs(s.self.z - 0.5) < 1 && s.self.x < 3, `did not wander (at ${s.self.x.toFixed(1)}, ${s.self.z.toFixed(1)})`);
  });

  it('a window counts only NET progress along the cue: sideways detour walking alone does not continue the window locally', async () => {
    const s = sim({ ownerAt: { x: 300.5, y: 64, z: 0.5 }, obstacles: wall(2_000) });
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
    assert.notEqual(r.reason, 'route_window_elapsed', `${r.reason}: ${r.effect}`);
    assert.ok(Number((r.evidence as { netProgress?: number }).netProgress ?? 0) < 12, JSON.stringify(r.evidence));
  });
});
