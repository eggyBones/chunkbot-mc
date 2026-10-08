// MB-PLAN-006 N-G3 — reusable bounded target grouping and removal outcome:
// a floating tree beside an unrelated grounded tree is ONE observed group;
// work is scoped to that group; the outcome is removal of THAT group's bound
// positions (never "collect N logs" elsewhere). Uses the actual
// PerceptionService, TaskCandidateGenerator, proposal checker and
// PredicateEngine on a credential-free fake world (no fixture, no inference).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type GoalOutcomeContract, type OutcomePredicate, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { SkillExecutorImpl } from '../src/execution/executor.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { renderObservation } from '../src/planner/prompt.ts';
import { proposalFromWire } from '../src/planner/wire.ts';
import { allSkills } from '../src/skills/index.ts';
import { constructionSkills } from '../src/skills/construction.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { ownerQuestionIn } from '../src/goals/declarative.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

function treeScene() {
  const client = fakeClient((name, data) => {
    // The server answers inventory resyncs (empty inventory) so predicate evaluation is prompt.
    if (name === 'window_click' && data['stateId'] === -1) setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 9, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
    ackSequenced(client, name, data);
  });
  const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
  scene.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
  // Grounded oak tree east of the bot: trunk x=4 y=0..3 with a small canopy.
  scene.fill(4, 0, 0, 4, 3, 0, 'oak_log');
  scene.fill(3, 4, -1, 5, 4, 1, 'oak_leaves');
  // Floating birch remnant west of the bot: trunk x=-3 y=2..4 (air beneath), canopy above.
  scene.fill(-3, 2, 0, -3, 4, 0, 'birch_log');
  scene.fill(-4, 5, -1, -2, 5, 1, 'birch_leaves');
  const evidence = evidenceFor(client);
  const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const knowledge = new VersionKnowledge({ version: '26.1.2' });
  const ledger = new EvidenceLedger(systemClock);
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 24, travelRadius: 128, rays: 2400 });
  const services = { perception, knowledge, ledger, clock: systemClock, limits: { observationRadius: 24, travelRadius: 128, ownerLossMs: 1_000 } };
  const registry = new SkillRegistry(allSkills());
  const generator = new TaskCandidateGenerator({ registry, services, session: () => session, ids: sequentialIds() });
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
  const predicates = new PredicateEngine({ services, session: () => session, leases });
  return { scene, perception, generator, predicates, registry, knowledge, session, services, leases, client };
}

const signal = () => new AbortController().signal;

