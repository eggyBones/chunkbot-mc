// MB-LOC-001 integration through the REAL shared catalog/validator/candidate
// seams (without editing them): seek_owner / route_travel registered in the
// same SkillRegistry appear in the planner catalog and generated wire schema,
// pass/fail the existing proposal checks, resolve grounded candidates from the
// real PerceptionService and TaskCandidateGenerator, and re-verify route and
// destination provenance in the executor before any movement.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, type OutcomePredicate, type PlannerProposal, type TaskSpec } from '../src/contracts/index.ts';
import { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema } from '../src/contracts/locator.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { parseOwnerCoordinates } from '../src/goals/owner-coordinates.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { RouteController } from '../src/locator/routes.ts';
import { LocatorService } from '../src/locator/service.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { plannerOutputSchema } from '../src/planner/wire.ts';
import type { ExecuteContext } from '../src/skills/definition.ts';
import { allSkills } from '../src/skills/index.ts';
import { locatorSkills, routeTravelSkill } from '../src/skills/locator.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

const OWNER = 'OwnerPlayer';
const OWNER_UUID = offlinePlayerUuid(OWNER);

function world(options: { ownerVisibleAt?: { x: number; y: number; z: number }; routes?: boolean } = {}) {
  const client = fakeClient();
  const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
  scene.fill(-40, -1, -40, 40, -1, 40, 'grass_block');
  scene.bot.players[OWNER] = { uuid: OWNER_UUID, username: OWNER } as never;
  if (options.ownerVisibleAt) scene.addEntity({ id: 50, type: 'player', name: 'player', username: OWNER, uuid: OWNER_UUID, height: 1.8, at: options.ownerVisibleAt });
  const evidence = evidenceFor(client);
  const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const clock = { t: 5_000, now() { return this.t; } };
  const ids = sequentialIds();
  const perception = new PerceptionService({ session: () => session, clock, ids, observationRadius: 32, travelRadius: 128, rays: 600, ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }) });
  const services = { perception, knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger: new EvidenceLedger(clock), clock, limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 1_000 } };
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: '26.2', ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }), session: () => session, clock });
  locator.attach(client, 1);
  client.emit('login', {});
  const routes = new RouteController({ policy: RoutePolicySchema.parse({}), clock });
  perception.admitTravelAnchor(1);
  if (options.routes !== false) {
    routes.admit({ goalId: 'goal-0001', goalEpoch: 1, admittedAtMs: clock.t, source: 'owner', goalDeadlineMs: clock.t + 600_000, connectionEpoch: 1, dimension: 'overworld', admissionAnchor: { x: 0.5, y: 0, z: 0.5 }, admissionRadius: 128, ownerCoordinates: parseOwnerCoordinates('meet me at 400 0 0', 'instruction').map((c) => ({ x: c.x, y: c.y, z: c.z, source: c.source })) });
  }
  const registry = new SkillRegistry([...allSkills(), ...locatorSkills({ locator, routes })]);
  const candidates = new TaskCandidateGenerator({ registry, services, session: () => session, ids });
  const waypoint = (operation: string, data: Record<string, unknown>) => client.emit('tracked_waypoint', { operation, waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 'minecraft:default' }, ...data } });
  return { scene, session, perception, services, locator, routes, registry, candidates, waypoint, evidence, clock };
}

