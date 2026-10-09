// W-R12: persistent maintenance option selection through the ACTUAL shared
// composition: real PerceptionService (offline-name owner policy), the real
// SkillRegistry (allSkills + locator skills, so `seek_owner` resolves exactly as
// in the app), TaskCandidateGenerator, PredicateEngine and TaskRuntime with the
// registry's own `sustained` policies. Only the executor (movement physics), the
// Jev port and time are scripted; the scripted executor moves the fake bot the
// way the retained actual skills did and returns outcomes with the actual
// identity/status/reason shapes.
//
// Retained actual input (read-only, root acceptance-native copy):
//   run-43de6c6a40fc/events.jsonl sha256 0909e0da399f357a4f7d8e604501cd580050a808d9f73bc6181a9efdfd036f43
//   R19 26.1.2 P6, goal-b65c8f2fbb3f / task-631733828d2a (maintain). The accepted
//   TaskSpec below is copied verbatim from its planner proposal (req-39e8640f6055).
//   Every round offered exactly [follow_entity "follow the visible owner for 30s",
//   move_near "walk to the visible owner"] with seek_owner:owner_visible; Jev chose
//   move_near (p 0.7/0.84/0.82/0.9) four times, each a finite action that ended on
//   arrival, so every owner step needed a new request; only round 5 (move_near:
//   no_grounded_destination) offered follow_entity alone, and following then held
//   locally. Result: 5 Jev requests, 0 local continuations in ~32 s (P6 quiet gate:
//   Jev <= 3). 26.2 P6 (Jev chose follow first) had 1 request, 1 continuation.
// The owner walk below is the P6 harness path translated by (-208, +60, -200).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, type ActionCandidate, type AdmittedTask, type DecisionChoice, type DecisionPort, type DecisionRequest, type ExecutionOwner, type LowHealthAllowancePort, type SkillOutcome, type TaskSpec } from '../src/contracts/index.ts';
import { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema } from '../src/contracts/locator.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { RouteController } from '../src/locator/routes.ts';
import { LocatorService } from '../src/locator/service.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { locatorSkills } from '../src/skills/locator.ts';
import { TaskRuntime, type TaskSafetyGate } from '../src/tasks/task-runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

const OWNER = 'FixtureOwner';
const OWNER_UUID = offlinePlayerUuid(OWNER);
const GOAL = { goalId: 'goal-b65c8f2fbb3f', goalEpoch: 11, taskId: 'task-631733828d2a' };

/** Verbatim accepted P6 task (req-39e8640f6055). */
const P6_SPEC: TaskSpec = {
  objective: 'Stay near you as you move.',
  decisionInstruction: 'Follow the visible owner within 3 blocks. Use seek_owner only if the owner becomes unseen with actionable locator guidance or moves beyond local bounds with route authorization. Maintain quietly when already near.',
  allowedCapabilities: ['follow_entity', 'move_near', 'seek_owner'],
  targetSelectors: [{ kind: 'owner' }],
  parameters: { within: 3 },
  completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 },
};

/** P6 harness: owner tp at task start then every 4 s (8 steps), measured/stopped at 32 s. */
const WALK: Array<[number, number]> = [[3.5, 1.5], [5.5, 3.5], [5.5, 6.5], [3.5, 8.5], [1.5, 6.5], [1.5, 3.5], [3.5, 1.5], [5.5, -0.5]];
const STEP_MS = 4_000;
const MEASURE_MS = 32_000;

type Jev = 'r19_one_off' | 'follow_first';
interface Options {
  mode?: 'maintain' | 'complete';
  spec?: TaskSpec;
  jev?: Jev;
  /** Scripted follow outcome override for adverse controls (index = follow dispatch number, 1-based). */
  follow?: (n: number) => Partial<SkillOutcome> | undefined;
  safety?: TaskSafetyGate;
  allowance?: LowHealthAllowancePort;
  health?: number;
  /** Called inside the Jev await (before the reply). */
  duringChoice?: (n: number) => void;
  stopAtMs?: number;
}

