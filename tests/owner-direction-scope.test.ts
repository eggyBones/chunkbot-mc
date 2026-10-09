// P-PLAN-R17: owner-direction scope of an admitted task. Actual 262 P4
// (goal-2617b17b932f, "bring me some bread"): the immutable outcome
// ALL(possess 3 bread, near owner 2) made EVERY task of the goal
// owner-direction-only, so the planner's resource-search window
// (explore_frontier, task-09e0f79c75df) was refused `owner_direction_required`
// before any action and the goal ended cannot_execute.
//
// Producer: the real GoalEngine window path (planner proposal -> checked plan ->
// AdmittedTask). Consumer: the real SkillRuntime candidate generator and
// SkillExecutor over the production composition (locator routes enabled).
// Owner seeking keeps owner-direction-only scope; a resource search inside a
// multi-condition resource+delivery goal is bounded by the ORIGINAL admission
// anchor/radius, never by an owner-route leg.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { parseConfig } from '../src/config/load.ts';
import {
  sequentialIds,
  systemClock,
  type AdmittedTask,
  type BoundPredicate,
  type InventoryBaseline,
  type OutcomePredicate,
  type PlannerProposal,
  type PredicateEvaluation,
  type PredicateEvaluator,
  type Readiness,
  type TaskExecutionPort,
  type TaskResult,
  type TaskSpec,
} from '../src/contracts/index.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ScriptedPlanner, makeEngine, until } from './helpers.ts';
import { scene, stopPhysics } from './safety-session.ts';

after(stopPhysics);
const OWNER = { surface: 'chat', principal: 'owner' } as const;
const cap = (id: string, family = 'test', targets: string[] = []) => ({ id, family, purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], targets, timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'owner-scope', capabilities: [cap('explore_frontier', 'exploration', ['frontier']), cap('inspect_container'), cap('follow_entity', 'movement', ['owner']), cap('seek_owner', 'movement', ['owner']), cap('move_near', 'movement', ['owner'])] });
const bread: OutcomePredicate = { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 3, mode: 'possess' };
const nearOwner: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 2 };
const breadToOwner: OutcomePredicate = { predicate: 'all', of: [bread, nearOwner] };
const searchBread: TaskSpec = { objective: 'Search one nearby frontier for bread or wheat sources.', decisionInstruction: 'Explore.', allowedCapabilities: ['explore_frontier'], targetSelectors: [], parameters: {}, completion: bread };

class Outcomes implements PredicateEvaluator {
  async captureBaseline(): Promise<InventoryBaseline> { return { capturedAtMs: 1, counts: {}, detail: 'fake admission inventory' }; }
  async bind(predicate: OutcomePredicate): Promise<BoundPredicate> { return { predicate, boundAtMs: 1, baselines: {} }; }
  async evaluate(): Promise<PredicateEvaluation> { return { status: 'unsatisfied', predicate: 'all', detail: '0/2 satisfied', evidence: {} }; }
}
class Tasks implements TaskExecutionPort {
  readonly runs: AdmittedTask[] = [];
  readiness(): Readiness { return { ready: true, detail: 'capture' }; }
  async run(t: AdmittedTask): Promise<TaskResult> {
    this.runs.push(t);
    return { taskId: t.taskId, status: 'blocked', reason: 'no_candidates', detail: 'capture only', rounds: 1, decisions: 0, actions: 0, localContinuations: 0, feedback: { taskId: t.taskId, objective: t.spec.objective, status: 'blocked', reason: 'no_candidates', detail: 'capture only', unavailable: [], recentOutcomes: [], exhaustedTargets: [], completion: null } };
  }
}

/** The real GoalEngine admits ONE window of `tasks` for `outcome`; returns the AdmittedTask it built. */
async function admitted(outcome: OutcomePredicate, task: TaskSpec, kind: 'finite' | 'persistent' = 'finite'): Promise<AdmittedTask> {
  const planner = new ScriptedPlanner();
  const tasks = new Tasks();
  const h = makeEngine({ planner, outcomes: new Outcomes(), tasks, capabilities: CAPS, executor: { readiness: () => ({ ready: true, detail: 'unused' }), execute: async () => { throw new Error('unused'); } }, registry: new VersionKnowledge({ version: '26.1.2' }), limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 4, plannerTimeoutMs: 2_000, planWindowSteps: 8, totalTaskCeiling: 8, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 0 } });
  await h.engine.submit('bring me some bread', OWNER);
  await until(() => planner.waiting === 1);
  const proposal = { version: 1, disposition: 'plan', interpretation: 'bring bread to the owner', outcome: kind === 'finite' ? { kind, outcome } : { kind, maintain: outcome }, tasks: [task], morePlanningNeeded: true } as PlannerProposal;
  planner.respond(proposal);
  await until(() => tasks.runs.length === 1 || h.engine.status().goal?.state === 'blocked');
  assert.equal(tasks.runs.length, 1, `window admitted: ${JSON.stringify(h.store.events.slice(-12))}`);
  return tasks.runs[0]!;
}

