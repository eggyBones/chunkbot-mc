// MB-FLOW-003-C2 (shared TaskRuntime): the survival low-health allowance is
// rechecked on the FRESH snapshot before BOTH Jev and sustained local
// continuation dispatch, every dispatch is counted (also on exception), and
// the ordinary guard is unchanged. Scripted ports; no inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionCandidate, AdmittedTask, AllowanceTaskRef, DecisionChoice, DecisionRequest, LowHealthAllowancePort, LowHealthCheck, ObservationSnapshot, OutcomePredicate, PredicateEvaluation, SkillOutcome, TaskSpec } from '../src/contracts/index.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { TaskRuntime, type TaskRuntimeDeps } from '../src/tasks/task-runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';

const REST: TaskSpec = {
  objective: 'rest until health recovers',
  decisionInstruction: 'rest in place',
  allowedCapabilities: ['rest_in_place', 'mine_block'],
  targetSelectors: [],
  parameters: {},
  completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 99, mode: 'possess' },
};

/** Fake canonical allowance: fixed max actions and expiry; refuses everything once used up or expired. */
class FakeAllowance implements LowHealthAllowancePort {
  used = 0;
  readonly checks: string[] = [];
  readonly rechecks: Array<{ capability: string; snapshotId: string }> = [];
  readonly consumedLog: Array<{ actionId: string; status: string }> = [];
  refuseRecheck = false;
  refuseReserve = false;
  readonly reserved = new Set<string>();
  readonly reserves: string[] = [];
  readonly max: number;
  readonly expiresAt: number;
  readonly now: () => number;
  readonly capabilities: string[];
  constructor(max: number, expiresAt: number, now: () => number, capabilities: string[] = ['rest_in_place']) {
    this.max = max;
    this.expiresAt = expiresAt;
    this.now = now;
    this.capabilities = capabilities;
  }
  private state(task: AllowanceTaskRef): LowHealthCheck {
    if (task.goalEpoch !== 3) return { allowed: false, reason: 'wrong_epoch', detail: 'other goal' };
    if (this.now() >= this.expiresAt) return { allowed: false, reason: 'expired', detail: 'allowance expired' };
    if (this.used >= this.max) return { allowed: false, reason: 'actions_exhausted', detail: `${this.used}/${this.max}` };
    return { allowed: true, allowanceId: 'alw-1', capabilities: this.capabilities, items: [], detail: 'ok' };
  }
  check(task: AllowanceTaskRef): LowHealthCheck {
    this.checks.push(task.taskId);
    return this.state(task);
  }
  recheck(_id: string, task: AllowanceTaskRef, candidate: { capability: string }, snapshot: ObservationSnapshot): LowHealthCheck {
    this.rechecks.push({ capability: candidate.capability, snapshotId: snapshot.id });
    if (this.refuseRecheck) return { allowed: false, reason: 'threat', detail: 'a hostile is visible now' };
    return this.state(task);
  }
  /** Counts BEFORE execution (S311). */
  reserve(_id: string, task: AllowanceTaskRef, candidate: { id: string }): LowHealthCheck {
    this.reserves.push(candidate.id);
    if (this.refuseReserve) return { allowed: false, reason: 'reserve_refused', detail: 'no actions left' };
    const s = this.state(task);
    if (!s.allowed) return s;
    this.used += 1;
    this.reserved.add(candidate.id);
    return { ...s, remainingActions: this.max - this.used };
  }
  /** Idempotent outcome note: a reserved action is never counted twice. */
  consumed(_id: string, outcome: { actionId: string; status: string }): void {
    if (!this.reserved.has(outcome.actionId)) this.used += 1;
    this.consumedLog.push(outcome);
  }
}