function scene(opts: Options = {}) {
  // The real PredicateEngine reads inventory through a correlated server resync
  // (window_click stateId -1 + sequenced barrier); answer it like a server (empty inventory).
  const client = fakeClient((name, data) => {
    if (name === 'block_dig' && typeof data['sequence'] === 'number') {
      const sequenceId = data['sequence'];
      setImmediate(() => {
        client.emit('window_items', { windowId: 0, stateId: 1, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) });
        client.emit('acknowledge_player_digging', { sequenceId });
      });
    }
  });
  const fake = fakeMineflayerBot(client, { dimension: 'overworld', at: { x: -0.5, y: 0, z: -0.5 } });
  fake.fill(-40, -1, -40, 40, -1, 40, 'grass_block');
  fake.bot.players[OWNER] = { uuid: OWNER_UUID, username: OWNER } as never;
  const owner = fake.addEntity({ id: 50, type: 'player', name: 'player', username: OWNER, uuid: OWNER_UUID, height: 1.8, at: { x: WALK[0]![0], y: 0, z: WALK[0]![1] } });
  if (opts.health !== undefined) fake.bot.health = opts.health;
  Object.assign(fake.bot, { pathfinder: { setGoal: () => undefined, setMovements: () => undefined, isMoving: () => false }, clearControlStates: () => undefined });
  const evidence = evidenceFor(client);
  const session = { bot: fake.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const t0 = 1_791_513_486_934; // actual task_baseline boundAtMs
  const clock = { t: t0, now() { return this.t; } };
  const ids = sequentialIds();
  const ownerPolicy = { mode: 'offline_name' as const, ownerName: OWNER };
  const perception = new PerceptionService({ session: () => session, clock, ids, observationRadius: 32, travelRadius: 128, rays: 600, ownerPolicy, admission: () => ({ serverOnlineMode: false }) });
  assert.equal(perception.admitTravelAnchor(GOAL.goalEpoch), true);
  const services = { perception, knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger: new EvidenceLedger(clock), clock, limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 } };
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: '26.1.2', ownerPolicy, admission: () => ({ serverOnlineMode: false }), session: () => session, clock });
  locator.attach(client, 1);
  client.emit('login', {});
  const routes = new RouteController({ policy: RoutePolicySchema.parse({}), clock });
  const registry = new SkillRegistry([...allSkills(), ...locatorSkills({ locator, routes })]);
  const candidates = new TaskCandidateGenerator({ registry, services, session: () => session, ids });
  const abort = new AbortController();
  let current = true;
  const leases = new ActuatorLeases({ clock, ownerCurrent: () => current && !abort.signal.aborted, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
  const predicates = new PredicateEngine({ services, session: () => session, leases });
  const store = new MemoryRunStore();
  const kinds: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const requests: DecisionRequest[] = [];
  const executed: Array<{ capability: string; id: string; atMs: number; owner?: ExecutionOwner }> = [];
  const stopAt = t0 + (opts.stopAtMs ?? MEASURE_MS);
  let walkIndex = 0;
  let follows = 0;

  const ownerAt = () => owner.position;
  const botAt = () => fake.bot.entity.position;
  const distance = () => Math.hypot(ownerAt().x - botAt().x, ownerAt().y - botAt().y, ownerAt().z - botAt().z);
  /** Advances scripted time: owner steps at the harness cadence, the stop at 32 s. */
  const advance = (ms: number, onStep?: () => void) => {
    const until = clock.t + ms;
    while (clock.t < until && !abort.signal.aborted) {
      clock.t = Math.min(until, clock.t + 250);
      const due = Math.min(WALK.length - 1, Math.floor((clock.t - t0) / STEP_MS));
      while (walkIndex < due) {
        walkIndex += 1;
        owner.position = vec3(WALK[walkIndex]![0], 0, WALK[walkIndex]![1]);
      }
      onStep?.();
      if (clock.t >= stopAt) { current = false; abort.abort(); }
    }
  };
  /** Good following, as observed: the bot keeps ~2.2 blocks from the owner. */
  const trail = () => {
    if (distance() <= 3) return;
    const o = ownerAt(), b = botAt(), d = distance();
    fake.bot.entity.position = vec3(o.x + ((b.x - o.x) / d) * 2.2, 0, o.z + ((b.z - o.z) / d) * 2.2);
  };
  const outcome = (c: ActionCandidate, o: Partial<SkillOutcome> & Pick<SkillOutcome, 'status' | 'elapsedMs' | 'effect'>): SkillOutcome => ({
    actionId: c.id, owner: 'goal', goalId: GOAL.goalId, taskId: GOAL.taskId, capability: c.capability, connectionEpoch: c.connectionEpoch, goalEpoch: c.goalEpoch,
    confirmation: 'client_only', evidence: {}, ...o,
  });
  const executor = {
    readiness: () => ({ ready: true, detail: 'scripted movement' }),
    async execute(c: ActionCandidate, signal: AbortSignal, who?: ExecutionOwner): Promise<SkillOutcome> {
      executed.push({ capability: c.capability, id: c.id, atMs: clock.t, ...(who ? { owner: who } : {}) });
      const started = clock.t;
      if (c.capability === 'follow_entity') {
        follows += 1;
        const override = opts.follow?.(follows);
        if (override) { advance(override.elapsedMs ?? 1_000, trail); return outcome(c, { status: 'failed', elapsedMs: clock.t - started, effect: 'scripted adverse follow end', ...override }); }
        const durationMs = Number((c.parameters as Record<string, unknown>)['durationMs'] ?? 30_000);
        advance(durationMs, trail);
        if (signal.aborted) return outcome(c, { status: 'cancelled', reason: 'owner_stop', confirmation: 'none', elapsedMs: clock.t - started, effect: 'cancelled; controls cleared' });
        return outcome(c, { status: 'succeeded', elapsedMs: clock.t - started, effect: `followed the owner for ${Math.round(durationMs / 1000)}s; final distance ${distance().toFixed(2)}` });
      }
      if (c.capability === 'move_near') {
        advance(800, trail);
        if (signal.aborted) return outcome(c, { status: 'cancelled', reason: 'owner_stop', confirmation: 'none', elapsedMs: clock.t - started, effect: 'cancelled' });
        return outcome(c, { status: 'succeeded', elapsedMs: clock.t - started, effect: `arrived within 3 of owner (last observed position) (distance ${distance().toFixed(2)})` });
      }
      throw new Error(`unexpected dispatch ${c.capability}`);
    },
  };
  const decision: DecisionPort = {
    readiness: () => ({ ready: true, detail: 'scripted Jev (no inference)' }),
    async choose(req: DecisionRequest): Promise<DecisionChoice> {
      requests.push(req);
      opts.duringChoice?.(requests.length);
      // R19 261 actual preference: the one-off approach whenever it is offered.
      const pick = (opts.jev ?? 'r19_one_off') === 'r19_one_off'
        ? req.candidates.find((c) => c.capability === 'move_near') ?? req.candidates[0]!
        : req.candidates.find((c) => c.capability === 'follow_entity') ?? req.candidates[0]!;
      const rest = req.candidates.filter((c) => c.id !== pick.id);
      const probabilities = Object.fromEntries([[pick.id, rest.length ? 0.84 : 1], ...rest.map((c) => [c.id, 0.16 / rest.length])]);
      return { requestId: req.requestId, candidateId: pick.id, confidence: 0.68, probabilities, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { inputTokens: 1246, outputTokens: 1, costUsd: 0 }, latencyMs: 450, attempts: 1 };
    },
  };
  const runtime = new TaskRuntime({
    perception, candidates, executor, predicates, decision,
    sustained: (id) => registry.get(id)?.sustained,
    catalogVersion: () => registry.catalog().catalogVersion, mechanicsVersion: '26.1.2', connectionEpoch: () => 1,
    model: 'typesafe/jev-1.13', store, clock, ids,
    // Actual fixture-planner.json limits.
    limits: { maxOptions: 8, noProgressMs: 30_000, perTargetRetries: 2, lowHealth: 8 },
    emit: (kind, data) => kinds.push({ kind, data }),
    sleep: async () => { advance(1_000); await Promise.resolve(); },
    ...(opts.safety ? { safety: opts.safety } : {}),
    ...(opts.allowance ? { lowHealthAllowance: opts.allowance } : {}),
  });
  const task: AdmittedTask = { ...GOAL, mode: opts.mode ?? 'maintain', spec: opts.spec ?? P6_SPEC, signal: abort.signal, isCurrent: () => current && !abort.signal.aborted };
  const of = (kind: string) => kinds.filter((k) => k.kind === kind).map((k) => k.data);
  return { runtime, task, perception, candidates, requests, executed, of, distance, clock, t0, abort, owner, fake, revoke: () => { current = false; abort.abort(); }, detach: () => evidence.detach() };
}

const offeredCaps = (r: DecisionRequest) => r.candidates.map((c) => c.capability);

describe('W-R12 actual composition of the retained P6 task', () => {
  it('the verbatim P6 TaskSpec resolves exactly the actual round-1 options: follow_entity + move_near, seek_owner owner_visible', () => {
    const s = scene();
    try {
      const snap = s.perception.take(GOAL.goalEpoch)!;
      assert.equal(snap.owner.visible, true);
      const set = s.candidates.generate(P6_SPEC, snap);
      assert.deepEqual(set.candidates.map((c) => [c.capability, c.description]), [['follow_entity', 'follow the visible owner for 30s'], ['move_near', 'walk to the visible owner']]);
      assert.deepEqual(set.unavailable.map((u) => `${u.capability}:${u.reason}`), ['seek_owner:owner_visible']);
      assert.equal(Math.round(s.distance() * 10) / 10, 4.5, 'actual round-1 distance 4.5');
    } finally { s.detach(); }
  });
});

describe('W-R12 persistent maintenance prefers currently usable registered sustained options', () => {
  it('P6 replay with the actual R19 one-off-preferring Jev: one request over [follow_entity] only, then local continuation (original quiet gate)', async () => {
    const s = scene({ jev: 'r19_one_off' });
    try {
      const r = await s.runtime.run(s.task);
      assert.equal(r.status, 'cancelled', `${r.status}/${r.reason}: ${r.detail}`);
      // Original P6 gate, unchanged: Jev requests <= 3 during ~32 s of following.
      assert.ok(s.requests.length <= 3, `quiet maintenance: Jev ${s.requests.length}`);
      assert.equal(s.requests.length, 1, 'exactly one real Jev choice');
      assert.deepEqual(offeredCaps(s.requests[0]!), ['follow_entity'], 'the frozen set is the usable sustained subset');
      assert.ok(r.localContinuations >= 1, `local continuations ${r.localContinuations}`);
      assert.ok(s.distance() <= 3, `following stays good: ${s.distance().toFixed(2)}`);
      const round = s.of('task_round')[0]!;
      assert.equal(round['generated'], 2);
      assert.deepEqual(round['sustainedPreference'], { deferred: ['move_near'] });
      assert.equal(round['truncated'], false, 'a deferred one-off is not reported as truncation');
      assert.equal(s.executed.filter((e) => e.capability === 'move_near').length, 0);
      assert.ok(s.executed.every((e) => e.owner?.kind === 'goal' && e.owner.goalId === GOAL.goalId && e.owner.taskId === GOAL.taskId && e.owner.goalEpoch === GOAL.goalEpoch));
    } finally { s.detach(); }
  });

  it('control: a follow-first Jev (actual 26.2 P6 behaviour) is unchanged — one request, local continuation', async () => {
    const s = scene({ jev: 'follow_first' });
    try {
      const r = await s.runtime.run(s.task);
      assert.equal(s.requests.length, 1);
      assert.ok(r.localContinuations >= 1);
    } finally { s.detach(); }
  });

  it('finite (complete) tasks keep ALL valid options: the same spec offers follow_entity and move_near, and the one-off may be chosen', async () => {
    const s = scene({ mode: 'complete', jev: 'r19_one_off' });
    try {
      const r = await s.runtime.run(s.task);
      assert.deepEqual(offeredCaps(s.requests[0]!), ['follow_entity', 'move_near']);
      assert.equal(s.executed[0]!.capability, 'move_near');
      assert.equal(r.status, 'completed', `${r.status}/${r.reason}`);
      assert.equal(s.of('task_round')[0]!['sustainedPreference'], undefined);
    } finally { s.detach(); }
  });

  it('maintain with no sustained usable option keeps the ordinary fallback: Jev chooses among the remaining valid options, nothing is dispatched without a choice', async () => {
    const s = scene({ spec: { ...P6_SPEC, allowedCapabilities: ['move_near', 'seek_owner'] }, stopAtMs: 9_000 });
    try {
      await s.runtime.run(s.task);
      assert.ok(s.requests.length >= 1);
      assert.ok(s.requests.every((r) => offeredCaps(r).join() === 'move_near'));
      assert.equal(s.executed.length, s.requests.length, 'every dispatch came from one Jev choice');
      assert.ok(s.of('task_round').every((d) => d['sustainedPreference'] === undefined));
    } finally { s.detach(); }
  });

  it('a sustained option that ended without a healthy window is not preferred again: the full valid set returns until it completes a healthy window itself', async () => {
    const s = scene({ follow: (n) => (n === 1 ? { status: 'failed', reason: 'target_outside_travel_bounds', elapsedMs: 1_000 } : undefined), stopAtMs: 12_000 });
    try {
      await s.runtime.run(s.task);
      assert.deepEqual(offeredCaps(s.requests[0]!), ['follow_entity']);
      assert.deepEqual(offeredCaps(s.requests[1]!), ['follow_entity', 'move_near'], 'fallback after the unhealthy end');
      assert.equal(s.executed[1]!.capability, 'move_near');
      assert.ok(s.of('task_local_continuation').length === 0, 'an unhealthy end is never continued locally');
    } finally { s.detach(); }
  });

  it('per-target retry exclusion still applies: a repeatedly failing sustained option leaves the set, the one-off stays available', async () => {
    let fails = 0;
    const s = scene({ follow: () => { fails += 1; return { status: 'failed', reason: 'path_blocked', elapsedMs: 600 }; }, jev: 'follow_first', stopAtMs: 20_000 });
    try {
      await s.runtime.run(s.task);
      const followed = s.executed.filter((e) => e.capability === 'follow_entity').length;
      assert.equal(followed, 3, 'perTargetRetries 2 -> at most 3 follow dispatches');
      assert.ok(s.requests.slice(3).every((r) => !offeredCaps(r).includes('follow_entity')), 'excluded after exhausting retries');
      assert.ok(s.executed.some((e) => e.capability === 'move_near'));
      assert.equal(fails, 3);
    } finally { s.detach(); }
  });

  it('a safety hold clears the continuation: the preempted follow is re-chosen by a FRESH Jev request after clear, never continued locally across safety', async () => {
    let held: ReturnType<TaskSafetyGate['hold']> = null;
    const safety: TaskSafetyGate = {
      hold: () => held,
      waitClear: async () => { held = null; return { status: 'clear', waitedMs: 2_000, episodes: 1 }; },
    };
    const s = scene({ safety, follow: (n) => (n === 1 ? (held = { reason: 'episode', detail: 'scripted hazard', episodeId: 'se-1', response: null, hazards: [], sinceMs: 0 }, { status: 'cancelled', reason: 'safety_preempt', confirmation: 'none', elapsedMs: 5_000 }) : undefined) });
    try {
      await s.runtime.run(s.task);
      assert.ok(s.of('task_safety_hold').length === 1 && s.of('task_safety_clear').length === 1);
      assert.equal(s.requests.length, 2, 'one fresh choice after the hold cleared');
      assert.deepEqual(offeredCaps(s.requests[1]!), ['follow_entity'], 'the preempted (cancelled) sustained option is still preferred, from fresh state');
      const firstContinuation = s.of('task_local_continuation')[0];
      assert.ok(!firstContinuation || firstContinuation['continues'] !== s.requests[0]!.candidates[0]!.id, 'nothing continues the pre-safety action');
      assert.ok(s.executed.length >= 2 && s.executed[1]!.id === s.requests[1]!.candidates[0]!.id);
    } finally { s.detach(); }
  });

  it('low-health allowance still bounds the set: with only move_near granted the sustained preference cannot reintroduce follow_entity', async () => {
    const reserved: string[] = [];
    const grant = { allowed: true as const, allowanceId: 'alw-1', capabilities: ['move_near'], items: [], detail: 'scripted survival grant' };
    const allowance: LowHealthAllowancePort = {
      check: () => grant, recheck: () => grant,
      reserve: (_id, _t, c) => { reserved.push(c.capability); return grant; },
      consumed: () => undefined,
    };
    const s = scene({ allowance, health: 6, stopAtMs: 6_000 });
    try {
      await s.runtime.run(s.task);
      assert.ok(s.requests.length >= 1);
      assert.ok(s.requests.every((r) => offeredCaps(r).join() === 'move_near'));
      assert.ok(reserved.length >= 1 && reserved.every((c) => c === 'move_near'));
    } finally { s.detach(); }
  });

  it('stop/replacement during the Jev await: nothing is dispatched', async () => {
    let s!: ReturnType<typeof scene>;
    s = scene({ duringChoice: () => s.revoke() });
    try {
      const r = await s.runtime.run(s.task);
      assert.equal(r.status, 'cancelled');
      assert.equal(s.executed.length, 0);
    } finally { s.detach(); }
  });

  it('the frozen sustained choice is revalidated against the current world: an owner hidden during the await is never followed', async () => {
    let s!: ReturnType<typeof scene>;
    s = scene({ stopAtMs: 3_000, duringChoice: (n) => { if (n === 1) delete (s.fake.bot.entities as Record<number, unknown>)[50]; } });
    try {
      await s.runtime.run(s.task);
      assert.equal(s.of('task_choice_stale').length >= 1, true);
      assert.equal(s.executed.filter((e) => e.capability === 'follow_entity').length, 0);
    } finally { s.detach(); }
  });
});
