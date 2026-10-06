// MB-MEM-001 service behavior: restart persistence and scope (M1), provenance
// and hallucination (M2), stale/changed world facts (M3), recovery status and
// bounded retrieval (M4), interrupted construction (M5), death seams (M7),
// request-bound refs fenced to goal/epoch/connection/dimension, and the
// MB-FLOW-002 preparation subject.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MEMORY_BOUNDS } from '../src/contracts/memory.ts';
import { scopeDirectory } from '../src/memory/store.ts';
import { MemoryService } from '../src/memory/service.ts';
import { memorySkills } from '../src/skills/memory.ts';
import { NETHER, OVERWORLD, cleanupRoots, goal, harness, outcome, snapshot, viewFor } from './memory-helpers.ts';

after(cleanupRoots);

const HOME = { dimension: OVERWORLD, at: { x: 100, y: 64, z: -40 } };

async function designateHome(h: ReturnType<typeof harness>, goalId = 'goal-0001', epoch = 1, instruction = 'remember this as home') {
  h.memory.beginGoal({ goalId, epoch, instruction });
  const r = await h.memory.designate({ goalId, category: 'home', label: 'home', location: HOME, basis: 'the bot position (test)' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

describe('memory: restart persistence and scope (M1)', () => {
  it('a verified home and resource survive an app restart and are retrieved with fresh refs; other worlds/revisions/dimensions cannot use them', async () => {
    const h = harness();
    await designateHome(h);
    // A verified resource from a server-confirmed mining outcome.
    h.world.evidence.set('act-mine', { blockChanges: [{ x: 110, y: 60, z: -35, from: 'minecraft:iron_ore', to: 'minecraft:air', atMs: 1 }], containers: [] });
    h.memory.beginGoal({ goalId: 'goal-0002', epoch: 2, instruction: 'mine iron' });
    h.memory.recordOutcome({ ...outcome({ capability: 'mine_block', goalId: 'goal-0002', goalEpoch: 2 }), actionId: 'act-mine' });
    await h.memory.flush();

    const r = await h.restart();
    assert.equal(r.memory.status().state, 'ready');
    const view = viewFor(r, goal('goal-0009', 9), 'go home and then get iron', 'req-0009', { x: 90, y: 64, z: -30 });
    const home = view.facts.find((f) => f.category === 'home');
    const iron = view.facts.find((f) => f.key === 'minecraft:iron_ore');
    assert.ok(home?.ref && iron?.ref, JSON.stringify(view.facts));
    assert.equal(home.source, 'owner_statement');
    assert.equal(iron.source, 'verified_skill');
    assert.equal(home.location?.currentDimension, true);
    const resolved = r.memory.resolveRef(home.ref, { goalEpoch: 9, goalId: 'goal-0009', connectionEpoch: r.world.conn!.connectionEpoch, dimension: OVERWORLD });
    assert.ok(!('error' in resolved));
    assert.deepEqual(resolved.at, HOME.at);

    // Same endpoint, a new world revision: isolated, empty.
    const r2 = await r.restart({ worldRevision: 2 });
    assert.equal(r2.memory.status().state, 'empty');
    assert.equal(viewFor(r2, goal('goal-0010', 10), 'go home').facts.length, 0);
    // Another world profile: isolated as well.
    const r3 = await r2.restart({ worldProfile: 'other-world', worldRevision: 1 });
    assert.equal(viewFor(r3, goal('goal-0011', 11), 'go home').facts.length, 0);
    // Back on the original profile but in the Nether: the home is shown, never as a local target.
    const r4 = await r3.restart({ worldProfile: 'fixture-world', worldRevision: 1 });
    r4.world.conn = { connectionEpoch: r4.world.conn!.connectionEpoch, dimension: NETHER };
    const nether = viewFor(r4, goal('goal-0012', 12), 'go home');
    const netherHome = nether.facts.find((f) => f.category === 'home');
    assert.ok(netherHome);
    assert.equal(netherHome.ref, undefined);
    assert.equal(netherHome.location?.currentDimension, false);
    await r4.memory.close();
  });

  it('a different endpoint for the same profile is a scope conflict: no retrieval and no writes unless the operator rebinds', async () => {
    const h = harness({ endpoint: '127.0.0.1:25566' });
    h.memory.onConnectionReady();
    await designateHome(h);
    await h.memory.close();
    const moved = harness({ root: h.root, endpoint: '127.0.0.1:25567' });
    moved.memory.onConnectionReady();
    assert.equal(moved.memory.status().state, 'scope_conflict');
    assert.match(moved.memory.statusLines().join('\n'), /bound to endpoint 127\.0\.0\.1:25566/);
    const v = viewFor(moved, goal('goal-0002', 2), 'go home');
    assert.equal(v.facts.length, 0);
    assert.equal(v.status.state, 'scope_conflict');
    moved.memory.beginGoal({ goalId: 'goal-0002', epoch: 2, instruction: 'remember this as home' });
    const w = await moved.memory.designate({ goalId: 'goal-0002', category: 'home', label: 'home', location: HOME, basis: 'x' });
    assert.equal(w.ok, false);
    await moved.memory.close();
    const rebound = harness({ root: h.root, endpoint: '127.0.0.1:25567', config: { rebindEndpoint: true } });
    rebound.memory.onConnectionReady();
    assert.equal(rebound.memory.status().state, 'ready');
    assert.equal(viewFor(rebound, goal('goal-0003', 3), 'go home').facts.length, 1);
    await rebound.memory.close();
  });

  it('a disabled (unconfigured) memory advertises nothing and builds no view', async () => {
    const m = new MemoryService({ config: undefined, rootDir: '/nonexistent', endpoint: 'x:1', clock: { now: () => 0 } });
    m.open();
    assert.equal(m.status().state, 'disabled');
    assert.match(m.statusLines()[0] ?? '', /disabled/);
    assert.deepEqual(memorySkills(m), []);
    const v = m.view({ subject: goal('goal-0001', 1), requestId: 'req-0001', instruction: 'go home', observation: null });
    assert.equal(v.facts.length, 0);
    assert.equal(v.status.state, 'disabled');
  });
});

describe('memory: request-bound refs are fenced and fail closed', () => {
  it('refs resolve only for the owning goal epoch, connection and dimension; never alias across requests; void after release/lifecycle', async () => {
    const h = harness();
    await designateHome(h);
    const conn = h.world.conn!;
    const v1 = viewFor(h, goal('goal-0005', 5), 'go home', 'req-0001');
    const v2 = viewFor(h, goal('goal-0005', 5), 'go home', 'req-0002');
    const ref1 = v1.facts[0]?.ref as string;
    const ref2 = v2.facts[0]?.ref as string;
    assert.ok(ref1 && ref2 && ref1 !== ref2, 'a fresh ref per request; ids are never reused');
    const fence = { goalEpoch: 5, goalId: 'goal-0005', connectionEpoch: conn.connectionEpoch, dimension: OVERWORLD };
    assert.ok(!('error' in h.memory.resolveRef(ref1, fence)));
    const fail = (refId: string, f: typeof fence) => {
      const r = h.memory.resolveRef(refId, f);
      assert.ok('error' in r, `${refId} must fail closed`);
      return r.error;
    };
    assert.equal(fail(ref1, { ...fence, goalEpoch: 6, goalId: 'goal-0006' }), 'memory_ref_not_owned');
    assert.equal(fail(ref1, { ...fence, goalId: 'goal-0099' }), 'memory_ref_not_owned');
    assert.equal(fail(ref1, { ...fence, connectionEpoch: conn.connectionEpoch + 1 }), 'stale_connection');
    assert.equal(fail(ref1, { ...fence, dimension: NETHER }), 'dimension_mismatch');
    assert.equal(fail('mref-zzzzzz0001', fence), 'unknown_memory_ref');
    // A refs-per-goal window: very old requests expire.
    for (let i = 3; i < 3 + MEMORY_BOUNDS.refRequestsPerGoal; i += 1) viewFor(h, goal('goal-0005', 5), 'go home', `req-000${i}`);
    assert.equal(fail(ref1, fence), 'unknown_memory_ref');
    // Releasing the goal voids its refs.
    const v3 = viewFor(h, goal('goal-0005', 5), 'go home', 'req-0100');
    h.memory.releaseGoal('goal-0005');
    assert.equal(fail(v3.facts[0]?.ref as string, fence), 'unknown_memory_ref');
    // Lifecycle (death) voids every transient ref; the durable fact stays.
    const v4 = viewFor(h, goal('goal-0007', 7), 'go home', 'req-0200');
    h.memory.onLifecycle({ type: 'death', connectionEpoch: conn.connectionEpoch });
    assert.equal(fail(v4.facts[0]?.ref as string, { ...fence, goalEpoch: 7, goalId: 'goal-0007' }), 'unknown_memory_ref');
    assert.ok(h.memory.facts().some((f) => f.category === 'home' && f.status === 'active'));
    // Two runs never share ref ids.
    const other = harness();
    await designateHome(other);
    const ov = viewFor(other, goal('goal-0005', 5), 'go home', 'req-0001');
    assert.notEqual(ov.facts[0]?.ref, ref1);
    await h.memory.close();
    await other.memory.close();
  });

  it('a superseded or contradicted fact makes its outstanding ref fail closed (no substitute target)', async () => {
    const h = harness();
    await designateHome(h);
    const conn = h.world.conn!;
    const v = viewFor(h, goal('goal-0002', 2), 'remember this as home', 'req-0001');
    const old = v.facts[0]?.ref as string;
    // Owner correction: home is now elsewhere.
    const r = await h.memory.designate({ goalId: 'goal-0002', category: 'home', label: 'home', location: { dimension: OVERWORLD, at: { x: 0, y: 70, z: 0 } }, basis: 'owner moved home' });
    assert.ok(r.ok && r.affected.length === 1);
    const res = h.memory.resolveRef(old, { goalEpoch: 2, goalId: 'goal-0002', connectionEpoch: conn.connectionEpoch, dimension: OVERWORLD });
    assert.ok('error' in res && res.error === 'memory_fact_inactive');
    await h.memory.close();
  });
});

describe('memory: preparation subject (MB-FLOW-002)', () => {
  it('a preparation sees bounded facts with NON-executable prepared refs; admission re-grounds the SAME active fact or fails closed', async () => {
    const h = harness();
    await designateHome(h);
    h.memory.releaseGoal('goal-0001');
    const conn = h.world.conn!;
    const prep = { kind: 'preparation' as const, intentId: 'intent-0001', generation: 3, connectionEpoch: conn.connectionEpoch, activeGoalId: 'goal-0001' };
    const v = viewFor(h, prep, 'go home', 'req-0010');
    const fact = v.facts.find((f) => f.category === 'home');
    assert.ok(fact?.prepRef && !fact.ref, 'prepared refs only');
    assert.match(fact.prepRef, /^mprep-/);
    assert.ok(h.memory.shownPreparedRefs({ intentId: 'intent-0001', generation: 3 }).has(fact.prepRef));
    // Never executable, even with a plausible fence.
    const direct = h.memory.resolveRef(fact.prepRef, { goalEpoch: 2, goalId: 'goal-0002', connectionEpoch: conn.connectionEpoch, dimension: OVERWORLD });
    assert.ok('error' in direct && direct.error === 'prepared_ref_not_admitted');
    // No goal was invented for the preparation.
    assert.equal(h.memory.ownerTexts('intent-0001'), undefined);
    const admission = { intentId: 'intent-0001', generation: 3, goalId: 'goal-0002', goalEpoch: 2, requestId: 'req-0011', connectionEpoch: conn.connectionEpoch, dimension: OVERWORLD };
    assert.ok('error' in h.memory.regroundPrepared(fact.prepRef, { ...admission, generation: 4 }));
    assert.ok('error' in h.memory.regroundPrepared(fact.prepRef, { ...admission, dimension: NETHER }));
    const ok = h.memory.regroundPrepared(fact.prepRef, admission);
    assert.ok(!('error' in ok), JSON.stringify(ok));
    assert.equal(ok.factId, fact.id);
    const res = h.memory.resolveRef(ok.refId, { goalEpoch: 2, goalId: 'goal-0002', connectionEpoch: conn.connectionEpoch, dimension: OVERWORLD });
    assert.ok(!('error' in res));
    assert.deepEqual(res.at, HOME.at);
    // A newer preparation generation voids the older prepared refs; a superseded fact cannot be re-grounded.
    const v2 = viewFor(h, { ...prep, generation: 4 }, 'go home', 'req-0012');
    const prep2 = v2.facts[0]?.prepRef as string;
    assert.ok('error' in h.memory.regroundPrepared(fact.prepRef, { ...admission, generation: 3 }));
    h.memory.beginGoal({ goalId: 'goal-0003', epoch: 5, instruction: 'remember this as home' });
    await h.memory.designate({ goalId: 'goal-0003', category: 'home', label: 'home', location: { dimension: OVERWORLD, at: { x: 1, y: 1, z: 1 } }, basis: 'moved' });
    const stale = h.memory.regroundPrepared(prep2, { ...admission, generation: 4, goalEpoch: 6, goalId: 'goal-0004' });
    assert.ok('error' in stale && stale.error === 'memory_fact_inactive');
    h.memory.releasePreparation('intent-0001');
    assert.equal(h.memory.shownPreparedRefs({ intentId: 'intent-0001', generation: 4 }).size, 0);
    await h.memory.close();
  });
});

describe('memory: provenance and hallucination (M2)', () => {
  it('owner, observed and verified facts stay distinguishable; a label the owner never said becomes an UNVERIFIED note and never a target', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'gather some wood' });
    const invented = await h.memory.designate({ goalId: 'goal-0001', category: 'resource', label: 'diamond cave', location: { dimension: OVERWORLD, at: { x: 500, y: 12, z: 300 } }, basis: 'planner claim' });
    assert.ok(invented.ok);
    assert.equal(invented.trusted, false);
    assert.equal(invented.fact.source, 'unverified_note');
    assert.equal(invented.fact.location, undefined, 'an ungrounded claim keeps no typed location');
    const recorded = h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'diamond cave', expect: 'recorded' }, 0);
    assert.equal(recorded.status, 'unsatisfied');
    assert.equal(h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'diamond cave', expect: 'noted' }, 0).status, 'satisfied');
    // Observed workstation from a filtered snapshot.
    h.world.snap = snapshot('snap-0001', h.world.conn!, [{ key: 'minecraft:crafting_table', at: { x: 3, y: 64, z: 3 } }]);
    h.memory.ingestObservation();
    const v = viewFor(h, goal('goal-0002', 2), 'find the diamond cave and the crafting table', 'req-0001');
    const table = v.facts.find((f) => f.key === 'minecraft:crafting_table');
    assert.equal(table?.source, 'observation');
    assert.equal(table?.trust, 'trusted');
    assert.equal(v.facts.some((f) => f.label === 'diamond cave'), false, 'notes are never listed as facts');
    const note = v.notes.find((f) => f.label === 'diamond cave');
    assert.equal(note?.trust, 'untrusted');
    assert.equal(note?.ref, undefined);
    // An irrelevant note is not retrieved at all.
    assert.equal(viewFor(h, goal('goal-0003', 3), 'follow me', 'req-0002').notes.length, 0);
    await h.memory.close();
  });

  it('forgetting requires the owner to name the fact; forgetting home leaves other facts and other worlds untouched', async () => {
    const h = harness();
    await designateHome(h);
    h.world.snap = snapshot('snap-0001', h.world.conn!, [{ key: 'minecraft:furnace', at: { x: 5, y: 64, z: 5 } }]);
    h.memory.ingestObservation();
    h.memory.beginGoal({ goalId: 'goal-0002', epoch: 2, instruction: 'clean up please' });
    const refused = await h.memory.forget({ goalId: 'goal-0002', label: 'home' });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, 'not_owner_grounded');
    h.memory.beginGoal({ goalId: 'goal-0003', epoch: 3, instruction: 'forget home' });
    const t0 = h.clock.now();
    const done = await h.memory.forget({ goalId: 'goal-0003', label: 'home' });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'forgotten' }, t0).status, 'satisfied');
    assert.ok(h.memory.facts().some((f) => f.key === 'minecraft:furnace' && f.status === 'active'));
    assert.equal(viewFor(h, goal('goal-0004', 4), 'go home', 'req-0004').facts.some((f) => f.category === 'home'), false);
    await h.memory.close();
  });

  it('memory_state "recorded" is satisfied only by a durable trusted write made after binding (local memory confirmation)', async () => {
    const h = harness();
    const before = h.clock.now();
    assert.equal(h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'recorded' }, before).status, 'unsatisfied');
    h.clock.advance(1_000);
    await designateHome(h);
    const ev = h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'recorded' }, before);
    assert.equal(ev.status, 'satisfied');
    assert.equal(ev.evidence['confirmation'], 'local_memory_store');
    h.clock.advance(1_000);
    assert.equal(h.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'recorded' }, h.clock.now()).status, 'unsatisfied', 'an older write does not satisfy a later binding');
    await h.memory.close();
  });
});

