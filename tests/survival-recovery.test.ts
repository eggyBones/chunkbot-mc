// MB-FLOW-003 R1-R5, R9-R10 (offline, inference-free): incident capture and
// EXACT memory linkage, fresh loss assessment, bounded recovery proposals,
// fenced regains, recovered vs concluded predicates, attempt/budget/hazard
// limits across deaths and restarts, stale callbacks, interrupted owner intent.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { OW, NETHER, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot, snapshot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

const SITE = { dimensionName: OW, location: { x: 30, y: 64, z: 10 } };
const KIT = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 10 }]), 37: slot('bread', 4), 9: slot('cobblestone', 20) };

async function deathAndRespawn(h: Harness, opts: { link?: boolean; translate?: string; respawnInv?: Record<number, ReturnType<typeof slot>>; site?: typeof SITE } = {}): Promise<string | undefined> {
  h.packets.inventory(KIT);
  h.packets.health(20, 20);
  dieWithItems(h, KIT, opts.translate ?? 'death.attack.mob');
  const ctx = h.service.deathContext();
  if (opts.link !== false && ctx.captureId) h.service.linkIncident(ctx.captureId, 'mf-0001');
  respawnFresh(h, opts.respawnInv ?? {}, opts.site ?? SITE);
  await settle(h);
  return ctx.captureId;
}

function propose(h: Harness, over: Parameters<typeof assessInput>[1] = {}): SurvivalProposal {
  const d = h.service.assess(assessInput(h, over));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  return (d as { proposal: SurvivalProposal }).proposal;
}

async function admit(h: Harness, p: SurvivalProposal, goalEpoch = 5, goalId = `goal-r${goalEpoch}xx`) {
  const grant = h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId, goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  await settle(h);
  return { goalId, goalEpoch, grant };
}

async function end(h: Harness, a: { goalId: string; goalEpoch: number }, p: SurvivalProposal, reason: string, counters = { plannerTurns: 2, tasksAdmitted: 3, replans: 0 }) {
  await settle(h);
  h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: a.goalId, goalEpoch: a.goalEpoch, state: reason === 'outcome_verified' ? 'completed' : 'blocked', reason, detail: reason, counters, endedAtMs: h.clock.now() });
  await settle(h);
}

