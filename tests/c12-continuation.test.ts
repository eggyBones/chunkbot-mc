// MB-FLOW-003-C12 same-session continuation (shared seam, P): count lineage
// arithmetic, the real PredicateEngine re-binding across repeated lossy deaths,
// and the GoalEngine checkpoint lifecycle (same goal id, fresh epoch, original
// limits/deadline/anchor/route lineage, fencing by stop and new intake,
// provenance holds, finite readiness). Credential-free fakes; no world, no
// provider, no inference.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import {
  sequentialIds,
  systemClock,
  type AdmittedTask,
  type BoundPredicate,
  type ContinuationCapture,
  type ContinuationSurvivalPort,
  type CountLineage,
  type GoalOutcomeContract,
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
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import type { GameSession } from '../src/game/connection.ts';
import { groundOutcome, segmentProgress } from '../src/goals/continuation.ts';
import type { AdmissionContinuation } from '../src/goals/goal-engine.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { ScriptedPlanner, makeEngine, tick, until } from './helpers.ts';
import { ackSequenced, evidenceFor, fakeClient } from './skill-fakes.ts';

// ---------------------------------------------------------------- A. lineage arithmetic

describe('C12 count lineage arithmetic (coordinator scenarios)', () => {
  // Segment after an interruption with held H and verified credit C (N = H - C).
  const seg = (credited: number, held: number, fresh: number, incident: boolean, returnsAtF = 0) => ({ credited, nonCredit: held - credited, fresh, incident, returnsAtF });

  it('B0 8, +4 verified, death, full recovery to 12 -> credit 4 restored; new acquisition counts from there', () => {
    const s = seg(4, 12, 12, true, 12);
    assert.deepEqual(segmentProgress(s, { count: 12, returns: 12, consumed: 0 }), { restored: 4, acquiredNew: 0, progress: 4 });
    assert.equal(segmentProgress(s, { count: 18, returns: 12, consumed: 0 }).progress, 10, 'completes at 18 for a goal of 10');
  });

  it('partial recovery to 9 -> only 1 credit restored', () => {
    assert.equal(segmentProgress(seg(4, 12, 9, true, 9), { count: 9, returns: 9, consumed: 0 }).restored, 1);
  });

  it('nothing recovered, 3 genuinely new, death again -> the next credit is 3 (never max(0, 3 - 8))', () => {
    const s1 = seg(4, 12, 0, true, 0);
    const atSecondDeath = segmentProgress(s1, { count: 3, returns: 0, consumed: 0 });
    assert.deepEqual(atSecondDeath, { restored: 0, acquiredNew: 3, progress: 3 });
    // Second segment: credit 3 held 3 -> recovering the 3 restores all of it.
    const s2 = seg(atSecondDeath.progress, 3, 0, true, 0);
    assert.equal(segmentProgress(s2, { count: 3, returns: 3, consumed: 0 }).progress, 3);
  });

  it('respawn-point (incidental) pickups never restore credit or count as returned belongings', () => {
    // F = 17: 12 own returns + 5 incidental items picked up near the respawn point.
    const s = seg(4, 12, 17, true, 12);
    assert.deepEqual(segmentProgress(s, { count: 17, returns: 12, consumed: 0 }), { restored: 4, acquiredNew: 0, progress: 4 });
  });

  it('late own returns AFTER the continuation restore credit and never count as new acquisition', () => {
    const s = seg(4, 12, 0, true, 0);
    assert.deepEqual(segmentProgress(s, { count: 12, returns: 12, consumed: 0 }), { restored: 4, acquiredNew: 0, progress: 4 });
    assert.deepEqual(segmentProgress(s, { count: 14, returns: 12, consumed: 0 }), { restored: 4, acquiredNew: 2, progress: 6 });
  });

  it('no incident (low health / safety, nothing lost): credit restored from the fresh count; consumption between is respected', () => {
    assert.equal(segmentProgress(seg(4, 12, 12, false), { count: 12, returns: 0, consumed: 0 }).progress, 4);
    assert.equal(segmentProgress(seg(4, 12, 10, false), { count: 10, returns: 0, consumed: 0 }).progress, 2, 'two eaten meanwhile');
  });

  it('groundability is derived from predicate semantics', () => {
    const c: GoalOutcomeContract = {
      kind: 'finite',
      outcome: { predicate: 'all', of: [{ predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 3, mayBeConsumedLater: false }, { predicate: 'near_target', target: { kind: 'owner' }, within: 3 }, { predicate: 'entity_outcome', target: { kind: 'observed', snapshotId: 'snap-0001', handle: 'ent-1' }, outcome: 'observed_defeated' }] },
    };
    const g = groundOutcome(c, true);
    assert.deepEqual(g.map((x) => [x.path, x.status, x.reason ?? null]), [['root.0', 'groundable', null], ['root.1', 'groundable', null], ['root.2', 'not_groundable', 'observed_handle']]);
    assert.equal(groundOutcome({ kind: 'finite', outcome: { predicate: 'not', of: { predicate: 'inventory_delta', selector: 'minecraft:dirt', atLeast: 1, mayBeConsumedLater: false } } }, true)[0]!.reason, 'count_under_any_or_not');
    assert.equal(groundOutcome({ kind: 'finite', outcome: { predicate: 'inventory_delta', selector: 'minecraft:dirt', atLeast: 1, mayBeConsumedLater: false } }, false)[0]!.reason, 'baseline_unknown');
  });
});