const config = parseConfig({ minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' }, limits: { travelRadius: 16 } });
function consumer() {
  const sc = scene({ pool: false });
  const store = new MemoryRunStore();
  const epoch = 1;
  const runtime = new SkillRuntime({ config, features: { locator: true }, session: () => sc.session, connectionEpoch: () => 1, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds() });
  runtime.onGoalAdmitted({ goalId: 'goal-2617b17b932f', epoch, admittedAtMs: Date.now(), deadlineAtMs: Date.now() + 600_000, source: { kind: 'owner' } });
  return { sc, runtime, epoch, store };
}
const ownerOf = (t: AdmittedTask) => ({ kind: 'goal' as const, goalId: t.goalId, goalEpoch: 1, taskId: t.taskId, ...(t.requiresOwnerDirection ? { requiresOwnerDirection: true } : {}) });

describe('P-PLAN-R17 owner-direction scope (actual producer and consumer)', () => {
  it('resource search inside an actual resource+delivery outcome is not owner-direction-only; frontiers are offered inside the ORIGINAL bound', async () => {
    const t = await admitted(breadToOwner, searchBread);
    assert.ok(!t.requiresOwnerDirection, 'P4 search window keeps resource exploration authority');
    const c = consumer();
    const snapshot = c.runtime.perception.take(c.epoch)!;
    const set = c.runtime.candidates.generate(t.spec, snapshot, t.destructiveScope, t.requiresOwnerDirection);
    assert.ok(!set.unavailable.some((u) => u.reason === 'owner_direction_required'), JSON.stringify(set.unavailable));
    assert.ok(set.candidates.length > 0 && set.candidates.every((x) => x.capability === 'explore_frontier'), JSON.stringify(set.unavailable));
    const admission = c.runtime.perception.admissionBounds()!;
    for (const x of set.candidates) {
      const r = c.runtime.perception.resolve(snapshot.id, (x.parameters['frontier'] as { handle: string }).handle);
      assert.ok(!('error' in r) && r.target.kind === 'frontier');
      if (!('error' in r) && r.target.kind === 'frontier') assert.ok(Math.hypot(r.target.at.x - admission.anchor.x, r.target.at.z - admission.anchor.z) <= admission.radius);
    }
  });

  it('owner seeking keeps owner-direction-only scope: pure follow outcome, owner-targeted delivery task, owner selector', async () => {
    const cases: Array<[OutcomePredicate, TaskSpec, 'finite' | 'persistent', string]> = [
      [nearOwner, { ...searchBread, objective: 'Look around for the owner.', completion: bread }, 'persistent', 'pure follow outcome: any exploration window is owner seeking'],
      [breadToOwner, { ...searchBread, objective: 'Bring it over.', completion: nearOwner }, 'finite', 'delivery leg of a mixed outcome'],
      [breadToOwner, { ...searchBread, objective: 'Find the owner.', targetSelectors: [{ kind: 'owner' }] }, 'finite', 'owner-targeted selector'],
      [breadToOwner, { ...searchBread, objective: 'Bread then owner.', completion: breadToOwner }, 'finite', 'task completion includes the owner atom'],
    ];
    for (const [outcome, task, kind, why] of cases) {
      const t = await admitted(outcome, task, kind);
      assert.equal(t.requiresOwnerDirection, true, why);
      const c = consumer();
      const snapshot = c.runtime.perception.take(c.epoch)!;
      const set = c.runtime.candidates.generate(t.spec, snapshot, t.destructiveScope, t.requiresOwnerDirection);
      assert.ok(set.unavailable.some((u) => u.reason === 'owner_direction_required'), why);
      assert.equal(set.candidates.filter((x) => x.capability === 'explore_frontier').length, 0, why);
    }
  });

  it('a live owner-route leg never extends a resource search: frontiers beyond the ORIGINAL bound are neither offered nor executed', async () => {
    const t = await admitted(breadToOwner, searchBread);
    const c = consumer();
    const admission = c.runtime.perception.admissionBounds()!;
    // An owner-directed leg (e.g. from an earlier seek window) is live for this goal.
    assert.ok(c.runtime.routes!.beginLeg({ goalEpoch: c.epoch, connectionEpoch: 1, dimension: admission.dimension, at: admission.anchor, destination: 'owner', bearingRad: 0 }).ok);
    const snapshot = c.runtime.perception.take(c.epoch)!;
    const outside = snapshot.frontiers.filter((f) => Math.hypot(f.at.x - admission.anchor.x, f.at.z - admission.anchor.z) > admission.radius);
    assert.ok(outside.length > 0, 'the leg genuinely exposes frontiers beyond the original bound');
    assert.ok(outside.every((f) => c.runtime.perception.withinTravel(f.at)), 'precondition: the leg admits them for owner-directed travel');
    const set = c.runtime.candidates.generate(t.spec, snapshot, t.destructiveScope, t.requiresOwnerDirection);
    for (const x of set.candidates) {
      const handle = (x.parameters['frontier'] as { handle: string }).handle;
      assert.ok(!outside.some((f) => f.handle === handle), `resource search offered leg-only frontier ${handle}`);
    }
    const writes = c.sc.client.written.length;
    const out = await c.runtime.executor.execute({ id: 'act-r17leg', snapshotId: snapshot.id, connectionEpoch: 1, goalEpoch: c.epoch, capability: 'explore_frontier', parameters: { frontier: { snapshotId: snapshot.id, handle: outside[0]!.handle } }, description: 'leg-only frontier', criteria: [], preconditions: [], timeoutMs: 1_000 }, new AbortController().signal, ownerOf(t));
    assert.equal(out.status, 'precondition_failed');
    assert.equal(out.reason, 'outside_admission_bounds');
    assert.equal(c.sc.client.written.length, writes, 'no navigation command before the refusal');
  });
});
