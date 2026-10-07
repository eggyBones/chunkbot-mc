// MB-FLOW-003-C2 (offline): conservative per-dispatch allowance accounting.
// Every dispatch (Jev or sustained local continuation) reserves BEFORE it runs,
// so the last allowed action leaves zero, a further local window is refused,
// an abort/exception without an outcome still consumed its action, no action
// is counted twice, expiry is fixed, a stale owner holds nothing and there is
// no renewal. Also: the canonical own-death RouteDestinationProvider returns
// `own_incident` provenance only for the frozen, exactly linked incident.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AllowanceTaskRef, RecoveryEpisode, SurvivalProposal } from '../src/contracts/survival.ts';
import type { RouteDestinationProvider } from '../src/contracts/locator.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, slot, snapshot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

function lowHealthEat(h: Harness, goalEpoch = 7) {
  h.packets.inventory({ 36: slot('bread', 3) });
  h.packets.health(6, 10);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose');
  const p = (d as { proposal: SurvivalProposal }).proposal;
  const goalId = `goal-c2${goalEpoch}aa`;
  const grant = h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId, goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  assert.ok(grant);
  const task: AllowanceTaskRef = { goalId, goalEpoch, taskId: 'task-c2', connectionEpoch: 1, allowedCapabilities: ['eat_safe_food'] };
  const snap = snapshot({ goalEpoch });
  const c = h.service.check(task, snap);
  assert.equal(c.allowed, true);
  return { p, grant, task, snap, id: (c as { allowanceId: string }).allowanceId };
}

const eat = (n: number) => ({ id: `act-c2-${n}`, capability: 'eat_safe_food', parameters: { item: 'minecraft:bread' } });

describe('low-health allowance accounting (C2)', () => {
  it('the last allowed dispatch leaves zero; a further (local) window is refused', () => {
    const h = harness();
    const a = lowHealthEat(h);
    assert.equal(a.grant.maxActions, 4);
    for (let i = 1; i <= 4; i += 1) {
      const r = h.service.reserve(a.id, a.task, eat(i), a.snap);
      assert.equal(r.allowed, true, `dispatch ${i}`);
      assert.equal((r as { remainingActions?: number }).remainingActions, 4 - i);
    }
    const further = h.service.reserve(a.id, a.task, eat(5), a.snap);
    assert.equal(further.allowed, false);
    assert.equal((further as { reason: string }).reason, 'allowance_exhausted');
    assert.equal(h.service.check(a.task, a.snap).allowed, false, 'the guard also refuses the next round');
  });

  it('an aborted/thrown dispatch without any outcome still consumed its action', () => {
    const h = harness();
    const a = lowHealthEat(h);
    h.service.reserve(a.id, a.task, eat(1), a.snap); // dispatch aborted: no consumed() call ever arrives
    h.service.reserve(a.id, a.task, eat(2), a.snap); // dispatch threw
    const r = h.service.reserve(a.id, a.task, eat(3), a.snap);
    assert.equal((r as { remainingActions?: number }).remainingActions, 1);
  });

  it('a reserved action is never counted twice; an unreserved dispatch is counted conservatively', () => {
    const h = harness();
    const a = lowHealthEat(h);
    h.service.reserve(a.id, a.task, eat(1), a.snap);
    h.service.consumed(a.id, { actionId: 'act-c2-1', capability: 'eat_safe_food', status: 'succeeded' });
    assert.equal((h.service.reserve(a.id, a.task, eat(1), a.snap) as { reason?: string }).reason, 'already_reserved', 'the same action id cannot be dispatched twice');
    // A dispatch the runtime forgot to reserve (e.g. the C2 local branch) is still counted once.
    h.service.consumed(a.id, { actionId: 'act-local-9', capability: 'eat_safe_food', status: 'succeeded' });
    h.service.consumed(a.id, { actionId: 'act-local-9', capability: 'eat_safe_food', status: 'succeeded' });
    const r = h.service.reserve(a.id, a.task, eat(2), a.snap);
    assert.equal((r as { remainingActions?: number }).remainingActions, 1, '1 reserved + 1 unreserved + this one = 3 of 4');
  });

  it('expiry is fixed: a later dispatch is refused even with actions left', () => {
    const h = harness();
    const a = lowHealthEat(h);
    assert.equal(h.service.reserve(a.id, a.task, eat(1), a.snap).allowed, true);
    h.clock.advance(a.grant.expiresAtMs - h.clock.now());
    const r = h.service.reserve(a.id, a.task, eat(2), a.snap);
    assert.equal((r as { reason?: string }).reason, 'allowance_expired');
  });

  it('a stale owner holds nothing: ended goal, other epoch, other task, other connection', () => {
    const h = harness();
    const a = lowHealthEat(h);
    assert.equal(h.service.reserve(a.id, { ...a.task, goalEpoch: 8 }, eat(1), snapshot({ goalEpoch: 8 })).allowed, false);
    assert.equal(h.service.reserve(a.id, { ...a.task, taskId: 'task-other' }, eat(1), a.snap).allowed, false);
    assert.equal(h.service.reserve(a.id, { ...a.task, connectionEpoch: 2 }, eat(1), a.snap).allowed, false);
    h.service.onSupportTerminal({ proposalId: a.p.proposalId, goalId: a.task.goalId, goalEpoch: a.task.goalEpoch, state: 'cancelled', reason: 'owner_stop', detail: 'stop', counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: h.clock.now() });
    const r = h.service.reserve(a.id, a.task, eat(1), a.snap);
    assert.equal(r.allowed, false);
    assert.equal((r as { reason: string }).reason, 'not_support_goal');
  });

  it('no renewal: a replayed admission gets no new grant and the exhausted count never resets', () => {
    const h = harness();
    const a = lowHealthEat(h);
    for (let i = 1; i <= 4; i += 1) h.service.reserve(a.id, a.task, eat(i), a.snap);
    assert.equal(h.service.onSupportAdmitted({ proposalId: a.p.proposalId, goalId: a.task.goalId, goalEpoch: a.task.goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() }), undefined);
    assert.equal(h.service.check(a.task, a.snap).allowed, false);
  });

  it('death revokes the grant before any further dispatch', () => {
    const h = harness();
    const a = lowHealthEat(h);
    h.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
    assert.equal(h.service.reserve(a.id, a.task, eat(1), a.snap).allowed, false);
  });
});

