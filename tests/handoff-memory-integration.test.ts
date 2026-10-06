// MB-MEM-001 shared-seam integration (designated writer, MB-FLOW-002 branch):
// goal and preparation planner requests carry the bounded memory view for
// their subject; checkProposal admits only refs shown to that subject; a
// prepared draft's mprep- refs are re-grounded at the REAL admission to the
// same fact (or fail closed into a counted repair) and the preparation's refs
// are released afterwards; memory_state binds a write-sequence baseline with
// an owning goal and is unknown without one; memory_ref targets resolve only
// under the owner fence; the planner wire schema offers memory vocabulary only
// when memory capabilities are installed. Uses the memory worker's real
// MemoryService with a temp store (no world, no inference).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { CapabilityCatalog, PlannerProposal, PlannerRequest } from '../src/contracts/index.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { renderRequest } from '../src/planner/prompt.ts';
import { plannerOutputSchema, proposalFromWire } from '../src/planner/wire.ts';
import { makeEngine, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, followPlan, holdUntilRevoked, task, type PlannerScript } from './handoff-fakes.ts';
import { OVERWORLD, cleanupRoots, harness as memoryHarness } from './memory-helpers.ts';

after(cleanupRoots);
const OWNER = { surface: 'chat', principal: 'owner' } as const;
const HOME = { dimension: OVERWORLD, at: { x: 10, y: 64, z: -4 } };
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
const CATALOG: CapabilityCatalog = { catalogVersion: 'test-mem', capabilities: [cap('follow_entity'), cap('go_to_memory'), cap('mine_block')] as CapabilityCatalog['capabilities'] };
const near = (refId: string) => ({ predicate: 'near_target' as const, target: { kind: 'memory_ref' as const, refId }, within: 3 });
const goHome = (refId: string): PlannerProposal =>
  ({ version: 1, disposition: 'plan', interpretation: 'walk home', outcome: { kind: 'finite', outcome: near(refId) }, tasks: [task('walk home', near(refId), { allowedCapabilities: ['go_to_memory'], targetSelectors: [{ kind: 'memory_ref', refId }] })], morePlanningNeeded: false }) as PlannerProposal;

