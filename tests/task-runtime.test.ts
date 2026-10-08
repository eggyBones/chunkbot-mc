// Generic task runtime with scripted ports. These are controller-mechanics
// tests: candidates/decisions/outcomes/predicates are fakes so each ownership,
// staleness, revalidation, progress and limit rule can be forced exactly.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ActionCandidate,
  AdmittedTask,
  CandidateSet,
  DecisionChoice,
  DecisionPort,
  DecisionRequest,
  ExecutionOwner,
  ObservationSnapshot,
  OutcomePredicate,
  PredicateEvaluation,
  SkillOutcome,
  TaskSpec,
} from '../src/contracts/index.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { DecisionError } from '../src/decision/errors.ts';
import { TaskRuntime, type TaskRuntimeDeps } from '../src/tasks/task-runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';

const SPEC: TaskSpec = {
  objective: 'Acquire three logs.',
  decisionInstruction: 'Pick a visible log or drop.',
  allowedCapabilities: ['mine_block', 'move_near'],
  targetSelectors: [],
  parameters: {},
  completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: true },
};

interface Target {
  handle: string;
  capability: string;
  block: [number, number, number];
}

class Harness {
  t = 1_000_000;
  clock = { now: () => this.t };
  ids = sequentialIds();
  store = new MemoryRunStore();
  connectionEpoch = 1;
  health = 20;
  snapCount = 0;
  /** Visible targets by handle (the "world"). */
  world = new Map<string, Target>();
  unavailable: CandidateSet['unavailable'] = [];
  /** Optional override of candidate generation (by call index). */
  generateHook?: (call: number) => Target[] | undefined;
  generateCalls = 0;
  decisions: DecisionRequest[] = [];
  decide: (req: DecisionRequest, signal: AbortSignal) => Promise<DecisionChoice> = async (req) => this.choice(req, req.candidates[0]!.id);
  executed: Array<{ c: ActionCandidate; owner: ExecutionOwner | undefined }> = [];
  outcome: (c: ActionCandidate, owner: ExecutionOwner) => Partial<SkillOutcome> = () => ({ status: 'succeeded', confirmation: 'server_packet', elapsedMs: 800 });
  evaluate: () => Partial<PredicateEvaluation> = () => ({ status: 'unsatisfied' });
  current = true;
  abort = new AbortController();