describe('memory: changed world facts are revised, never asserted (M3)', () => {
  it('historical chest contents are labeled historical; a later empty inspection replaces them; a destroyed workstation is invalidated by direct observation', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'check the chest' });
    h.world.evidence.set('act-aaaa', { blockChanges: [], containers: [{ dimension: OVERWORLD, x: 7, y: 64, z: 7, contents: { 'minecraft:oak_planks': 12, 'minecraft:cobblestone': 30 }, atMs: h.clock.now(), via: 'inspect_container' }] });
    h.world.voxels.set('7,64,7', 'minecraft:chest');
    h.memory.recordOutcome({ ...outcome({ capability: 'inspect_container', goalId: 'goal-0001', confirmation: 'server_sync' }), actionId: 'act-aaaa' });
    h.world.snap = snapshot('snap-0001', h.world.conn!, [{ key: 'minecraft:crafting_table', at: { x: 9, y: 64, z: 9 } }]);
    h.memory.ingestObservation();
    await h.memory.flush();
    h.clock.advance(3_600_000);
    const r = await h.restart();
    const v = viewFor(r, goal('goal-0002', 2), 'craft sticks from the planks in the chest', 'req-0001');
    const chest = v.facts.find((f) => f.key === 'minecraft:chest');
    assert.ok(chest?.container);
    assert.equal(chest.container.historical, true);
    assert.equal(chest.container.contents['minecraft:oak_planks'], 12);
    assert.ok(chest.container.observedAgeS >= 3_600);
    assert.match(v.rules.join(' '), /never present stock/);
    // The chest is emptied between sessions: a fresh inspection revises memory.
    r.world.voxels.set('7,64,7', 'minecraft:chest');
    r.world.evidence.set('act-bbbb', { blockChanges: [], containers: [{ dimension: OVERWORLD, x: 7, y: 64, z: 7, contents: {}, atMs: r.clock.now(), via: 'inspect_container' }] });
    r.memory.recordOutcome({ ...outcome({ capability: 'inspect_container', goalId: 'goal-0002', goalEpoch: 2, connectionEpoch: r.world.conn!.connectionEpoch }), actionId: 'act-bbbb' });
    const tableRef = v.facts.find((f) => f.key === 'minecraft:crafting_table')?.ref as string;
    // The crafting table was destroyed: its voxel is directly observable and empty.
    r.world.voxels.set('9,64,9', 'minecraft:air');
    r.world.snap = snapshot('snap-0002', r.world.conn!, [], { x: 8, y: 64, z: 8 });
    r.memory.ingestObservation();
    const after = r.memory.facts();
    const chestFact = after.find((f) => f.key === 'minecraft:chest' && f.status === 'active');
    assert.deepEqual(chestFact?.container?.contents, {});
    const table = after.find((f) => f.key === 'minecraft:crafting_table');
    assert.equal(table?.status, 'invalid');
    assert.match(table?.statusDetail ?? '', /observed air/);
    const res = r.memory.resolveRef(tableRef, { goalEpoch: 2, goalId: 'goal-0002', connectionEpoch: r.world.conn!.connectionEpoch, dimension: OVERWORLD });
    assert.ok('error' in res && res.error === 'memory_fact_inactive');
    // A voxel that is NOT observable now changes nothing (absence of sight is not evidence).
    r.world.snap = snapshot('snap-0003', r.world.conn!, [{ key: 'minecraft:furnace', at: { x: 20, y: 64, z: 20 } }]);
    r.memory.ingestObservation();
    r.world.snap = snapshot('snap-0004', r.world.conn!, []);
    r.memory.ingestObservation();
    assert.equal(r.memory.facts().find((f) => f.key === 'minecraft:furnace')?.status, 'active');
    await r.memory.close();
  });
});