// ---------------------------------------------------------------- B. real PredicateEngine re-binding

const registry = createRequire(import.meta.url)('prismarine-registry')('26.1.2');
function world() {
  const slots = new Map<number, { name: string; count: number }>();
  const client = fakeClient((name, data) => {
    if (name === 'window_click' && data['stateId'] === -1) {
      setImmediate(() => {
        const items = Array.from({ length: 46 }, (_, i) => {
          const s = slots.get(i);
          return s ? { itemCount: s.count, itemId: registry.itemsByName[s.name].id } : { itemCount: 0 };
        });
        client.emit('window_items', { windowId: 0, stateId: 9, items });
      });
    }
    ackSequenced(client, name, data);
  });
  const evidence = evidenceFor(client);
  (evidence as unknown as { registry: unknown }).registry = registry;
  const bot = { _client: client, registry, currentWindow: null, quickBarSlot: 0, entities: {}, game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 0, z: 0 } }, username: 'Chunkbot', players: {} };
  const session = { bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const ledger = new EvidenceLedger(systemClock);
  const services = { perception: new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 8, travelRadius: 32 }), knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger, clock: systemClock, limits: { observationRadius: 8, travelRadius: 32, ownerLossMs: 1_000 } };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
  const returns = new Map<string, number | null>();
  const engine = new PredicateEngine({ services, session: () => session, leases, incidentReturns: (id) => (returns.has(id) ? returns.get(id)! : 0) });
  const hold = (n: number) => (n > 0 ? slots.set(36, { name: 'cobblestone', count: n }) : slots.delete(36));
  return { engine, ledger, hold, returns };
}
const sig = () => new AbortController().signal;
const COBBLE: OutcomePredicate = { predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 10, mode: 'collect_additional' };
const CONTRACT: GoalOutcomeContract = { kind: 'finite', outcome: COBBLE };
const owner = { goalId: 'goal-0001', goalEpoch: 1 };

