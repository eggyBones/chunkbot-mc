// Production private guidance + real RouteController + real SurvivalService
// incident/permission lifecycle. Owned samples below simulate only client
// motion; the application/executor path is covered in gameplay-motion-progress.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { sequentialIds, type ActionCandidate, type AdmittedTask, type DecisionPort } from '../src/contracts/index.ts';
import { RoutePolicySchema } from '../src/contracts/locator.ts';
import type { OwnedMotionSample } from '../src/execution/executor.ts';
import { clearSharedControls, SkillExecutorImpl } from '../src/execution/executor.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { RouteController } from '../src/locator/routes.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { locatorSkills } from '../src/skills/locator.ts';
import { navigateRecoveryTravel } from '../src/skills/survival.ts';
import { currentMotionGuidance, type MotionGuidanceDeps } from '../src/tasks/motion-guidance.ts';
import { TaskMotionProgress } from '../src/tasks/motion-progress.ts';
import { TaskRuntime } from '../src/tasks/task-runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot } from './survival-helpers.ts';

after(cleanupRoots);
const fence = { goalEpoch: 5, connectionEpoch: 1, dimension: 'overworld' };
const completion = { predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' } as const;

async function scene() {
  const h = harness({ farRoute: () => 'locator_route_legs' });
  const kit = { 36: slot('bread', 8), 37: slot('oak_log', 2) };
  h.pos.at = { x: 287, y: 0, z: 0 }; h.packets.inventory(kit); h.packets.health(20);
  dieWithItems(h, kit); h.service.linkIncident(h.service.deathContext().captureId!, 'mf-0001');
  h.pos.at = { x: 0.5, y: 0, z: 0.5 };
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 287, y: 0, z: 0 } }); await settle(h);
  const proposed = h.service.assess(assessInput(h));
  assert.equal(proposed.kind, 'propose'); if (proposed.kind !== 'propose') throw new Error(JSON.stringify(proposed));
  h.service.onSupportAdmitted({ proposalId: proposed.proposal.proposalId, goalId: 'goal-rec5', ...fence, admittedAtMs: h.clock.now() }); await settle(h);
  let available = true, changes: Partial<NonNullable<ReturnType<typeof h.service.current>>> = {};
  const provider = { kind: 'own_death' as const, current: (ctx: typeof fence) => { const d = h.service.current(ctx); return available && d ? { ...d, ...changes } : undefined; } };
  const routes = new RouteController({ policy: RoutePolicySchema.parse({ sources: ['support'], destinations: ['own_death'] }), clock: h.clock, ownDeath: provider });
  const auth = routes.admit({ goalId: 'goal-rec5', ...fence, admittedAtMs: h.clock.now(), source: 'support', goalDeadlineMs: h.clock.now() + 600_000, admissionAnchor: { ...h.pos.at }, admissionRadius: 128, ownerCoordinates: [] })!;
  assert.ok(auth);
  const registry = new SkillRegistry([...allSkills(), ...locatorSkills({ routes, recoveryTravel: (ctx, options) => navigateRecoveryTravel(h.service, ctx, options) })]);
  const abort = new AbortController();
  let epoch = 5, connection = 1, held = false;
  const task: AdmittedTask = { goalId: 'goal-rec5', goalEpoch: 5, taskId: 'task-rec5', mode: 'complete', spec: { objective: 'Attempt scoped recovery.', decisionInstruction: 'Use offered options.', allowedCapabilities: ['route_travel'], targetSelectors: [], parameters: { destination: 'own_death', durationMs: 1_000 }, completion }, signal: abort.signal, isCurrent: () => epoch === 5 && !abort.signal.aborted };
  const candidate: ActionCandidate = { id: 'act-rec5', capability: 'route_travel', parameters: { destination: 'own_death', durationMs: 1_000, within: 3 }, snapshotId: 'snap-rec5', ...{ goalEpoch: 5, connectionEpoch: 1 }, description: 'Travel toward own incident.', criteria: [], preconditions: [], timeoutMs: 125_000 };
  const sample = (x = 0.5): OwnedMotionSample => ({ actionId: candidate.id, capability: candidate.capability, owner: { kind: 'goal', goalId: task.goalId, goalEpoch: task.goalEpoch, taskId: task.taskId }, leaseId: 1, connectionEpoch: 1, dimension: 'overworld', self: { x, y: 0, z: 0.5 }, atMs: h.clock.now(), correctionSeq: 0, commandsIssued: 1 });
  const deps: MotionGuidanceDeps = { descriptor: (id) => registry.get(id)?.descriptor, routes, locator: { steering: () => undefined }, admissionBounds: () => ({ ...fence, anchor: { x: 0.5, y: 0, z: 0.5 }, radius: 128 }), goalEpoch: () => epoch, connectionEpoch: () => connection, held: () => held };
  const bind = () => {
    const v = routes.verifyDestination(fence, 'own_death'); assert.ok(v.ok && v.kind === 'own_death');
    if (!v.ok || v.kind !== 'own_death') throw new Error('no own incident');
    assert.equal(routes.bindOwnDeath(fence, v.identity), true);
    assert.equal(routes.beginLeg({ ...fence, at: sample().self, destination: 'own_death', destinationAt: v.at }).ok, true);
  };
  return { h, routes, registry, task, candidate, sample, deps, auth, bind, abort, change: (v: typeof changes) => { changes = v; }, unavailable: () => { available = false; }, epoch: (v: number) => { epoch = v; }, connection: (v: number) => { connection = v; }, hold: () => { held = true; }, guidance: (s = sample()) => currentMotionGuidance(deps, task, candidate, s), close: () => h.service.close() };
}

