// MB-LOC-002 F1: direction correctness of the owner locator cue and the FIRST
// route movement on a clear plane, for all eight cardinal/diagonal directions
// plus bearing wraparound, every payload variant the server selects (block,
// chunk, azimuth), positive and NEGATIVE world coordinates and arbitrary bot
// yaw. The oracle is the simulated server's TRUE owner position (it never
// reaches the runner, the hint or any evidence). Invalid, other-player, stale,
// unverified, old-connection and voided statements must never steer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_LOCATOR_CONFIG } from '../src/contracts/locator.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { compassSector } from '../src/perception/frontiers.ts';
import type { Vec } from '../src/perception/visibility.ts';
import { angleBetween } from '../src/locator/geometry.ts';
import { runRoute } from '../src/locator/route-runner.ts';
import { DIM, OWNER, OWNER_UUID, assertNoCoordinates, sim } from './locator-sim.ts';

const deg = (d: number) => (d * Math.PI) / 180;
/** Bearings in the +x east / +z south convention (atan2(dz, dx)), degrees. */
const EIGHT = [0, 45, 90, 135, 180, -135, -90, -45];
/**
 * Wraparound: +/-179 straddle +/-pi of atan2(dz, dx) (due west); -89/-91
 * straddle the Minecraft-yaw +/-pi of the azimuth payload (due north).
 */
const WRAP = [179, -179, -89, -91];
const STARTS: Vec[] = [
  { x: 0.5, y: 64, z: 0.5 },
  { x: -1200.5, y: 64, z: -1400.5 }, // negative world coordinates (chunk indices < 0)
];
/** Distances that make the official rule pick each variant (view distance 10 chunks in the simulator). */
const VARIANTS = [
  { distance: 60, variant: 'vec3i' },
  { distance: 260, variant: 'chunk' }, // per-axis chunk offset beyond 10 chunks even on diagonals
  { distance: 420, variant: 'azimuth' },
] as const;
const YAWS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 3.0, -2.2];

function ownerFrom(start: Vec, bearingDeg: number, distance: number): Vec {
  return { x: start.x + Math.cos(deg(bearingDeg)) * distance, y: 64, z: start.z + Math.sin(deg(bearingDeg)) * distance };
}

/** Runs exactly ONE route step (the lease fence revokes the second step) and returns the first movement. */
async function firstStep(s: ReturnType<typeof sim>): Promise<{ target: Vec; moved: Vec }> {
  s.sleeps.revokeAfter = 1;
  await assert.rejects(runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator }), /lease revoked/);
  assert.ok(s.targets.length >= 1, 'a first movement was issued');
  return { target: s.targets[0]!, moved: { x: s.self.x - s.start.x, y: s.self.y - s.start.y, z: s.self.z - s.start.z } };
}

describe('MB-LOC-002 F1 coarse cue: eight directions, wraparound, all variants, negative coordinates, any yaw', () => {
  for (const start of STARTS) {
    for (const { distance, variant } of VARIANTS) {
      it(`start (${start.x}, ${start.z}), ${variant} at ${distance}: the cue sector is the true sector for every direction and does not depend on yaw`, () => {
        for (const b of [...EIGHT, ...WRAP]) {
          const ownerAt = ownerFrom(start, b, distance);
          const truth = compassSector(ownerAt.x - start.x, ownerAt.z - start.z);
          let first: string | undefined;
          for (const yaw of YAWS) {
            const s = sim({ ownerAt, start, yaw });
            const h = s.locator.ownerHint();
            assert.ok(h.actionable, `${b}deg: actionable (${h.reason}: ${h.note})`);
            assert.equal(h.direction, truth, `${b}deg yaw ${yaw}: cue ${h.direction}, true ${truth}`);
            assert.equal(s.locator.status().counters.byVariant[variant], 1, `${b}deg: the server chose ${variant}`);
            const key = JSON.stringify({ ...h, ageMs: 0, expiresInMs: 0 });
            first ??= key;
            assert.equal(key, first, 'identical hint for every bot yaw');
            assertNoCoordinates(h, [Math.round(ownerAt.x), Math.round(ownerAt.z), Math.floor(ownerAt.x), Math.floor(ownerAt.z)].filter((n) => Math.abs(n) >= 20));
          }
        }
      });
    }
  }
});

describe('MB-LOC-002 F1 first route movement on a clear plane agrees with the true bearing', () => {
  for (const start of STARTS) {
    for (const { distance, variant } of VARIANTS) {
      it(`start (${start.x}, ${start.z}), ${variant}: first frontier step within 30deg of the true bearing with real progress (8 directions + wraparound)`, async () => {
        let i = 0;
        for (const b of [...EIGHT, ...WRAP]) {
          const ownerAt = ownerFrom(start, b, distance);
          const s = sim({ ownerAt, start, yaw: YAWS[i++ % YAWS.length]! });
          const truth = Math.atan2(ownerAt.z - start.z, ownerAt.x - start.x);
          const { target, moved } = await firstStep(s);
          const targetAngle = angleBetween(Math.atan2(target.z - start.z, target.x - start.x), truth);
          const movedAngle = angleBetween(Math.atan2(moved.z, moved.x), truth);
          const progress = moved.x * Math.cos(truth) + moved.z * Math.sin(truth);
          const label = `${variant} ${b}deg from (${start.x}, ${start.z})`;
          assert.ok(targetAngle <= deg(30), `${label}: first target ${(targetAngle * 180 / Math.PI).toFixed(1)}deg off the true bearing`);
          assert.ok(movedAngle <= deg(30), `${label}: moved ${(movedAngle * 180 / Math.PI).toFixed(1)}deg off`);
          assert.ok(progress >= 10, `${label}: progress along the true bearing ${progress.toFixed(1)}`);
          assert.ok(Math.hypot(ownerAt.x - s.self.x, ownerAt.z - s.self.z) < distance - 8, `${label}: closer to the owner after the first step`);
        }
      });
    }
  }

  it('the owner reappears on the OPPOSITE side mid-route: the bot re-steers toward the new cue (no stale bearing)', async () => {
    const start = { x: -600.5, y: 64, z: 300.5 };
    const s = sim({ ownerAt: ownerFrom(start, 0, 260), start });
    const original = s.env.move;
    let flipped = false;
    let flipAt: Vec | undefined;
    s.env.move = async (t, w, bb, o) => {
      if (!flipped && s.self.x - start.x > 30) {
        flipped = true;
        flipAt = { ...s.self };
        s.owner.at = ownerFrom(start, 180, 260); // now due west of the start
      }
      return original(t, w, bb, o);
    };
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.ok(flipped && flipAt);
    assert.ok(s.self.x < flipAt.x - 20, `turned around toward the new cue (x ${s.self.x.toFixed(1)} vs flip ${flipAt.x.toFixed(1)}; ${r.status}/${r.reason})`);
  });
});