describe('C12 PredicateEngine: repeated lossy deaths keep only code-verified lineage credit', () => {
  it('B0 8, +4, death (nothing recovered), +3 new, death, recover those 3, then +7 -> satisfied; returned items never double count', async () => {
    const w = world();
    const original: InventoryBaseline = { capturedAtMs: Date.now(), counts: { 'minecraft:cobblestone': 8 }, detail: 'admission', lifecycleMark: 0, connectionEpoch: 1 };
    const bound1 = await w.engine.bind(COBBLE, sig(), original, owner);
    w.hold(12);
    assert.equal((await w.engine.evaluate(bound1, sig())).evidence['acquired'], 4);
    // Death 1: capture (ledger valid) then progress from the frozen last-alive counts (12).
    const cap1: ContinuationCapture = w.engine.captureContinuation(bound1);
    const p1 = w.engine.progressAt(cap1, CONTRACT, { 'minecraft:cobblestone': 12 }, () => 0);
    assert.equal(p1['root'], 4);
    const lin1: CountLineage = { path: 'root', basis: 'possession', predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 10, admissionCount: 8, credited: 4, heldAtInterruption: 12, evidence: 'last_alive_server_packets', latched: false, incidentId: 'inc-1', segments: 1 };
    // Nothing recovered: fresh 0, own returns 0. Three NEW cobblestone are mined.
    w.hold(0);
    w.ledger.invalidate('death'); // the lifecycle cleared the ledger
    w.returns.set('inc-1', 0);
    const bound2 = await w.engine.rebindContinuation(CONTRACT, { counts: [lin1], removal: [], fresh: { capturedAtMs: Date.now(), counts: {}, detail: 'fresh', lifecycleMark: w.ledger.invalidations.length, connectionEpoch: 1 }, original, owner: { goalId: 'goal-0001', goalEpoch: 3 } }, sig());
    w.hold(3);
    let e = await w.engine.evaluate(bound2, sig());
    assert.equal(e.evidence['acquired'], 3);
    assert.equal(e.evidence['restoredCredit'], 0);
    // Death 2: the next credit is the CURRENT lineage progress (3), not max(0, 3 - 8).
    const cap2 = w.engine.captureContinuation(bound2);
    const p2 = w.engine.progressAt(cap2, CONTRACT, { 'minecraft:cobblestone': 3 }, () => 0);
    assert.equal(p2['root'], 3);
    const lin2: CountLineage = { ...lin1, credited: 3, heldAtInterruption: 3, incidentId: 'inc-2', segments: 2 };
    w.hold(0);
    w.ledger.invalidate('death');
    w.returns.set('inc-2', 0);
    const bound3 = await w.engine.rebindContinuation(CONTRACT, { counts: [lin2], removal: [], fresh: { capturedAtMs: Date.now(), counts: {}, detail: 'fresh', lifecycleMark: w.ledger.invalidations.length, connectionEpoch: 1 }, original, owner: { goalId: 'goal-0001', goalEpoch: 5 } }, sig());
    // Late own returns (3) restore credit, never new acquisition.
    w.returns.set('inc-2', 3);
    w.hold(3);
    e = await w.engine.evaluate(bound3, sig());
    assert.deepEqual([e.evidence['restoredCredit'], e.evidence['newSinceContinuation'], e.evidence['acquired']], [3, 0, 3]);
    w.hold(10);
    e = await w.engine.evaluate(bound3, sig());
    assert.equal(e.status, 'satisfied', e.detail);
    assert.equal(e.evidence['acquired'], 10);
  });

  it('unknown own-incident attribution keeps the count unknown (never invented credit or new acquisition)', async () => {
    const w = world();
    const original: InventoryBaseline = { capturedAtMs: Date.now(), counts: { 'minecraft:cobblestone': 8 }, detail: 'admission', lifecycleMark: 0, connectionEpoch: 1 };
    const lin: CountLineage = { path: 'root', basis: 'possession', predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 10, admissionCount: 8, credited: 4, heldAtInterruption: 12, evidence: 'last_alive_server_packets', latched: false, incidentId: 'inc-x', segments: 1 };
    w.returns.set('inc-x', null);
    const bound = await w.engine.rebindContinuation(CONTRACT, { counts: [lin], removal: [], fresh: { capturedAtMs: Date.now(), counts: {}, detail: 'fresh', lifecycleMark: 0, connectionEpoch: 1 }, original, owner }, sig());
    w.hold(20);
    assert.equal((await w.engine.evaluate(bound, sig())).status, 'unknown');
  });

  it('effect credit survives ledger invalidation; a latched consumed milestone stays satisfied', async () => {
    const w = world();
    const crafted: GoalOutcomeContract = { kind: 'finite', outcome: { predicate: 'all', of: [{ predicate: 'crafting_result', output: 'minecraft:oak_planks', atLeast: 8 }, { predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 2, mayBeConsumedLater: true }] } };
    const original: InventoryBaseline = { capturedAtMs: Date.now() - 10, counts: {}, detail: 'admission', lifecycleMark: 0, connectionEpoch: 1 };
    const bound = await w.engine.bind((crafted as { outcome: OutcomePredicate }).outcome, sig(), original, owner);
    w.ledger.add({ kind: 'crafted', output: 'minecraft:oak_planks', count: 4, consumed: { 'minecraft:oak_log': 1 }, atMs: Date.now() });
    w.hold(2);
    await w.engine.evaluate(bound, sig()); // latches the cobblestone milestone
    const cap = w.engine.captureContinuation(bound);
    assert.equal(cap.effect['root.0'], 4);
    assert.deepEqual(cap.latched, ['root.1']);
    const diedAt = Date.now();
    w.ledger.invalidate('death');
    const counts: CountLineage[] = [
      { path: 'root.0', basis: 'effect', predicate: 'crafting_result', selector: 'minecraft:oak_planks', atLeast: 8, admissionCount: null, credited: 4, heldAtInterruption: null, evidence: 'skill_confirmed_outputs', latched: false, incidentId: null, segments: 1 },
      { path: 'root.1', basis: 'possession', predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 2, admissionCount: 0, credited: 2, heldAtInterruption: 2, evidence: 'last_alive_server_packets', latched: true, incidentId: 'inc-1', segments: 1 },
    ];
    w.hold(0);
    const re = await w.engine.rebindContinuation(crafted, { counts, removal: [], fresh: { capturedAtMs: Date.now(), counts: {}, detail: 'fresh', lifecycleMark: w.ledger.invalidations.length, connectionEpoch: 1 }, original, owner, notBeforeMs: diedAt + 1 }, sig());
    let e = await w.engine.evaluate(re, sig());
    assert.equal(e.children?.[0]?.evidence['confirmed'], 4, 'crafted planks before the death still count (not a claim of present inventory)');
    assert.equal(e.children?.[1]?.status, 'satisfied', 'latched milestone');
    w.ledger.add({ kind: 'crafted', output: 'minecraft:oak_planks', count: 4, consumed: { 'minecraft:oak_log': 1 }, atMs: diedAt + 5 });
    e = await w.engine.evaluate(re, sig());
    assert.equal(e.status, 'satisfied');
  });
});