async function setup(script: (r: PlannerRequest, i: number) => PlannerScript) {
  const mem = memoryHarness();
  mem.memory.beginGoal({ goalId: 'goal-setup', epoch: 99, instruction: 'remember this as home' });
  const d = await mem.memory.designate({ goalId: 'goal-setup', category: 'home', label: 'home', location: HOME, basis: 'the bot position (test)' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const tasks = new FakeTaskRuntime(log);
  tasks.behaviors.set('stay near the owner', holdUntilRevoked);
  tasks.behaviors.set('walk home', holdUntilRevoked);
  const world = new FakeWorld();
  world.dimension = OVERWORLD;
  const h = makeEngine({
    planner,
    tasks,
    outcomes: new FakeServer(log),
    observation: world,
    capabilities: new StaticCapabilityRegistry(CATALOG),
    executor: { readiness: () => ({ ready: true, detail: 'fake' }), execute: async () => { throw new Error('unused'); } },
    registry: new VersionKnowledge({ version: '26.1.2' }),
    memory: mem.memory,
    limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 5_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 200 },
    flow: { handoff: 'smooth', lookahead: false },
    connectionEpoch: () => 1,
  });
  return { ...h, planner, tasks, mem };
}

const homeRef = (r: PlannerRequest) => r.memory?.facts.find((f) => f.category === 'home');

describe('memory view and references through the goal engine', () => {
  it('an admitted goal sees an executable mref- for the remembered home; only shown refs are accepted', async () => {
    let n = 0;
    const h = await setup((r) => {
      n += 1;
      const ref = homeRef(r)?.ref;
      return { kind: 'reply', proposal: n === 1 ? goHome('mref-zzzzzz9999') : goHome(ref ?? 'missing') };
    });
    await h.engine.submit('go home', OWNER);
    await until(() => h.tasks.runs.length === 1);
    const first = h.planner.requests[0]!;
    assert.match(homeRef(first)?.ref ?? '', /^mref-/);
    assert.equal(homeRef(first)?.prepRef, undefined);
    assert.match(h.planner.requests[1]!.rejection?.problems.join(' ') ?? '', /mref-zzzzzz9999 was not shown to the planner for this goal/);
    const sel = h.tasks.runs[0]!.task.spec.targetSelectors[0] as { refId: string };
    assert.equal(sel.refId, homeRef(h.planner.requests[1]!)?.ref);
    await h.engine.stop('owner_stop');
  });

  it('a preparation sees only non-executable mprep- refs; at the real admission they are re-grounded to the SAME fact and the preparation refs are released', async () => {
    const h = await setup((r) => (r.instruction === 'follow me' ? { kind: 'reply', proposal: followPlan() } : { kind: 'reply', proposal: goHome(homeRef(r)?.prepRef ?? homeRef(r)?.ref ?? 'missing'), delayMs: 20 }));
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    const r = await h.engine.submit('go home', OWNER);
    assert.equal(r.status, 'preparing');
    await until(() => h.tasks.runs.length === 2);
    const prep = h.planner.requests[1]!;
    assert.equal(prep.subject.kind, 'preparation');
    const shownPrep = homeRef(prep);
    assert.match(shownPrep?.prepRef ?? '', /^mprep-/);
    assert.equal(shownPrep?.ref, undefined, 'no executable ref for a preparation');
    assert.match(renderRequest(prep, 8), /"prepRef":"mprep-/, 'the prepared ref is rendered for the draft');
    const sel = h.tasks.runs[1]!.task.spec.targetSelectors[0] as { refId: string };
    assert.match(sel.refId, /^mref-/, 'executed with a fresh executable ref');
    const goal = h.engine.status().goal!;
    const resolved = h.mem.memory.resolveRef(sel.refId, { goalEpoch: goal.epoch, goalId: goal.id, connectionEpoch: 1, dimension: OVERWORLD });
    assert.ok(!('error' in resolved), JSON.stringify(resolved));
    assert.deepEqual(resolved.at, HOME.at, 'the same remembered fact');
    assert.equal(h.store.ofType('draft_revalidated')[0]?.['memoryRefsRegrounded'], 1);
    const intentId = h.store.ofType('instruction_preparing')[0]!['intentId'] as string;
    assert.equal(h.mem.memory.shownPreparedRefs({ intentId, generation: prep.subject.kind === 'preparation' ? prep.subject.generation : -1 }).size, 0, 'preparation refs released after re-grounding');
    await h.engine.stop('owner_stop');
  });

  it('a prepared ref whose fact was forgotten before the switch fails closed into a counted repair turn (no action on it)', async () => {
    let prepTurns = 0;
    const h = await setup((r) => {
      if (r.instruction === 'follow me') return { kind: 'reply', proposal: followPlan() };
      if (r.subject.kind === 'preparation') {
        prepTurns += 1;
        return { kind: 'reply', proposal: goHome(homeRef(r)?.prepRef ?? 'missing'), delayMs: 80 };
      }
      return { kind: 'hang' };
    });
    await h.engine.submit('follow me', OWNER);
    await until(() => h.tasks.runs.length === 1);
    await h.engine.submit('go home', OWNER);
    await until(() => h.planner.count === 2);
    h.mem.memory.beginGoal({ goalId: 'goal-owner', epoch: 98, instruction: 'forget home' });
    const forgot = await h.mem.memory.forget({ goalId: 'goal-owner', label: 'home' });
    assert.equal(forgot.ok, true, JSON.stringify(forgot));
    await until(() => h.planner.count === 3);
    const repair = h.planner.requests[2]!;
    assert.equal(repair.subject.kind, 'goal');
    assert.equal(repair.turnKind, 'repair');
    assert.match(repair.rejection?.problems.join(' ') ?? '', /mprep-\S+ no longer names the same remembered fact/);
    assert.equal(h.tasks.runs.length, 1, 'nothing executed from the stale draft');
    assert.equal(prepTurns, 1);
    await h.engine.stop('owner_stop');
  });
});

describe('memory predicates and targets in the predicate engine', () => {
  const services = { clock: { now: () => 5 }, ledger: { invalidations: [] as unknown[] } };
  it('memory_state binds the write sequence for an owning goal and is unknown without an owner', async () => {
    const mem = memoryHarness();
    const engine = new PredicateEngine({ services: services as never, session: () => undefined, leases: {} as never, memory: mem.memory });
    const admission = { capturedAtMs: 1, counts: {}, detail: 'test' };
    const p = { predicate: 'memory_state' as const, label: 'home', expect: 'recorded' as const };
    const owned = await engine.bind(p, new AbortController().signal, admission, { goalId: 'goal-0001', goalEpoch: 1 });
    assert.equal(owned.baselines['memory:seq'], mem.memory.memoryBaseline());
    assert.equal((await engine.evaluate(owned, new AbortController().signal)).status, 'unsatisfied');
    mem.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'remember this as home' });
    await mem.memory.designate({ goalId: 'goal-0001', category: 'home', label: 'home', location: HOME, basis: 'test' });
    const after = await engine.evaluate(owned, new AbortController().signal);
    assert.equal(after.status, 'satisfied');
    assert.equal(after.evidence['confirmation'], 'local_memory_store');
    const unowned = await engine.bind(p, new AbortController().signal, admission);
    assert.equal((await engine.evaluate(unowned, new AbortController().signal)).status, 'unknown');
    const noMemory = new PredicateEngine({ services: services as never, session: () => undefined, leases: {} as never });
    assert.equal((await noMemory.evaluate(await noMemory.bind(p, new AbortController().signal, admission, { goalId: 'goal-0001', goalEpoch: 1 }), new AbortController().signal)).status, 'unknown');
  });
});