describe('MB-PLAN-006 N-G3 observation groups', () => {
  it('N1-R5: three independent removal completions permit each bound member, while primary, registry, stale and original-goal fences remain binding', async () => {
    const w = treeScene();
    const positions = [{x:0,y:1,z:2},{x:1,y:1,z:2},{x:2,y:1,z:2}];
    const other = {x:-1,y:1,z:2};
    for (const p of [...positions,other]) w.scene.setBlock(p.x,p.y,p.z,'birch_leaves');
    const snap = w.perception.take(3)!;
    const refs = positions.map((p) => {
      const b = snap.blocks.find((b) => b.at.x===p.x && b.at.y===p.y && b.at.z===p.z);
      assert.ok(b, 'every member is freshly visible');
      return {kind:'observed',snapshotId:snap.id,handle:b.handle} as const;
    });
    const completion: OutcomePredicate = {predicate:'all',of:refs.map((target)=>({predicate:'blocks_removed',target,selector:'minecraft:birch_leaves'}))};
    const bound = await w.predicates.bind(completion,signal());
    const originalScope = w.predicates.captureContinuation(bound).removal;
    const task: TaskSpec = {objective:'Remove the three shown bound blocks.',decisionInstruction:'Pick a current member.',allowedCapabilities:['mine_block'],targetSelectors:refs,parameters:{},completion};
    const fresh = w.perception.take(3)!;
    const offered = w.generator.generate(task,fresh,originalScope);
    assert.equal(offered.candidates.length,3,JSON.stringify(offered.unavailable));
    const offeredPositions = offered.candidates.map((c)=>{
      const t=c.parameters['target'] as {snapshotId:string;handle:string};
      const r=w.perception.resolve(t.snapshotId,t.handle);
      assert.ok(!('error' in r) && r.target.kind==='block');
      return `${r.target.x},${r.target.y},${r.target.z}`;
    });
    assert.deepEqual(new Set(offeredPositions),new Set(positions.map(p=>`${p.x},${p.y},${p.z}`)));
    assert.equal(w.generator.generate({...task,targetSelectors:[refs[0]!] },fresh,originalScope).candidates.length,1,'completion discovery cannot broaden an explicit primary target');
    const foreign=fresh.blocks.find(b=>b.at.x===other.x && b.at.y===other.y && b.at.z===other.z)!;
    assert.ok(foreign);
    const foreignTarget={kind:'observed',snapshotId:fresh.id,handle:foreign.handle} as const;
    assert.equal(w.generator.generate({...task,targetSelectors:[foreignTarget]},fresh).candidates.length,0,'disjoint task and completion work sets cannot combine');
    assert.equal(w.generator.generate({...task,targetSelectors:[...refs,{kind:'registry',key:'minecraft:oak_leaves'}]},fresh,originalScope).candidates.length,0,'registry remains binding');
    const substituted:TaskSpec={...task,targetSelectors:[foreignTarget],completion:{predicate:'blocks_removed',target:foreignTarget,selector:'minecraft:birch_leaves'}};
    const unfenced=w.generator.generate(substituted,fresh);
    assert.equal(unfenced.candidates.length,1,'discriminating foreign positive control');
    assert.equal(w.generator.generate(substituted,fresh,originalScope).candidates.length,0,'fresh sibling work cannot enlarge the original outcome');
    w.perception.admitTravelAnchor(3);
    const executor = new SkillExecutorImpl({registry:w.registry,leases:w.leases,session:()=>w.session,services:w.services,goalEpoch:()=>3,store:new MemoryRunStore()});
    const writes=w.client.written.length;
    const denied=await executor.execute(unfenced.candidates[0]!,signal(),{kind:'goal',goalId:'goal-0001',goalEpoch:3,taskId:'task-0001',destructiveScope:originalScope});
    assert.equal(denied.reason,'destructive_target_conflict'); assert.equal(w.client.written.length,writes);
    for(const p of positions.slice(0,2)) w.scene.setBlock(p.x,p.y,p.z,'air');
    const later=w.perception.take(3)!;
    assert.equal(w.generator.generate({...task,targetSelectors:[refs[0]!]},later,originalScope).candidates.length,0,'stale primary admits no substitute remaining member');
    assert.equal((await w.predicates.evaluate(bound,signal())).status,'unsatisfied','one remaining member cannot credit completion');
    w.scene.setBlock(positions[2]!.x,positions[2]!.y,positions[2]!.z,'air');
    assert.equal((await w.predicates.evaluate(bound,signal())).status,'satisfied');
    assert.equal(w.scene.bot.blockAt({x:other.x,y:other.y,z:other.z})?.name,'birch_leaves','unrelated leaf unchanged');
  });
  it('N1-R4 keeps only the exact bound outcome after shown-history eviction; new tasks and destructive scope remain fenced', async () => {
    const { perception, predicates, registry, knowledge, generator, scene } = treeScene();
    const initial = perception.take(0)!;
    const birch = initial.groups!.find((g) => g.support === 'floating')!;
    const originalTarget = { kind: 'observed', snapshotId: initial.id, handle: birch.handle } as const;
    const acceptedOutcome: GoalOutcomeContract = { kind: 'finite', outcome: { predicate: 'all', of: ['minecraft:birch_log', 'minecraft:birch_leaves'].map((selector) => ({ predicate: 'blocks_removed', target: originalTarget, selector })) } };
    const bound = await predicates.bind(acceptedOutcome.outcome, signal());
    // The trunk is gone, but the goal's original canopy remains bound.
    scene.fill(-3, 2, 0, -3, 4, 0, 'air');
    for (let i = 0; i < 10; i += 1) perception.take(0);
    const fresh = perception.take(0)!;
    const leaf = fresh.blocks.find((b) => b.key === 'minecraft:birch_leaves')!;
    assert.ok(leaf);
    const target = { kind: 'observed', snapshotId: fresh.id, handle: leaf.handle } as const;
    const task: TaskSpec = { objective: 'Remove the remaining bound canopy.', decisionInstruction: 'Use the shown birch leaf.', allowedCapabilities: ['mine_block'], targetSelectors: [target], parameters: {}, completion: { predicate: 'blocks_removed', target, selector: 'minecraft:birch_leaves' } };
    const raw = { version: 1, disposition: 'plan', interpretation: 'Finish the original removal.', outcome: acceptedOutcome, tasks: [task], morePlanningNeeded: true };
    const context = { registry: knowledge, shown: new Map([[fresh.id, { handles: new Set([...fresh.blocks, ...(fresh.groups ?? [])].map((b) => b.handle)), dimension: fresh.dimension }]]), dimension: fresh.dimension };
    const limits = { planWindowSteps: 4, remainingTaskAllowance: 10 };
    assert.equal(checkProposal(raw, registry, limits, context).ok, false, 'unadmitted old outcomes cannot acquire authority');
    const check = checkProposal(raw, registry, limits, { ...context, acceptedOutcome });
    assert.ok(check.ok && check.proposal.disposition === 'plan', JSON.stringify(check));
    assert.deepEqual(check.proposal.outcome, acceptedOutcome);
    const scope = predicates.captureContinuation(bound).removal;
    const remaining = generator.generate(check.proposal.tasks[0]!, fresh, scope);
    assert.ok(remaining.candidates.some((c) => c.capability === 'mine_block'), 'fresh remaining leaf is still actionable');
    const oak = fresh.groups!.find((g) => g.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    const substituted: TaskSpec = { ...task, targetSelectors: [{ kind: 'observed', snapshotId: fresh.id, handle: oak.handle }], completion: { ...task.completion, selector: 'minecraft:oak_log' } as OutcomePredicate };
    assert.ok(generator.generate(substituted, fresh, scope).candidates.every((c) => c.capability !== 'mine_block'), 'accepted outcome cannot union oak into destructive authority');
    for (const staleTask of [{ ...task, targetSelectors: [originalTarget] }, { ...task, completion: acceptedOutcome.outcome }]) {
      const stale = checkProposal({ ...raw, tasks: [staleTask] }, registry, limits, { ...context, acceptedOutcome });
      assert.ok(!stale.ok && stale.kind === 'reference', JSON.stringify(stale));
    }
    const altered = checkProposal({ ...raw, outcome: { kind: 'finite', outcome: { predicate: 'blocks_removed', target: originalTarget, selector: 'minecraft:oak_log' } } }, registry, limits, { ...context, acceptedOutcome });
    assert.ok(!altered.ok && altered.kind === 'semantic', 'the old outcome identity cannot be edited');
    const status = await predicates.evaluate(bound, signal());
    assert.equal(status.status, 'unsatisfied', 'uncleared bound leaves cannot credit completion');
  });
  it('reports the floating remnant and the grounded tree as separate bounded groups with support', () => {
    const { perception } = treeScene();
    const snap = perception.take(0)!;
    const groups = snap.groups ?? [];
    assert.equal(groups.length, 2, JSON.stringify(groups));
    const birch = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:birch_log'))!;
    const oak = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    assert.equal(birch.support, 'floating');
    assert.equal(oak.support, 'unknown', 'the soil under the trunk is not visible: hidden data never proves ground');
    assert.ok(!birch.keys.some((k) => k.key.startsWith('minecraft:oak')), 'unrelated tree not merged');
    assert.equal(birch.class, 'tree');
    // The planner sees the groups (bounded rendering) and can reference their handles.
    const rendered = renderObservation(snap) as { groups: Array<{ handle: string; support: string }> };
    assert.deepEqual(rendered.groups.map((g) => g.support).sort(), ['floating', 'unknown']);
  });

  it('a group handle re-grounds to the SAME group in a fresh snapshot, and not after it is gone', () => {
    const { perception, scene } = treeScene();
    const first = perception.take(0)!;
    const birch = first.groups!.find((g) => g.support === 'floating')!;
    scene.setBlock(-3, 4, 0, 'air'); // partly removed
    const second = perception.take(0)!;
    const moved = perception.translateHandle(first.id, birch.handle, second.id);
    assert.ok(moved);
    assert.equal(second.groups!.find((g) => g.handle === moved)?.support, 'floating');
    scene.fill(-4, 2, -1, -2, 5, 1, 'air');
    const third = perception.take(0)!;
    assert.equal(perception.translateHandle(first.id, birch.handle, third.id), undefined, 'no fallback to the oak tree');
  });
});

describe('MB-PLAN-006 N-G3 scoped work and removal outcome', () => {
  it('N1-R3: replan cannot union an unrelated oak target with the original birch completion or bypass explicit leaf keys', async () => {
    const w = treeScene();
    const original = w.perception.take(3)!;
    const birch = original.groups!.find((g) => g.support === 'floating')!;
    const root: OutcomePredicate = { predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: original.id, handle: birch.handle }, selector: '#minecraft:logs' };
    const bound = await w.predicates.bind(root, signal());
    const scope = w.predicates.captureContinuation(bound).removal;
    w.scene.fill(-3, 2, 0, -3, 4, 0, 'air');
    const fresh = w.perception.take(3)!;
    const oak = fresh.groups!.find((g) => g.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    const replan: TaskSpec = { objective: 'remove remaining leaves', decisionInstruction: 'only birch leaves', allowedCapabilities: ['mine_block'], targetSelectors: [{ kind: 'observed', snapshotId: fresh.id, handle: oak.handle }, { kind: 'registry', key: 'minecraft:birch_leaves' }], parameters: {}, completion: root };
    assert.equal(w.generator.generate(replan, fresh, scope).candidates.length, 0, 'conflicting targets do not become a destructive union');
    const malicious = { ...replan, targetSelectors: [{ kind: 'observed' as const, snapshotId: fresh.id, handle: oak.handle }], completion: { predicate: 'inventory_delta' as const, selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: false } };
    const unbound = w.generator.generate(malicious, fresh);
    assert.ok(unbound.candidates.length > 0, 'discriminating oak options without the original goal fence');
    assert.equal(w.generator.generate(malicious, fresh, scope).candidates.length, 0, 'the bound goal fence survives a changed task predicate');
    w.perception.admitTravelAnchor(3);
    const executor = new SkillExecutorImpl({ registry: w.registry, leases: w.leases, session: () => w.session, services: w.services, goalEpoch: () => 3, store: new MemoryRunStore() });
    const writes = w.client.written.length;
    const outcome = await executor.execute(unbound.candidates[0]!, signal(), { kind: 'goal', goalId: 'goal-0001', goalEpoch: 3, taskId: 'task-0001', destructiveScope: scope });
    assert.equal(outcome.reason, 'destructive_target_conflict');
    assert.equal(w.client.written.length, writes, 'execution refuses before any command');
  });

  it('mining scoped to the bound group offers only that group\'s blocks; the unrelated tree stays out of scope', () => {
    const { perception, generator } = treeScene();
    const snap = perception.take(0)!;
    const birch = snap.groups!.find((g) => g.support === 'floating')!;
    const scoped: TaskSpec = {
      objective: 'remove the floating birch tree',
      decisionInstruction: 'break its logs',
      allowedCapabilities: ['mine_block'],
      targetSelectors: [{ kind: 'observed', snapshotId: snap.id, handle: birch.handle }],
      parameters: {},
      completion: { predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'minecraft:birch_log' },
    };
    const fresh = perception.take(0)!;
    const set = generator.generate(scoped, fresh);
    assert.ok(set.candidates.length > 0, JSON.stringify(set.unavailable));
    for (const c of set.candidates) {
      const t = (c.parameters as { target: { snapshotId: string; handle: string } }).target;
      const r = perception.resolve(t.snapshotId, t.handle);
      assert.ok(!('error' in r) && r.target.kind === 'block' && r.target.x <= -2 && r.target.x >= -4, `only birch-group blocks: ${c.description}`);
    }
    // Unscoped log mining would include the oak tree too (contrast).
    const open = generator.generate({ ...scoped, targetSelectors: [], completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 1, mayBeConsumedLater: false } }, fresh);
    assert.ok(open.candidates.some((c) => /oak_log/.test(c.description)));
  });

  it('blocks_removed binds THAT group\'s positions and is satisfied only when they are removed (other logs elsewhere do not count)', async () => {
    const { perception, predicates, scene } = treeScene();
    const snap = perception.take(0)!;
    const birch = snap.groups!.find((g) => g.support === 'floating')!;
    const p: OutcomePredicate = { predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'minecraft:birch_log' };
    const bound = await predicates.bind(p, signal());
    let e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'unsatisfied');
    assert.equal(e.evidence['remaining'], 3);
    // Removing the OAK tree changes nothing for this outcome.
    scene.fill(4, 0, 0, 4, 3, 0, 'air');
    e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'unsatisfied');
    scene.fill(-3, 2, 0, -3, 3, 0, 'air');
    e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'unsatisfied');
    assert.equal(e.evidence['remaining'], 1);
    scene.setBlock(-3, 4, 0, 'air');
    e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'satisfied', e.detail);
  });

  it('blocks_removed outlives snapshot eviction but is unknown after a lifecycle interruption', async () => {
    const { perception, predicates, scene } = treeScene();
    const snap = perception.take(0)!;
    const birch = snap.groups!.find((g) => g.support === 'floating')!;
    for (let i = 0; i < 10; i += 1) perception.take(0);
    const bound = await predicates.bind({ predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'minecraft:birch_log' }, signal());
    scene.fill(-3, 2, 0, -3, 4, 0, 'air');
    assert.equal((await predicates.evaluate(bound, signal())).status, 'satisfied', 'identity retained after eviction');
    const bound2 = await predicates.bind({ predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'minecraft:birch_leaves' }, signal());
    (predicates as unknown as { deps: { services: { ledger: EvidenceLedger } } }).deps.services.ledger.invalidate('death');
    assert.equal((await predicates.evaluate(bound2, signal())).status, 'unknown');
  });

  it('proposals may only bind blocks_removed to a shown group or block handle; the wire round-trips it', () => {
    const { perception, registry, knowledge } = treeScene();
    const snap = perception.take(0)!;
    const birch = snap.groups!.find((g) => g.support === 'floating')!;
    const shown = new Map([[snap.id, { handles: new Set([...snap.blocks, ...snap.entities].map((t) => t.handle).concat(snap.groups!.map((g) => g.handle))), dimension: snap.dimension }]]);
    const registryFacts = knowledge;
    const plan = (target: unknown) => ({
      version: 1,
      disposition: 'plan',
      interpretation: 'Removing the floating birch tree; the oak tree stays.',
      outcome: { kind: 'finite', outcome: { predicate: 'blocks_removed', target, selector: 'minecraft:birch_log' } },
      tasks: [{ objective: 'break the birch logs', decisionInstruction: 'mine the floating birch logs', allowedCapabilities: ['mine_block'], targetSelectors: [target], parameters: {}, completion: { predicate: 'blocks_removed', target, selector: 'minecraft:birch_log' } }],
      morePlanningNeeded: true,
    });
    const ok = checkProposal(plan({ kind: 'observed', snapshotId: snap.id, handle: birch.handle }), registry, { planWindowSteps: 4, remainingTaskAllowance: 10 }, { registry: registryFacts, shown, dimension: snap.dimension });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const bad = checkProposal(plan({ kind: 'registry', key: 'minecraft:birch_log' }), registry, { planWindowSteps: 4, remainingTaskAllowance: 10 }, { registry: registryFacts, shown, dimension: snap.dimension });
    assert.equal(bad.ok, false);
    const invented = checkProposal(plan({ kind: 'observed', snapshotId: snap.id, handle: 'grp-999' }), registry, { planWindowSteps: 4, remainingTaskAllowance: 10 }, { registry: registryFacts, shown, dimension: snap.dimension });
    assert.equal(invented.ok, false);
    const wire = proposalFromWire({
      disposition: 'cannot_execute',
      interpretation: 'x',
      outcome: { kind: 'finite', predicate: { predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'birch_log' } },
      tasks: [],
      morePlanningNeeded: false,
      queries: [],
      missing: 'm',
      missingCapabilities: [],
      verifiedProgress: null,
    });
    assert.equal(wire.disposition, 'cannot_execute');
  });
});