  choice(req: DecisionRequest, id: string): DecisionChoice {
    return { requestId: req.requestId, candidateId: id, confidence: 0.9, probabilities: { [id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { inputTokens: 400, outputTokens: 20, costUsd: 0.0000168 }, latencyMs: 300, attempts: 1 };
  }

  snapshot(goalEpoch: number): ObservationSnapshot {
    this.snapCount += 1;
    return {
      id: `snap-${String(this.snapCount).padStart(4, '0')}`,
      connectionEpoch: this.connectionEpoch,
      goalEpoch,
      takenAtMs: this.t,
      dimension: 'overworld',
      self: { at: { x: 0, y: 0, z: 0 }, health: this.health, food: 20 },
      inventory: [],
      equipment: {},
      owner: { visible: false },
      entities: [],
      blocks: [],
      drops: [],
      remembered: [],
      blockSummary: [],
      frontiers: [],
    };
  }

  deps(over: Partial<TaskRuntimeDeps> = {}): TaskRuntimeDeps {
    const decision: DecisionPort = {
      readiness: () => ({ ready: true, detail: 'fake' }),
      choose: (req, signal) => {
        this.decisions.push(req);
        return this.decide(req, signal);
      },
    };
    return {
      perception: {
        take: (e) => this.snapshot(e),
        resolve: (_s, handle) => {
          const t = this.world.get(handle) ?? [...this.world.values()].find((w) => w.handle === handle);
          return t ? { target: { kind: 'block', x: t.block[0], y: t.block[1], z: t.block[2] } } : { error: 'unknown_handle' };
        },
      },
      candidates: {
        generate: (_spec, snap) => {
          this.generateCalls += 1;
          const targets = this.generateHook?.(this.generateCalls) ?? [...this.world.values()];
          return {
            snapshotId: snap.id,
            connectionEpoch: snap.connectionEpoch,
            goalEpoch: snap.goalEpoch,
            generatedAtMs: this.t,
            candidates: targets.map((t) => ({
              id: this.ids.next('act'),
              capability: t.capability,
              parameters: { target: { snapshotId: snap.id, handle: t.handle } },
              snapshotId: snap.id,
              connectionEpoch: snap.connectionEpoch,
              goalEpoch: snap.goalEpoch,
              description: `${t.capability} ${t.handle}`,
              criteria: [],
              preconditions: [],
              timeoutMs: 10_000,
            })),
            unavailable: this.unavailable,
            truncated: false,
          };
        },
      },
      executor: {
        readiness: () => ({ ready: true, detail: 'fake' }),
        execute: async (c, _signal, owner) => {
          this.executed.push({ c, owner });
          const o = this.outcome(c, owner as ExecutionOwner);
          this.t += o.elapsedMs ?? 800;
          const g = owner as Extract<ExecutionOwner, { kind: 'goal' }>;
          return { actionId: c.id, owner: 'goal', goalId: g.goalId, taskId: g.taskId, capability: c.capability, connectionEpoch: c.connectionEpoch, goalEpoch: c.goalEpoch, status: 'succeeded', elapsedMs: 800, effect: 'done', confirmation: 'server_packet', evidence: {}, ...o } as SkillOutcome;
        },
      },
      predicates: {
        bind: async (predicate: OutcomePredicate) => ({ predicate, boundAtMs: this.t, baselines: { 'inv:#minecraft:logs': 0 } }),
        evaluate: async () => ({ status: 'unsatisfied', predicate: 'inventory_delta', detail: 'fake', evidence: {}, ...this.evaluate() }) as PredicateEvaluation,
      },
      decision,
      sustained: (cap) => (cap === 'follow_entity' ? { windowElapsed: (o) => o.status === 'succeeded' } : undefined),
      catalogVersion: () => 'skills-20-test',
      mechanicsVersion: '26.1.2',
      connectionEpoch: () => this.connectionEpoch,
      model: 'typesafe/jev-1.13',
      store: this.store,
      clock: this.clock,
      ids: this.ids,
      limits: { maxOptions: 8, noProgressMs: 30_000, perTargetRetries: 2, lowHealth: 8 },
      ...over,
    };
  }

  task(spec: TaskSpec = SPEC, mode: AdmittedTask['mode'] = 'complete'): AdmittedTask {
    return { taskId: 'task-0001', goalId: 'goal-0001', goalEpoch: 3, spec, mode, signal: this.abort.signal, isCurrent: () => this.current };
  }

  revoke(): void {
    this.current = false;
    this.abort.abort(new Error('owner_stop'));
  }
}

const log = (h: string, x: number): Target => ({ handle: h, capability: 'mine_block', block: [x, 0, 0] });

describe('task runtime: completion only from verified predicates', () => {
  it('runs Jev-chosen actions until the code-evaluated predicate is satisfied; successes alone do not complete', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.world.set('blk-2', log('blk-2', 2));
    h.world.set('blk-3', log('blk-3', 3));
    let mined = 0;
    h.outcome = (c) => {
      const t = h.world.get((c.parameters['target'] as { handle: string }).handle)!;
      h.world.delete(t.handle);
      mined += 1;
      return { status: 'succeeded', confirmation: 'server_packet' };
    };
    h.evaluate = () => ({ status: mined >= 3 ? 'satisfied' : 'unsatisfied', evidence: { acquired: mined } });
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'completed');
    assert.equal(r.reason, 'completion_verified');
    assert.equal(r.decisions, 3);
    assert.equal(r.actions, 3);
    for (const [i, e] of h.executed.entries()) {
      assert.deepEqual(e.owner, { kind: 'goal', goalEpoch: 3, goalId: 'goal-0001', taskId: 'task-0001' });
      assert.ok(h.decisions[i]!.candidates.some((c) => c.id === e.c.id), 'executed only an offered candidate of that round');
    }
    assert.equal(h.decisions[0]!.objective, SPEC.objective);
    assert.equal(h.decisions[0]!.instruction, SPEC.decisionInstruction);
    assert.equal(h.decisions[0]!.goalEpoch, 3);
  });

  it('an already-satisfied completion finishes with no inference and no action', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.evaluate = () => ({ status: 'satisfied' });
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'completed');
    assert.equal(h.decisions.length, 0);
    assert.equal(h.executed.length, 0);
  });
});

describe('task runtime: structured planner feedback', () => {
  it('no grounded option returns resolver reasons (missing tool/table/target) without calling Jev', async () => {
    const h = new Harness();
    h.unavailable = [
      { capability: 'mine_block', reason: 'harvest_tool_missing', detail: 'stone needs a pickaxe', evidence: { validTools: ['minecraft:wooden_pickaxe'] } },
      { capability: 'craft_item', reason: 'workstation_required', detail: 'needs a crafting table in reach', evidence: {} },
      { capability: 'move_near', reason: 'no_grounded_destination', detail: 'no visible target', evidence: {} },
    ];
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'no_candidates');
    assert.equal(h.decisions.length, 0);
    assert.deepEqual(r.feedback.unavailable.map((u) => u.reason), ['harvest_tool_missing', 'workstation_required', 'no_grounded_destination']);
    assert.deepEqual(r.feedback.unavailable[0]!.evidence, { validTools: ['minecraft:wooden_pickaxe'] });
    assert.equal(r.feedback.completion?.status, 'unsatisfied');
  });
});

