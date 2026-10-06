// Rolling planner/task-window integration in the goal engine (fake ports):
// admission baseline before the first planner turn and outcome binding to it,
// counters and turn kinds preserved across knowledge/windows/replans,
// immutable outcome, window exhaustion != completion, replan limit,
// persistent maintain mode, transport retry/limits, stop ordering around the
// planner process, and ledger-verified prior results.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AdmittedTask,
  BoundPredicate,
  InventoryBaseline,
  OutcomePredicate,
  PlannerProposal,
  PlannerRequest,
  PredicateEvaluation,
  PredicateEvaluator,
  Readiness,
  TaskExecutionPort,
  TaskResult,
  TaskSpec,
} from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PlannerError } from '../src/planner/errors.ts';
import { ScriptedPlanner, makeEngine, tick, until } from './helpers.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const FACTS = new VersionKnowledge({ version: '26.1.2' });
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'test-3', capabilities: [cap('mine_block'), cap('move_near'), cap('follow_entity')] });
const READY_EXECUTOR = { readiness: (): Readiness => ({ ready: true, detail: 'fake executor' }), execute: async () => { throw new Error('not used'); } };

const cobble: OutcomePredicate = { predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 2, mode: 'collect_additional' };
const near: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const task = (objective: string, completion: OutcomePredicate = cobble, extra: Partial<TaskSpec> = {}): TaskSpec => ({ objective, decisionInstruction: 'do it', allowedCapabilities: ['mine_block'], targetSelectors: [], parameters: {}, completion, ...extra });
const plan = (tasks: TaskSpec[], outcome: OutcomePredicate = cobble, kind: 'finite' | 'persistent' = 'finite'): PlannerProposal =>
  ({ version: 1, disposition: 'plan', interpretation: 'collect two more cobblestone', outcome: kind === 'finite' ? { kind, outcome } : { kind, maintain: outcome }, tasks, morePlanningNeeded: true }) as PlannerProposal;
const info: PlannerProposal = { version: 1, disposition: 'needs_information', interpretation: 'need harvest rules', queries: [{ kind: 'harvest', block: 'minecraft:stone' }] };

class FakeOutcomes implements PredicateEvaluator {
  readonly log: string[];
  satisfied = false;
  readonly boundWith: Array<InventoryBaseline | undefined> = [];
  readonly baseline: InventoryBaseline = { capturedAtMs: 1_000, counts: { 'minecraft:cobblestone': 3 }, detail: 'fake server inventory at admission' };
  constructor(log: string[]) {
    this.log = log;
  }
  async captureBaseline(): Promise<InventoryBaseline> {
    this.log.push('baseline');
    return this.baseline;
  }
  async bind(predicate: OutcomePredicate, _signal: AbortSignal, baseline?: InventoryBaseline): Promise<BoundPredicate> {
    this.log.push('bind');
    this.boundWith.push(baseline);
    return { predicate, boundAtMs: baseline?.capturedAtMs ?? 0, baselines: { 'inv:minecraft:cobblestone': baseline?.counts?.['minecraft:cobblestone'] ?? Number.NaN } };
  }
  async evaluate(): Promise<PredicateEvaluation> {
    return { status: this.satisfied ? 'satisfied' : 'unsatisfied', predicate: 'inventory_amount', detail: this.satisfied ? 'acquired 2/2' : 'acquired 0/2', evidence: {} };
  }
}

class FakeTasks implements TaskExecutionPort {
  readonly runs: AdmittedTask[] = [];
  readonly log: string[];
  outcomes: Array<Partial<TaskResult>> = [];
  constructor(log: string[]) {
    this.log = log;
  }
  readiness(): Readiness {
    return { ready: true, detail: 'fake task runtime' };
  }
  async run(t: AdmittedTask): Promise<TaskResult> {
    this.runs.push(t);
    this.log.push(`task:${t.mode}:${t.spec.objective}`);
    const o = this.outcomes.shift() ?? {};
    if (o.reason === 'hold') await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
    const status = t.signal.aborted ? 'cancelled' : (o.status ?? 'completed');
    return { taskId: t.taskId, status, reason: o.reason ?? 'completion_verified', detail: 'fake', rounds: 1, decisions: 1, actions: 1, localContinuations: 0, feedback: { taskId: t.taskId, objective: t.spec.objective, status, reason: o.reason ?? 'completion_verified', detail: 'fake', unavailable: [], recentOutcomes: o.feedback?.recentOutcomes ?? [], exhaustedTargets: [], completion: null } };
  }
}

function harness(over: Parameters<typeof makeEngine>[0] = {}, limits: Partial<ReturnType<typeof makeEngine>['engine'] extends never ? never : Record<string, number>> = {}) {
  const log: string[] = [];
  const planner = new ScriptedPlanner(log);
  const outcomes = new FakeOutcomes(log);
  const tasks = new FakeTasks(log);
  const h = makeEngine(
    {
      planner,
      outcomes,
      tasks,
      capabilities: CAPS,
      executor: READY_EXECUTOR,
      registry: FACTS,
      limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 2_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 8, ...limits },
      ...over,
    },
    log,
  );
  return { ...h, planner, outcomes, tasks, log };
}

