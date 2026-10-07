// MB-FLOW-003-C5 (offline, real SurvivalService + real atomic store, fault
// injection through the store's beforeRename seam): durable recovery authority.
// The incident, the current attempt and its budget must be in a COMPLETE durable
// survival revision, and the exact memory death fact must be durable, before
// any recovery travel/pickup is authorized. Pending writes are a bounded wait
// (no destination, slot held); failed writes block (no destination) until a
// later write succeeds; capture and lifecycle never wait for disk.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import type { ResolveContext } from '../src/skills/definition.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, fakeMemory, harness, respawnFresh, settle, slot, snapshot, type FakeMemory, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

const KIT = { 36: slot('iron_pickaxe'), 37: slot('bread', 4) };
const FENCE = { goalEpoch: 5, connectionEpoch: 1, dimension: OW };

interface Faults {
  fail: boolean;
  hold: Promise<void> | undefined;
  release?: () => void;
}

function faulty(opts: { root?: string; memory?: FakeMemory; pid?: number } = {}): { h: Harness; f: Faults } {
  const f: Faults = { fail: false, hold: undefined };
  const h = harness({
    ...(opts.root ? { root: opts.root } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    pid: opts.pid ?? 6100,
    beforeRename: async () => {
      if (f.fail) throw new Error('injected rename failure');
      if (f.hold) await f.hold;
    },
  });
  return { h, f };
}

function hold(f: Faults): void {
  f.hold = new Promise((r) => (f.release = r));
}

async function incident(h: Harness): Promise<SurvivalProposal> {
  h.packets.inventory(KIT);
  h.packets.health(20, 20);
  dieWithItems(h, KIT);
  h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
  await settle(h);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  return (d as { proposal: SurvivalProposal }).proposal;
}

const admit = (h: Harness, p: SurvivalProposal) => h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-dur5', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
const targetError = (h: Harness) => {
  const t = h.service.recoveryTarget(FENCE);
  return 'error' in t ? t.error : 'authorized';
};
const goResolve = (h: Harness) =>
  survivalSkills(h.service)
    .find((s) => s.descriptor.id === 'go_to_death_site')!
    .resolve({ snapshot: snapshot({ goalEpoch: 5 }), session: { connectionEpoch: 1, bot: {} }, services: { perception: { withinTravel: () => true } }, hints: { keys: [], handles: [] } } as unknown as ResolveContext);

describe('durable recovery authority (C5)', () => {
  it('held attempt write: no destination, no route, no skill candidate until the revision is complete', async () => {
    const { h, f } = faulty();
    const p = await incident(h);
    hold(f);
    admit(h, p);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.service.durability(), 'pending');
    assert.equal(targetError(h), 'attempt_write_pending');
    assert.equal(h.service.current(FENCE), undefined, 'no route destination while pending');
    assert.equal(goResolve(h).unavailable?.[0]?.reason, 'attempt_write_pending');
    f.release?.();
    f.hold = undefined;
    await settle(h);
    assert.equal(h.service.durability(), 'durable');
    assert.equal(targetError(h), 'authorized', 'successful after commit');
    assert.ok(h.service.current(FENCE));
    assert.equal(goResolve(h).drafts.length, 1);
  });

  it('failed attempt write: authority withdrawn and stays withdrawn; nothing moves', async () => {
    const { h, f } = faulty();
    const p = await incident(h);
    f.fail = true;
    admit(h, p);
    await settle(h);
    assert.equal(h.service.durability(), 'failed');
    assert.equal(targetError(h), 'attempt_write_failed');
    assert.equal(h.service.current(FENCE), undefined);
    assert.ok(h.events.some((e) => e['type'] === 'survival_write_failed'));
    // The in-process attempt counter is NOT reset by the failure.
    assert.equal(h.service.status(h.clock.now()).incidents[0]?.phase, 'traveling');
  });

  it('a later successful write restores authority (bounded retry from assess, never on the lifecycle path)', async () => {
    const { h, f } = faulty();
    const p = await incident(h);
    f.fail = true;
    admit(h, p);
    await settle(h);
    assert.equal(targetError(h), 'attempt_write_failed');
    f.fail = false;
    h.service.assess(assessInput(h, { active: { kind: 'support', goalId: 'goal-dur5', goalEpoch: 5, routine: 'death_recovery' } }));
    await settle(h);
    assert.equal(targetError(h), 'attempt_write_failed', 'no retry before the bounded interval');
    h.clock.advance(31_000);
    h.service.assess(assessInput(h, { active: { kind: 'support', goalId: 'goal-dur5', goalEpoch: 5, routine: 'death_recovery' } }));
    await settle(h);
    assert.equal(h.service.durability(), 'durable');
    assert.equal(targetError(h), 'authorized');
  });

  it('restart after a failed attempt write: the never-durable attempt authorized no action; the durable incident remains', async () => {
    const { h, f } = faulty({ pid: 6101 });
    const p = await incident(h);
    f.fail = true;
    admit(h, p);
    await settle(h);
    assert.equal(targetError(h), 'attempt_write_failed');
    await h.service.close().catch(() => undefined);
    const r = harness({ root: h.root, clock: h.clock, pid: 6102 });
    const inc = r.service.status(r.clock.now()).incidents[0];
    assert.equal(inc?.incidentFactId, 'mf-0001', 'the durable incident and its exact link survived');
    assert.equal(inc?.attempts.used, 0, 'the attempt never reached disk, and no travel/pickup ran under it');
    await r.service.close();
  });

  it('restart after a durable attempt keeps the counted attempt (never reset)', async () => {
    const { h } = faulty({ pid: 6103 });
    const p = await incident(h);
    admit(h, p);
    await settle(h);
    assert.equal(targetError(h), 'authorized');
    await h.service.close();
    const r = harness({ root: h.root, clock: h.clock, pid: 6104 });
    assert.equal(r.service.status(r.clock.now()).incidents[0]?.attempts.used, 1);
    await r.service.close();
  });

  it('stop during the wait cancels; release afterwards authorizes nothing; stale callbacks do nothing', async () => {
    const { h, f } = faulty();
    const p = await incident(h);
    hold(f);
    admit(h, p);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.service.markArrived({ goalId: 'goal-other', goalEpoch: 5, connectionEpoch: 1 }), false);
    assert.equal(h.service.recordRegain({ goalId: 'goal-other', goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:bread', 4, 'act-x'), 0);
    h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: 'goal-dur5', goalEpoch: 5, state: 'cancelled', reason: 'owner_stop', detail: 'stop', counters: { plannerTurns: 0, tasksAdmitted: 0, replans: 0 }, endedAtMs: h.clock.now() });
    f.release?.();
    f.hold = undefined;
    await settle(h);
    assert.equal(targetError(h), 'not_a_recovery_goal');
    assert.equal(h.service.current(FENCE), undefined);
  });

  it('a pending survival write holds the support slot (lower routines do not jump in)', async () => {
    const { h, f } = faulty();
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    hold(f);
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    await new Promise((r) => setTimeout(r, 20));
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'blocked');
    assert.equal((d as { reason: string }).reason, 'durable_write_pending');
    f.release?.();
    f.hold = undefined;
    await settle(h);
    const ok = h.service.assess(assessInput(h));
    assert.equal(ok.kind === 'propose' && ok.proposal.routine, 'death_recovery');
  });

  it('memory fact durability: pending waits, failed blocks, a missing seam blocks, and authority follows it after admission', async () => {
    const mem = fakeMemory();
    const { h } = faulty({ memory: mem });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    await settle(h);
    mem.durability.set('mf-0001', 'pending');
    const waiting = h.service.assess(assessInput(h));
    assert.equal((waiting as { reason?: string }).reason, 'incident_write_pending');
    mem.durability.set('mf-0001', 'failed');
    h.service.assess(assessInput(h));
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.reason === 'incident_write_failed'));
    mem.durability.set('mf-0001', 'durable');
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'propose');
    admit(h, (d as { proposal: SurvivalProposal }).proposal);
    await settle(h);
    assert.equal(targetError(h), 'authorized');
    mem.durability.set('mf-0001', 'pending');
    assert.equal(targetError(h), 'incident_write_pending', 'authority is rechecked at every use');
  });

  it('without the memory durability seam, an in-process fact is not authority', async () => {
    const mem = fakeMemory();
    const noSeam = { factList: mem.factList, updates: mem.updates, durability: mem.durability, facts: mem.facts, updateDeathRecovery: mem.updateDeathRecovery } as unknown as FakeMemory;
    const { h } = faulty({ memory: noSeam });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    await settle(h);
    h.service.assess(assessInput(h));
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.reason === 'incident_durability_unknown'));
  });

  it('death capture and lifecycle never wait for disk (held write)', async () => {
    const { h, f } = faulty();
    hold(f);
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    const t0 = Date.now();
    dieWithItems(h, KIT);
    const ctx = h.service.deathContext();
    assert.ok(ctx.captureId, 'captured synchronously while the store is held');
    assert.ok(Date.now() - t0 < 200);
    f.release?.();
    f.hold = undefined;
    await settle(h);
  });
});
