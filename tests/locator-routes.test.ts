// MB-LOC-001 L3/L6 + C1: code-owned route authorization and leg ceilings.
// Cumulative own movement (out-and-back/detours consume it), fixed deadline,
// net-progress stall detection, monotonic admission (no regrant/reset),
// exact-match leg bounds, destination provenance, revocation.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { RoutePolicySchema, RouteStatusSchema, type RouteAdmission, type RouteDestinationProvider, type RoutePolicy } from '../src/contracts/locator.ts';
import type { GameSession } from '../src/game/connection.ts';
import { RouteController } from '../src/locator/routes.ts';

const CTX = { goalEpoch: 3, connectionEpoch: 1, dimension: 'minecraft:overworld' };

function controller(policy: Partial<RoutePolicy> = {}, ownDeath?: RouteDestinationProvider) {
  const clock = { t: 100_000, now() { return this.t; } };
  const events: Array<Record<string, unknown>> = [];
  const routes = new RouteController({ policy: RoutePolicySchema.parse(policy), clock, record: (e) => events.push(e), ...(ownDeath ? { ownDeath } : {}) });
  return { routes, clock, events };
}

function admission(over: Partial<RouteAdmission> = {}): RouteAdmission {
  return { goalId: 'goal-0003', goalEpoch: 3, admittedAtMs: 100_000, source: 'owner', goalDeadlineMs: 100_000 + 20 * 60_000, connectionEpoch: 1, dimension: 'minecraft:overworld', admissionAnchor: { x: 0.5, y: 64, z: 0.5 }, admissionRadius: 128, ownerCoordinates: [], ...over };
}

describe('MB-LOC-001 route authorization at admission', () => {
  it('grants a frozen authorization from operator policy; the planner-facing context has no coordinates', () => {
    const { routes } = controller();
    const auth = routes.admit(admission())!;
    assert.ok(auth);
    assert.ok(Object.isFrozen(auth) && Object.isFrozen(auth.ceilings) && Object.isFrozen(auth.admissionAnchor));
    assert.throws(() => {
      (auth.ceilings as { maxLegs: number }).maxLegs = 99;
    });
    assert.equal(auth.ceilings.routeDeadlineMs, 100_000 + 15 * 60_000, 'deadline fixed at admission: min(admission + maxRouteMs, goal deadline)');
    assert.deepEqual(routes.proposalContext(CTX), { authorized: true, destinations: ['owner', 'owner_destination'], ownDeathAvailable: false, state: 'authorized' });
  });

  it('disabled policy or a source outside policy grants nothing', () => {
    assert.equal(controller({ enabled: false }).routes.admit(admission()), undefined);
    assert.equal(controller().routes.admit(admission({ source: 'progression' })), undefined);
    assert.ok(controller({ sources: ['owner', 'progression'] }).routes.admit(admission({ source: 'progression' })));
  });

  it('an epoch is admitted once: a repeated/older epoch (callback, reconnect, re-hook) cannot regrant or reset a route', () => {
    const { routes, events } = controller();
    routes.admit(admission());
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 }).ok, true);
    assert.equal(routes.admit(admission()), undefined, 'same epoch refused');
    assert.equal(routes.admit(admission({ goalEpoch: 2 })), undefined, 'older epoch refused');
    assert.equal(routes.status(3)?.legsUsed, 1, 'usage unchanged');
    assert.ok(events.some((e) => e['type'] === 'route_admission_refused'));
    // a NEW admission (replacement goal) revokes the old route; it never comes back
    assert.ok(routes.admit(admission({ goalId: 'goal-0004', goalEpoch: 4 })));
    assert.equal(routes.legBounds(CTX), undefined);
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 0, y: 64, z: 0 }, destination: 'owner' }).ok, false);
  });
});

