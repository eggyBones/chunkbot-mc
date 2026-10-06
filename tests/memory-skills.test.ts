// MB-MEM-001 memory capabilities: registration in the single catalog, owner
// grounding of designations, local-memory (not server) confirmation, forget
// refusal, and go_to_memory ref ownership/travel fences.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ActionCandidate, ExecutionOwner, ObservationSnapshot } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import type { ExecuteContext, ResolveContext, SkillServices, TaskHints } from '../src/skills/definition.ts';
import { allSkills } from '../src/skills/index.ts';
import { goToMemory, memorySkills, rememberLocation, forgetMemory, noteMemory } from '../src/skills/memory.ts';
import { OVERWORLD, cleanupRoots, goal, harness, snapshot, viewFor, type Harness } from './memory-helpers.ts';

after(cleanupRoots);

function fakeSession(at = { x: 12.3, y: 64, z: -7.8 }, connectionEpoch = 1): GameSession {
  return { connectionEpoch, bot: { entity: { position: at }, game: { dimension: OVERWORLD }, entities: {} } } as unknown as GameSession;
}

function fakeServices(h: Harness, opts: { travel?: (at: { x: number; z: number }) => boolean } = {}): SkillServices {
  return {
    clock: { now: h.clock.now },
    limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 },
    perception: {
      resolve: () => ({ error: 'unknown_handle' }),
      blockVisibleNow: () => false,
      entityVisibleNow: () => false,
      isOwnerEntity: () => false,
      anchor: () => undefined,
      withinTravel: (at: { x: number; z: number }) => (opts.travel ? opts.travel(at) : true),
      travelBounds: () => ({ anchor: { x: 0, y: 64, z: 0 }, radius: 128 }),
      recordVisited: () => undefined,
    },
  } as unknown as SkillServices;
}

const candidate = (capability: string, parameters: Record<string, unknown>): ActionCandidate =>
  ({ id: 'act-0001', capability, parameters, snapshotId: 'snap-0001', connectionEpoch: 1, goalEpoch: 1, description: 'test', criteria: [], preconditions: [], timeoutMs: 10_000 }) as ActionCandidate;

function execCtx(h: Harness, capability: string, params: Record<string, unknown>, owner: ExecutionOwner, session = fakeSession()): ExecuteContext {
  return { act: {} as never, session, services: fakeServices(h), candidate: candidate(capability, params), owner, progress: () => undefined };
}

function hints(parameters: Record<string, unknown>, memoryRefs: string[] = []): TaskHints {
  return { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: parameters as TaskHints['parameters'], memoryRefs } as TaskHints;
}

function resolveCtx(h: Harness, snap: ObservationSnapshot, parameters: Record<string, unknown>, memoryRefs: string[] = [], services = fakeServices(h)): ResolveContext {
  return { task: { objective: 'x', decisionInstruction: 'x', allowedCapabilities: ['remember_location'], targetSelectors: [], parameters: {}, completion: { predicate: 'memory_state', label: 'home', expect: 'recorded' } as never }, hints: hints(parameters, memoryRefs), snapshot: snap, session: fakeSession(), services };
}

const goalOwner = (goalId = 'goal-0001', goalEpoch = 1): ExecutionOwner => ({ kind: 'goal', goalId, goalEpoch, taskId: 'task-0001' });