class H {
  t = 1_000_000;
  ids = sequentialIds();
  store = new MemoryRunStore();
  health = 6;
  snaps = 0;
  executed: ActionCandidate[] = [];
  decisions = 0;
  current = true;
  abort = new AbortController();
  throwOnExecute = false;
  decide: (req: DecisionRequest) => Promise<DecisionChoice> = async (req) => this.choice(req, req.candidates[0]!.id);
  choice(req: DecisionRequest, id: string): DecisionChoice {
    return { requestId: req.requestId, candidateId: id, confidence: 0.9, probabilities: { [id]: 1 }, requestedModel: 'm', model: 'm', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 1, attempts: 1 };
  }
  snapshot(goalEpoch: number): ObservationSnapshot {
    this.snaps += 1;
    return { id: `snap-${String(this.snaps).padStart(4, '0')}`, connectionEpoch: 1, goalEpoch, takenAtMs: this.t, dimension: 'overworld', self: { at: { x: 0, y: 0, z: 0 }, health: this.health, food: 10 }, inventory: [], equipment: {}, owner: { visible: false }, entities: [], blocks: [], drops: [], remembered: [], blockSummary: [], frontiers: [] };
  }
  deps(allowance?: LowHealthAllowancePort): TaskRuntimeDeps {
    return {
      perception: { take: (e) => this.snapshot(e), resolve: () => ({ error: 'none' }) },
      candidates: {
        generate: (_s, snap) => ({
          snapshotId: snap.id,
          connectionEpoch: 1,
          goalEpoch: snap.goalEpoch,
          generatedAtMs: this.t,
          candidates: ['rest_in_place', 'mine_block'].map((capability) => ({ id: this.ids.next('act'), capability, parameters: { mode: capability }, snapshotId: snap.id, connectionEpoch: 1, goalEpoch: snap.goalEpoch, description: capability, criteria: [], preconditions: [], timeoutMs: 10_000 })),
          unavailable: [],
          truncated: false,
        }),
      },
      executor: {
        readiness: () => ({ ready: true, detail: 'fake' }),
        execute: async (c, _signal, owner) => {
          this.executed.push(c);
          this.t += 1_000;
          if (this.throwOnExecute) throw new Error('executor exploded');
          const g = owner as { goalId: string; taskId: string };
          return { actionId: c.id, owner: 'goal', goalId: g.goalId, taskId: g.taskId, capability: c.capability, connectionEpoch: 1, goalEpoch: c.goalEpoch, status: 'succeeded', elapsedMs: 1_000, effect: 'rested', confirmation: 'client_only', evidence: {} } as SkillOutcome;
        },
      },
      predicates: {
        bind: async (predicate: OutcomePredicate) => ({ predicate, boundAtMs: this.t, baselines: {} }),
        evaluate: async () => ({ status: 'unsatisfied', predicate: 'inventory_amount', detail: 'fake', evidence: {} }) as PredicateEvaluation,
      },
      decision: {
        readiness: () => ({ ready: true, detail: 'fake' }),
        choose: (req) => {
          this.decisions += 1;
          return this.decide(req);
        },
      },
      // rest_in_place is a SUSTAINED capability: its window elapsing continues locally without inference.
      sustained: (cap) => (cap === 'rest_in_place' ? { windowElapsed: (o) => o.status === 'succeeded' } : undefined),
      catalogVersion: () => 'test',
      mechanicsVersion: '26.1.2',
      connectionEpoch: () => 1,
      model: 'm',
      store: this.store,
      clock: { now: () => this.t },
      ids: this.ids,
      limits: { maxOptions: 8, noProgressMs: 600_000, perTargetRetries: 5, lowHealth: 8 },
      ...(allowance ? { lowHealthAllowance: allowance } : {}),
    };
  }
  task(): AdmittedTask {
    return { taskId: 'task-0001', goalId: 'goal-0001', goalEpoch: 3, spec: REST, mode: 'complete', signal: this.abort.signal, isCurrent: () => this.current };
  }
}