// ---------------------------------------------------------------- C. GoalEngine checkpoint lifecycle

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const capId = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'test-c12', capabilities: [capId('mine_block'), capId('move_near')] });
const READY = { readiness: (): Readiness => ({ ready: true, detail: 'fake executor' }), execute: async () => { throw new Error('not used'); } };
const NEAR: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const LOGS: OutcomePredicate = { predicate: 'inventory_amount', selector: 'minecraft:oak_log', atLeast: 6, mode: 'collect_additional' };
const spec = (completion: OutcomePredicate): TaskSpec => ({ objective: 'work', decisionInstruction: 'do it', allowedCapabilities: ['move_near'], targetSelectors: [], parameters: {}, completion });
const planFor = (outcome: OutcomePredicate): PlannerProposal => ({ version: 1, disposition: 'plan', interpretation: 'Doing the job.', outcome: { kind: 'finite', outcome }, tasks: [spec(outcome)], morePlanningNeeded: true }) as PlannerProposal;

class HoldTasks implements TaskExecutionPort {
  readonly runs: AdmittedTask[] = [];
  readiness(): Readiness {
    return { ready: true, detail: 'fake' };
  }
  async run(t: AdmittedTask): Promise<TaskResult> {
    this.runs.push(t);
    await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
    return { taskId: t.taskId, status: 'cancelled', reason: 'ownership_revoked', detail: 'fake', rounds: 1, decisions: 0, actions: 0, localContinuations: 0, feedback: { taskId: t.taskId, objective: t.spec.objective, status: 'cancelled', reason: 'ownership_revoked', detail: 'fake', unavailable: [], recentOutcomes: [], exhaustedTargets: [], completion: null } };
  }
}