describe('memory capabilities', () => {
  it('register in the single capability catalog only when memory is enabled', () => {
    const h = harness();
    const registry = new SkillRegistry([...allSkills(), ...memorySkills(h.memory)]);
    const ids = registry.catalog().capabilities.map((c) => c.id);
    for (const id of ['remember_location', 'forget_memory', 'note_memory', 'go_to_memory']) assert.ok(ids.includes(id), id);
    assert.equal(new SkillRegistry(allSkills()).catalog().capabilities.length + 4, ids.length);
  });

  it('remember_location: owner words make a trusted durable fact confirmed LOCALLY (not by a server packet)', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'remember this as home' });
    const skill = rememberLocation(h.memory);
    const snap = snapshot('snap-0001', h.world.conn!, []);
    assert.equal(skill.resolve(resolveCtx(h, snap, {})).unavailable?.[0]?.reason, 'missing_parameter', 'code never invents a label');
    const drafts = skill.resolve(resolveCtx(h, snap, { label: 'home', category: 'home' })).drafts;
    assert.equal(drafts.length, 1);
    const t0 = h.clock.now();
    const r = await skill.execute(execCtx(h, 'remember_location', drafts[0]!.parameters, goalOwner()), skill.params.parse(drafts[0]!.parameters));
    assert.equal(r.status, 'succeeded', r.effect);
    assert.equal(r.confirmation, 'none');
    const mem = (r.evidence as { memory: Record<string, unknown> }).memory;
    assert.equal(mem['confirmation'], 'local_memory_store');
    assert.equal(mem['trust'], 'trusted');
    assert.ok(Number(mem['storeRevision']) > 0);
    assert.match(r.effect, /not a world effect/);
    assert.equal(h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'recorded' }, t0).status, 'satisfied');
    const fact = h.memory.facts().find((f) => f.category === 'home');
    assert.deepEqual(fact?.location, { dimension: OVERWORLD, at: { x: 12.3, y: 64, z: -7.8 } });
    assert.equal(fact?.evidence[0]?.ownerText, 'remember this as home');
    await h.memory.close();
  });

  it('remember_location: an invented label is only an unverified note (partial), and typed coordinates must be the owner\'s', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'put the base at 100 64 -20 please' });
    const skill = rememberLocation(h.memory);
    const invented = await skill.execute(execCtx(h, 'remember_location', {}, goalOwner()), { label: 'castle', category: 'location' });
    assert.equal(invented.status, 'partial');
    assert.equal(invented.reason, 'not_owner_grounded');
    const wrong = await skill.execute(execCtx(h, 'remember_location', {}, goalOwner()), { label: 'base', category: 'home', target: { kind: 'destination', dimension: OVERWORLD, x: 5, y: 64, z: 5 } });
    assert.equal(wrong.status, 'precondition_failed');
    assert.equal(wrong.reason, 'coordinates_not_owner_typed');
    const typed = await skill.execute(execCtx(h, 'remember_location', {}, goalOwner()), { label: 'base', category: 'home', target: { kind: 'destination', dimension: OVERWORLD, x: 100, y: 64, z: -20 } });
    assert.equal(typed.status, 'succeeded', typed.effect);
    assert.deepEqual(h.memory.facts().find((f) => f.category === 'home')?.location?.at, { x: 100, y: 64, z: -20 });
    // An operator diagnostic has no owner words: nothing is written.
    const diag = await skill.execute(execCtx(h, 'remember_location', {}, { kind: 'diagnostic', diagnosticId: 'diag-1' }), { label: 'home', category: 'home' });
    assert.equal(diag.status, 'precondition_failed');
    assert.equal(diag.reason, 'owner_text_unavailable');
    await h.memory.close();
  });

  it('forget_memory refuses an owner-unnamed fact and tombstones a named one; note_memory is untrusted', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'remember this as home' });
    await h.memory.designate({ goalId: 'goal-0001', category: 'home', label: 'home', location: { dimension: OVERWORLD, at: { x: 1, y: 2, z: 3 } }, basis: 'x' });
    const forget = forgetMemory(h.memory);
    h.memory.beginGoal({ goalId: 'goal-0002', epoch: 2, instruction: 'tidy up the inventory' });
    const refused = await forget.execute(execCtx(h, 'forget_memory', {}, goalOwner('goal-0002', 2)), { label: 'home' });
    assert.equal(refused.reason, 'not_owner_grounded');
    h.memory.beginGoal({ goalId: 'goal-0003', epoch: 3, instruction: 'forget about home' });
    const ok = await forget.execute(execCtx(h, 'forget_memory', {}, goalOwner('goal-0003', 3)), { label: 'home' });
    assert.equal(ok.status, 'succeeded', ok.effect);
    assert.equal(h.memory.facts().find((f) => f.category === 'home')?.status, 'forgotten');
    const note = await noteMemory(h.memory).execute(execCtx(h, 'note_memory', {}, goalOwner('goal-0003', 3)), { label: 'idea', text: 'iron might be east' });
    assert.equal(note.status, 'succeeded');
    assert.equal(((note.evidence as { memory: Record<string, unknown> }).memory)['trust'], 'untrusted');
    await h.memory.close();
  });

  it('go_to_memory: only refs issued to THIS goal epoch become options; foreign, prepared and out-of-bounds refs are reported, never substituted', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'remember this as home' });
    await h.memory.designate({ goalId: 'goal-0001', category: 'home', label: 'home', location: { dimension: OVERWORLD, at: { x: 40, y: 64, z: 0 } }, basis: 'x' });
    const skill = goToMemory(h.memory);
    const mine = viewFor(h, goal('goal-0002', 2), 'go home', 'req-0001').facts[0]?.ref as string;
    const foreign = viewFor(h, goal('goal-0009', 9), 'go home', 'req-0002').facts[0]?.ref as string;
    const prepared = viewFor(h, { kind: 'preparation', intentId: 'intent-0001', generation: 1, connectionEpoch: 1, activeGoalId: null }, 'go home', 'req-0003').facts[0]?.prepRef as string;
    const snap = { ...snapshot('snap-0001', h.world.conn!, []), goalEpoch: 2 };
    const res = skill.resolve(resolveCtx(h, snap, {}, [mine, foreign, prepared]));
    assert.equal(res.drafts.length, 1);
    assert.deepEqual(res.drafts[0]?.parameters['ref'], mine);
    const reasons = (res.unavailable ?? []).map((u) => u.reason).sort();
    assert.deepEqual(reasons, ['memory_ref_not_owned', 'prepared_ref_not_admitted']);
    const far = skill.resolve(resolveCtx(h, snap, {}, [mine], fakeServices(h, { travel: () => false })));
    assert.equal(far.unavailable?.[0]?.reason, 'outside_travel_bounds');
    assert.equal(skill.params.safeParse({ ref: prepared }).success, false, 'a prepared ref can never be an execution parameter');
    const diag = await skill.execute(execCtx(h, 'go_to_memory', { ref: mine }, { kind: 'diagnostic', diagnosticId: 'diag-1' }), { ref: mine, within: 3 });
    assert.equal(diag.reason, 'memory_ref_not_owned');
    const wrongGoal = await skill.execute(execCtx(h, 'go_to_memory', { ref: foreign }, goalOwner('goal-0002', 2)), { ref: foreign, within: 3 });
    assert.equal(wrongGoal.status, 'precondition_failed');
    assert.equal(wrongGoal.reason, 'memory_ref_not_owned');
    assert.equal(skill.resolve(resolveCtx(h, snap, {}, [])).unavailable?.[0]?.reason, 'no_memory_ref');
    await h.memory.close();
  });
});