describe('task runtime: stale epochs, late replies and revalidation', () => {
  it('ownership lost while the decision is in flight: no action, task cancelled', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.decide = async (req) => {
      h.revoke(); // stop/replacement arrives during the request
      return h.choice(req, req.candidates[0]!.id); // a late valid reply
    };
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'cancelled');
    assert.equal(h.executed.length, 0, 'the late reply cannot actuate');
    assert.equal(h.store.ofType('task_reply_discarded').length, 1);
  });

  it('a delayed reply that ignores the abort signal still cannot dispatch', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.decide = (req) => new Promise((resolve) => setTimeout(() => resolve(h.choice(req, req.candidates[0]!.id)), 30));
    const p = new TaskRuntime(h.deps()).run(h.task());
    setTimeout(() => h.revoke(), 5);
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.equal(h.executed.length, 0);
  });

  it('a connection epoch change during the decision voids the frozen round', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.decide = async (req) => {
      h.connectionEpoch = 2;
      return h.choice(req, req.candidates[0]!.id);
    };
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'cancelled');
    assert.equal(h.executed.length, 0);
  });

  it('a choice that is not an offered candidate of the frozen round is never executed', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    let n = 0;
    h.decide = async (req) => {
      n += 1;
      if (n === 1) return h.choice(req, 'act-notoffered');
      throw new DecisionError('auth', 'stop the test');
    };
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(h.executed.length, 0);
    assert.equal(h.store.ofType('task_choice_rejected').length, 1);
    assert.equal(r.reason, 'decision_not_ready');
  });

  it('a target removed between choice and execution is revalidated away (no command), then regenerated', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.world.set('blk-2', log('blk-2', 2));
    let decided = 0;
    h.decide = async (req) => {
      decided += 1;
      const chosen = req.candidates[0]!;
      if (decided === 1) h.world.delete((chosen.parameters['target'] as { handle: string }).handle); // the block vanished
      return h.choice(req, chosen.id);
    };
    let mined = 0;
    h.outcome = () => {
      mined += 1;
      return { status: 'succeeded', confirmation: 'server_packet' };
    };
    h.evaluate = () => ({ status: mined >= 1 ? 'satisfied' : 'unsatisfied' });
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'completed');
    assert.equal(h.store.ofType('task_choice_stale').length, 1);
    assert.equal(h.executed.length, 1);
    assert.equal((h.executed[0]!.c.parameters['target'] as { handle: string }).handle, 'blk-2', 'only the still-valid target was acted on');
  });

  it('a mismatched or diagnostic outcome cannot advance the task', async () => {
    for (const bad of [{ actionId: 'act-someoneelse' }, { owner: 'diagnostic' as const }, { goalEpoch: 99 }, { taskId: 'task-9999' }]) {
      const h = new Harness();
      h.world.set('blk-1', log('blk-1', 1));
      let calls = 0;
      h.outcome = () => ({ ...bad });
      h.evaluate = () => ({ status: calls++ > 0 ? 'satisfied' : 'unsatisfied' }); // would "complete" if credited
      const r = await new TaskRuntime(h.deps()).run(h.task());
      assert.equal(r.status, 'failed', JSON.stringify(bad));
      assert.equal(r.reason, 'runtime_error');
      assert.equal(h.store.ofType('task_outcome_rejected').length, 1);
    }
  });
});

