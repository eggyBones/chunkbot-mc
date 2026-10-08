// MB-FLOW-003-C12 route lineage (L-owned part of the shared continuation
// contract): a route is exported BEFORE revocation and admitted once into the
// continuation epoch of the SAME logical goal id. Original routeId, anchor,
// frozen ceilings and absolute deadline; every consumed leg, the cumulative
// distance with its sources and the stalled/blocker history are kept; new legs
// are numbered after the old ones; exhausted/blocked/expired lineages get no
// authority; stale, tampered, mismatched or repeated admissions are refused.
// No movement, handle, task or lease is carried (plain data only).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoutePolicySchema, RouteStatusSchema, type RouteAdmission, type RouteCarry, type RouteDestinationProvider } from '../src/contracts/locator.ts';
import { RouteController } from '../src/locator/routes.ts';

const DIM = 'minecraft:overworld';
const ANCHOR = { x: 0.5, y: 64, z: 0.5 };

function setup(policy: Record<string, unknown> = {}, ownDeath?: RouteDestinationProvider) {
  const clock = { t: 1_000_000, now() { return this.t; } };
  const events: Array<Record<string, unknown>> = [];
  const routes = new RouteController({ policy: RoutePolicySchema.parse({ maxTotalDistance: 400, maxLegs: 6, maxRouteMs: 600_000, ...policy }), clock, record: (e) => events.push(e), ...(ownDeath ? { ownDeath } : {}) });
  const admission = (epoch: number, over: Partial<RouteAdmission> = {}): RouteAdmission => ({ goalId: 'goal-0001', goalEpoch: epoch, admittedAtMs: clock.t, source: 'owner', goalDeadlineMs: clock.t + 3_600_000, connectionEpoch: 1, dimension: DIM, admissionAnchor: { ...ANCHOR }, admissionRadius: 128, ownerCoordinates: [], ...over });
  const ctx = (epoch: number) => ({ goalEpoch: epoch, connectionEpoch: 1, dimension: DIM });
  /** Walks along +x from `from` to `to` in 4-block samples (client physics) for the given epoch. */
  const walk = (epoch: number, from: number, to: number) => {
    for (let x = from + 4; x <= to; x += 4) routes.sample(ctx(epoch), { x, y: 64, z: 0.5 });
  };
  return { clock, routes, admission, ctx, walk, events };
}

