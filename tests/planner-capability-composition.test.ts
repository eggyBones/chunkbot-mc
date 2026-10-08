// N1-C12-R5: production application catalog/knowledge/rendering, then real
// survival incident -> route admission -> proposal and candidate fences.
// Packet fixtures and self/world models are simulated; no planner inference.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { join } from 'node:path';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, type PlannerProposal, type PlannerRequest, type TaskSpec } from '../src/contracts/index.ts';
import { RoutePolicySchema } from '../src/contracts/locator.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { RouteController } from '../src/locator/routes.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { PLANNER_INSTRUCTIONS, PLANNER_INSTRUCTIONS_VERSION, renderRequest } from '../src/planner/prompt.ts';
import { proposalFromWire } from '../src/planner/wire.ts';
import { allSkills } from '../src/skills/index.ts';
import { locatorSkills } from '../src/skills/locator.ts';
import { navigateRecoveryTravel, survivalSkills } from '../src/skills/survival.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot } from './survival-helpers.ts';

after(cleanupRoots);
const fence = { goalEpoch: 5, connectionEpoch: 1, dimension: 'overworld' };
const completion = { predicate: 'survival_state' as const, routine: 'death_recovery' as const, expect: 'concluded' as const };
const task: TaskSpec = { objective: 'Attempt scoped recovery.', decisionInstruction: 'Use eligible offered capabilities.', allowedCapabilities: ['route_travel', 'go_to_death_site', 'recover_lost_items'], targetSelectors: [], parameters: { destination: 'own_death' }, completion };
const plan = (spec = task): PlannerProposal => ({ version: 1, disposition: 'plan', interpretation: 'Attempt bounded recovery.', outcome: { kind: 'finite', outcome: completion }, tasks: [spec], morePlanningNeeded: false });

async function recovery(version: string) {
  const h = harness({ farRoute: () => 'locator_route_legs' });
  const kit = { 36: slot('bread', 8), 37: slot('oak_log', 2) };
  h.pos.at = { x: 287, y: 0, z: 0 };
  h.packets.inventory(kit); h.packets.health(20, 20);
  dieWithItems(h, kit);
  h.service.linkIncident(h.service.deathContext().captureId!, 'mf-0001');
  h.pos.at = { x: 0.5, y: 0, z: 0.5 };
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 287, y: 0, z: 0 } });
  await settle(h);
  const proposed = h.service.assess(assessInput(h));
  assert.equal(proposed.kind, 'propose');
  if (proposed.kind !== 'propose') throw new Error(JSON.stringify(proposed));
  h.service.onSupportAdmitted({ proposalId: proposed.proposal.proposalId, goalId: 'goal-rec5', ...fence, admittedAtMs: h.clock.now() });
  await settle(h);
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { dimension: 'overworld' });
  fake.fill(-40, -1, -40, 40, -1, 40, 'grass_block');
  const evidence = evidenceFor(client);
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const routes = new RouteController({ policy: RoutePolicySchema.parse({ sources: ['owner', 'support'], destinations: ['owner', 'owner_destination', 'own_death'] }), clock: h.clock, ownDeath: h.service });
  routes.admit({ goalId: 'goal-rec5', ...fence, admittedAtMs: h.clock.now(), source: 'support', goalDeadlineMs: h.clock.now() + 600_000, admissionAnchor: { ...h.pos.at }, admissionRadius: 128, ownerCoordinates: [] });
  const ids = sequentialIds();
  const perception = new PerceptionService({ session: () => session, clock: h.clock, ids, observationRadius: 32, travelRadius: 128, rays: 100, ownerPolicy: { mode: 'offline_name', ownerName: 'FixtureOwner' }, admission: () => ({ serverOnlineMode: false }), effectiveTravel: (p) => routes.effectiveTravel(p) });
  perception.admitTravelAnchor(5);
  const registry = new SkillRegistry([...allSkills(), ...survivalSkills(h.service), ...locatorSkills({ routes, recoveryTravel: (ctx, options) => navigateRecoveryTravel(h.service, ctx, options) })]);
  const knowledge = new VersionKnowledge({ version, catalog: () => registry.catalog() });
  const services = { perception, knowledge, ledger: new EvidenceLedger(h.clock), clock: h.clock, limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 } };
  const candidates = new TaskCandidateGenerator({ registry, services, session: () => session, ids });
  const snapshot = perception.take(5)!;
  const context = () => ({ registry: knowledge, dimension: 'overworld', survival: true, route: routes.proposalContext(fence) });
  return { h, routes, registry, knowledge, candidates, snapshot, context, close: async () => { evidence.detach(); await h.service.close(); } };
}