describe('MB-FLOW-003-C2 allowance on every dispatch', () => {
  it('a sustained local continuation is rechecked and counted; the last allowed action is followed by a refused window', async () => {
    const h = new H();
    const a = new FakeAllowance(2, h.t + 60_000, () => h.t);
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'low_health');
    assert.match(r.detail, /actions_exhausted/);
    assert.equal(h.decisions, 1, 'one Jev choice; the second dispatch was a LOCAL continuation');
    assert.equal(r.localContinuations, 1);
    assert.equal(h.executed.length, 2, 'exactly maxActions dispatches');
    assert.ok(h.executed.every((c) => c.capability === 'rest_in_place'), 'only allowance capabilities were offered/dispatched');
    assert.equal(a.rechecks.length, 2, 'recheck before the Jev dispatch AND before the local continuation');
    assert.equal(a.used, 2);
  });

  it('expiry during a sustained window refuses the next local continuation', async () => {
    const h = new H();
    const a = new FakeAllowance(8, h.t + 500, () => h.t);
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(r.reason, 'low_health');
    assert.match(r.detail, /expired/);
    assert.equal(h.executed.length, 1);
    assert.equal(a.used, 1);
  });

  it('an executor exception still consumes the dispatch (finally accounting)', async () => {
    const h = new H();
    h.throwOnExecute = true;
    const a = new FakeAllowance(3, h.t + 60_000, () => h.t);
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(r.status, 'failed');
    assert.equal(a.used, 1);
    assert.equal(a.consumedLog[0]?.status, 'dispatch_interrupted');
  });

  it('a fresh recheck refusal after the Jev await executes nothing', async () => {
    const h = new H();
    const a = new FakeAllowance(3, h.t + 60_000, () => h.t);
    a.refuseRecheck = true;
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(r.reason, 'low_health');
    assert.match(r.detail, /recheck refused: threat/);
    assert.equal(h.executed.length, 0);
    assert.equal(a.used, 0);
  });

  it('stop while the Jev decision is in flight dispatches and consumes nothing', async () => {
    const h = new H();
    const a = new FakeAllowance(3, h.t + 60_000, () => h.t);
    h.decide = async (req) => {
      h.current = false;
      h.abort.abort(new Error('owner_stop'));
      return h.choice(req, req.candidates[0]!.id);
    };
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(r.status, 'cancelled');
    assert.equal(h.executed.length, 0);
    assert.equal(a.used, 0);
  });

  it('without an allowance port the ordinary guard blocks at low health; above the guard nothing is checked', async () => {
    const h = new H();
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.reason, 'low_health');
    assert.equal(h.executed.length, 0);
    const h2 = new H();
    h2.health = 20;
    const a = new FakeAllowance(1, h2.t + 60_000, () => h2.t);
    const rt = new TaskRuntime({ ...h2.deps(a), limits: { maxOptions: 8, noProgressMs: 600_000, perTargetRetries: 5, lowHealth: 8, maxRounds: 3 } });
    await rt.run(h2.task());
    assert.equal(a.checks.length + a.rechecks.length, 0, 'healthy: the allowance is never consulted');
    assert.equal(a.used, 0);
  });
});

describe('S311 reserve before every dispatch', () => {
  it('reserve precedes BOTH the Jev dispatch and the local continuation; the outcome note never double counts', async () => {
    const h = new H();
    const a = new FakeAllowance(2, h.t + 60_000, () => h.t);
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(a.reserves.length, 2, 'one reserve per dispatch (Jev + local)');
    assert.deepEqual(a.reserves, h.executed.map((c) => c.id), 'reserved exactly the dispatched candidates, in order');
    assert.equal(a.used, 2, 'counted at reserve; consumed() notes did not add more');
    assert.equal(a.consumedLog.length, 2);
    assert.equal(r.reason, 'low_health');
  });

  it('a reserve refusal executes nothing', async () => {
    const h = new H();
    const a = new FakeAllowance(2, h.t + 60_000, () => h.t);
    a.refuseReserve = true;
    const r = await new TaskRuntime(h.deps(a)).run(h.task());
    assert.match(r.detail, /reserve refused/);
    assert.equal(h.executed.length, 0);
    assert.equal(a.used, 0);
  });

  it('an action that throws after reserve stays counted (counted before execution)', async () => {
    const h = new H();
    h.throwOnExecute = true;
    const a = new FakeAllowance(1, h.t + 60_000, () => h.t);
    await new TaskRuntime(h.deps(a)).run(h.task());
    assert.equal(a.used, 1);
    assert.equal(a.consumedLog[0]?.status, 'dispatch_interrupted');
  });
});