const req = (p: ScriptedPlanner, i: number): PlannerRequest => p.requests[i] as PlannerRequest;

describe('rolling planner/task windows', () => {
  it('captures the ALL-item admission baseline before the first planner turn, binds the outcome to it once, and preserves counters/turn kinds across knowledge, windows and replans', async () => {
    const h = harness();
    await h.engine.submit('get me two cobblestone', OWNER);
    await until(() => h.planner.waiting === 1);
    assert.deepEqual(h.log.slice(0, 2), ['baseline', 'planner:request:get me two cobblestone'], 'baseline before the first planner turn');
    assert.deepEqual(req(h.planner, 0).admission?.counts, [{ key: 'minecraft:cobblestone', count: 3 }]);
    assert.equal(req(h.planner, 0).turnKind, 'initial');
    h.planner.respond(info);
    await until(() => h.planner.waiting === 1 && h.planner.requests.length === 2);
    assert.equal(req(h.planner, 1).turnKind, 'knowledge');
    assert.equal(req(h.planner, 1).knowledge.length, 1);
    h.planner.respond(plan([task('mine stone')]));
    await until(() => h.planner.waiting === 1 && h.planner.requests.length === 3);
    assert.deepEqual(h.outcomes.boundWith, [h.outcomes.baseline], 'outcome bound to the ADMISSION baseline (original counts)');
    const r3 = req(h.planner, 2);
    assert.equal(r3.turnKind, 'replan');
    assert.deepEqual(r3.acceptedOutcome, { kind: 'finite', outcome: cobble });
    assert.equal(r3.outcomeStatus?.status, 'unsatisfied');
    assert.deepEqual(r3.counters, { plannerTurns: 3, knowledgeRounds: 1, repairs: 0, retries: 0, clarifications: 0, replans: 1, windows: 1, tasksAdmitted: 1 });
    assert.equal(h.engine.status().goal?.state, 'planning', 'a finished window is not goal completion');
    h.outcomes.satisfied = true;
    h.planner.respond(plan([task('mine more stone')]));
    await until(() => h.engine.status().goal?.state === 'completed');
    const g = h.engine.status().goal!;
    assert.equal(g.terminal?.reason, 'outcome_verified');
    assert.deepEqual(g.counters, { plannerTurns: 3, knowledgeRounds: 1, repairs: 0, retries: 0, clarifications: 0, replans: 1, windows: 2, tasksAdmitted: 2 });
    assert.equal(h.outcomes.boundWith.length, 1, 'bound once');
    assert.equal(h.log.filter((l) => l === 'baseline').length, 1);
  });

  it('a revision that changes the accepted outcome is rejected before any action and answered with a counted repair turn', async () => {
    const h = harness();
    await h.engine.submit('get me two cobblestone', OWNER);
    await until(() => h.planner.waiting === 1);
    h.planner.respond(plan([task('mine stone')]));
    await until(() => h.planner.requests.length === 2 && h.planner.waiting === 1);
    const ranBefore = h.tasks.runs.length;
    h.planner.respond(plan([task('get only one')], { ...cobble, atLeast: 1 } as OutcomePredicate));
    await until(() => h.planner.requests.length === 3 && h.planner.waiting === 1);
    assert.equal(h.tasks.runs.length, ranBefore, 'no task from the outcome-changing revision');
    assert.equal(req(h.planner, 2).turnKind, 'repair');
    assert.match(req(h.planner, 2).rejection?.problems.join(' ') ?? '', /changes the accepted goal outcome/);
    h.outcomes.satisfied = true;
    h.planner.respond(plan([task('mine stone again')]));
    await until(() => h.engine.status().goal?.state === 'completed');
    assert.equal(h.engine.status().goal?.counters?.repairs, 1);
  });

  it('window exhaustion never completes a goal; the replan limit ends it limit_exhausted with progress', async () => {
    const h = harness({}, { replans: 1 });
    await h.engine.submit('get me two cobblestone', OWNER);
    for (let i = 0; i < 2; i += 1) {
      await until(() => h.planner.waiting === 1 && h.planner.requests.length === i + 1);
      h.planner.respond(plan([task(`window ${i + 1}`)]));
    }
    await until(() => h.engine.status().goal?.state === 'blocked');
    const g = h.engine.status().goal!;
    assert.equal(g.terminal?.reason, 'limit_exhausted');
    assert.match(g.terminal?.detail ?? '', /replan limit \(1\).*windows 2/);
  });

  it('persistent outcomes run their maintaining task in maintain mode (no completion from holding)', async () => {
    const h = harness();
    h.tasks.outcomes = [{ reason: 'hold' }];
    await h.engine.submit('follow me', OWNER);
    await until(() => h.planner.waiting === 1);
    h.planner.respond({ ...plan([task('stay near the owner', near, { allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }] })], near, 'persistent'), morePlanningNeeded: false } as PlannerProposal);
    await until(() => h.tasks.runs.length === 1);
    assert.equal(h.tasks.runs[0]!.mode, 'maintain');
    await tick(50);
    assert.equal(h.engine.status().goal?.state, 'executing');
    await h.engine.stop('owner_stop');
    assert.equal(h.engine.status().goal?.state, 'cancelled');
  });

  it('a timed-out planner turn is retried once (counted), then the goal fails planner_error; quota blocks immediately without retry', async () => {
    const h = harness({}, { plannerTimeoutMs: 40 });
    await h.engine.submit('do something', OWNER);
    await until(() => h.engine.status().goal?.state === 'failed', 3_000);
    assert.equal(h.engine.status().goal?.terminal?.reason, 'planner_error');
    assert.deepEqual([h.planner.requests.length, h.engine.status().goal?.counters?.retries, h.planner.requests[1]?.turnKind], [2, 1, 'retry']);

    const quota = harness({ planner: { readiness: () => ({ ready: true, detail: 'q' }), propose: async () => { throw new PlannerError('quota', "You've hit your usage limit"); } } });
    await quota.engine.submit('do something', OWNER);
    await until(() => quota.engine.status().goal?.state === 'blocked');
    assert.equal(quota.engine.status().goal?.terminal?.reason, 'planner_not_ready');
    assert.match(quota.engine.status().goal?.terminal?.detail ?? '', /usage limit.*no paid or alternative planner/);
    assert.equal(quota.engine.status().goal?.plannerTurns, 1);
  });

  it('stop during a planner turn revokes ownership at once, but revocation awaits the planner process cleanup before a replacement plans', async () => {
    const log: string[] = [];
    const slowCleanup = {
      calls: 0,
      readiness: (): Readiness => ({ ready: true, detail: 'slow cleanup planner' }),
      propose(request: PlannerRequest, signal: AbortSignal): Promise<PlannerProposal> {
        this.calls += 1;
        log.push(`request:${request.instruction}`);
        return new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => {
          log.push(`cleanup-done:${request.instruction}`);
          reject(new PlannerError('aborted', 'killed'));
        }, 120), { once: true }));
      },
    };
    const h = harness({ planner: slowCleanup });
    await h.engine.submit('first goal', OWNER);
    await until(() => log.length === 1);
    const t = Date.now();
    await h.engine.submit('second goal', OWNER);
    await until(() => log.includes('request:second goal'));
    assert.deepEqual(log, ['request:first goal', 'cleanup-done:first goal', 'request:second goal'], 'old planner process cleaned up before the replacement planned');
    assert.ok(Date.now() - t >= 100);
    await h.engine.stop('owner_stop');
  });

  it('ledger-verified prior results become referable by later plans; unverified ids stay invented', async () => {
    const verified: string[][] = [];
    const h = harness({
      priorResults: (ids) => {
        verified.push([...ids]);
        return ids.filter((id) => id === 'act-placedtable').map((actionId) => ({ actionId, key: 'minecraft:crafting_table', at: { x: 1, y: 2, z: 3 }, dimension: 'overworld' }));
      },
    });
    h.tasks.outcomes = [{ feedback: { recentOutcomes: [{ actionId: 'act-placedtable', capability: 'place_block', status: 'succeeded', confirmation: 'server_packet', effect: 'placed', via: 'jev' }, { actionId: 'act-otherthing', capability: 'move_near', status: 'succeeded', confirmation: 'client_only', effect: 'moved', via: 'jev' }] } as unknown as TaskResult['feedback'] }];
    await h.engine.submit('get me two cobblestone', OWNER);
    await until(() => h.planner.waiting === 1);
    h.planner.respond(plan([task('place a table')]));
    await until(() => h.planner.requests.length === 2 && h.planner.waiting === 1);
    assert.deepEqual(verified, [['act-placedtable', 'act-otherthing']]);
    assert.deepEqual(req(h.planner, 1).priorResults?.map((r) => r.actionId), ['act-placedtable']);
    h.planner.respond(plan([task('use the placed table', cobble, { targetSelectors: [{ kind: 'prior_result', actionId: 'act-placedtable' }] })]));
    await until(() => h.tasks.runs.length === 2);
    h.planner.respond(plan([task('invented', cobble, { targetSelectors: [{ kind: 'prior_result', actionId: 'act-otherthing' }] })]));
    await until(() => h.planner.requests.length === 4 && h.planner.waiting === 1);
    assert.match(req(h.planner, 3).rejection?.problems.join(' ') ?? '', /act-otherthing is not a verified prior result/);
    await h.engine.stop('owner_stop');
  });
});
