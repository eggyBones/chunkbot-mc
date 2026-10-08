// MB-LOC-001 L3/L4/L5/L6: the route runner over a scripted world and a
// simulated server that emits tracked_waypoint statements by the OFFICIAL
// variant rules (see tests/locator-sim.ts). Real LocatorService and
// RouteController; movement is a scripted walker that only steps on standable,
// non-hazard cells inside the bound it is given (no digging/placing/towering).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_LOCATOR_CONFIG, type RouteDestinationProvider } from '../src/contracts/locator.ts';
import type { Vec } from '../src/perception/visibility.ts';
import { runRoute } from '../src/locator/route-runner.ts';
import { DIM, FULL, assertNoCoordinates, runWindows, sim, type ProcWorld } from './locator-sim.ts';

describe('MB-LOC-001 L3 locator-assisted reunion beyond the 128-block admission radius', () => {
  it('follows azimuth -> chunk -> block cues through counted legs, reacquires the VISIBLE owner and verifies proximity', async () => {
    const s = sim({ ownerAt: { x: 437.3, y: 64, z: 61.7 } });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'succeeded', JSON.stringify(results.map((r) => [r.status, r.reason, r.effect])));
    assert.equal(last.reason, 'owner_reached');
    assert.ok(Math.hypot(s.owner.at.x - s.self.x, s.owner.at.z - s.self.z) <= 3.25);
    const st = s.routes.status(1)!;
    assert.ok(st.legsUsed >= 3 && st.legsUsed <= st.maxLegs, `legs ${st.legsUsed}`);
    assert.ok(st.distanceUsed > 0 && st.distanceUsed <= st.maxTotalDistance);
    assert.deepEqual(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM })!.admissionAnchor, { x: 0.5, y: 64, z: 0.5 }, 'admission anchor unchanged');
    const counters = s.locator.status().counters;
    assert.ok(counters.byVariant.azimuth > 0 && counters.byVariant.chunk > 0 && counters.byVariant.vec3i > 0, JSON.stringify(counters.byVariant));
    for (const r of results) assertNoCoordinates(r.evidence, [437, 61, 437.3, 61.7]);
  });

  it('a fixed owner-typed destination beyond the radius is reached through legs (arrival = own position)', async () => {
    const s = sim({ ownerAt: { x: 0, y: 64, z: -900 }, ownerCoordinates: [{ x: 300, y: 64, z: 200 }] });
    s.owner.hidden = true;
    const C = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM };
    const results = await runWindows(s, {
      kind: 'fixed',
      destination: 'owner_destination',
      dimension: DIM,
      at: { x: 300, y: 64, z: 200 },
      label: 'owner-supplied destination 300,64,200',
      recheck: () => {
        const v = s.routes.verifyDestination(C, 'owner_destination', { x: 300, y: 64, z: 200 }, DIM);
        return v.ok ? { ok: true } : { ok: false, reason: `route_${v.blocker}`, detail: v.detail };
      },
    });
    const last = results.at(-1)!;
    assert.equal(last.status, 'succeeded', JSON.stringify(results.map((r) => [r.status, r.reason, r.effect])));
    assert.equal(last.reason, 'arrived');
    assert.ok(Math.hypot(300 - s.self.x, 200 - s.self.z) <= 3.5);
  });
});

describe('MB-LOC-001 L4 withdrawn/absent cues stop advancing', () => {
  it('no locator statement: nothing moves (no omniscient fallback)', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.owner.hidden = true;
    s.serverEmit();
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
    assert.deepEqual(s.self, { x: 0.5, y: 64, z: 0.5 });
  });

  it('the owner hides (crouch/invisibility/head item -> untrack) mid-route: the bot stops on the withdrawn cue', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      if (s.self.x > 40) {
        s.owner.hidden = true;
      }
      return original(t, w, b, o);
    };
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'hint_withdrawn');
    const stoppedAt = s.self.x;
    assert.ok(stoppedAt < 60, `stopped near where the cue was withdrawn (x=${stoppedAt})`);
    const again = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(again.reason, 'no_actionable_hint');
    assert.equal(s.self.x, stoppedAt, 'no further movement without a current cue');
  });

  it('an expired statement (stationary bot, no broadcasts) is not followed', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.clock.t += DEFAULT_LOCATOR_CONFIG.hintMaxAgeMs + 1;
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
  });
});

