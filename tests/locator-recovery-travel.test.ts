// L consumer controls over the production RouteController/runner; no fixture or inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoutePolicySchema, type RouteDestinationProvider } from '../src/contracts/locator.ts';
import { RouteController } from '../src/locator/routes.ts';
import { routeTravelSkill, seekOwnerSkill, type LocatorSkillDeps } from '../src/skills/locator.ts';
import type { ExecuteContext } from '../src/skills/definition.ts';

const scope = { goalEpoch: 5, connectionEpoch: 1, dimension: 'overworld' };
function scene() {
  let time = 1_000;
  const at = { x: 0.5, y: 0, z: 0.5 }, site = { x: 8.5, y: 0, z: 0.5 };
  const incident = { destinationId: 'incident-l001', dimension: 'overworld', at: site, recordedAtMs: 500, provenance: 'own_incident' as const, label: 'own death' };
  const provider: RouteDestinationProvider = { kind: 'own_death', current: () => incident };
  const routes = new RouteController({ policy: RoutePolicySchema.parse({ sources: ['owner', 'support'], destinations: ['owner', 'owner_destination', 'own_death'] }), clock: { now: () => time }, ownDeath: provider });
  routes.admit({ goalId: 'goal-l001', ...scope, admittedAtMs: time, source: 'support', goalDeadlineMs: 100_000, admissionAnchor: at, admissionRadius: 128, ownerCoordinates: [{ x: 8.5, y: 0, z: 0.5, source: 'instruction' }] });
  const bot = { game: { dimension: 'overworld' }, entity: { position: { ...at } }, entities: {} };
  const ctx = { session: { bot, connectionEpoch: 1 }, act: { fence: () => undefined, sleep: async () => { time++; } }, candidate: { goalEpoch: 5 }, owner: { kind: 'goal', goalId: 'goal-l001', goalEpoch: 5, taskId: 'task-l001' }, progress: () => undefined,
    services: { clock: { now: () => time }, limits: { observationRadius: 32, ownerLossMs: 1_000 }, perception: { admissionBounds: () => ({ ...scope, anchor: at, radius: 128 }), world: () => ({ blockAt: () => ({}) }), recordVisited: () => undefined } } } as unknown as ExecuteContext;
  return { routes, ctx, bot, site, incident, advance: (ms: number) => { time += ms; } };
}
const params = { destination: 'own_death' as const, within: 3, durationMs: 5_000 };
const navigation = { status: 'arrived' as const, finalDistance: 0, elapsedMs: 10, pathUpdates: 1, corrections: 0 };
const pickup = { counted: 0, byKey: {}, incidental: [] as string[], nonItem: [] as string[] };