class ContOutcomes implements PredicateEvaluator {
  rebinds = 0;
  async captureBaseline(): Promise<InventoryBaseline> {
    return { capturedAtMs: Date.now(), counts: { 'minecraft:oak_log': 2 }, detail: 'fake server inventory' };
  }
  async bind(predicate: OutcomePredicate, _s: AbortSignal, baseline?: InventoryBaseline): Promise<BoundPredicate> {
    return { predicate, boundAtMs: baseline?.capturedAtMs ?? 0, baselines: {} };
  }
  async evaluate(): Promise<PredicateEvaluation> {
    return { status: 'unsatisfied', predicate: 'near_target', detail: 'not yet', evidence: {} };
  }
  captureContinuation(): ContinuationCapture {
    return { effect: {}, consumed: {}, latched: [], removal: [], segments: {}, boundAtMs: 0, baselines: {} };
  }
  progressAt(_c: ContinuationCapture, _k: GoalOutcomeContract, counts: Readonly<Record<string, number>>): Record<string, number | null> {
    return { root: Math.max(0, (counts['minecraft:oak_log'] ?? 0) - 2) };
  }
  async rebindContinuation(contract: GoalOutcomeContract): Promise<BoundPredicate> {
    this.rebinds += 1;
    return { predicate: contract.kind === 'finite' ? contract.outcome : contract.maintain, boundAtMs: Date.now(), baselines: {} };
  }
}

function harness(opts: { survival?: ContinuationSurvivalPort; alive?: () => boolean } = {}) {
  const planner = new ScriptedPlanner();
  const tasks = new HoldTasks();
  const outcomes = new ContOutcomes();
  const admissions: Array<{ goalId: string; epoch: number; continuation?: AdmissionContinuation; deadlineAtMs: number }> = [];
  const budget: Array<[string, boolean]> = [];
  const h = makeEngine({
    planner,
    capabilities: CAPS,
    executor: READY,
    tasks,
    outcomes,
    registry: new VersionKnowledge({ version: '26.1.2' }),
    connectionEpoch: () => 1,
    decisionBudget: { retainGoalBudget: (g, r) => budget.push([g, r]) },
    onGoalAdmitted: (a) => admissions.push({ goalId: a.goalId, epoch: a.epoch, deadlineAtMs: a.deadlineAtMs, ...(a.continuation ? { continuation: a.continuation } : {}) }),
    continuation: {
      sessionId: 'run-test',
      matches: (sel, key) => sel === key,
      captureAnchor: () => ({ dimension: 'overworld', at: { x: 1, y: 64, z: 2 }, radius: 128 }),
      captureRoute: () => null,
      currentDimension: () => 'overworld',
      ...(opts.alive ? { isAlive: opts.alive } : {}),
      ...(opts.survival ? { survival: opts.survival } : {}),
    },
  });
  return { ...h, planner, tasks, outcomes, admissions, budget };
}

async function runningJob(h: ReturnType<typeof harness>, outcome: OutcomePredicate, text = 'stay with me') {
  await h.engine.submit(text, OWNER);
  await until(() => h.planner.waiting === 1);
  h.planner.respond(planFor(outcome));
  await until(() => h.tasks.runs.length === 1);
  return h.engine.status().goal!;
}