describe('task runtime: retries, progress and guards', () => {
  it('per-target retries are bounded; then the task blocks with the exhausted target in feedback', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.outcome = () => ({ status: 'failed', reason: 'no_safe_path', confirmation: 'none' });
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'per_target_retries_exhausted');
    assert.equal(h.executed.length, 3, 'first attempt + 2 retries');
    assert.equal(r.feedback.exhaustedTargets.length, 1);
    assert.match(r.feedback.recentOutcomes.at(-1)!.reason ?? '', /no_safe_path/);
  });

  it('repeating the same unevidenced success without verified progress trips the no-progress window', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.outcome = () => ({ status: 'succeeded', confirmation: 'none', elapsedMs: 6_000 });
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'no_progress');
  });

  it('two options that undo each other (equip A / equip B) are bounded quickly, not polled until the window ends', async () => {
    const h = new Harness();
    let held = 'a';
    h.generateHook = () => [{ handle: held === 'a' ? 'itm-b' : 'itm-a', capability: 'equip_item', block: held === 'a' ? [2, 0, 0] : [1, 0, 0] }];
    h.world.set('itm-a', { handle: 'itm-a', capability: 'equip_item', block: [1, 0, 0] });
    h.world.set('itm-b', { handle: 'itm-b', capability: 'equip_item', block: [2, 0, 0] });
    h.outcome = (c) => {
      held = (c.parameters['target'] as { handle: string }).handle === 'itm-a' ? 'a' : 'b';
      return { status: 'succeeded', confirmation: 'server_sync', elapsedMs: 300 };
    };
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'repeated_without_progress');
    assert.ok(h.decisions.length <= 8, `bounded: ${h.decisions.length} decisions`);
  });

  it('low health interrupts before any decision', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    h.health = 6;
    const r = await new TaskRuntime(h.deps()).run(h.task());
    assert.equal(r.reason, 'low_health');
    assert.equal(h.decisions.length, 0);
  });

  it('decision failures map to explicit task results', async () => {
    for (const [kind, status, reason] of [
      ['auth', 'blocked', 'decision_not_ready'],
      ['not_configured', 'blocked', 'decision_not_ready'],
      ['payment', 'blocked', 'decision_not_ready'],
      ['spend_cap', 'blocked', 'decision_limit'],
      ['attempt_limit', 'blocked', 'decision_limit'],
      ['transient', 'failed', 'decision_error'],
      ['invalid_response', 'failed', 'decision_error'],
    ] as const) {
      const h = new Harness();
      h.world.set('blk-1', log('blk-1', 1));
      h.decide = async () => {
        throw new DecisionError(kind, 'fixture');
      };
      const r = await new TaskRuntime(h.deps()).run(h.task());
      assert.equal(r.status, status, kind);
      assert.equal(r.reason, reason, kind);
      assert.equal(h.executed.length, 0);
    }
  });
});

describe('task runtime: stable sustained waiting', () => {
  const FOLLOW: TaskSpec = { ...SPEC, objective: 'Stay near the owner.', allowedCapabilities: ['follow_entity'], completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } };
  const owner: Target = { handle: 'ent-1', capability: 'follow_entity', block: [9, 9, 9] };

  it('healthy follow windows continue locally: ONE Jev decision, no repeated inference, no false no-progress', async () => {
    const h = new Harness();
    h.world.set('ent-1', owner);
    let windows = 0;
    h.outcome = () => {
      windows += 1;
      if (windows === 6) h.revoke(); // operator stop during the 6th window
      return { status: 'succeeded', confirmation: 'client_only', elapsedMs: 30_000 };
    };
    // The owner starts out of range (violation -> one decision), then stays near while followed.
    h.evaluate = () => ({ status: windows === 0 ? 'unsatisfied' : 'satisfied' });
    const r = await new TaskRuntime(h.deps()).run(h.task(FOLLOW, 'maintain'));
    assert.equal(r.status, 'cancelled');
    assert.equal(h.decisions.length, 1, 'stable following made exactly one inference call');
    assert.equal(r.localContinuations, 5);
    assert.equal(h.store.ofType('task_local_continuation').length, 5);
    assert.ok(h.t - 1_000_000 >= 180_000, '3 minutes of healthy waiting without a no-progress block');
  });

  it('owner loss ends the sustained action; with no grounded follow option the task blocks with evidence', async () => {
    const h = new Harness();
    h.world.set('ent-1', owner);
    let windows = 0;
    h.outcome = () => {
      windows += 1;
      if (windows === 2) {
        h.world.delete('ent-1');
        h.unavailable = [{ capability: 'follow_entity', reason: 'owner_not_visible', detail: 'the owner is not currently visible', evidence: {} }];
        return { status: 'failed', reason: 'target_lost', confirmation: 'client_only', elapsedMs: 10_000 };
      }
      return { status: 'succeeded', confirmation: 'client_only', elapsedMs: 30_000 };
    };
    h.evaluate = () => ({ status: windows === 0 ? 'unsatisfied' : windows >= 2 ? 'unknown' : 'satisfied' });
    const r = await new TaskRuntime(h.deps()).run(h.task(FOLLOW, 'maintain'));
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'no_candidates');
    assert.equal(r.feedback.unavailable[0]!.reason, 'owner_not_visible');
    assert.equal(h.decisions.length, 1);
  });

  it('maintain: while the kept condition holds and nothing sustained runs, the task holds locally with no inference; a violation triggers one decision', async () => {
    const h = new Harness();
    h.world.set('blk-1', { handle: 'blk-1', capability: 'move_near', block: [5, 0, 0] });
    let holds = 0;
    let violated = false;
    h.evaluate = () => ({ status: violated ? 'unsatisfied' : 'satisfied' });
    h.outcome = () => {
      h.revoke();
      return { status: 'succeeded', confirmation: 'client_only' };
    };
    const r = await new TaskRuntime(
      h.deps({
        sleep: async () => {
          holds += 1;
          h.t += 1_000;
          if (holds === 40) violated = true; // the owner walked away after 40 s
        },
      }),
    ).run(h.task({ ...SPEC, allowedCapabilities: ['move_near'], completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, 'maintain'));
    assert.equal(holds, 40);
    assert.equal(h.decisions.length, 1, 'only the violation asked Jev');
    assert.equal(h.store.ofType('task_holding').length, 1);
    assert.equal(r.status, 'cancelled');
  });

  it('idle: a runtime that is not running makes no calls', async () => {
    const h = new Harness();
    new TaskRuntime(h.deps());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.decisions.length, 0);
  });
});