describe('MB-PLAN-006 "here" home site (fresh visible owner, never hidden)', () => {
  function siteScene(ownerVisible: boolean) {
    const client = fakeClient();
    const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
    scene.fill(-24, -1, -24, 24, -1, 24, 'grass_block');
    if (ownerVisible) scene.addEntity({ id: 500, type: 'player', name: 'player', username: 'Jake', uuid: offlinePlayerUuid('Jake'), height: 1.8, at: { x: 14.5, y: 0, z: 0.5 } });
    else scene.fill(10, 0, -3, 10, 3, 3, 'stone'); // a wall hides the owner position
    const evidence = evidenceFor(client);
    const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
    const knowledge = new VersionKnowledge({ version: '26.1.2' });
    const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 24, travelRadius: 128, rays: 2400, ownerName: 'Jake' });
    const services = { perception, knowledge, ledger: new EvidenceLedger(systemClock), clock: systemClock, limits: { observationRadius: 24, travelRadius: 128, ownerLossMs: 1_000 } };
    const home = { project: () => undefined, writable: () => true } as never;
    const select = constructionSkills({ home, inspector: {} as never, interior: 3, maxSiteDistance: 8 }).find((s) => s.descriptor.id === 'select_home_site')!;
    const snap = perception.take(0)!;
    const resolve = (parameters: Record<string, unknown>) =>
      select.resolve({ task: { objective: 'site', decisionInstruction: 'site', allowedCapabilities: ['select_home_site'], targetSelectors: [], parameters: parameters as never, completion: { predicate: 'structure_state', structure: 'home', expect: 'site_approved' } }, hints: { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: parameters as never, memoryRefs: [] }, snapshot: snap, session, services });
    return { resolve, snap };
  }

  it('near=owner searches around the visible owner; default searches around the bot', () => {
    const { resolve, snap } = siteScene(true);
    assert.equal(snap.owner.visible, true);
    const here = resolve({ near: 'owner' });
    assert.ok(here.drafts.length > 0, JSON.stringify(here.unavailable));
    for (const d of here.drafts) {
      const o = d.parameters['origin'] as { x: number; z: number };
      assert.ok(Math.hypot(o.x + 2.5 - 14.5, o.z + 2.5 - 0.5) <= 12, `site near the owner: ${d.description}`);
      assert.equal(d.parameters['near'], 'owner');
    }
    const self = resolve({});
    assert.ok(self.drafts.every((d) => Math.hypot((d.parameters['origin'] as { x: number }).x + 2.5 - 0.5, (d.parameters['origin'] as { z: number }).z + 2.5 - 0.5) <= 12));
  });

  it('near=owner with the owner not visible is a declarative blocker (no hidden coordinates)', () => {
    const { resolve, snap } = siteScene(false);
    assert.equal(snap.owner.visible, false);
    const r = resolve({ near: 'owner' });
    assert.equal(r.drafts.length, 0);
    assert.equal(r.unavailable?.[0]?.reason, 'owner_not_visible');
    assert.equal(ownerQuestionIn(r.unavailable?.[0]?.detail), undefined, 'the blocker is declarative');
  });
});