/** Original epoch 1: two legs (the second active), 120 blocks walked, one 6-block server correction. */
function interruptedRoute(s: ReturnType<typeof setup>) {
  assert.ok(s.routes.admit(s.admission(1)));
  assert.ok(s.routes.beginLeg({ ...s.ctx(1), at: { x: 100.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
  s.walk(1, 100.5, 160.5);
  s.routes.sample(s.ctx(1), { x: 166.5, y: 64, z: 0.5 }, 'server_correction');
  assert.ok(s.routes.beginLeg({ ...s.ctx(1), at: { x: 166.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
  s.walk(1, 166.5, 218.5);
  const before = s.routes.status(1)!;
  assert.equal(before.state, 'leg_active');
  assert.equal(before.legsUsed, 2);
  return before;
}

describe('MB-FLOW-003-C12 route lineage: export before revocation', () => {
  it('exportCarry captures the current route of the epoch (an active leg finalized as interrupted) and changes no route state', () => {
    const s = setup();
    const before = interruptedRoute(s);
    const carry = s.routes.exportCarry(1)!;
    assert.ok(carry && Object.isFrozen(carry) && Object.isFrozen(carry.ceilings) && Object.isFrozen(carry.distance));
    assert.equal(carry.routeId, before.routeId);
    assert.equal(carry.goalId, 'goal-0001');
    assert.equal(carry.legsUsed, 2, 'the interrupted active leg is counted');
    assert.equal(carry.lastLeg?.index, 2);
    assert.match(carry.lastLeg?.outcome ?? '', /^interrupted_(progressed|stalled)$/);
    assert.equal(carry.state, 'authorized');
    assert.deepEqual(carry.distance, { total: before.distanceUsed, clientPhysics: before.distanceSources.clientPhysics, serverCorrections: before.distanceSources.serverCorrections, correctionCount: 1 });
    assert.equal(s.routes.status(1)!.state, 'leg_active', 'exporting changes no route state');
    assert.ok(!('legs' in carry) && !('lastSample' in carry), 'plain lineage data only (no executable leg, no position chain)');
  });

  it('capture must precede revocation: after revoke nothing is exported; revokeWithCarry exports THEN revokes', () => {
    const s = setup();
    interruptedRoute(s);
    s.routes.revoke('lifecycle_death', 1);
    assert.equal(s.routes.exportCarry(1), undefined);
    const t = setup();
    interruptedRoute(t);
    const carry = t.routes.revokeWithCarry('lifecycle_death', 1);
    assert.ok(carry);
    assert.equal(t.routes.status(1)!.state, 'revoked');
    assert.equal(t.routes.exportCarry(2), undefined, 'another epoch exports nothing');
  });
});

describe('MB-FLOW-003-C12 continuation admission', () => {
  it('same routeId and logical goal id at a FRESH epoch: original anchor, frozen ceilings and absolute deadline; consumed history and distance sources kept; no leg is executable until a new one begins', () => {
    const s = setup();
    const before = interruptedRoute(s);
    const auth1 = s.routes.authorization(s.ctx(1))!;
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    s.clock.t += 30_000; // respawn and recovery take time; the deadline is not refreshed
    const r = s.routes.admitContinuation(carry, s.admission(2));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.authorization.routeId, before.routeId);
    assert.equal(r.authorization.goalId, 'goal-0001');
    assert.equal(r.authorization.goalEpoch, 2);
    assert.deepEqual({ ...r.authorization.ceilings }, { ...auth1.ceilings }, 'ORIGINAL frozen ceilings');
    assert.equal(r.authorization.ceilings.routeDeadlineMs, auth1.ceilings.routeDeadlineMs, 'absolute deadline unchanged');
    assert.equal(r.authorization.grantedAtMs, auth1.grantedAtMs);
    assert.deepEqual({ ...r.authorization.admissionAnchor }, ANCHOR);
    assert.deepEqual(r.authorization.continuation, { originalGoalEpoch: 1, fromGoalEpoch: 1, count: 1 });
    const st = r.status;
    RouteStatusSchema.parse(st);
    assert.equal(st.legsUsed, 2);
    assert.equal(st.distanceUsed, before.distanceUsed);
    assert.deepEqual(st.distanceSources, before.distanceSources, 'client physics, server corrections and their count survive');
    assert.equal(st.remainingMs, before.remainingMs - 30_000);
    assert.equal(st.currentLeg, null, 'the interrupted leg is not executable again');
    assert.equal(st.lastLeg?.index, 2);
    assert.deepEqual(st.continuation, { count: 1, originalGoalEpoch: 1 });
    const e = s.routes.effectiveTravel({ goalEpoch: 2, connectionEpoch: 1, dimension: DIM, anchor: { ...ANCHOR }, radius: 128 });
    assert.equal(e.kind, 'admission', 'no expanded authority until a new counted leg begins');
    const leg = s.routes.beginLeg({ ...s.ctx(2), at: { x: 30.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 });
    assert.ok(leg.ok);
    if (leg.ok) assert.equal(leg.leg.legIndex, 3, 'monotonic leg numbering across epochs');
  });

  it('the respawn displacement is not own movement; movement after continuation counts from admission onto the carried total', () => {
    const s = setup();
    const before = interruptedRoute(s);
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.ok(s.routes.admitContinuation(carry, s.admission(2)).ok);
    s.routes.sample(s.ctx(2), { x: 5.5, y: 64, z: 0.5 }); // first sample after respawn far away: starts the chain, counts nothing
    assert.equal(s.routes.status(2)!.distanceUsed, before.distanceUsed);
    s.routes.sample(s.ctx(2), { x: 15.5, y: 64, z: 0.5 }); // walking before any new leg still counts (the route had begun)
    assert.equal(s.routes.status(2)!.distanceUsed, Math.round((before.distanceUsed + 10) * 10) / 10);
  });

  it('repeated deaths: the lineage continues with cumulative legs/distance and count; only the LATEST export is admissible, once', () => {
    const s = setup();
    interruptedRoute(s);
    const carry1 = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.ok(s.routes.admitContinuation(carry1, s.admission(2)).ok);
    assert.equal(s.routes.admitContinuation(carry1, s.admission(3)).ok, false, 'an export is admitted once');
    // epoch 3 was consumed by that refusal (fail closed); continue epoch 2's route
    assert.equal(s.routes.status(2), null, 'the refused fresh epoch replaced nothing it could steer');
    const t = setup();
    interruptedRoute(t);
    const c1 = t.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.ok(t.routes.admitContinuation(c1, t.admission(2)).ok);
    t.routes.sample(t.ctx(2), { x: 10.5, y: 64, z: 0.5 });
    assert.ok(t.routes.beginLeg({ ...t.ctx(2), at: { x: 10.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
    t.walk(2, 10.5, 50.5);
    const mid = t.routes.status(2)!;
    const c2 = t.routes.revokeWithCarry('lifecycle_death', 2)!;
    assert.equal(c2.legsUsed, 3);
    assert.equal(c2.continuations, 1);
    assert.equal(c2.originalGoalEpoch, 1);
    const stale = t.routes.admitContinuation(c1, t.admission(3));
    assert.ok(!stale.ok && stale.kind === 'refused' && stale.reason === 'unknown_or_stale_carry', 'an older export after a newer one');
    const r = t.routes.admitContinuation(c2, t.admission(4));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.status.legsUsed, 3);
    assert.equal(r.status.distanceUsed, mid.distanceUsed);
    assert.deepEqual(r.authorization.continuation, { originalGoalEpoch: 1, fromGoalEpoch: 2, count: 2 });
    const leg = t.routes.beginLeg({ ...t.ctx(4), at: { x: 0.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 });
    assert.ok(leg.ok && leg.leg.legIndex === 4);
  });

  it('an expired original deadline gets no authority (terminal time_limit), recorded truthfully', () => {
    const s = setup({ maxRouteMs: 60_000 });
    interruptedRoute(s);
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    s.clock.t += 120_000;
    const r = s.routes.admitContinuation(carry, s.admission(2));
    assert.ok(!r.ok && r.kind === 'terminal' && r.blocker === 'time_limit', JSON.stringify(r));
    assert.equal(s.routes.status(2)!.state, 'exhausted');
    assert.equal(s.routes.canBegin(s.ctx(2), 'owner').ok, false);
    assert.equal(s.routes.effectiveTravel({ goalEpoch: 2, connectionEpoch: 1, dimension: DIM, anchor: { ...ANCHOR }, radius: 128 }).kind, 'admission');
  });

  it('a lineage exhausted (distance) or blocked (stalled) before the interruption stays so; no fresh grant', () => {
    const s = setup({ maxTotalDistance: 100 });
    assert.ok(s.routes.admit(s.admission(1)));
    assert.ok(s.routes.beginLeg({ ...s.ctx(1), at: { x: 100.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
    s.walk(1, 100.5, 204.5);
    assert.equal(s.routes.status(1)!.state, 'exhausted');
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.equal(carry.state, 'exhausted');
    const r = s.routes.admitContinuation(carry, s.admission(2));
    assert.ok(!r.ok && r.kind === 'terminal' && r.blocker === 'distance_limit', JSON.stringify(r));
    assert.equal(s.routes.beginLeg({ ...s.ctx(2), at: { x: 0.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok, false);

    const b = setup({ maxStalledLegs: 1, minLegProgress: 20 });
    assert.ok(b.routes.admit(b.admission(1)));
    assert.ok(b.routes.beginLeg({ ...b.ctx(1), at: { x: 100.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
    b.routes.sample(b.ctx(1), { x: 104.5, y: 64, z: 0.5 });
    const blocked = b.routes.beginLeg({ ...b.ctx(1), at: { x: 104.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 });
    assert.ok(!blocked.ok && blocked.blocker === 'stalled');
    const bc = b.routes.revokeWithCarry('lifecycle_death', 1)!;
    const br = b.routes.admitContinuation(bc, b.admission(2));
    assert.ok(!br.ok && br.kind === 'terminal' && br.blocker === 'stalled');
    assert.equal(b.routes.status(2)!.state, 'blocked');
  });

  it('an interrupted active leg is finalized conservatively: a stalled interrupted leg extends the stall run (and can block)', () => {
    const s = setup({ maxStalledLegs: 1, minLegProgress: 20 });
    assert.ok(s.routes.admit(s.admission(1)));
    assert.ok(s.routes.beginLeg({ ...s.ctx(1), at: { x: 100.5, y: 64, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
    s.routes.sample(s.ctx(1), { x: 103.5, y: 64, z: 0.5 });
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.equal(carry.lastLeg?.outcome, 'interrupted_stalled');
    assert.equal(carry.stalledLegs, 1);
    const r = s.routes.admitContinuation(carry, s.admission(2));
    assert.ok(!r.ok && r.kind === 'terminal' && r.blocker === 'stalled');
  });

  it('refusals: stale epoch, connection, dimension, anchor, goal and source mismatches, tampered or forged carries', () => {
    const cases: Array<[string, (c: RouteCarry) => RouteCarry, Partial<RouteAdmission>, number, string]> = [
      ['stale epoch', (c) => c, {}, 1, 'stale_epoch'],
      ['connection', (c) => c, { connectionEpoch: 2 }, 2, 'connection_mismatch'],
      ['dimension', (c) => c, { dimension: 'minecraft:the_nether' }, 2, 'dimension_mismatch'],
      ['anchor (respawn position)', (c) => c, { admissionAnchor: { x: 40.5, y: 64, z: 0.5 } }, 2, 'anchor_mismatch'],
      ['radius', (c) => c, { admissionRadius: 256 }, 2, 'anchor_mismatch'],
      ['goal id', (c) => c, { goalId: 'goal-0002' }, 2, 'goal_mismatch'],
      ['source', (c) => c, { source: 'progression' }, 2, 'source_mismatch'],
      ['tampered distance', (c) => ({ ...c, distance: { ...c.distance, total: 0, clientPhysics: 0 } }), {}, 2, 'unknown_or_stale_carry'],
      ['tampered ceilings', (c) => ({ ...c, ceilings: { ...c.ceilings, routeDeadlineMs: c.ceilings.routeDeadlineMs + 1_000_000 } }), {}, 2, 'unknown_or_stale_carry'],
      ['forged route id', (c) => ({ ...c, routeId: 'route-99' as RouteCarry['routeId'] }), {}, 2, 'unknown_or_stale_carry'],
    ];
    for (const [label, mutate, over, epoch, reason] of cases) {
      const s = setup();
      interruptedRoute(s);
      const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
      const r = s.routes.admitContinuation(mutate(carry), s.admission(epoch, over));
      assert.ok(!r.ok && r.kind === 'refused' && r.reason === reason, `${label}: ${JSON.stringify(r)}`);
      assert.equal(s.routes.legBounds({ goalEpoch: epoch, connectionEpoch: over.connectionEpoch ?? 1, dimension: over.dimension ?? DIM }), undefined, `${label}: no authority`);
    }
  });

  it('a plain admit of the same logical goal id never gets a fresh allowance (continuation only through its carry)', () => {
    const s = setup();
    interruptedRoute(s);
    s.routes.revokeWithCarry('lifecycle_death', 1);
    assert.equal(s.routes.admit(s.admission(2)), undefined);
    assert.ok(s.events.some((e) => e.type === 'route_admission_refused' && e.reason === 'continuation_requires_carry'));
    assert.equal(s.routes.status(2), null);
    assert.ok(s.routes.admit(s.admission(3, { goalId: 'goal-0002' })), 'a genuinely new owner goal gets its own route');
  });

  it('a frozen own-incident destination stays frozen across the continuation (no rebinding to a changed incident)', () => {
    let current: ReturnType<RouteDestinationProvider['current']> = { destinationId: 'mf-0001', dimension: DIM, at: { x: 400, y: 64, z: 0 }, recordedAtMs: 5, label: 'own death location', provenance: 'own_incident' };
    const s = setup({ destinations: ['owner', 'own_death'] }, { kind: 'own_death', current: () => current });
    assert.ok(s.routes.admit(s.admission(1)));
    const v = s.routes.verifyDestination(s.ctx(1), 'own_death');
    assert.ok(v.ok && v.kind === 'own_death');
    if (v.ok && v.kind === 'own_death') assert.ok(s.routes.bindOwnDeath(s.ctx(1), v.identity));
    const carry = s.routes.revokeWithCarry('lifecycle_death', 1)!;
    assert.equal(carry.boundOwnDeath?.destinationId, 'mf-0001');
    assert.ok(s.routes.admitContinuation(carry, s.admission(2)).ok);
    assert.deepEqual(s.routes.frozenOwnDeath(s.ctx(2)), carry.boundOwnDeath);
    current = { ...current!, destinationId: 'mf-0002', at: { x: 10, y: 64, z: 10 }, recordedAtMs: 9 };
    const changed = s.routes.verifyDestination(s.ctx(2), 'own_death');
    assert.ok(!changed.ok && changed.blocker === 'destination_changed');
  });
});