for (const version of ['26.1.2', '26.2']) describe(`N1-C12-R5 capability composition (${version})`, () => {
  it('the application exposes both independent capabilities and exact knowledge without inventing a route when disabled', async () => {
    const config = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-inference-free.json')).config;
    config.minecraft.version = version;
    const clock = { now: () => 1_000 };
    for (const installed of [true, false]) {
      const runtime = new SkillRuntime({ config, clock, ids: sequentialIds(), store: new MemoryRunStore(), session: () => undefined, connectionEpoch: () => 1, goalEpoch: () => 5, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), features: { locator: installed, survival: { config: {}, scope: undefined } } });
      try {
        const catalog = runtime.registry.catalog();
        for (const id of ['go_to_death_site', 'route_travel']) {
          const answer = runtime.knowledge.answerOne({ kind: 'capability', id });
          const descriptor = catalog.capabilities.find((c) => c.id === id);
          assert.equal(answer.status, descriptor ? 'known' : 'unknown');
          if (answer.status === 'known') assert.deepEqual(answer.data, descriptor, 'knowledge describes only the registered capability');
        }
        const request: PlannerRequest = { requestId: 'req-composition', subject: { kind: 'goal', goalId: 'goal-rec5', goalEpoch: 5 }, instruction: 'Attempt bounded recovery.', turn: 1, maxTurns: 20, catalog, observation: null, knowledge: ['route_travel', 'go_to_death_site'].map((id) => runtime.knowledge.answerOne({ kind: 'capability', id })) };
        const text = renderRequest(request, 8);
        const doc = JSON.parse(text.slice(text.indexOf('{')));
        assert.equal(doc.catalog.capabilities.some((c: { id: string }) => c.id === 'route_travel'), installed);
        assert.equal(doc.catalog.capabilities.some((c: { id: string }) => c.id === 'go_to_death_site'), true);
        assert.deepEqual(doc.knowledge, request.knowledge);
        assert.equal(doc.route, undefined, 'catalog availability alone does not create current route authority');
      } finally { await runtime.survival?.close(); }
    }
  });

  it('a far local refusal coexists with one real current own-incident route option; neither arrival nor recovery is inferred', async () => {
    const r = await recovery(version);
    try {
      const set = r.candidates.generate(task, r.snapshot);
      assert.ok(set.unavailable.some((u) => u.capability === 'go_to_death_site' && u.reason === 'outside_travel_bounds'));
      assert.deepEqual(set.candidates.map((c) => c.capability), ['route_travel'], JSON.stringify(set.unavailable));
      assert.equal(set.candidates[0]!.parameters['destination'], 'own_death');
      assert.doesNotMatch(JSON.stringify(set.candidates), /287/, 'code-owned destination coordinates are not planner action parameters');
      assert.equal(checkProposal(plan(), r.registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, r.context()).ok, true);
      const before = structuredClone(r.routes.status(5));
      const request: PlannerRequest = { requestId: 'req-composition', subject: { kind: 'goal', goalId: 'goal-rec5', goalEpoch: 5 }, instruction: 'Attempt bounded recovery.', turn: 2, maxTurns: 20, catalog: r.registry.catalog(), observation: r.snapshot, knowledge: ['route_travel', 'go_to_death_site'].map((id) => r.knowledge.answerOne({ kind: 'capability', id })), route: { ...r.routes.proposalContext(fence), status: r.routes.status(5)!, admission: { anchor: { x: 0.5, y: 0, z: 0.5 }, radius: 128 } } };
      const text = renderRequest(request, 8), doc = JSON.parse(text.slice(text.indexOf('{')));
      assert.equal(doc.route.authorized, true); assert.equal(doc.route.ownDeathAvailable, true);
      assert.ok(doc.catalog.capabilities.find((c: { id: string }) => c.id === 'route_travel').parameters.some((p: string) => p.includes('own_death')));
      assert.equal(doc.route.progress.legsUsed, 0);
      assert.deepEqual(r.routes.status(5), before, 'knowledge, validation and rendering spend or grant nothing');
      assert.equal(r.h.service.evaluateSurvivalState(completion, { goalId: 'goal-rec5', goalEpoch: 5 }).status, 'unsatisfied');
      assert.equal(r.h.service.evaluateSurvivalState({ ...completion, expect: 'recovered' }, { goalId: 'goal-rec5', goalEpoch: 5 }).status, 'unsatisfied');
    } finally { await r.close(); }
  });

  it('missing, expired or foreign authority still refuses, even with the whole catalog and valid capability knowledge', async () => {
    const r = await recovery(version);
    try {
      assert.equal(r.routes.verifyDestination({ ...fence, goalEpoch: 6 }, 'own_death').ok, false);
      assert.equal(r.routes.verifyDestination({ ...fence, connectionEpoch: 2 }, 'own_death').ok, false);
      assert.equal(r.routes.verifyDestination({ ...fence, dimension: 'the_nether' }, 'own_death').ok, false);
      for (const parameters of [{ destination: 'own_death', maxLegs: 64 }, { destination: 'foreign_death' }, { target: { kind: 'destination', dimension: 'overworld', x: 287, y: 0, z: 0 } }]) {
        assert.equal(checkProposal(plan({ ...task, parameters }), r.registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, r.context()).ok, false);
      }
      assert.equal(checkProposal(plan({ ...task, allowedCapabilities: ['unregistered_route'] }), r.registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, r.context()).ok, false);
      r.h.clock.advance(600_001);
      assert.equal(r.candidates.generate(task, r.snapshot).candidates.length, 0);
      assert.equal(r.routes.canBegin(fence, 'own_death').ok, false);
      r.routes.revoke('owner_stop');
      assert.equal(checkProposal(plan(), r.registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, r.context()).ok, false);
    } finally { await r.close(); }
  });

  it('spent cumulative distance cannot be refilled by knowledge queries, proposals or repeated route admission', async () => {
    const r = await recovery(version);
    try {
      const auth = r.routes.authorization(fence)!;
      assert.equal(r.routes.beginLeg({ ...fence, at: r.snapshot.self.at, destination: 'own_death', destinationAt: { x: 287, y: 0, z: 0 } }).ok, true);
      r.routes.sample(fence, { x: 1025, y: 0, z: 0.5 });
      const before = structuredClone(r.routes.status(5));
      assert.equal(before?.state, 'exhausted');
      assert.equal(r.knowledge.answerOne({ kind: 'capability', id: 'route_travel' }).status, 'known');
      assert.equal(r.candidates.generate(task, r.snapshot).candidates.length, 0);
      assert.equal(r.routes.canBegin(fence, 'own_death').ok, false);
      assert.deepEqual(r.routes.status(5), before);
      assert.equal(r.routes.admit({ goalId: 'goal-rec5', ...fence, admittedAtMs: r.h.clock.now(), source: 'support', goalDeadlineMs: r.h.clock.now() + 600_000, admissionAnchor: { ...auth.admissionAnchor }, admissionRadius: auth.admissionRadius, ownerCoordinates: [] }), undefined);
      assert.deepEqual(r.routes.status(5), before);
    } finally { await r.close(); }
  });
});