describe('planner wire vocabulary', () => {
  it('offers memory_ref/memory_state only when memory capabilities are installed, and keeps memory_state values verbatim', () => {
    const without = JSON.stringify(plannerOutputSchema({ catalogVersion: 'x', capabilities: [cap('mine_block')] as CapabilityCatalog['capabilities'] }));
    const withMemory = JSON.stringify(plannerOutputSchema(CATALOG));
    assert.ok(!without.includes('memory_ref') && !without.includes('memory_state'));
    assert.ok(withMemory.includes('memory_ref') && withMemory.includes('memory_state'));
    const nullTarget = { kind: null, key: null, snapshotId: null, handle: null, anchorId: null, dimension: null, at: null, ownerText: null, actionId: null, refId: null };
    const nullPred = { predicate: null, selector: null, atLeast: null, mode: null, mayBeConsumedLater: null, slot: null, target: null, within: null, expect: null, output: null, outcome: null, of: null, label: null };
    const p = proposalFromWire({
      disposition: 'plan',
      interpretation: 'remember home',
      outcome: { kind: 'finite', predicate: { ...nullPred, predicate: 'memory_state', label: 'home', expect: 'recorded' } },
      tasks: [{ objective: 'remember', decisionInstruction: 'x', allowedCapabilities: ['go_to_memory'], targetSelectors: [{ ...nullTarget, kind: 'memory_ref', refId: 'mref-abcdef01' }], parameters: [], completion: { ...nullPred, predicate: 'memory_state', label: 'home', expect: 'recorded' } }],
      morePlanningNeeded: false,
      queries: [],
      question: null,
      missing: null,
      missingCapabilities: [],
      verifiedProgress: null,
    });
    assert.equal(p.disposition, 'plan');
    if (p.disposition !== 'plan') return;
    assert.deepEqual(p.outcome, { kind: 'finite', outcome: { predicate: 'memory_state', label: 'home', expect: 'recorded' } });
    assert.deepEqual(p.tasks[0]!.targetSelectors, [{ kind: 'memory_ref', refId: 'mref-abcdef01' }]);
  });
});

describe('SkillRuntime composition with memory', () => {
  it('registers memory capabilities only when configured, and runs the memory death snapshot before ledger/perception invalidation', async () => {
    const { parseConfig } = await import('../src/config/load.ts');
    const { SkillRuntime } = await import('../src/app/skill-runtime.ts');
    const { MemoryRunStore } = await import('../src/telemetry/run-store.ts');
    const { sequentialIds } = await import('../src/contracts/index.ts');
    const { tempRoot } = await import('./memory-helpers.ts');
    const base = { minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' } };
    const make = (raw: Record<string, unknown>, store = new MemoryRunStore()) =>
      new SkillRuntime({ config: parseConfig(raw), session: () => undefined, connectionEpoch: () => 1, goalEpoch: () => 0, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: { now: () => Date.now() }, ids: sequentialIds(), dataDir: tempRoot() });
    const plain = make(base);
    assert.equal(plain.memory, undefined);
    assert.ok(!plain.registry.catalog().capabilities.some((c) => c.id === 'remember_location'));
    const store = new MemoryRunStore();
    const rt = make({ ...base, memory: { worldProfile: 'fixture-world', worldRevision: 1, botProfile: 'chunkbot' } }, store);
    assert.ok(rt.memory?.enabled);
    const ids = rt.registry.catalog().capabilities.map((c) => c.id);
    for (const id of ['remember_location', 'forget_memory', 'note_memory', 'go_to_memory']) assert.ok(ids.includes(id), id);
    assert.ok(rt.adapters().memory, 'memory planner seam installed');
    const order: string[] = [];
    const invalidate = rt.ledger.invalidate.bind(rt.ledger);
    rt.ledger.invalidate = (reason: string) => {
      order.push('ledger_invalidated');
      invalidate(reason);
    };
    const record = store.record.bind(store);
    store.record = (e) => {
      if (String(e.type).startsWith('memory_death')) order.push(String(e.type));
      record(e);
    };
    rt.onLifecycle({ type: 'death', connectionEpoch: 1 });
    assert.equal(order[0]?.startsWith('memory_death'), true, order.join(','));
    assert.ok(order.includes('ledger_invalidated'));
    await rt.memory?.close();
  });
});