describe('MB-LOC-001 leg ceilings (C1)', () => {
  it('cumulative own movement counts out-and-back and detours; net displacement does not hide it', () => {
    const { routes } = controller({ maxTotalDistance: 200 });
    routes.admit(admission());
    const leg = routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    assert.equal(leg.ok, true);
    // walk 60 east, then 60 back west: net 0, path 120
    for (let x = 121; x <= 180; x += 1) routes.sample(CTX, { x, y: 64, z: 0 });
    for (let x = 179; x >= 120; x -= 1) routes.sample(CTX, { x, y: 64, z: 0 });
    let st = routes.status(3)!;
    assert.equal(st.distanceUsed, 120);
    assert.equal(st.distanceSources.clientPhysics, 120);
    // detour north and back: 2 x 40
    for (let z = -1; z >= -40; z -= 1) routes.sample(CTX, { x: 120, y: 64, z });
    for (let z = -39; z <= 0; z += 1) routes.sample(CTX, { x: 120, y: 64, z });
    st = routes.status(3)!;
    assert.equal(st.state, 'exhausted');
    assert.equal(st.blocker?.reason, 'distance_limit');
    assert.equal(routes.budget(CTX).ok, false);
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 }).ok, false);
    RouteStatusSchema.parse(st);
  });

  it('server position corrections count and are labelled', () => {
    const { routes } = controller();
    routes.admit(admission());
    routes.beginLeg({ ...CTX, at: { x: 100, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    routes.sample(CTX, { x: 110, y: 64, z: 0 });
    routes.sample(CTX, { x: 104, y: 64, z: 0 }, 'server_correction');
    const st = routes.status(3)!;
    assert.deepEqual(st.distanceSources, { clientPhysics: 10, serverCorrections: 6, correctionCount: 1 });
    assert.equal(st.distanceUsed, 16);
  });

  it('movement before the first leg (inside the admission radius) is not route distance', () => {
    const { routes } = controller();
    routes.admit(admission());
    routes.sample(CTX, { x: 50, y: 64, z: 0 });
    routes.sample(CTX, { x: 100, y: 64, z: 0 });
    assert.equal(routes.status(3)!.distanceUsed, 0);
  });

  it('leg limit and time limit; the deadline is never restarted by a leg', () => {
    const { routes, clock } = controller({ maxLegs: 2, maxRouteMs: 60_000 });
    routes.admit(admission());
    clock.t += 50_000;
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 }).ok, true);
    assert.equal(routes.status(3)!.remainingMs, 10_000, 'measured from admission, not from the first leg');
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 200, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 }).ok, true);
    const third = routes.beginLeg({ ...CTX, at: { x: 280, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.blocker, 'leg_limit');
    const t = controller({ maxRouteMs: 60_000 });
    t.routes.admit(admission());
    t.clock.t += 61_000;
    const late = t.routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.blocker, 'time_limit');
  });

  it('stall detection uses NET progress toward the destination (moving sideways is a stalled leg)', () => {
    const { routes } = controller({ maxStalledLegs: 2, minLegProgress: 8 });
    routes.admit(admission());
    routes.beginLeg({ ...CTX, at: { x: 0, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 }); // east
    routes.sample(CTX, { x: 2, y: 64, z: 60 }); // mostly south: 2 blocks east
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 2, y: 64, z: 60 }, destination: 'owner', bearingRad: 0 }).ok, true);
    routes.sample(CTX, { x: 3, y: 64, z: 0 });
    const r = routes.beginLeg({ ...CTX, at: { x: 3, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.blocker, 'stalled');
    assert.equal(routes.status(3)!.state, 'blocked');
    assert.ok(routes.status(3)!.distanceUsed >= 120, 'the sideways movement still consumed route distance');
  });
});

describe('MB-LOC-001 exact-match scope and revocation (L6)', () => {
  it('leg bounds only for the exact goal epoch, connection and dimension; they carry the unchanged admission anchor', () => {
    const { routes } = controller();
    routes.admit(admission());
    routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    const leg = routes.legBounds(CTX)!;
    assert.deepEqual(leg.admissionAnchor, { x: 0.5, y: 64, z: 0.5 });
    assert.deepEqual(leg.anchor, { x: 120, y: 64, z: 0 });
    assert.equal(routes.legBounds({ ...CTX, goalEpoch: 4 }), undefined);
    assert.equal(routes.legBounds({ ...CTX, connectionEpoch: 2 }), undefined);
    assert.equal(routes.legBounds({ ...CTX, dimension: 'minecraft:the_nether' }), undefined);
    const anchor = { goalEpoch: 3 as number | undefined, connectionEpoch: 1, dimension: 'minecraft:overworld', at: { x: 0.5, y: 64, z: 0.5 } };
    assert.equal(RouteController.applies(leg, anchor), true);
    assert.equal(RouteController.applies(leg, { ...anchor, at: { x: 1.5, y: 64, z: 0.5 } }), false, 'a different admission anchor never adopts the leg');
    assert.equal(RouteController.applies(leg, { ...anchor, goalEpoch: undefined }), false, 'a diagnostic anchor never adopts a leg');
  });

  it('revocation (stop/replacement/lifecycle) is terminal: no bounds, no legs, no samples, no regrant', () => {
    const { routes } = controller();
    routes.admit(admission());
    routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    routes.revoke('lifecycle_dimension_change');
    assert.equal(routes.legBounds(CTX), undefined);
    assert.equal(routes.beginLeg({ ...CTX, at: { x: 120, y: 64, z: 0 }, destination: 'owner' }).ok, false);
    routes.sample(CTX, { x: 500, y: 64, z: 0 });
    assert.equal(routes.status(3)!.state, 'revoked');
    assert.equal(routes.status(3)!.distanceUsed, 0);
    assert.equal(routes.admit(admission()), undefined);
  });

  it('attachMovement samples bot moves and server corrections of the session; detach stops it', () => {
    const { routes } = controller();
    routes.admit(admission());
    routes.beginLeg({ ...CTX, at: { x: 100, y: 64, z: 0 }, destination: 'owner', bearingRad: 0 });
    const bot = Object.assign(new EventEmitter(), { entity: { position: { x: 100, y: 64, z: 0 } }, game: { dimension: 'minecraft:overworld' } });
    const records = new Set<(e: { kind: string; x?: number; y?: number; z?: number }) => void>();
    const session = { bot, connectionEpoch: 1, evidence: { onRecord: (l: never) => (records.add(l), () => records.delete(l)) } } as unknown as GameSession;
    const detach = routes.attachMovement(session, () => 3);
    bot.entity.position = { x: 105, y: 64, z: 0 };
    bot.emit('move');
    for (const l of records) l({ kind: 'position_correction', x: 103, y: 64, z: 0 });
    detach();
    bot.entity.position = { x: 150, y: 64, z: 0 };
    bot.emit('move');
    assert.deepEqual(routes.status(3)!.distanceSources, { clientPhysics: 5, serverCorrections: 2, correctionCount: 1 });
  });
});