describe('memory: interrupted construction keeps only confirmed checkpoints (M5)', () => {
  it('server-confirmed placements are checkpoints; commands after the last confirmation are UNKNOWN; restart replays nothing', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'build a small cobblestone wall here' });
    for (let i = 0; i < 3; i += 1) {
      const id = `act-p00${i}`;
      h.world.evidence.set(id, { blockChanges: [{ x: 10 + i, y: 64, z: 0, from: 'minecraft:air', to: 'minecraft:cobblestone', atMs: h.clock.now() }], containers: [] });
      h.memory.recordOutcome({ ...outcome({ capability: 'place_block', goalId: 'goal-0001' }), actionId: id });
    }
    // Stop midway: the 4th placement was cancelled after its packet; its effect is unknown.
    h.memory.recordOutcome(outcome({ capability: 'place_block', goalId: 'goal-0001', status: 'cancelled', confirmation: 'none', effect: 'cancelled; 1 game command(s) after the last confirmation have UNKNOWN effects', evidence: { partialEffects: { confirmed: 'none', additional: 'unknown', commandsAfterLastConfirmation: 1 } } }));
    h.memory.onGoalTerminal({ goalId: 'goal-0001', reason: 'owner_stop', detail: 'stopped by the owner' });
    await h.memory.flush();
    const r = await h.restart();
    const project = r.memory.facts().find((f) => f.category === 'project');
    assert.equal(project?.project?.state, 'interrupted');
    assert.equal(project?.project?.checkpoints.length, 3);
    assert.equal(project?.project?.unknownEffects.length, 1);
    assert.equal(project?.project?.unknownEffects[0]?.commandsAfterLastConfirmation, 1);
    const v = viewFor(r, goal('goal-0002', 2), 'finish the cobblestone wall', 'req-0001');
    const pv = v.facts.find((f) => f.category === 'project');
    assert.equal(pv?.project?.state, 'interrupted');
    assert.equal(pv?.project?.unknownEffects, 1);
    assert.ok(pv?.project?.recent.every((c) => c.ref), 'fresh refs to verify each checkpoint with fresh observations');
    // Nothing executes on restart: the service exposes no actuation and records no new actions.
    assert.equal(r.events.filter((e) => /skill|action/.test(String(e['type']))).length, 0);
    await r.memory.close();
  });
});