describe('task runtime: immediate-safety hold seam (MB-FLOW-003-C11/C13 shared wiring)', () => {
  class FakeSafety {
    held: { reason: 'episode' | 'blocked'; detail: string; episodeId: string | null } | null = null;
    waits = 0;
    next: 'clear' | 'blocked' = 'clear';
    hold() {
      return this.held ? { ...this.held, response: null, hazards: [], sinceMs: 0 } : null;
    }
    async waitClear(_signal: AbortSignal) {
      this.waits += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (this.next === 'blocked') return { status: 'blocked' as const, waitedMs: 5, reason: 'no_exit', detail: 'no observed shore', hazards: [] };
      this.held = null;
      return { status: 'clear' as const, waitedMs: 5, episodes: 1 };
    }
  }

  it('no candidate is dispatched and no Jev call is made while safety holds; work continues from fresh state when clear', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    const safety = new FakeSafety();
    safety.held = { reason: 'episode', detail: 'escaping water', episodeId: 'se-0001' };
    let mined = 0;
    h.outcome = () => {
      mined += 1;
      return { status: 'succeeded', confirmation: 'server_packet' };
    };
    h.evaluate = () => ({ status: mined >= 1 ? 'satisfied' : 'unsatisfied' });
    const r = await new TaskRuntime(h.deps({ safety })).run(h.task());
    assert.equal(r.status, 'completed');
    assert.equal(safety.waits, 1);
    assert.equal(h.decisions.length, 1, 'Jev only after the hold cleared');
    const events = h.store.events.map((e) => e['type']);
    assert.ok(events.indexOf('task_safety_hold') < events.indexOf('task_safety_clear'));
    assert.ok(events.indexOf('task_safety_clear') < events.indexOf('task_round'));
  });

  it('a safety blocker ends the task blocked/safety_blocked declaratively without dispatch', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    const safety = new FakeSafety();
    safety.held = { reason: 'blocked', detail: 'submerged, no exit', episodeId: null };
    safety.next = 'blocked';
    const r = await new TaskRuntime(h.deps({ safety })).run(h.task());
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'safety_blocked');
    assert.equal(h.decisions.length, 0);
    assert.equal(h.executed.length, 0);
  });

  it('a hazard that begins while Jev decides defers the chosen action (nothing dispatched); the task continues after clear', async () => {
    const h = new Harness();
    h.world.set('blk-1', log('blk-1', 1));
    const safety = new FakeSafety();
    let first = true;
    h.decide = async (req) => {
      if (first) {
        first = false;
        safety.held = { reason: 'episode', detail: 'zombie close', episodeId: 'se-0002' };
      }
      return h.choice(req, req.candidates[0]!.id);
    };
    let mined = 0;
    h.outcome = () => {
      mined += 1;
      return { status: 'succeeded', confirmation: 'server_packet' };
    };
    h.evaluate = () => ({ status: mined >= 1 ? 'satisfied' : 'unsatisfied' });
    const r = await new TaskRuntime(h.deps({ safety })).run(h.task());
    assert.equal(r.status, 'completed');
    assert.equal(h.executed.length, 1, 'the deferred choice was never executed; one fresh dispatch after clear');
    assert.ok(h.store.events.some((e) => e['type'] === 'task_choice_deferred'));
  });
});