describe('MB-LOC-001 L5 impassable terrain produces specific blockers (no dig/tower/invented path)', () => {
  it('visible lava across the cue direction -> hazard_lava; the bot never steps on lava', async () => {
    const s = sim({ ownerAt: { x: 300, y: 64, z: 0 }, obstacles: (w) => w.features.push((x, y, z) => (x >= 3 && x <= 40 && Math.abs(z) <= 300 && y === 63 ? { name: 'lava', stateId: 9, shapes: [] } : undefined)) });
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'hazard_lava', r.effect);
    assert.ok(s.self.x < 3);
  });

  it('a deep drop -> cliff_drop', async () => {
    const s = sim({ ownerAt: { x: 300, y: 56, z: 0 } });
    s.world.floorAt = (x) => (x >= 3 ? 55 : 63);
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'cliff_drop', r.effect);
    assert.ok(s.self.x < 3 && s.self.y === 64);
  });

  it('a wall with the owner above -> vertical_separation (no towering); a plain wall -> wall', async () => {
    const wall = (w: ProcWorld) => w.features.push((x, y, z) => (x >= 3 && x <= 4 && Math.abs(z) <= 300 && y >= 64 && y <= 80 ? { name: 'stone', stateId: 3, shapes: FULL } : undefined));
    const above = sim({ ownerAt: { x: 40, y: 90, z: 0 }, obstacles: wall });
    const r1 = await runRoute(above.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: above.routes, locator: above.locator });
    assert.equal(r1.reason, 'vertical_separation', r1.effect);
    const level = sim({ ownerAt: { x: 300, y: 64, z: 0 }, obstacles: wall });
    const r2 = await runRoute(level.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: level.routes, locator: level.locator });
    assert.equal(r2.reason, 'wall', r2.effect);
    assert.ok(level.self.x < 3 && level.self.y === 64);
  });
});

describe('MB-LOC-001 ceilings and ownership in the runner (L6/C1)', () => {
  it('without a route authorization the bot stops at the admission bound (route_not_authorized)', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 }, routes: false });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'failed');
    assert.equal(last.reason, 'route_not_authorized', last.effect);
    assert.ok(Math.hypot(s.self.x - 0.5, s.self.z - 0.5) <= 128);
  });

  it('the leg ceiling ends the route; the expanded leg is withdrawn and the bot never left the last authorized leg', async () => {
    const s = sim({ ownerAt: { x: 900, y: 64, z: 0 }, policy: { maxLegs: 2 } });
    let lastLeg: { anchor: Vec; radius: number } | undefined;
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      const leg = s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM });
      if (leg) lastLeg = { anchor: leg.anchor, radius: leg.radius };
      return original(t, w, b, o);
    };
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.reason, 'route_leg_limit', last.effect);
    assert.equal(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM }), undefined, 'C2: no stale expanded authority');
    assert.equal((s.routes.effectiveTravel(s.env.admissionBounds()!) as { reason?: string }).reason, 'route_exhausted');
    assert.equal(s.routes.status(1)!.legsUsed, 2);
    assert.ok(lastLeg && Math.hypot(s.self.x - lastLeg.anchor.x, s.self.z - lastLeg.anchor.z) <= lastLeg.radius + 1e-6);
  });

  it('the cumulative distance ceiling stops route movement mid-leg', async () => {
    const s = sim({ ownerAt: { x: 900, y: 64, z: 0 }, policy: { maxTotalDistance: 100 } });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.reason, 'route_distance_limit', last.effect);
    const st = s.routes.status(1)!;
    assert.ok(st.distanceUsed >= 100 && st.distanceUsed < 104, `${st.distanceUsed}`);
  });

  it('lease revocation (stop/replacement) aborts the runner; no movement afterwards', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.sleeps.revokeAfter = 3;
    await assert.rejects(runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator }), /lease revoked/);
    const moves = s.moves;
    const at = { ...s.self };
    await assert.rejects(runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator }), /lease revoked/);
    assert.equal(s.moves, moves);
    assert.deepEqual(s.self, at);
  });

  it('a revoked route (goal ended) cannot be continued by a late window', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 } });
    await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 30_000 }, { routes: s.routes, locator: s.locator });
    s.routes.revoke('goal_terminal', 1);
    const results = await runWindows(s);
    assert.ok(results.every((r) => r.status !== 'succeeded'));
    assert.equal(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM }), undefined);
  });
});

