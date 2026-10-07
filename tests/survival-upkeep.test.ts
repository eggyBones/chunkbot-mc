// MB-FLOW-003 R6/R7/R10 (offline, inference-free): food/rest thresholds with
// hysteresis, safe-food selection, the narrow low-health allowance bindings,
// tool/armor upkeep from server metadata, designated-storage room making,
// bounded resupply with cooldown, admission caps and no re-proposal on
// unchanged blocked conditions.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { MemoryFact } from '../src/contracts/memory.ts';
import type { AllowanceTaskRef, SurvivalProposal } from '../src/contracts/survival.ts';
import { assessInput, cleanupRoots, harness, slot, snapshot, OW, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

function propose(h: Harness, over: Parameters<typeof assessInput>[1] = {}): SurvivalProposal | undefined {
  const d = h.service.assess(assessInput(h, over));
  return d.kind === 'propose' ? d.proposal : undefined;
}

function admit(h: Harness, p: SurvivalProposal, goalEpoch = 7) {
  const goalId = `goal-s${goalEpoch}aa`;
  const grant = h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId, goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  return { goalId, goalEpoch, grant };
}

function endSupport(h: Harness, a: { goalId: string; goalEpoch: number }, p: SurvivalProposal, reason: string): void {
  h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: a.goalId, goalEpoch: a.goalEpoch, state: reason === 'outcome_verified' ? 'completed' : 'blocked', reason, detail: reason, counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: h.clock.now() });
}

const task = (a: { goalId: string; goalEpoch: number }, taskId = 'task-1', caps = ['eat_safe_food']): AllowanceTaskRef => ({ goalId: a.goalId, goalEpoch: a.goalEpoch, taskId, connectionEpoch: 1, allowedCapabilities: caps });

