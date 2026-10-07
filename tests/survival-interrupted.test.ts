// MB-FLOW-003-C4 (offline, real SurvivalService, inference-free): necessary
// support for a RETAINED interrupted owner directive. Live intake (a preparing
// instruction / unanswered question) keeps priority; an already interrupted
// directive allows only eat/rest/death recovery serving owner_intent, holds
// its outcome/baseline, survives pause/resume and process restart (survival's
// durable record is used even when the supervisor's in-process flag is lost),
// and is cleared only by a new explicit owner instruction or an explicit
// dismissal — never replayed, never resubmitted with a new baseline.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SurvivalDecision, SurvivalProposal } from '../src/contracts/survival.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, slot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

const OWNER_END = (reason: string, at: number) => ({ goalId: 'goal-own1', instruction: 'collect 10 oak logs', outcome: { kind: 'finite' as const, rendered: 'inventory_delta oak_log >= 10', atomic: ['inventory_delta'] }, baseline: { capturedAtMs: 1, counts: { 'minecraft:oak_log': 2 } }, progress: 'collected 6', state: reason === 'death' ? 'failed' : 'blocked', reason, endedAtMs: at });
const proposal = (d: SurvivalDecision) => (d.kind === 'propose' ? d.proposal : undefined);

async function restart(h: Harness, pid: number): Promise<Harness> {
  await h.service.flush();
  await new Promise((r) => setTimeout(r, 25));
  await h.service.close();
  return harness({ root: h.root, clock: h.clock, pid });
}

describe('interrupted owner intent (C4)', () => {
  it('low-health interruption: live intake yields; retained intent gets safety eating serving owner_intent', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(6, 12);
    const revoke = h.service.assess(assessInput(h, { active: { kind: 'owner_goal', goalId: 'goal-own1', goalEpoch: 3 } }));
    assert.equal(revoke.kind, 'revoke_unsafe');
    h.service.onOwnerGoalEnd(OWNER_END('low_health', h.clock.now()));
    // A NEW owner instruction being prepared keeps priority.
    assert.equal(h.service.assess(assessInput(h, { ownerIntakePending: true, ownerIntentInterrupted: true })).kind, 'none');
    // Only the retained directive: necessary support runs.
    const p = proposal(h.service.assess(assessInput(h, { ownerIntakePending: false, ownerIntentInterrupted: true })));
    assert.equal(p?.routine, 'eat');
    assert.equal(p?.priority, 'safety');
    assert.equal(p?.serves, 'owner_intent');
    assert.ok(p?.lowHealthAllowance, 'narrow allowance at low health');
    // Even if the supervisor's flag is lost, survival's own record still marks it.
    h.service.onSupportAdmitted({ proposalId: (p as SurvivalProposal).proposalId, goalId: 'goal-eat1', goalEpoch: 4, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    h.service.onSupportTerminal({ proposalId: (p as SurvivalProposal).proposalId, goalId: 'goal-eat1', goalEpoch: 4, state: 'blocked', reason: 'no_progress', detail: '', counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: h.clock.now() });
    const s = h.service.status(h.clock.now());
    assert.equal(s.interrupted[0]?.state, 'awaiting_owner', 'support does not resolve the owner directive');
    assert.equal(s.interrupted[0]?.continuation, 'requires_owner_decision');
  });

  it('while intent is retained, only necessary routines run; a new owner instruction re-enables ordinary upkeep', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 1) }); // resupply would normally be proposed (reserve below low)
    h.packets.health(20, 20);
    h.service.onOwnerGoalEnd(OWNER_END('low_health', h.clock.now()));
    const held = h.service.assess(assessInput(h, { ownerIntentInterrupted: true }));
    assert.equal(held.kind, 'none');
    assert.match((held as { reason: string }).reason, /awaits the owner/);
    // Supervisor flag lost (e.g. restart in P): survival's own record still holds it.
    assert.equal(h.service.assess(assessInput(h, { ownerIntentInterrupted: false })).kind, 'none');
    h.service.onOwnerInstruction(h.clock.now());
    const p = proposal(h.service.assess(assessInput(h)));
    assert.equal(p?.routine, 'resupply');
    assert.equal(p?.serves, 'none');
  });

  it('pause and resume do not clear the retained directive', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 8) });
    h.packets.health(20, 20);
    h.service.onOwnerGoalEnd(OWNER_END('low_health', h.clock.now()));
    assert.equal(h.service.assess(assessInput(h, { autonomyAllowed: false })).kind, 'none');
    assert.equal(h.service.assess(assessInput(h, { autonomyAllowed: true })).kind, 'none');
    assert.equal(h.service.interruptedOwnerIntent().length, 1);
    assert.equal(h.service.status(h.clock.now()).interrupted[0]?.state, 'awaiting_owner');
  });

  it('owner death -> restart: the durable directive still holds; recovery serves it; supersession persists', async () => {
    let h = harness();
    const kit = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 249 }]), 37: slot('bread', 4) };
    h.packets.inventory(kit);
    h.packets.health(20, 20);
    dieWithItems(h, kit);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    h.service.onOwnerGoalEnd(OWNER_END('death', h.clock.now()));
    respawnFresh(h, { 38: slot('stone_pickaxe', 1, [{ type: 'damage', data: 130 }]) }, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    h = await restart(h, 7101);
    const listed = h.service.interruptedOwnerIntent();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.durable, true);
    assert.equal(listed[0]?.instruction, 'collect 10 oak logs');
    // Fresh connection after restart; the supervisor's in-process owner-intent state is gone.
    h.packets.inventory({ 38: slot('stone_pickaxe', 1, [{ type: 'damage', data: 130 }]) });
    h.packets.health(20, 20);
    const p = proposal(h.service.assess(assessInput(h, { ownerIntentInterrupted: false })));
    assert.equal(p?.routine, 'death_recovery', 'necessary recovery runs (the worn tool upkeep waits)');
    assert.equal(p?.serves, 'owner_intent');
    if (p?.execution.kind === 'planner_goal') assert.doesNotMatch(p.execution.instruction, /oak logs/, 'the old owner text is never resubmitted');
    // A new explicit owner instruction supersedes it, durably.
    h.service.onOwnerInstruction(h.clock.now());
    assert.equal(h.service.interruptedOwnerIntent().length, 0);
    h = await restart(h, 7102);
    assert.equal(h.service.interruptedOwnerIntent().length, 0);
    assert.equal(h.service.status(h.clock.now()).interrupted[0]?.state, 'superseded_by_owner');
    await h.service.close();
  });

  it('explicit dismissal is durable; unscoped intent is reported non-durable', async () => {
    let h = harness();
    h.service.onOwnerGoalEnd(OWNER_END('low_health', h.clock.now()));
    assert.equal(h.service.dismissInterrupted('goal-own1', h.clock.now()), true);
    h = await restart(h, 7103);
    assert.equal(h.service.interruptedOwnerIntent().length, 0);
    assert.equal(h.service.status(h.clock.now()).interrupted[0]?.state, 'dismissed_by_owner');
    await h.service.close();
    const u = harness({ scoped: false });
    u.service.onOwnerGoalEnd(OWNER_END('low_health', u.clock.now()));
    assert.equal(u.service.interruptedOwnerIntent()[0]?.durable, false, 'without operator scope the supervisor must persist it itself');
  });
});