describe('MB-LOC-002 F1 invalid, other-player, stale and unverified statements cannot steer', () => {
  const far = { x: 300.5, y: 64, z: 0.5 };
  const noMove = async (s: ReturnType<typeof sim>, label: string) => {
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 30_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed', label);
    assert.equal(r.reason, 'no_actionable_hint', `${label}: ${r.effect}`);
    assert.equal(s.moves, 0, `${label}: nothing moved`);
    assert.deepEqual(s.self, s.start, `${label}: position unchanged`);
    return r;
  };
  const track = (uuid: string | undefined, type: unknown, data: unknown, id?: string) => ({ operation: 'track', waypoint: { hasUUID: uuid !== undefined, ...(uuid !== undefined ? { uuid } : { id }), icon: { style: 'minecraft:default' }, type, data } });

  it("another player's waypoint (even the only one, nearest, or with a matching icon) never steers", async () => {
    const s = sim({ ownerAt: far, emitOwner: false });
    s.client.emit('tracked_waypoint', track(offlinePlayerUuid('SomeoneElse'), 'vec3i', { x: 300, y: 64, z: 0 }));
    s.client.emit('tracked_waypoint', track(offlinePlayerUuid('SomeoneElse2'), 'azimuth', 1.2));
    assert.equal(s.locator.status().counters.otherTracked, 2);
    await noMove(s, 'other player');
  });

  it("a string-identified waypoint carrying the owner's name never grants identity", async () => {
    const s = sim({ ownerAt: far, emitOwner: false });
    s.client.emit('tracked_waypoint', track(undefined, 'vec3i', { x: 300, y: 64, z: 0 }, OWNER));
    await noMove(s, 'string id');
  });

  it('malformed or unknown-variant owner statements are rejected, not guessed', async () => {
    const s = sim({ ownerAt: far, emitOwner: false });
    s.client.emit('tracked_waypoint', track(OWNER_UUID, 7, 1.0)); // raw id from the mapper
    s.client.emit('tracked_waypoint', track(OWNER_UUID, 'vec3i', { x: 1.5, y: 64, z: 0 })); // non-integer
    s.client.emit('tracked_waypoint', track(OWNER_UUID, 'azimuth', Number.NaN));
    s.client.emit('tracked_waypoint', { operation: 9, waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 'x' }, type: 'azimuth', data: 0 } });
    assert.equal(s.locator.status().counters.rejected, 4);
    await noMove(s, 'malformed');
  });

  it('a stale statement (older than hintMaxAgeMs, no later broadcast) does not steer', async () => {
    const s = sim({ ownerAt: far });
    assert.ok(s.locator.ownerHint().actionable);
    s.clock.t += DEFAULT_LOCATOR_CONFIG.hintMaxAgeMs + 1;
    const r = await noMove(s, 'stale');
    assert.equal((r.evidence as { hintReason?: string }).hintReason, 'expired');
  });

  it('the owner UUID without the exact listed owner name (identity unverified) does not steer', async () => {
    const s = sim({ ownerAt: far });
    s.bot.players = {};
    const r = await noMove(s, 'unlisted');
    assert.equal((r.evidence as { hintReason?: string }).hintReason, 'owner_identity_unverified');
  });

  it('statements from an OLD connection never steer a new one; a respawn/dimension change voids statements', async () => {
    const s = sim({ ownerAt: far });
    const old = s.client;
    const { EventEmitter } = await import('node:events');
    const fresh = new EventEmitter();
    s.locator.attach(fresh, 1); // a new attachment (same epoch number reused deliberately: identity is the client object)
    old.emit('tracked_waypoint', track(OWNER_UUID, 'vec3i', { x: 300, y: 64, z: 0 }));
    await noMove(s, 'old client');
    fresh.emit('login', {});
    fresh.emit('tracked_waypoint', track(OWNER_UUID, 'vec3i', { x: 300, y: 64, z: 0 }));
    assert.ok(s.locator.ownerHint().actionable, 'a fresh statement on the current client is actionable');
    fresh.emit('respawn', {});
    assert.equal(s.locator.ownerHint().reason, 'dimension_changed');
    await noMove(s, 'voided by respawn');
  });

  it('a different dimension never uses overworld statements (the hint carries its dimension)', () => {
    const s = sim({ ownerAt: far });
    assert.equal(s.locator.ownerHint().dimension, DIM);
    s.locator.onLifecycle({ type: 'dimension_change', connectionEpoch: 1, dimension: 'minecraft:the_nether' } as never);
    assert.equal(s.locator.ownerHint().actionable, false);
  });
});
