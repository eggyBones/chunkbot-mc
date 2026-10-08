// MB-PLAN-006 N-G3 — reusable bounded target grouping and removal outcome:
// a floating tree beside an unrelated grounded tree is ONE observed group;
// work is scoped to that group; the outcome is removal of THAT group's bound
// positions (never "collect N logs" elsewhere). Uses the actual
// PerceptionService, TaskCandidateGenerator, proposal checker and
// PredicateEngine on a credential-free fake world (no fixture, no inference).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type OutcomePredicate, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
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
  return { scene, perception, generator, predicates, registry, knowledge, session };
}

const signal = () => new AbortController().signal;

describe('MB-PLAN-006 N-G3 observation groups', () => {
  it('reports the floating remnant and the grounded tree as separate bounded groups with support', () => {
    const { perception } = treeScene();
    const snap = perception.take(0)!;
    const groups = snap.groups ?? [];
    assert.equal(groups.length, 2, JSON.stringify(groups));
    const birch = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:birch_log'))!;
    const oak = groups.find((g) => g.keys.some((k) => k.key === 'minecraft:oak_log'))!;
    assert.equal(birch.support, 'floating');
    assert.equal(oak.support, 'grounded');
    assert.ok(!birch.keys.some((k) => k.key.startsWith('minecraft:oak')), 'unrelated tree not merged');
    assert.equal(birch.class, 'tree');
    // The planner sees the groups (bounded rendering) and can reference their handles.
    const rendered = renderObservation(snap) as { groups: Array<{ handle: string; support: string }> };
    assert.deepEqual(rendered.groups.map((g) => g.support).sort(), ['floating', 'grounded']);
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
