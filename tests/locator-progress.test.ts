// MB-LOC-002 coordinator correction (review of 394bec4): a seek window may
// continue locally only on CONSERVATIVE progress. Having seen the owner at some
// point is not progress: movement after the owner is lost, sideways/backward
// movement, or walking away from a visible owner never counts. Progress while
// the owner is visible is credited per movement poll from the owner's FRESH
// visible position only (the runner reads it through ownerVisible(), which is
// visibility-first; hidden positions are never read).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Vec } from '../src/perception/visibility.ts';
import type { MoveOptions, MoveResult } from '../src/locator/route-runner.ts';
import { MIN_WINDOW_PROGRESS, runRoute } from '../src/locator/route-runner.ts';
import { sim } from './locator-sim.ts';

type Tick = { bot: { dx: number; dz: number }; owner?: Vec };

/**
 * Replaces the simulated walker for the FIRST move with an exact script (one
 * poll per tick, 250 ms each); later moves only let the window time run out.
 * Records every owner read the runner makes while the owner is not visible.
 */
function scripted(s: ReturnType<typeof sim>, ticks: Tick[], durationMs: number) {
  let calls = 0;
  s.env.move = async (_t: Vec, _w: number, _b, opts: MoveOptions): Promise<MoveResult> => {
    calls += 1;
    if (calls > 1) {
      s.clock.t += durationMs; // nothing more happens in this window
      return { status: 'timeout', finalDistance: 0 };
    }
    for (const tick of ticks) {
      s.clock.t += 250;
      if (tick.owner) s.owner.at = { ...tick.owner };
      s.self.x += tick.bot.dx;
      s.self.z += tick.bot.dz;
      s.serverEmit();
      const abort = opts.abortIf?.();
      if (abort) return { status: 'stuck', aborted: abort, finalDistance: 0 };
      opts.retarget?.();
    }
    return { status: 'timeout', finalDistance: 0 };
  };
}

const run = (s: ReturnType<typeof sim>, durationMs: number) => runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs }, { routes: s.routes, locator: s.locator });
const progressOf = (r: Awaited<ReturnType<typeof run>>) => Number((r.evidence as { netProgress?: number }).netProgress ?? Number.NaN);
const repeat = (n: number, t: Tick): Tick[] => Array.from({ length: n }, () => t);

describe('MB-LOC-002 conservative window progress around a visible owner', () => {
  it('visible -> lost -> sideways: only the visible approach counts; the window does not continue on raw movement', async () => {
    const s = sim({ ownerAt: { x: 15.5, y: 64, z: 0.5 } });
    // 2 blocks toward the visible owner, then the owner leaves sight (60 east; cue still current), then 25 blocks sideways.
    scripted(s, [...repeat(2, { bot: { dx: 1, dz: 0 } }), { bot: { dx: 0, dz: 0 }, owner: { x: 60.5, y: 64, z: 0.5 } }, ...repeat(25, { bot: { dx: 0, dz: 1 } })], 8_000);
    const r = await run(s, 8_000);
    const moved = Math.hypot(s.self.x - 0.5, s.self.z - 0.5);
    assert.ok(moved > 20, `the bot really moved ${moved.toFixed(1)} blocks`);
    assert.ok(progressOf(r) < MIN_WINDOW_PROGRESS, `credited ${progressOf(r)}`);
    assert.notEqual(r.reason, 'route_window_elapsed', `${r.status}/${r.reason}: raw movement after the owner was lost is not progress`);
  });

  it('visible -> lost -> wrong way: movement away along the last visible bearing is debited', async () => {
    const s = sim({ ownerAt: { x: 15.5, y: 64, z: 0.5 } });
    scripted(s, [...repeat(3, { bot: { dx: 1, dz: 0 } }), { bot: { dx: 0, dz: 0 }, owner: { x: 60.5, y: 64, z: 0.5 } }, ...repeat(12, { bot: { dx: -1, dz: 0 } })], 6_000);
    const r = await run(s, 6_000);
    assert.ok(progressOf(r) <= 3 - 12 + 0.01, `credited ${progressOf(r)}`);
    assert.notEqual(r.reason, 'route_window_elapsed');
  });

  it('a visible owner walking away north while the bot walks south: no credit, however far the bot moved', async () => {
    const s = sim({ ownerAt: { x: 0.5, y: 64, z: -10.5 } });
    const ticks: Tick[] = [];
    for (let i = 1; i <= 12; i += 1) ticks.push({ bot: { dx: 0, dz: 1 }, owner: { x: 0.5, y: 64, z: -10.5 - i * 0.5 } });
    scripted(s, ticks, 4_000);
    const r = await run(s, 4_000);
    assert.ok(progressOf(r) < 0, `credited ${progressOf(r)}`);
    assert.notEqual(r.reason, 'route_window_elapsed');
  });

  it('positive control: following a visible owner who keeps walking ahead is credited and the window continues', async () => {
    const s = sim({ ownerAt: { x: 12.5, y: 64, z: 0.5 } });
    const ticks: Tick[] = [];
    for (let i = 1; i <= 24; i += 1) ticks.push({ bot: { dx: 1, dz: 0 }, owner: { x: 12.5 + i, y: 64, z: 0.5 } });
    scripted(s, ticks, 7_000);
    const r = await run(s, 7_000);
    assert.ok(progressOf(r) >= 20, `credited ${progressOf(r)}`);
    assert.equal(r.status, 'partial');
    assert.equal(r.reason, 'route_window_elapsed');
  });

  it('the visible-owner progress uses only ownerVisible() (visibility-first); no other owner position source', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/locator/route-runner.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const trackVisible = () => {'), src.indexOf('const res = await move(seen'));
    assert.ok(body.includes('env.ownerVisible()'));
    assert.ok(!/owner\.at|entities|position\b|steering\(/.test(body), 'no hidden or locator position is used to credit visible progress');
  });
});