describe('survival upkeep', () => {
  it('eats only below the low threshold, only safe owned food, never at full hunger', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3), 37: slot('rotten_flesh', 5), 38: slot('golden_apple', 1) });
    h.packets.health(20, 16);
    assert.equal(propose(h)?.routine === 'eat', false, 'food 16 is above the 14 low threshold (hysteresis)');
    h.packets.health(20, 12);
    const p = propose(h);
    assert.equal(p?.routine, 'eat');
    assert.equal(p?.execution.kind, 'code_task');
    if (p?.execution.kind === 'code_task') {
      assert.deepEqual(p.execution.spec.allowedCapabilities, ['eat_safe_food']);
      assert.deepEqual(p.execution.completion, { predicate: 'survival_state', routine: 'eat', expect: 'satisfied' });
    }
    assert.equal(p?.lowHealthAllowance, undefined, 'no allowance at normal health');
    h.packets.health(20, 20);
    assert.notEqual(propose(h)?.routine, 'eat');
  });

  it('a completed eat cooldown never suppresses a later NECESSARY low-health eat (C6)', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 6) });
    h.packets.health(20, 10);
    const p = propose(h) as SurvivalProposal;
    assert.equal(p.routine, 'eat');
    const a = admit(h, p);
    h.packets.health(20, 18);
    endSupport(h, a, p, 'outcome_verified');
    h.packets.health(20, 12);
    assert.notEqual(propose(h)?.routine, 'eat', 'ordinary eat waits out its cooldown');
    h.packets.health(6, 12);
    const necessary = propose(h);
    assert.equal(necessary?.routine, 'eat');
    assert.equal(necessary?.priority, 'safety');
  });

  it('risky or precious food only: honest no_safe_food block, unchanged signature is not re-proposed', () => {
    const h = harness();
    h.packets.inventory({ 37: slot('rotten_flesh', 5), 38: slot('golden_apple', 1) });
    h.packets.health(20, 10);
    const d = h.service.assess(assessInput(h));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'eat');
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.routine === 'eat' && b.reason === 'no_safe_food'));
  });

  it('low health: eat proposal carries a narrow allowance bound to goal/epoch/connection/dimension/task/items', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(6, 10);
    const p = propose(h);
    assert.equal(p?.routine, 'eat');
    assert.equal(p?.priority, 'safety');
    assert.deepEqual(p?.lowHealthAllowance?.items, ['minecraft:bread']);
    const a = admit(h, p as SurvivalProposal);
    assert.ok(a.grant);
    const snap = snapshot({ goalEpoch: a.goalEpoch });
    const c = h.service.check(task(a), snap);
    assert.equal(c.allowed, true);
    // Bound to its first task: another task id is refused.
    assert.equal(h.service.check(task(a, 'task-2'), snap).allowed, false);
    // A task allowing more than the grant is refused.
    assert.equal(h.service.check(task(a, 'task-1', ['eat_safe_food', 'mine_block']), snap).allowed, false);
    // Post-choice recheck: only allowed items/capabilities, still owned.
    const id = (c as { allowanceId: string }).allowanceId;
    assert.equal(h.service.recheck(id, task(a), { capability: 'eat_safe_food', parameters: { item: 'minecraft:bread' } }, snap).allowed, true);
    assert.equal(h.service.recheck(id, task(a), { capability: 'eat_safe_food', parameters: { item: 'minecraft:golden_apple' } }, snap).allowed, false);
    assert.equal(h.service.recheck(id, task(a), { capability: 'mine_block', parameters: {} }, snap).allowed, false);
    // Visible threat refuses; other dimension / stale snapshot refuse.
    assert.equal(h.service.check(task(a), snapshot({ goalEpoch: a.goalEpoch, entities: [{ handle: 'ent-1', key: 'minecraft:zombie', at: { x: 3, y: 64, z: 0 }, distance: 3 }] })).allowed, false);
    assert.equal(h.service.check(task(a), snapshot({ goalEpoch: a.goalEpoch, dimension: 'minecraft:the_nether' })).allowed, false);
    assert.equal(h.service.check(task(a), snapshot({ goalEpoch: 99 })).allowed, false);
    // Max actions then exhausted; no renewal for the same epoch.
    for (let i = 0; i < 4; i += 1) h.service.consumed(id, { actionId: `act-${i}`, capability: 'eat_safe_food', status: 'succeeded' });
    const ex = h.service.check(task(a), snap);
    assert.equal(ex.allowed, false);
    assert.equal((ex as { reason: string }).reason, 'allowance_exhausted');
    endSupport(h, a, p as SurvivalProposal, 'low_health');
    assert.equal(h.service.check(task(a), snap).allowed, false, 'ended goal holds nothing');
  });

  it('allowance expiry is fixed and cannot be extended; a second grant for the same epoch is refused', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(6, 10);
    const p = propose(h) as SurvivalProposal;
    const a = admit(h, p);
    h.clock.advance(91_000);
    const c = h.service.check(task(a), snapshot({ goalEpoch: a.goalEpoch }));
    assert.equal((c as { reason?: string }).reason, 'allowance_expired');
    // A replayed admission for the same epoch: no second grant.
    assert.equal(h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: a.goalId, goalEpoch: a.goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() }), undefined);
  });

  it('only a bound support goal can hold an allowance (owner goals never)', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(6, 10);
    const c = h.service.check({ goalId: 'goal-own1', goalEpoch: 3, taskId: 't', connectionEpoch: 1, allowedCapabilities: ['eat_safe_food'] }, snapshot({ goalEpoch: 3 }));
    assert.equal(c.allowed, false);
  });

  it('rest needs food >= 18; regeneration failure blocks until the condition changes', () => {
    const h = harness();
    h.packets.inventory({});
    h.packets.health(10, 12);
    h.service.assess(assessInput(h));
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.routine === 'rest' && b.reason === 'regeneration_needs_food'));
    h.packets.health(10, 20);
    const p = propose(h);
    assert.equal(p?.routine, 'rest');
    const a = admit(h, p as SurvivalProposal);
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'rest', expect: 'satisfied' }, a).status, 'unsatisfied');
    endSupport(h, a, p as SurvivalProposal, 'no_progress');
    assert.notEqual(propose(h)?.routine, 'rest', 'unchanged condition after a failed rest is not re-proposed');
    h.packets.health(9, 20); // took damage: health band changed
    assert.equal(propose(h)?.routine, 'rest');
  });

  it('survival_state eat/rest are owner-fenced and use fresh server vitals', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 3) });
    h.packets.health(20, 10);
    const p = propose(h) as SurvivalProposal;
    const a = admit(h, p);
    const pred = { predicate: 'survival_state' as const, routine: 'eat' as const, expect: 'satisfied' as const };
    assert.equal(h.service.evaluateSurvivalState(pred, undefined).status, 'unknown');
    assert.equal(h.service.evaluateSurvivalState(pred, { goalId: 'goal-zzzz', goalEpoch: a.goalEpoch }).status, 'unknown');
    assert.equal(h.service.evaluateSurvivalState(pred, a).status, 'unsatisfied');
    h.packets.health(20, 18);
    assert.equal(h.service.evaluateSurvivalState(pred, a).status, 'satisfied');
  });

  it('tool upkeep uses server durability metadata; unknown metadata is never "worn"', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 245 }]), 37: slot('bread', 8) });
    h.packets.health(20, 20);
    const p = propose(h);
    assert.equal(p?.routine, 'tool_upkeep');
    assert.equal(p?.execution.kind, 'planner_goal');
    // A healthy spare means no replacement is needed.
    h.packets.setSlot(38, slot('stone_pickaxe', 1));
    assert.notEqual(propose(h)?.routine, 'tool_upkeep');
  });

  it('owned unworn armor is worn through the existing equip capability (code task)', () => {
    const h = harness();
    h.packets.inventory({ 20: slot('iron_helmet'), 37: slot('bread', 8) });
    h.packets.health(20, 20);
    const p = propose(h);
    assert.equal(p?.routine, 'tool_upkeep');
    if (p?.execution.kind === 'code_task') assert.deepEqual(p.execution.completion, { predicate: 'equipped', selector: 'minecraft:iron_helmet', slot: 'head' });
    else assert.fail('expected a code task');
  });

  it('inventory room needs owner-designated storage; nothing is ever dropped', () => {
    const h = harness();
    const full: Record<number, ReturnType<typeof slot>> = {};
    for (let i = 9; i <= 44; i += 1) full[i] = i === 9 ? slot('bread', 8) : slot('dirt', 64);
    h.packets.inventory(full);
    h.packets.health(20, 20);
    h.service.assess(assessInput(h));
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.routine === 'inventory_room' && b.reason === 'no_designated_storage'));
    const fact = { id: 'mf-0009', category: 'container', label: 'storage chest', labelKey: 'storage chest', source: 'owner_statement', status: 'active', location: { dimension: OW, at: { x: 5, y: 64, z: 5 } } } as unknown as MemoryFact;
    h.memory.factList.push(fact);
    const p = propose(h);
    assert.equal(p?.routine, 'inventory_room');
    if (p?.execution.kind === 'planner_goal') {
      assert.match(p.execution.instruction, /mf-0009/);
      assert.ok(p.execution.context.rules.some((r) => /never drop/.test(r)));
    }
  });

  it('resupply below the low reserve is bounded and cools down after completion', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 1) });
    h.packets.health(20, 20);
    const p = propose(h);
    assert.equal(p?.routine, 'resupply');
    const a = admit(h, p as SurvivalProposal);
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'resupply', expect: 'satisfied' }, a).status, 'unsatisfied');
    h.packets.setSlot(37, slot('bread', 5));
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'resupply', expect: 'satisfied' }, a).status, 'satisfied');
    endSupport(h, a, p as SurvivalProposal, 'outcome_verified');
    h.packets.setSlot(37, { itemCount: 0 });
    assert.notEqual(propose(h)?.routine, 'resupply', 'cooldown prevents an immediate repeat');
    h.clock.advance(16 * 60_000);
    assert.equal(propose(h)?.routine, 'resupply');
  });

  it('admissions per hour are capped (non-safety)', () => {
    const h = harness({ config: { admissionsPerHour: 1 } });
    h.packets.inventory({ 36: slot('bread', 1) });
    h.packets.health(20, 20);
    const p = propose(h) as SurvivalProposal;
    const a = admit(h, p);
    endSupport(h, a, p, 'cannot_execute');
    h.packets.setSlot(38, slot('iron_pickaxe', 1, [{ type: 'damage', data: 249 }]));
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'blocked');
    assert.equal((d as { reason: string }).reason, 'admission_cap');
  });

  it('status is bounded and labels gated slices honestly', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 1) });
    h.packets.health(20, 20);
    h.service.assess(assessInput(h));
    const s = h.service.status(h.clock.now());
    assert.ok(JSON.stringify(s).length <= 4_000);
    assert.ok(s.gated.some((g) => g.slice === 'home_rest' && g.status === 'mechanics_gate_pending'));
    assert.ok(s.gated.some((g) => g.slice === 'lighting' && g.status === 'later_gated_slice'));
    assert.ok(h.service.statusLines(h.clock.now()).length >= 1);
  });

  it('disabled survival proposes nothing', () => {
    const h = harness({ config: { enabled: false } });
    h.packets.inventory({ 36: slot('bread', 1) });
    h.packets.health(4, 2);
    assert.equal(h.service.assess(assessInput(h)).kind, 'none');
    assert.equal(h.service.enabled, false);
  });
});