describe('fixed own-incident motion retains current authority and exact identity', () => {
  for (const moving of [true, false]) it(`actual own-death resolver/navigation/executor/task window ${moving ? 'continues useful motion' : 'blocks stationary motion'}`, async () => {
    const s = await scene();
    const client = fakeClient((name, data) => { ackSequenced(client, name, data); if (name === 'window_click' && data['stateId'] === -1) setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 3, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) })); });
    const fake = fakeMineflayerBot(client, { dimension: 'overworld', loaded: 400 });
    fake.fill(-40, -1, -40, 400, -1, 40, 'grass_block');
    const pathfinder = { goal: null as { x: number; z: number } | null, setMovements: (_: unknown) => undefined, isMoving: () => false, setGoal(g: unknown) { this.goal = g as typeof this.goal; } };
    Object.assign(fake.bot, { pathfinder, clearControlStates: () => undefined, stopDigging: () => undefined });
    const evidence = evidenceFor(client), session = { bot: fake.bot, evidence, connectionEpoch: 1 } as unknown as GameSession;
    const ids = sequentialIds(), store = new MemoryRunStore();
    const perception = new PerceptionService({ session: () => session, clock: s.h.clock, ids, observationRadius: 16, travelRadius: 128, ownerPolicy: { mode: 'offline_name', ownerName: 'FixtureOwner' }, admission: () => ({ serverOnlineMode: false }), effectiveTravel: (p) => s.routes.effectiveTravel(p) });
    assert.equal(perception.admitTravelAnchor(5), true);
    const knowledge = new VersionKnowledge({ version: '26.1.2', catalog: () => s.registry.catalog() });
    const ledger = new EvidenceLedger(s.h.clock, () => 1);
    const services = { perception, knowledge, ledger, clock: s.h.clock, limits: { travelRadius: 128, observationRadius: 16, ownerLossMs: 1_000 } };
    const leases = new ActuatorLeases({ clock: s.h.clock, ownerCurrent: () => s.task.isCurrent(), connectionEpoch: () => 1, clearShared: () => clearSharedControls(fake.bot as never) });
    const executor = new SkillExecutorImpl({ registry: s.registry, leases, session: () => session, services, goalEpoch: () => 5, store, settleMs: 0 });
    const candidates = new TaskCandidateGenerator({ registry: s.registry, services, session: () => session, ids });
    const predicates = new PredicateEngine({ services, session: () => session, leases, survival: s.h.service });
    let decisions = 0, continued = false;
    const decision: DecisionPort = { readiness: () => ({ ready: true, detail: 'scripted only' }), choose: async (req) => { decisions++; const id = req.candidates[0]!.id; return { requestId: req.requestId, candidateId: id, confidence: 1, probabilities: { [id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, attempts: 1 }; } };
    const motionProgress = new TaskMotionProgress({ executor, guidance: (t, c, m) => currentMotionGuidance({ ...s.deps, admissionBounds: () => perception.admissionBounds() }, t, c, m) });
    const runtime = new TaskRuntime({ perception, candidates, executor, predicates, decision, sustained: (id) => s.registry.get(id)?.sustained, catalogVersion: () => s.registry.catalog().catalogVersion, mechanicsVersion: '26.1.2', connectionEpoch: () => 1, model: 'typesafe/jev-1.13', store, clock: s.h.clock, ids, limits: { maxOptions: 8, noProgressMs: 700, perTargetRetries: 2, lowHealth: 6 }, motionProgress, emit: (kind) => { if (kind === 'task_local_continuation') continued = true; if (kind === 'task_motion_progress' && continued) s.abort.abort(new Error('owner_stop')); } });
    const physical = setInterval(() => {
      s.h.clock.advance(25);
      if (!moving || !pathfinder.goal) return;
      const p = fake.bot.entity.position, dx = pathfinder.goal.x - p.x, dz = pathfinder.goal.z - p.z, distance = Math.hypot(dx, dz);
      if (distance < 0.35) return;
      fake.bot.entity.position = vec3(p.x + dx / distance * 0.35, p.y, p.z + dz / distance * 0.35); fake.bot.emit('move');
    }, 25);
    const timer = setTimeout(() => s.abort.abort(new Error('test_timeout')), 10_000);
    const original = structuredClone(s.task.spec), auth = structuredClone(s.auth);
    try {
      const result = await runtime.run(s.task);
      assert.equal(result.status, moving ? 'cancelled' : 'blocked'); assert.equal(decisions, 1);
      assert.equal(result.reason, moving ? 'ownership_revoked' : 'no_progress');
      if (moving) {
        assert.ok(result.localContinuations >= 1); assert.ok(s.routes.frozenOwnDeath(fence));
        assert.ok(store.events.some((e) => e.type === 'skill_outcome' && e['capability'] === 'route_travel' && e['reason'] === 'route_window_elapsed' && e['confirmation'] === 'client_only'));
        assert.ok(store.events.filter((e) => e.type === 'task_motion_progress').length >= 2);
      } else assert.equal(store.events.filter((e) => e.type === 'task_motion_progress').length, 0);
      assert.ok(store.events.filter((e) => e.type === 'task_completion').every((e) => e['status'] !== 'satisfied'));
      assert.equal(s.h.service.evaluateSurvivalState(completion, { goalId: s.task.goalId, goalEpoch: 5 }).status, 'unsatisfied');
      assert.deepEqual(s.task.spec, original); assert.deepEqual(s.routes.authorization(fence), auth);
      assert.deepEqual(ledger.since(0), []); assert.equal(leases.current, undefined); assert.equal(pathfinder.goal, null);
    } finally { clearInterval(physical); clearTimeout(timer); s.abort.abort(); evidence.detach(); await s.close(); }
  });
  it('requires the route executor binding, then advances only the client stall receipt under original cumulative limits', async () => {
    const s = await scene();
    try {
      assert.equal(s.guidance(), undefined, 'catalog/provider availability is not actual execution');
      s.bind();
      const before = structuredClone(s.auth), original = structuredClone(s.task.spec);
      let observer: ((sample: OwnedMotionSample) => void) | undefined;
      const receipts: Array<{ atMs: number; netProgress: number; provenance: 'client_only' }> = [];
      const progress = new TaskMotionProgress({ executor: { observeMotion: (f) => { observer = f; return () => { observer = undefined; }; } }, guidance: (t, c, m) => currentMotionGuidance(s.deps, t, c, m) });
      const unwatch = progress.watch(s.task, s.candidate, (r) => receipts.push(r));
      for (const x of [0.5, 2.6, 4.7]) { s.h.clock.advance(100); s.routes.sample(fence, s.sample(x).self); observer!(s.sample(x)); }
      unwatch(); assert.equal(observer, undefined); assert.equal(receipts.length, 2);
      assert.ok(receipts.every((r) => r.provenance === 'client_only')); assert.ok(receipts.at(-1)!.netProgress > 4);
      assert.doesNotMatch(JSON.stringify(receipts), /287|destinationId|mf-0001|own_death/);
      assert.equal(s.h.service.evaluateSurvivalState(completion, { goalId: s.task.goalId, goalEpoch: 5 }).status, 'unsatisfied');
      assert.equal(s.h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, { goalId: s.task.goalId, goalEpoch: 5 }).status, 'unsatisfied');
      assert.deepEqual(s.task.spec, original); assert.deepEqual(s.routes.authorization(fence), before);
      assert.ok(s.routes.status(5)!.distanceUsed > 4); assert.equal(s.routes.status(5)!.legsUsed, 1);
    } finally { await s.close(); }
  });
  for (const change of [
    { destinationId: 'other-incident' }, { dimension: 'the_nether' },
    { at: { x: 287.1, y: 0, z: 0 } }, { recordedAtMs: 1 },
  ]) it(`changed complete incident identity refuses motion: ${Object.keys(change)[0]}`, async () => {
    const s = await scene();
    try {
      s.bind(); assert.ok(s.guidance()); s.change(change); assert.equal(s.guidance(), undefined);
      assert.equal(s.routes.verifyDestination(fence, 'own_death').ok, false);
    } finally { await s.close(); }
  });
  for (const invalidation of ['absent', 'goal', 'connection', 'dimension', 'held', 'expired', 'spent', 'stop'] as const) it(`${invalidation} cannot retain fixed-destination motion credit`, async () => {
    const s = await scene();
    try {
      s.bind(); assert.ok(s.guidance());
      if (invalidation === 'absent') s.unavailable();
      else if (invalidation === 'goal') s.epoch(6);
      else if (invalidation === 'connection') s.connection(2);
      else if (invalidation === 'held') s.hold();
      else if (invalidation === 'expired') s.h.clock.advance(600_001);
      else if (invalidation === 'spent') s.routes.sample(fence, { x: 1025, y: 0, z: 0.5 });
      else if (invalidation === 'stop') s.routes.revoke('operator_stop', 5);
      const sample = s.sample(); if (invalidation === 'dimension') sample.dimension = 'the_nether';
      assert.equal(s.guidance(sample), undefined);
      if (invalidation === 'spent' || invalidation === 'expired' || invalidation === 'stop') {
        const before = structuredClone(s.routes.status(5));
        assert.equal(s.routes.admit({ ...s.auth, source: 'support', admissionAnchor: { ...s.auth.admissionAnchor }, ownerCoordinates: [], admittedAtMs: s.h.clock.now(), goalDeadlineMs: s.h.clock.now() + 600_000 }), undefined);
        assert.deepEqual(s.routes.status(5), before, 'no same-goal grant or counter refill');
      }
    } finally { await s.close(); }
  });
  it('undeclared, nonmovement or unadmitted destination parameters cannot borrow the incident route', async () => {
    const s = await scene();
    try {
      s.bind(); assert.ok(s.guidance());
      delete s.task.spec.parameters['destination']; assert.equal(s.guidance(), undefined);
      s.task.spec.parameters['destination'] = 'own_death';
      const descriptor = s.registry.get('route_travel')!.descriptor;
      for (const replacement of [{ ...descriptor, family: 'mining' }, { ...descriptor, parameters: descriptor.parameters.filter((p) => p.name !== 'destination') }, { ...descriptor, targets: ['none'] }]) {
        assert.equal(currentMotionGuidance({ ...s.deps, descriptor: () => replacement }, s.task, s.candidate, s.sample()), undefined);
      }
      s.candidate.parameters['target'] = { kind: 'destination', dimension: 'overworld', x: 287, y: 0, z: 0 }; assert.equal(s.guidance(), undefined);
      delete s.candidate.parameters['target'];
      s.candidate.parameters['destination'] = 'foreign_death'; assert.equal(s.guidance(), undefined);
    } finally { await s.close(); }
  });
});