describe('survival death recovery', () => {
  it('captures, links EXACTLY by capture id, assesses losses and proposes a bounded recovery', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const s = h.service.status(h.clock.now());
    const inc = s.incidents[0];
    assert.ok(inc);
    assert.equal(inc.incidentFactId, 'mf-0001');
    assert.equal(inc.site.source, 'server_death_location');
    assert.deepEqual(inc.missing.map((m) => m.key).sort(), ['minecraft:bread', 'minecraft:cobblestone', 'minecraft:iron_pickaxe']);
    const p = propose(h);
    assert.equal(p.routine, 'death_recovery');
    assert.equal(p.execution.kind, 'planner_goal');
    assert.ok(p.ceilings.plannerTurns <= 12 && p.ceilings.plannerTurns <= 20);
    if (p.execution.kind === 'planner_goal') {
      assert.ok(p.execution.context.rules.some((r) => /never sweep/.test(r)));
      assert.ok(JSON.stringify(p.execution.context).length <= 2_000);
    }
  });

  it('an unknown capture id or a missing link is an honest blocker (no time matching)', async () => {
    const h = harness();
    await deathAndRespawn(h, { link: false });
    h.service.linkIncident('dcap-999-999', 'mf-0002');
    const d = h.service.assess(assessInput(h));
    // death_recovery is blocked; another routine (resupply of food) may be proposed after it
    const s = h.service.status(h.clock.now());
    assert.equal(s.incidents[0]?.incidentFactId, undefined);
    assert.ok(s.blocked.some((b) => b.routine === 'death_recovery' && b.reason === 'incident_not_linked'));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'death_recovery');
    assert.ok(h.events.some((e) => e['type'] === 'survival_link_refused' && e['reason'] === 'unknown_capture'));
  });

  it('retained inventory (keepInventory) causes no trip', async () => {
    const h = harness();
    await deathAndRespawn(h, { respawnInv: KIT });
    const s = h.service.status(h.clock.now());
    assert.equal(s.incidents[0]?.status, 'no_loss');
    const d = h.service.assess(assessInput(h));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'death_recovery');
  });

  it('lava and void deaths are never known_destroyed by cause alone', async () => {
    for (const [key, reason] of [['death.attack.lava', 'site_fatal_hazard'], ['death.attack.outOfWorld', 'likely_destroyed_void']] as const) {
      const h = harness();
      await deathAndRespawn(h, { translate: key });
      const inc = h.service.status(h.clock.now()).incidents[0];
      assert.equal(inc?.status, 'blocked');
      assert.equal(inc?.blocker?.reason, reason);
      assert.ok(inc?.missing.every((m) => m.state === 'likely_destroyed'));
    }
  });

  it('unscoped durable state blocks recovery but not eating; cross-dimension and far sites block honestly', async () => {
    const u = harness({ scoped: false });
    await deathAndRespawn(u);
    const du = u.service.assess(assessInput(u));
    assert.ok(du.kind !== 'propose' || du.proposal.routine !== 'death_recovery');
    assert.equal(u.service.status(u.clock.now()).store.state, 'unscoped');

    const far = harness();
    await deathAndRespawn(far, { site: { dimensionName: OW, location: { x: 400, y: 64, z: 0 } } });
    far.service.assess(assessInput(far));
    assert.ok(far.service.status(far.clock.now()).blocked.some((b) => b.reason === 'outside_travel_bounds'));

    const nether = harness();
    await deathAndRespawn(nether, { site: { dimensionName: NETHER, location: { x: 3, y: 40, z: 3 } } });
    nether.service.assess(assessInput(nether));
    assert.ok(nether.service.status(nether.clock.now()).blocked.some((b) => b.reason === 'cross_dimension'));
  });

  it('far site proceeds only when code-owned routing is integrated', async () => {
    const h = harness({ farRoute: () => 'locator_route_v1' });
    await deathAndRespawn(h, { site: { dimensionName: OW, location: { x: 400, y: 64, z: 0 } } });
    assert.equal(propose(h).routine, 'death_recovery');
  });

  it('fences destinations and regains to the bound goal; recovered differs from concluded', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p = propose(h);
    const a = await admit(h, p);
    // Wrong goal epoch / connection / dimension: no destination.
    assert.ok('error' in h.service.recoveryTarget({ goalEpoch: 4, connectionEpoch: 1, dimension: OW }));
    assert.ok('error' in h.service.recoveryTarget({ goalEpoch: 5, connectionEpoch: 2, dimension: OW }));
    assert.ok('error' in h.service.recoveryTarget({ goalEpoch: 5, connectionEpoch: 1, dimension: NETHER }));
    const t = h.service.recoveryTarget({ goalEpoch: 5, connectionEpoch: 1, dimension: OW });
    assert.ok(!('error' in t));
    assert.equal(h.service.current({ goalEpoch: 5, connectionEpoch: 1, dimension: OW })?.destinationId.startsWith('own_death:'), true);
    assert.equal(h.service.current({ goalEpoch: 6, connectionEpoch: 1, dimension: OW }), undefined);
    // Stale fence counts nothing.
    assert.equal(h.service.recordRegain({ goalId: 'goal-other', goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:iron_pickaxe', 1, 'act-1'), 0);
    // Regain is capped at the missing amount; unrelated keys are not counted.
    assert.equal(h.service.recordRegain({ goalId: a.goalId, goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:cobblestone', 64, 'act-2'), 20);
    assert.equal(h.service.recordRegain({ goalId: a.goalId, goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:dirt', 3, 'act-3'), 0);
    const owner = { goalId: a.goalId, goalEpoch: 5 };
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, owner).status, 'unsatisfied');
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }, owner).status, 'unsatisfied');
    // Arrive and search: a still-sought drop near the site keeps it unconcluded.
    h.service.markArrived({ goalId: a.goalId, goalEpoch: 5, connectionEpoch: 1 });
    h.clock.advance(1_000);
    const near = { x: 30.5, y: 64, z: 11 };
    h.snap.value = snapshot({ goalEpoch: 5, takenAtMs: h.clock.now(), at: near, drops: [{ handle: 'drp-1', key: 'minecraft:bread', at: { x: 31, y: 64, z: 12 }, distance: 1, label: 'x4' }] });
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }, owner).status, 'unsatisfied');
    // Nothing scoped visible anymore: concluded, but NOT recovered.
    h.snap.value = snapshot({ goalEpoch: 5, takenAtMs: h.clock.now(), at: near, drops: [{ handle: 'drp-2', key: 'minecraft:dirt', at: { x: 31, y: 64, z: 12 }, distance: 1 }] });
    const c = h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }, owner);
    assert.equal(c.status, 'satisfied');
    assert.match(c.detail, /NOT a full recovery/);
    assert.equal(c.evidence['recoveryStatus'], 'partially_recovered');
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, owner).status, 'unsatisfied');
    await end(h, a, p, 'outcome_verified');
    const inc = h.service.status(h.clock.now()).incidents[0];
    assert.equal(inc?.status, 'partially_recovered');
    assert.equal(inc?.blocker?.reason, 'not_found_in_bounded_search');
    await h.service.flush();
    assert.ok(h.memory.updates.some((u) => u.factId === 'mf-0001'));
  });

  it('full recovery satisfies `recovered`', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p = propose(h);
    const a = await admit(h, p);
    const f = { goalId: a.goalId, goalEpoch: 5, connectionEpoch: 1 };
    h.service.recordRegain(f, 'minecraft:iron_pickaxe', 1, 'act-1');
    h.service.recordRegain(f, 'minecraft:bread', 4, 'act-2');
    h.service.recordRegain(f, 'minecraft:cobblestone', 20, 'act-3');
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, { goalId: a.goalId, goalEpoch: 5 }).status, 'satisfied');
    assert.equal(h.service.status(h.clock.now()).incidents[0]?.status, 'recovered');
  });

  it('a failed attempt is not repeated without material improvement; better armor allows attempt 2; then attempts exhaust', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p1 = propose(h);
    const a1 = await admit(h, p1, 5);
    await end(h, a1, p1, 'no_progress');
    let d = h.service.assess(assessInput(h));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'death_recovery', 'unchanged preparation is not re-proposed');
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.routine === 'death_recovery'));
    // Improve armor: wear an iron helmet (server inventory).
    h.packets.setSlot(5, slot('iron_helmet'));
    h.packets.setSlot(6, slot('iron_helmet'));
    d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'propose');
    const p2 = (d as { proposal: SurvivalProposal }).proposal;
    assert.equal(p2.routine, 'death_recovery');
    const a2 = await admit(h, p2, 6);
    await end(h, a2, p2, 'no_progress');
    h.packets.setSlot(7, slot('iron_helmet'));
    h.packets.setSlot(8, slot('iron_helmet'));
    h.service.assess(assessInput(h));
    const inc = h.service.status(h.clock.now()).incidents[0];
    assert.equal(inc?.attempts.used, 2);
    assert.equal(inc?.blocker?.reason, 'attempts_exhausted');
    assert.notEqual(inc?.status, 'pending');
  });

  it('owner stop/replacement does not consume an attempt but accumulates budget', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p = propose(h);
    const a = await admit(h, p);
    await end(h, a, p, 'replaced', { plannerTurns: 3, tasksAdmitted: 2, replans: 1 });
    const inc = h.service.status(h.clock.now()).incidents[0];
    assert.equal(inc?.attempts.used, 0);
    assert.equal(inc?.budget.plannerTurns, 3);
  });

  it('a recovery death keeps the ORIGINAL incident, ends the attempt, and the same hazard blocks early', async () => {
    const h = harness();
    await deathAndRespawn(h, { translate: 'death.attack.drown' });
    const p = propose(h);
    const a = await admit(h, p);
    // Die again near the site with the same hazard while recovering.
    h.pos.at = { x: 33, y: 63, z: 10 };
    h.packets.inventory({ 36: slot('stone_pickaxe') });
    dieWithItems(h, { 36: slot('stone_pickaxe') }, 'death.attack.drown');
    const ctx = h.service.deathContext();
    h.service.linkIncident(ctx.captureId as string, 'mf-0002');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 33, y: 63, z: 10 } });
    await settle(h);
    await end(h, a, p, 'death');
    const s = h.service.status(h.clock.now());
    assert.equal(s.incidents.length, 1, 'no new episode replaces the original');
    assert.equal(s.incidents[0]?.originalIncidentFactId, 'mf-0001');
    assert.equal(s.incidents[0]?.relatedDeaths, 1);
    assert.equal(s.incidents[0]?.site.at?.x, 31, 'the original (refined 30.5) site is kept, not the recovery death at 33.5');
    assert.ok(s.incidents[0]?.missing.some((m) => m.key === 'minecraft:stone_pickaxe'), 'related losses near the site join the search');
    h.service.assess(assessInput(h));
    const after2 = h.service.status(h.clock.now()).incidents[0];
    assert.equal(after2?.blocker?.reason, 'repeated_fatal_hazard');
    assert.equal(after2?.attempts.used, 1);
  });

  it('attempt counters and budgets survive a restart; a running attempt is closed honestly', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p = propose(h);
    await admit(h, p);
    await h.service.flush();
    await new Promise((r) => setTimeout(r, 20));
    await h.service.close();
    const r = harness({ root: h.root, clock: h.clock, pid: 5151 });
    assert.ok(r.events.some((e) => e['type'] === 'survival_restart_attempts_closed'));
    const inc = r.service.status(r.clock.now()).incidents[0];
    assert.equal(inc?.attempts.used, 1, 'restart_interrupted counts');
    assert.equal(inc?.incidentFactId, 'mf-0001', 'the exact link persisted');
    // Fresh inventory on the new connection; no automatic replay without a fresh proposal/admission.
    r.packets.inventory({});
    r.packets.health(20, 20);
    // The restart assessment itself is persisted first: recovery waits (bounded) until it is durable.
    const waiting = r.service.assess(assessInput(r));
    assert.equal(waiting.kind, 'blocked');
    assert.equal((waiting as { reason: string }).reason, 'durable_write_pending');
    await settle(r);
    const d = r.service.assess(assessInput(r));
    // Unchanged preparation after an interrupted attempt is still allowed (not the route's fault).
    assert.equal(d.kind, 'propose');
    await r.service.close();
  });

  it('stale proposals, terminals and admissions after lifecycle cannot revive work', async () => {
    const h = harness();
    await deathAndRespawn(h);
    const p = propose(h);
    h.service.onLifecycle({ type: 'dimension_change', connectionEpoch: 1, from: OW, to: NETHER });
    assert.equal((await admit(h, p)).grant, undefined);
    assert.ok(h.events.some((e) => e['type'] === 'survival_admission_ignored'));
    h.service.onSupportTerminal({ proposalId: 'sp-x', goalId: 'goal-zzzz', goalEpoch: 9, state: 'completed', reason: 'outcome_verified', detail: '', counters: { plannerTurns: 0, tasksAdmitted: 0, replans: 0 }, endedAtMs: h.clock.now() });
    assert.ok(h.events.some((e) => e['type'] === 'survival_terminal_ignored'));
  });

  it('pause, owner priority and pending owner instructions yield; nothing is proposed', async () => {
    const h = harness();
    await deathAndRespawn(h);
    assert.equal(h.service.assess(assessInput(h, { autonomyAllowed: false })).kind, 'none');
    assert.equal(h.service.assess(assessInput(h, { active: { kind: 'owner_goal', goalId: 'goal-own1', goalEpoch: 3 } })).kind, 'none');
    assert.equal(h.service.assess(assessInput(h, { ownerIntakePending: true })).kind, 'none');
  });

  it('interrupted owner intent stays visible until a NEW owner instruction; never resubmitted', async () => {
    const h = harness();
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    h.service.onOwnerGoalEnd({ goalId: 'goal-own1', instruction: 'collect 10 oak logs', outcome: { kind: 'finite', rendered: 'inventory_delta oak_log >= 10', atomic: ['inventory_delta'] }, baseline: { capturedAtMs: 1, counts: { 'minecraft:oak_log': 2 } }, progress: 'collected 6', state: 'failed', reason: 'death', endedAtMs: h.clock.now() });
    let s = h.service.status(h.clock.now());
    assert.equal(s.interrupted[0]?.state, 'awaiting_owner');
    assert.equal(s.interrupted[0]?.continuation, 'requires_owner_decision');
    respawnFresh(h, {}, SITE);
    await settle(h);
    const p = propose(h, { ownerIntentInterrupted: true });
    assert.equal(p.serves, 'owner_intent');
    assert.doesNotMatch(p.execution.kind === 'planner_goal' ? p.execution.instruction : '', /oak logs/, 'the old owner text is never resubmitted');
    h.service.onOwnerInstruction(h.clock.now());
    s = h.service.status(h.clock.now());
    assert.equal(s.interrupted[0]?.state, 'superseded_by_owner');
  });

  it('low health revokes running non-support work once (owner intent retained)', async () => {
    const h = harness();
    h.packets.inventory({ 37: slot('bread', 2) });
    h.packets.health(6, 12);
    const d = h.service.assess(assessInput(h, { active: { kind: 'owner_goal', goalId: 'goal-own1', goalEpoch: 3 } }));
    assert.equal(d.kind, 'revoke_unsafe');
    assert.equal((d as { retainOwnerIntent: boolean }).retainOwnerIntent, true);
    assert.notEqual(h.service.assess(assessInput(h, { active: { kind: 'owner_goal', goalId: 'goal-own1', goalEpoch: 3 } })).kind, 'revoke_unsafe');
  });
});