describe('memory: own death incidents (M7 seams)', () => {
  it('captures a death synchronously, links a later death to the unresolved ORIGINAL, keeps the original location, and survives restart without authorizing anything', async () => {
    const h = harness();
    const conn = h.world.conn!;
    h.world.death = { dimension: OVERWORLD, position: { x: 50, y: 40, z: 50 }, accuracy: 'client_position_at_death_event', inventory: { source: 'server_sync', capturedAtMs: h.clock.now() - 90_000, items: [{ key: 'minecraft:iron_pickaxe', count: 1 }, { key: 'minecraft:cobblestone', count: 40 }] } };
    h.memory.onLifecycle({ type: 'death', connectionEpoch: conn.connectionEpoch });
    // Recorded before any persistence completes (no I/O on the revocation path).
    const first = h.memory.facts().find((f) => f.category === 'death');
    assert.ok(first?.death);
    assert.equal(first.death.lastAliveInventory.ageMsAtDeath, 90_000);
    assert.equal(first.death.recovery.status, 'unresolved');
    h.clock.advance(60_000);
    h.world.death = { dimension: OVERWORLD, position: { x: 52, y: 41, z: 49 }, accuracy: 'client_position_at_death_event', inventory: { source: 'client_model', capturedAtMs: h.clock.now() - 5_000, items: [{ key: 'minecraft:dirt', count: 3 }] } };
    h.memory.onLifecycle({ type: 'death', connectionEpoch: conn.connectionEpoch });
    await h.memory.flush();
    const r = await h.restart();
    const deaths = r.memory.facts().filter((f) => f.category === 'death');
    assert.equal(deaths.length, 2);
    const original = deaths.find((d) => !d.death?.relatedTo);
    const related = deaths.find((d) => d.death?.relatedTo);
    assert.deepEqual(original?.location?.at, { x: 50, y: 40, z: 50 }, 'the original gear location is never overwritten');
    assert.equal(related?.death?.relatedTo, original?.id);
    assert.equal(related?.death?.lastAliveInventory.source, 'client_model');
    const v = viewFor(r, goal('goal-0003', 3), 'what happened', 'req-0001');
    const shown = v.facts.filter((f) => f.category === 'death');
    assert.equal(shown.length, 2, 'unresolved incidents are always retrieved');
    assert.ok(shown.every((f) => f.ref === undefined), 'death records are historical, never executable targets');
    assert.equal(shown.find((f) => !f.death?.relatedTo)?.death?.missing.length, 2);
    // Verified recovery evidence updates the incident (MB-FLOW-003 seam).
    const upd = await r.memory.updateDeathRecovery(original!.id, { regained: [{ key: 'minecraft:iron_pickaxe', count: 1 }] }, { detail: 'picked up (server collect packet)' });
    assert.ok(upd.ok);
    assert.equal(upd.ok && upd.fact.death?.recovery.status, 'partially_recovered');
    await r.memory.close();
  });
});