describe('MB-LOC-001-C3 provenance in the runner', () => {
  it('a frozen own-incident destination that changes or disappears mid-route stops movement at the next poll', async () => {
    let current: ReturnType<RouteDestinationProvider['current']> = { destinationId: 'mf-0001', dimension: DIM, at: { x: 400, y: 64, z: 0 }, recordedAtMs: 5, label: 'own death location', provenance: 'own_incident' };
    for (const change of ['moved', 'missing'] as const) {
      current = { destinationId: 'mf-0001', dimension: DIM, at: { x: 400, y: 64, z: 0 }, recordedAtMs: 5, label: 'own death location', provenance: 'own_incident' };
      const s = sim({ ownerAt: { x: 0, y: 64, z: -900 }, policy: { destinations: ['owner', 'own_death'] }, ownDeath: { kind: 'own_death', current: () => current } });
      s.owner.hidden = true;
      const C = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM };
      const v = s.routes.verifyDestination(C, 'own_death');
      assert.ok(v.ok && v.kind === 'own_death');
      if (v.ok && v.kind === 'own_death') assert.ok(s.routes.bindOwnDeath(C, v.identity));
      const original = s.env.move;
      let changedAt: Vec | undefined;
      s.env.move = async (t, w, b, o) => {
        if (s.self.x > 60 && !changedAt) {
          changedAt = { ...s.self };
          current = change === 'moved' ? { ...current!, at: { x: 420, y: 64, z: 0 } } : undefined;
        }
        return original(t, w, b, o);
      };
      const r = await runRoute(s.env, { kind: 'fixed', destination: 'own_death', dimension: DIM, at: { x: 400, y: 64, z: 0 }, label: 'own death location', recheck: () => {
        const c = s.routes.verifyDestination(C, 'own_death');
        return c.ok ? { ok: true } : { ok: false, reason: `route_${c.blocker}`, detail: c.detail };
      } }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, change === 'moved' ? 'route_destination_changed' : 'route_destination_unverified', r.effect);
      assert.ok(changedAt, 'the incident changed mid-route');
      assert.deepEqual(s.self, changedAt, 'stopped at the first movement poll after the change (no further step)');
    }
  });

  it('a leg whose admission anchor differs from the goal-owned proof is never applied (no relaxed fallback)', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 } });
    // The proof claims a different admission anchor than the route authorization (e.g. a leg-expanded travelBounds misused as proof).
    s.proofOverride.value = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM, anchor: { x: 10.5, y: 64, z: 0.5 }, radius: 128 };
    await runWindows(s);
    assert.ok(Math.hypot(s.self.x - 10.5, s.self.z - 0.5) <= 128 + 1e-6, `stayed inside the proven admission bound (x=${s.self.x})`);
    s.proofOverride.value = { goalEpoch: 2, connectionEpoch: 1, dimension: DIM, anchor: { x: 0.5, y: 64, z: 0.5 }, radius: 128 };
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 30_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'travel_anchor_not_admitted', 'a proof for another goal epoch moves nothing');
  });
});