it('shared instructions distinguish local bounds, legal composition and current possession without granting authority or prescribing a recovery plan', () => {
  assert.equal(PLANNER_INSTRUCTIONS_VERSION, 'gameplay-planner-v7');
  assert.match(PLANNER_INSTRUCTIONS, /preconditions and limitations describe that capability alone/);
  assert.match(PLANNER_INSTRUCTIONS, /existing cumulative leg, distance and time allowances/);
  assert.match(PLANNER_INSTRUCTIONS, /proves neither current possession nor current equipment/);
  assert.match(PLANNER_INSTRUCTIONS, /Travel arrival proves neither recovered belongings nor a concluded recovery routine/);
  assert.doesNotMatch(PLANNER_INSTRUCTIONS, /287|mf-0002|go_to_death_site/);
});

it('the actual RC2C malformed knowledge disposition still rejects; descriptive missing fields grant no exception', () => {
  const wire = { disposition: 'needs_information', interpretation: 'Inspect available capability details.', outcome: null, tasks: [], morePlanningNeeded: false, queries: [{ kind: 'capability', key: 'route_travel' }], missing: null, missingCapabilities: [], verifiedProgress: null };
  assert.equal(proposalFromWire(wire).disposition, 'needs_information');
  assert.throws(() => proposalFromWire({ ...wire, missing: 'Long-distance routing.' }), /missing must be null\/empty for disposition needs_information/);
});