describe('memory: corruption status and bounded retrieval (M4)', () => {
  it('a corrupt newest revision is reported as recovered in status lines, with the older facts intact', async () => {
    const h = harness();
    await designateHome(h);
    h.memory.beginGoal({ goalId: 'goal-0002', epoch: 2, instruction: 'remember this as the mine' });
    await h.memory.designate({ goalId: 'goal-0002', category: 'location', label: 'mine', location: { dimension: OVERWORLD, at: { x: 1, y: 2, z: 3 } }, basis: 'x' });
    await h.memory.close();
    const dir = scopeDirectory(h.root, { worldProfile: 'fixture-world', worldRevision: 1, botProfile: 'chunkbot' });
    const newest = readdirSync(dir).filter((n) => /^memory-\d+\.json$/.test(n)).sort().at(-1) as string;
    writeFileSync(join(dir, newest), readFileSync(join(dir, newest), 'utf8').slice(0, 50));
    const r = harness({ root: h.root });
    assert.equal(r.memory.status().state, 'recovered');
    assert.match(r.memory.statusLines().join('\n'), /recovered complete revision/);
    assert.ok(r.memory.facts().some((f) => f.category === 'home'));
    await r.memory.close();
  });

  it('retrieval is capped at 20 facts and the serialized bound, keeps home, and excludes irrelevant untrusted notes', async () => {
    const h = harness();
    await designateHome(h);
    const blocks = Array.from({ length: 60 }, (_, i) => ({ key: i % 2 ? 'minecraft:oak_log' : 'minecraft:coal_ore', at: { x: i * 20, y: 64, z: i * 17 } }));
    h.world.snap = snapshot('snap-0001', h.world.conn!, blocks);
    h.memory.ingestObservation();
    for (let i = 0; i < 10; i += 1) await h.memory.note({ goalId: 'goal-0001', label: `idea ${i}`, text: `maybe build a tower ${i}` });
    const v = viewFor(h, goal('goal-0002', 2), 'collect coal', 'req-0001');
    assert.ok(v.facts.length + v.notes.length <= MEMORY_BOUNDS.retrieveFacts);
    assert.ok(JSON.stringify(v).length <= MEMORY_BOUNDS.viewMaxChars + 2_000, 'rules + bounded facts');
    assert.ok(v.facts.some((f) => f.category === 'home'));
    assert.ok(v.facts.filter((f) => f.key === 'minecraft:coal_ore').length > 0);
    assert.equal(v.notes.length, 0, 'notes unrelated to the instruction are not retrieved');
    assert.ok(v.omitted.count > 0);
    const towers = viewFor(h, goal('goal-0003', 3), 'build a tower', 'req-0002');
    assert.ok(towers.notes.length > 0 && towers.notes.length <= MEMORY_BOUNDS.retrieveNotes);
    await h.memory.close();
  });
});