describe('MB-PLAN-006 N-G3 review corrections: trunk segmentation, lineage, line-of-sight support', () => {
  function touchingScene() {
    const t = treeScene();
    // Clear the default trees; build a floating birch (trunk x=-3 y=2..4, canopy y=5) next to an
    // ordinary oak (trunk x=0 y=0..4, canopy y=5) whose canopies TOUCH (x=-2 and x=-1 at y=5).
    t.scene.fill(-6, 0, -3, 6, 8, 3, 'air');
    t.scene.fill(-3, 2, 0, -3, 4, 0, 'birch_log');
    t.scene.fill(-4, 5, -1, -2, 5, 1, 'birch_leaves');
    t.scene.fill(0, 0, 3, 0, 4, 3, 'oak_log');
    t.scene.fill(-1, 5, 2, 1, 5, 4, 'oak_leaves');
    t.scene.fill(-2, 5, 2, -2, 5, 2, 'oak_leaves'); // touches the birch canopy at (-2,5,1)
    return t;
  }

  it('touching canopies never merge two trees; unrelated logs never enter scope or the removal proof', async () => {
    const { perception, generator, predicates, scene } = touchingScene();
    const snap = perception.take(0)!;
    const groups = snap.groups ?? [];
    const birch = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:birch_log'))!;
    const oak = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    assert.ok(birch && oak && birch.handle !== oak.handle, JSON.stringify(groups));
    assert.ok(!birch.keys.some((k) => k.key === 'minecraft:oak_log'), 'no oak log in the birch group');
    assert.equal(birch.support, 'floating');
    const sel = { kind: 'observed' as const, snapshotId: snap.id, handle: birch.handle };
    const set = generator.generate({ objective: 'remove the floating tree', decisionInstruction: 'mine it', allowedCapabilities: ['mine_block'], targetSelectors: [sel], parameters: {}, completion: { predicate: 'blocks_removed', target: sel, selector: '#minecraft:logs' } }, perception.take(0)!);
    for (const c of set.candidates) assert.doesNotMatch(c.description, /oak_log/, `out of scope: ${c.description}`);
    const bound = await predicates.bind({ predicate: 'blocks_removed', target: sel, selector: '#minecraft:logs' }, signal());
    scene.fill(-3, 2, 0, -3, 4, 0, 'air');
    perception.take(0);
    const e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'satisfied', `${e.detail} (the oak's logs are not part of the proof)`);
    assert.equal(e.evidence['bound'], 3);
  });

  it('re-grounding never expands into a neighbouring tree even if the neighbour shares a leaf', () => {
    const { perception, scene } = touchingScene();
    const first = perception.take(0)!;
    const birch = first.groups!.find((g) => g.keys.some((k) => k.key === 'minecraft:birch_log'))!;
    // Remove the birch trunk: only the oak (whose leaf touches the birch canopy) remains with a trunk.
    scene.fill(-3, 2, 0, -3, 4, 0, 'air');
    const second = perception.take(0)!;
    assert.equal(perception.translateHandle(first.id, birch.handle, second.id), undefined, 'no lineage into the oak');
  });

  it('incrementally revealed logs of the SAME tree join the removal proof (no premature satisfaction)', async () => {
    const { perception, predicates, scene } = treeScene();
    // Birch trunk y=2..4 visible; y=5,6 logs enclosed by leaves (hidden until the logs below are removed).
    scene.fill(-5, 5, -2, -1, 7, 2, 'birch_leaves');
    scene.fill(-3, 5, 0, -3, 6, 0, 'birch_log');
    const snap = perception.take(0)!;
    const birch = snap.groups!.find((g) => g.keys.some((k) => k.key === 'minecraft:birch_log'))!;
    assert.equal(birch.keys.find((k) => k.key === 'minecraft:birch_log')?.count, 3, 'the enclosed logs are not reported');
    const bound = await predicates.bind({ predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: snap.id, handle: birch.handle }, selector: 'minecraft:birch_log' }, signal());
    scene.fill(-3, 2, 0, -3, 4, 0, 'air'); // every originally seen log removed
    perception.take(0); // the y=5 log is now visible from below
    let e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'unsatisfied', `${e.detail}: the newly exposed connected log joins`);
    scene.setBlock(-3, 5, 0, 'air');
    perception.take(0);
    e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'unsatisfied', `${e.detail}: the next revealed log joins through the removed one`);
    scene.setBlock(-3, 6, 0, 'air');
    perception.take(0);
    e = await predicates.evaluate(bound, signal());
    assert.equal(e.status, 'satisfied', e.detail);
    assert.equal(e.evidence['bound'], 5);
  });

  it('support: grounded only from a SEEN solid block below; hidden roots stay unknown', () => {
    const { perception, scene } = treeScene();
    scene.fill(-6, 0, -3, 6, 8, 3, 'air');
    // A trunk on a visible stone pedestal (the pedestal's sides are seen).
    scene.setBlock(2, 0, 0, 'stone');
    scene.fill(2, 1, 0, 2, 3, 0, 'oak_log');
    const snap = perception.take(0)!;
    const g = snap.groups!.find((x) => x.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    assert.equal(g.support, 'grounded');
    assert.ok(!g.keys.some((k) => k.key === 'minecraft:stone'), 'the support block is never reported as a member');
  });
});