describe('L typed own-death route consumer milestone', () => {
  it('refuses without callback before movement or incident binding', async () => {
    const s = scene();
    const r = await routeTravelSkill({ routes: s.routes }).execute(s.ctx, params);
    assert.equal(r.status, 'precondition_failed'); assert.equal(r.reason, 'recovery_travel_not_installed');
    assert.equal(s.routes.frozenOwnDeath(scope), null); assert.equal(s.routes.status(5)?.legsUsed, 0);
  });
  it('forwards the same context/actuator and unchanged single leg options only after exact binding', async () => {
    const s = scene(), before = s.routes.authorization(scope);
    let calls = 0;
    const recoveryTravel: LocatorSkillDeps['recoveryTravel'] = async (ctx, options) => {
      calls++; assert.equal(ctx, s.ctx); assert.equal(ctx.act, s.ctx.act);
      assert.deepEqual(s.routes.frozenOwnDeath(scope), { destinationId: s.incident.destinationId, dimension: 'overworld', at: s.site, recordedAtMs: 500 });
      assert.deepEqual(options.bounds, { anchor: { x: 0.5, y: 0, z: 0.5 }, radius: 128 });
      assert.equal(options.timeoutMs, 5_000); assert.equal(options.searchRadius, 32);
      assert.equal(options.abortIf?.(), undefined); assert.equal(options.retarget, undefined); assert.equal(options.inBounds, undefined);
      assert.equal(options.arrived(), false); assert.equal(options.distance(), 8);
      s.bot.entity.position = { ...s.site }; assert.equal(options.arrived(), true);
      return { navigation, pickup: { ...pickup, counted: 2, byKey: { 'minecraft:bread': 2 }, nonItem: ['entity 99 x1'] } };
    };
    const r = await routeTravelSkill({ routes: s.routes, recoveryTravel }).execute(s.ctx, params);
    assert.equal(r.status, 'succeeded'); assert.equal(r.confirmation, 'server_packet'); assert.equal(calls, 1);
    assert.deepEqual((r.evidence?.recoveryTravel as any)[0].pickup, { ...pickup, counted: 2, byKey: { 'minecraft:bread': 2 }, nonItem: ['entity 99 x1'] });
    assert.equal(s.routes.authorization(scope), before); assert.equal(before?.ceilings.routeDeadlineMs, 100_000);
  });
  for (const mode of ['error', 'veto', 'throw'] as const) it(`propagates ${mode} once with structured failure and settled effects`, async () => {
    const s = scene(); let calls = 0;
    const recoveryTravel: LocatorSkillDeps['recoveryTravel'] = async () => {
      calls++;
      if (mode === 'error') return { error: 'not_a_recovery_goal', detail: 'service refuses ownership' };
      if (mode === 'throw') throw new Error('settlement unavailable');
      return { navigation: { ...navigation, status: 'stuck', aborted: 'unrelated_loot_nearby' }, pickup: { ...pickup, incidental: ['minecraft:dirt x1'] }, veto: 'unrelated_loot_nearby' };
    };
    const r = await routeTravelSkill({ routes: s.routes, recoveryTravel }).execute(s.ctx, params);
    assert.equal(r.status, 'failed'); assert.equal(calls, 1);
    assert.equal(r.reason, mode === 'error' ? 'not_a_recovery_goal' : mode === 'throw' ? 'recovery_travel_error' : 'unrelated_loot_nearby');
    if (mode === 'veto') { assert.equal(r.confirmation, 'server_packet'); assert.deepEqual((r.evidence?.recoveryTravel as any)[0].pickup.incidental, ['minecraft:dirt x1']); }
    else assert.equal(r.confirmation, 'none');
  });
  it('changed exact identity, wrong goal, stale epoch, stale connection and revoked route cannot call the callback', async () => {
    for (const mode of ['identity', 'goal', 'epoch', 'connection', 'revoked'] as const) {
      const s = scene(); let calls = 0;
      if (mode === 'identity') { s.routes.bindOwnDeath(scope, { ...s.incident }); s.incident.recordedAtMs++; }
      if (mode === 'goal') (s.ctx.owner as any).goalId = 'goal-other';
      if (mode === 'epoch') (s.ctx.owner as any).goalEpoch++;
      if (mode === 'connection') (s.ctx.session as unknown as { connectionEpoch: number }).connectionEpoch++;
      if (mode === 'revoked') s.routes.revoke('owner_stop');
      const r = await routeTravelSkill({ routes: s.routes, recoveryTravel: async () => { calls++; return { navigation, pickup }; } }).execute(s.ctx, params);
      assert.equal(r.status, 'precondition_failed', mode); assert.equal(calls, 0, mode);
    }
  });
  it('ordinary owner destination arrival does not call recovery even when installed', async () => {
    const s = scene(); s.bot.entity.position = { ...s.site }; let calls = 0;
    const recoveryTravel: LocatorSkillDeps['recoveryTravel'] = async () => { calls++; return { navigation, pickup }; };
    const r = await routeTravelSkill({ routes: s.routes, recoveryTravel }).execute(s.ctx, { target: { kind: 'destination', dimension: 'overworld', ...s.site }, within: 3, durationMs: 5_000 });
    assert.equal(r.status, 'succeeded'); assert.equal(r.confirmation, 'client_only'); assert.equal(calls, 0);
    assert.equal(s.routes.frozenOwnDeath(scope), null);
  });
  it('ordinary visible-owner arrival does not call recovery even when installed', async () => {
    const s = scene(); let calls = 0;
    s.bot.entities = { owner: { id: 99, position: { x: 2.5, y: 0, z: 0.5 } } } as never;
    Object.assign(s.ctx.services.perception, { isOwnerEntity: () => true, entityVisibleNow: () => true });
    const r = await seekOwnerSkill({ routes: s.routes, recoveryTravel: async () => { calls++; return { navigation, pickup }; } }).execute(s.ctx, { within: 3, durationMs: 5_000 });
    assert.equal(r.status, 'succeeded'); assert.equal(calls, 0);
  });
});