const nearOwner: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const seekTask = (over: Partial<TaskSpec> = {}): TaskSpec => ({ objective: 'Rejoin the owner.', decisionInstruction: 'Seek the owner, then stay close.', allowedCapabilities: ['seek_owner', 'move_near', 'follow_entity'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: nearOwner, ...over });

describe('MB-LOC-001 catalog, wire and proposal validation (shared seams, unmodified)', () => {
  const w = world();
  const catalog = w.registry.catalog();
  it('the capabilities are in the ACTUAL planner catalog and generated output schema', () => {
    const ids = catalog.capabilities.map((c) => c.id);
    assert.ok(ids.includes('seek_owner') && ids.includes('route_travel'));
    const schema = plannerOutputSchema(catalog) as { $defs: { task: { properties: { allowedCapabilities: { items: { enum: string[] } } } } } };
    assert.ok(schema.$defs.task.properties.allowedCapabilities.items.enum.includes('seek_owner'));
    assert.ok(new SkillRegistry(allSkills()).catalog().catalogVersion !== catalog.catalogVersion, 'catalog version changes with the capability set');
  });

  it('proposal checks: declared parameters pass; limit fields and invented coordinates are rejected', () => {
    const limits = { planWindowSteps: 8, remainingTaskAllowance: 64 };
    const ctx = { registry: w.services.knowledge, dimension: 'overworld', ownerCoordinates: parseOwnerCoordinates('meet me at 400 0 0', 'instruction') };
    const plan = (tasks: TaskSpec[]): PlannerProposal => ({ version: 1, disposition: 'plan', interpretation: 'Come to the owner.', outcome: { kind: 'finite', outcome: nearOwner }, tasks, morePlanningNeeded: false }) as PlannerProposal;
    assert.equal(checkProposal(plan([seekTask({ parameters: { within: 3 } })]), w.registry, limits, ctx).ok, true);
    const limitField = checkProposal(plan([seekTask({ parameters: { maxLegs: 64 } })]), w.registry, limits, ctx);
    assert.equal(limitField.ok, false);
    if (!limitField.ok) assert.match(limitField.problems.join(' '), /no allowed capability declares parameter "maxLegs"/);
    const travel = (x: number) => plan([seekTask({ allowedCapabilities: ['route_travel'], parameters: { target: { kind: 'destination', dimension: 'overworld', x, y: 0, z: 0 } } })]);
    assert.equal(checkProposal(travel(400), w.registry, limits, ctx).ok, true);
    const invented = checkProposal(travel(900), w.registry, limits, ctx);
    assert.equal(invented.ok, false);
    if (!invented.ok) assert.match(invented.problems.join(' '), /not supplied by the owner/);
  });
});

describe('MB-LOC-001 seek_owner resolution from the real perception + candidate generator', () => {
  it('owner out of sight with a current cue -> one grounded option; the description carries no coordinates', () => {
    const w = world();
    try {
      w.waypoint('track', { type: 'vec3i', data: { x: 317, y: 9, z: -88 } });
      const snap = w.perception.take(1)!;
      assert.equal(snap.owner.visible, false);
      const set = w.candidates.generate(seekTask(), snap);
      const seek = set.candidates.filter((c) => c.capability === 'seek_owner');
      assert.equal(seek.length, 1, JSON.stringify(set.unavailable));
      assert.match(seek[0]!.description, /toward east .*far distance, above height/);
      for (const n of ['317', '-88']) assert.ok(!JSON.stringify(seek[0]).includes(n), `exact coordinate ${n} leaked`);
      assert.ok(set.unavailable.some((u) => u.capability === 'follow_entity'), 'ordinary following still needs a visible owner');
    } finally {
      w.evidence.detach();
    }
  });

  it('no cue, hidden owner -> no option with a precise reason; a task that does not target the owner -> no option', () => {
    const w = world();
    try {
      const snap = w.perception.take(1)!;
      const set = w.candidates.generate(seekTask(), snap);
      assert.equal(set.candidates.filter((c) => c.capability === 'seek_owner').length, 0);
      assert.ok(set.unavailable.some((u) => u.capability === 'seek_owner' && u.reason === 'no_locator_hint'));
      w.waypoint('track', { type: 'azimuth', data: 1 });
      w.waypoint('untrack', { type: 'empty' });
      const set2 = w.candidates.generate(seekTask(), w.perception.take(1)!);
      assert.ok(set2.unavailable.some((u) => u.capability === 'seek_owner' && u.reason === 'no_locator_hint' && /withdrew/.test(u.detail)));
      const other = w.candidates.generate(seekTask({ targetSelectors: [], completion: { predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 1, mayBeConsumedLater: false } }), w.perception.take(1)!);
      assert.ok(other.unavailable.some((u) => u.capability === 'seek_owner' && u.reason === 'owner_not_targeted'));
    } finally {
      w.evidence.detach();
    }
  });

  it('owner visible inside the travel bound -> ordinary visible following/approach, not seeking (26.1.2 regression path unchanged)', () => {
    const w = world({ ownerVisibleAt: { x: 8.5, y: 0, z: 0.5 } });
    try {
      w.waypoint('track', { type: 'vec3i', data: { x: 8, y: 0, z: 0 } });
      const snap = w.perception.take(1)!;
      assert.equal(snap.owner.visible, true);
      const set = w.candidates.generate(seekTask(), snap);
      assert.ok(set.unavailable.some((u) => u.capability === 'seek_owner' && u.reason === 'owner_visible'));
      assert.ok(set.candidates.some((c) => c.capability === 'follow_entity'));
      assert.ok(set.candidates.some((c) => c.capability === 'move_near'));
    } finally {
      w.evidence.detach();
    }
  });
});

describe('MB-LOC-001 route_travel provenance in resolver AND executor', () => {
  const dest = (x: number) => ({ kind: 'owner_destination' as const, dimension: 'overworld', at: { x, y: 0, z: 0 }, ownerText: `meet me at ${x} 0 0` });
  const travelTask = (x: number): TaskSpec => ({ objective: 'Go there.', decisionInstruction: 'Travel.', allowedCapabilities: ['route_travel'], targetSelectors: [dest(x)], parameters: {}, completion: { predicate: 'near_target', target: dest(x), within: 3 } });

  it('resolver: an owner-typed far destination of THIS goal is offered; other coordinates are not', () => {
    const w = world();
    try {
      const snap = w.perception.take(1)!;
      const ok = w.candidates.generate(travelTask(400), snap);
      assert.equal(ok.candidates.length, 1, JSON.stringify(ok.unavailable));
      const forged = w.candidates.generate(travelTask(900), snap);
      assert.equal(forged.candidates.length, 0);
      assert.ok(forged.unavailable.some((u) => u.reason === 'route_destination_unverified'));
    } finally {
      w.evidence.detach();
    }
  });

  it('resolver: without a route authorization nothing is offered', () => {
    const w = world({ routes: false });
    try {
      const set = w.candidates.generate(travelTask(400), w.perception.take(1)!);
      assert.equal(set.candidates.length, 0);
      assert.ok(set.unavailable.some((u) => u.reason === 'route_not_authorized'));
    } finally {
      w.evidence.detach();
    }
  });

  it('executor: re-verifies provenance before any command (forged coordinates / own_death without authorization)', async () => {
    const w = world();
    try {
      const skill = routeTravelSkill({ locator: w.locator, routes: w.routes });
      let commands = 0;
      const act = { sleep: async () => void (commands += 1), fence: () => undefined } as unknown as ExecuteContext['act'];
      const ctx = { act, session: w.session, services: w.services, candidate: { goalEpoch: 1 }, owner: { kind: 'goal', goalEpoch: 1, goalId: 'goal-0001', taskId: 'task-0001' }, progress: () => undefined } as unknown as ExecuteContext;
      const forged = await skill.execute(ctx, { target: { kind: 'destination', dimension: 'overworld', x: 900, y: 0, z: 0 }, within: 3, durationMs: 5_000 });
      assert.equal(forged.status, 'precondition_failed');
      assert.equal(forged.reason, 'route_destination_unverified');
      const death = await skill.execute(ctx, { destination: 'own_death', within: 3, durationMs: 5_000 });
      assert.equal(death.status, 'precondition_failed');
      assert.equal(death.reason, 'route_destination_not_authorized');
      const wrongEpoch = { ...ctx, owner: { kind: 'goal', goalEpoch: 7, goalId: 'goal-0007', taskId: 'task-0002' } } as unknown as ExecuteContext;
      const stale = await skill.execute(wrongEpoch, { target: { kind: 'destination', dimension: 'overworld', x: 400, y: 0, z: 0 }, within: 3, durationMs: 5_000 });
      assert.equal(stale.reason, 'route_not_authorized');
      assert.equal(commands, 0, 'nothing was issued');
    } finally {
      w.evidence.detach();
    }
  });
});