describe('MB-LOC-001 destination provenance', () => {
  it('owner_destination only for coordinates the owner typed for THIS goal (admission or correlated answer)', () => {
    const { routes } = controller();
    routes.admit(admission({ ownerCoordinates: [{ x: 500, y: 70, z: -20, source: 'instruction' }] }));
    assert.equal(routes.verifyDestination(CTX, 'owner_destination', { x: 500.5, y: 70, z: -20 }, CTX.dimension).ok, true);
    const invented = routes.verifyDestination(CTX, 'owner_destination', { x: 900, y: 70, z: 0 }, CTX.dimension);
    assert.equal(invented.ok, false);
    if (!invented.ok) assert.equal(invented.blocker, 'destination_unverified');
    routes.noteOwnerCoordinates(3, [{ x: 900, y: 70, z: 0, source: 'answer' }]);
    assert.equal(routes.verifyDestination(CTX, 'owner_destination', { x: 900, y: 70, z: 0 }, CTX.dimension).ok, true);
    routes.noteOwnerCoordinates(2, [{ x: 1, y: 70, z: 1, source: 'answer' }]);
    assert.equal(routes.verifyDestination(CTX, 'owner_destination', { x: 1, y: 70, z: 1 }, CTX.dimension).ok, false, 'another epoch cannot add coordinates');
    assert.equal(routes.verifyDestination(CTX, 'owner_destination', { x: 500, y: 70, z: -20 }, 'minecraft:the_nether').ok, false);
  });

  it('own_death only when authorized, from the provider (own incident), and bound to the first destination id', () => {
    let current: ReturnType<RouteDestinationProvider['current']> = { destinationId: 'death-1', dimension: 'minecraft:overworld', at: { x: 300, y: 60, z: 0 }, recordedAtMs: 1, label: 'own death location', provenance: 'own_incident' };
    const provider: RouteDestinationProvider = { kind: 'own_death', current: () => current };
    const unauth = controller({}, provider);
    unauth.routes.admit(admission());
    const r0 = unauth.routes.verifyDestination(CTX, 'own_death');
    assert.equal(r0.ok, false);
    if (!r0.ok) assert.equal(r0.blocker, 'destination_not_authorized');
    const { routes } = controller({ destinations: ['owner', 'own_death'] }, provider);
    routes.admit(admission());
    assert.equal(routes.proposalContext(CTX).ownDeathAvailable, true);
    const ok = routes.verifyDestination(CTX, 'own_death');
    assert.equal(ok.ok, true);
    if (ok.ok && ok.kind === 'own_death') assert.equal(routes.bindOwnDeath(CTX, ok.destinationId), true);
    current = { ...current!, destinationId: 'death-2', at: { x: -300, y: 60, z: 0 } };
    const changed = routes.verifyDestination(CTX, 'own_death');
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.blocker, 'destination_changed');
    current = undefined;
    assert.equal(routes.verifyDestination(CTX, 'own_death').ok, false);
  });
});