describe('C12 GoalEngine: held owner job continues as the SAME goal with original limits', () => {
  it('death -> held; continuation re-admits the same id at a fresh epoch with all counters, original caps/deadline/anchor; first turn kind continuation', async () => {
    const h = harness();
    const g = await runningJob(h, NEAR);
    const turnsBefore = g.counters!.plannerTurns;
    await h.engine.endOwnership('death', 'the bot died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    const cp = h.engine.checkpoints()[0]!;
    assert.equal(cp.goalId, g.id);
    assert.deepEqual(cp.anchor, { dimension: 'overworld', at: { x: 1, y: 64, z: 2 }, radius: 128 });
    assert.ok(h.budget.some(([id, r]) => id === g.id && r), 'Jev budget retained for the same goal id');
    assert.ok(h.notices.some((n) => /held: Chunkbot continues this job when it is safe/.test(n.text)));
    const r = await h.engine.continueHeld(g.id, 'respawn_ready');
    assert.equal(r.status, 'admitted');
    const st = h.engine.status().goal!;
    assert.equal(st.id, g.id, 'same logical goal id');
    assert.ok(st.epoch > g.epoch, 'fresh, larger epoch');
    assert.deepEqual(st.continuation, { number: 1, max: 2, after: 'death' });
    const last = h.admissions.at(-1)!;
    assert.equal(last.deadlineAtMs, h.admissions[0]!.deadlineAtMs, 'ORIGINAL absolute deadline');
    assert.deepEqual(last.continuation?.anchor, cp.anchor, 'ORIGINAL anchor passed to the execution layer');
    await until(() => h.planner.waiting === 1);
    const req = h.planner.requests.at(-1)!;
    assert.equal(req.turnKind, 'continuation');
    assert.equal(req.turn, turnsBefore + 1, 'cumulative planner turns (the continuation turn counts)');
    assert.ok(req.continuation?.facts.some((f) => /SAME owner job/.test(f)));
    assert.deepEqual(req.acceptedOutcome, { kind: 'finite', outcome: NEAR }, 'immutable outcome pre-bound');
    assert.equal(h.outcomes.rebinds, 1);
    await h.engine.stop('owner_stop', 'chat');
  });

  it('explicit stop fences a held job (resume never revives it); a new owner instruction supersedes it', async () => {
    const h = harness();
    const g = await runningJob(h, NEAR);
    await h.engine.endOwnership('death', 'died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    await h.engine.stop('owner_stop', 'chat');
    assert.equal(h.engine.checkpoints()[0]?.state, 'stopped_by_owner');
    h.engine.resume('chat');
    assert.equal((await h.engine.continueHeld(g.id, 'scheduled')).status, 'not_ready');
    assert.ok(h.budget.some(([id, r]) => id === g.id && !r), 'budget released');

    const h2 = harness();
    const g2 = await runningJob(h2, NEAR);
    await h2.engine.endOwnership('death', 'died');
    await until(() => h2.engine.checkpoints()[0]?.state === 'held');
    await h2.engine.submit('do something else', OWNER);
    assert.equal(h2.engine.checkpoints().find((c) => c.goalId === g2.id)?.state, 'superseded_by_owner');
    await h2.engine.stop('owner_stop', 'chat');
  });

  it('a counted possession job interrupted by DEATH without the survival service is held for provenance; non-count jobs still continue', async () => {
    const h = harness();
    const g = await runningJob(h, LOGS, 'get me some logs');
    await h.engine.endOwnership('death', 'died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    const r = await h.engine.continueHeld(g.id, 'respawn_ready');
    assert.equal(r.status, 'blocked');
    assert.equal(r.status === 'blocked' && r.reason, 'provenance_unavailable');
    assert.equal(h.engine.checkpoints()[0]?.state, 'blocked');
    assert.equal(h.planner.requests.length, 1, 'no planner turn for a held provenance job');
  });

  it('death with the survival service: credit from frozen last-alive counts; recovery has priority; continues when clear', async () => {
    let gate: ReturnType<ContinuationSurvivalPort['continuationGate']> = { kind: 'wait', reason: 'recovery_open', detail: 'recovering' };
    const persisted: string[] = [];
    const survival: ContinuationSurvivalPort = {
      frozenInventory: () => ({ incidentId: 'inc-1', counts: { 'minecraft:oak_log': 6 }, evidence: 'last_alive_server_packets' }),
      incidentReturns: () => ({ incidentId: 'inc-1', connectionEpoch: 1, regained: { 'minecraft:oak_log': 6 }, retained: {}, attribution: 'server_attributed' }),
      continuationGate: () => gate,
      persistCheckpoint: (cp) => persisted.push(cp.state),
    };
    const h = harness({ survival });
    const g = await runningJob(h, LOGS, 'get me some logs');
    await h.engine.endOwnership('death', 'died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    const wait = await h.engine.continueHeld(g.id, 'respawn_ready');
    assert.equal(wait.status === 'not_ready' && wait.reason, 'recovery_open', 'necessary recovery first (finite wait, no inference)');
    gate = { kind: 'clear' };
    const r = await h.engine.continueHeld(g.id, 'recovery_concluded');
    assert.equal(r.status, 'admitted');
    const lin = h.engine.checkpoints()[0]!.counts[0]!;
    assert.deepEqual([lin.credited, lin.heldAtInterruption, lin.incidentId, lin.evidence], [4, 6, 'inc-1', 'last_alive_server_packets']);
    assert.ok(persisted.includes('held') && persisted.includes('continuing'), 'display-only persistence notified');
    await h.engine.stop('owner_stop', 'chat');
  });

  it('continuations are finite: after the allowance the job stays held with a declarative reason', async () => {
    const h = harness();
    const g = await runningJob(h, NEAR);
    for (let i = 1; i <= 2; i += 1) {
      await h.engine.endOwnership('death', 'died');
      await until(() => h.engine.checkpoints()[0]?.state === 'held');
      assert.equal((await h.engine.continueHeld(g.id, 'scheduled')).status, 'admitted');
      await until(() => h.planner.waiting === 1);
      h.planner.respond(planFor(NEAR));
      await until(() => h.tasks.runs.length === i + 1);
    }
    await h.engine.endOwnership('death', 'died again');
    await until(() => h.engine.checkpoints()[0]?.state === 'blocked');
    assert.equal(h.engine.checkpoints()[0]?.stateReason, 'continuations_exhausted');
    assert.equal(h.engine.status().goal?.counters?.plannerTurns, 3, 'cumulative turns across the lineage (never reset)');
  });

  it('disconnect records a held, non-executable checkpoint; low-health and stop/replace end differently', async () => {
    const h = harness();
    const g = await runningJob(h, NEAR);
    await h.engine.endOwnership('disconnected', 'connection lost');
    await until(() => h.engine.checkpoints()[0]?.state === 'blocked');
    assert.equal(h.engine.checkpoints()[0]?.stateReason, 'not_continuable_in_v1');
    assert.equal((await h.engine.continueHeld(g.id, 'scheduled')).status, 'not_ready');

    const h2 = harness();
    await runningJob(h2, NEAR);
    await h2.engine.stop('owner_stop', 'chat');
    assert.equal(h2.engine.checkpoints().length, 0, 'an explicit stop never creates a checkpoint');
  });

  it('readiness waits (finitely) while not alive or another goal owns control; never needs the automatic latch', async () => {
    let alive = false;
    const h = harness({ alive: () => alive });
    const g = await runningJob(h, NEAR);
    await h.engine.endOwnership('death', 'died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    assert.equal((await h.engine.continueHeld(g.id, 'scheduled')).status, 'not_ready');
    alive = true;
    // The automatic pause latch is irrelevant to continuation of a manual owner job.
    assert.equal(h.engine.status().latch.paused, false);
    const r = await h.engine.continueHeld(g.id, 'respawn_ready');
    assert.equal(r.status, 'admitted');
    await tick(5);
    await h.engine.stop('owner_stop', 'chat');
  });
});

describe('C12 Jev budget retention through the engine lifecycle', () => {
  it('an active owner job is retained from admission; a stopped (not held) job is released; a held job stays retained until it settles', async () => {
    const h = harness();
    const g = await runningJob(h, NEAR);
    assert.deepEqual(h.budget.filter(([id]) => id === g.id), [[g.id, true]], 'retained while ACTIVE');
    await h.engine.endOwnership('death', 'died');
    await until(() => h.engine.checkpoints()[0]?.state === 'held');
    assert.ok(!h.budget.some(([id, r]) => id === g.id && !r), 'still retained while HELD');
    await h.engine.stop('owner_stop', 'chat');
    assert.equal(h.budget.at(-1)?.[1], false, 'released once the held job is fenced');

    const h2 = harness();
    const g2 = await runningJob(h2, NEAR);
    await h2.engine.stop('owner_stop', 'chat');
    assert.deepEqual(h2.budget.filter(([id]) => id === g2.id), [[g2.id, true], [g2.id, false]], 'an ordinary end releases it');
  });
});