describe('own-death destination (canonical RouteDestinationProvider)', () => {
  function bound(): { h: Harness; goalEpoch: number } {
    const h = harness();
    const kit = { 36: slot('iron_pickaxe'), 37: slot('bread', 4) };
    h.packets.inventory(kit);
    h.packets.health(20, 20);
    dieWithItems(h, kit);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    const d = h.service.assess(assessInput(h));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-dest5', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    return { h, goalEpoch: 5 };
  }

  it('returns own_incident provenance and an id encoding the whole incident identity', () => {
    const { h } = bound();
    const provider: RouteDestinationProvider = h.service;
    const dest = provider.current({ connectionEpoch: 1, dimension: OW, goalEpoch: 5 });
    assert.ok(dest);
    assert.equal(dest.provenance, 'own_incident');
    assert.match(dest.destinationId, /^own_death:rep-[a-z0-9]+:mf-0001:minecraft:overworld:30\.5,64,10\.5:server_death_location$/);
    assert.match(dest.label, /server_death_location/);
    assert.equal(provider.current({ connectionEpoch: 1, dimension: OW, goalEpoch: 6 }), undefined);
    assert.equal(provider.current({ connectionEpoch: 2, dimension: OW, goalEpoch: 5 }), undefined);
  });

  it('a changed coordinate after admission is refused (never a stale or substituted target)', () => {
    const { h } = bound();
    const book = (h.service as unknown as { book: { open(): RecoveryEpisode } }).book;
    const e = book.open();
    (e.site.at as { x: number }).x += 5;
    assert.equal(h.service.current({ connectionEpoch: 1, dimension: OW, goalEpoch: 5 }), undefined);
    const t = h.service.recoveryTarget({ goalEpoch: 5, connectionEpoch: 1, dimension: OW });
    assert.ok('error' in t && t.error === 'destination_changed');
  });

  it('an unlinked incident is never a destination', () => {
    const h = harness();
    const kit = { 36: slot('bread', 4) };
    h.packets.inventory(kit);
    h.packets.health(20, 20);
    dieWithItems(h, kit);
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    assert.equal(h.service.current({ connectionEpoch: 1, dimension: OW, goalEpoch: 5 }), undefined);
  });
});
