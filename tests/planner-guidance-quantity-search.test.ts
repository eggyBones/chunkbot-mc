// P-PLAN-R21: root-authorized generic planner guidance A (unspecified quantity
// of a named item defaults to 1; exact numbers bind; the accepted outcome is
// never rewritten) and B (specific "that/this/the" targets keep the finite
// honest refusal; obtaining a named resource searches distinct unvisited
// frontiers inside the ORIGINAL admission bound within the existing limits).
//
// Causal source: actual 261 goal-388b88db4ec2 and 262 goal-d885cb5cd4bb
// ("bring me some bread") accepted possess >= 3 bread under the v7 line
// "choose a modest task-appropriate amount", explored ONE north frontier and
// answered cannot_execute under the v7 line "Target not visible: ... if it stays
// unavailable, answer cannot_execute". The fixture supplies exactly one bread.
//
// Guidance is model-dependent; no inference runs here. These controls prove
// (1) the instruction text the real planner receives, (2) that every fact the
// guidance relies on is actually rendered to the planner from the real
// perception over the actual P4 scene, (3) that following B from both actual
// P4 decision states reaches a viewpoint where the occluded bread is visible
// (and the actual north choice does not), (4) that an A-shaped outcome is
// valid and attainable, and (5) that the real GoalEngine refuses a later plan
// that rewrites an accepted quantity.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  PlannerProposalSchema,
  sequentialIds,
  systemClock,
  type AdmittedTask,
  type BoundPredicate,
  type InventoryBaseline,
  type ObservationSnapshot,
  type OutcomePredicate,
  type PlannerProposal,
  type PlannerRequest,
  type PredicateEvaluation,
  type PredicateEvaluator,
  type Readiness,
  type TaskExecutionPort,
  type TaskResult,
} from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { NO_QUESTION_GUIDANCE } from '../src/goals/declarative.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { PLANNER_INSTRUCTIONS, PLANNER_INSTRUCTIONS_VERSION, renderRequest } from '../src/planner/prompt.ts';
import { allSkills } from '../src/skills/index.ts';
import { sceneCommands } from '../scripts/lib/scene.ts';
import { ScriptedPlanner, makeEngine, until } from './helpers.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

// Actual P4 setup, read from the harness source (never imported: top-level fixture side effects).
const SOURCE = readFileSync(new URL('../scripts/planner-live-check.ts', import.meta.url), 'utf8');
const P4 = SOURCE.slice(SOURCE.indexOf("await check('P4'"), SOURCE.indexOf("await check('P5'"));
const summon = /summon item (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) \{Item:\{id:"minecraft:bread",count:(\d+)\}/.exec(P4)!;
const ownerTp = /tp FixtureOwner (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(P4)!;
const BREAD = { x: Number(summon[1]), y: Number(summon[2]), z: Number(summon[3]), count: Number(summon[4]) };
const OWNER_AT = { x: Number(ownerTp[1]), y: Number(ownerTp[2]), z: Number(ownerTp[3]) };
const START = { x: 205.5, z: 205.5 }; // journaled admission anchor
const EXPLORED = { x: 204.5, z: 185.5 }; // journaled end of the actual explore_frontier (north)

/** ONE continuous real PerceptionService over the actual scene: admitted at START, as in the actual goal. */
function p4World() {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { loaded: 400, at: { x: START.x, y: -60, z: START.z } });
  fake.fill(150, -61, 150, 270, -61, 270, 'grass_block');
  for (const c of sceneCommands()) {
    const a = c.split(' ');
    const b = (s: string) => s.replace(/\[.*$/, '');
    if (a[0] === 'fill') fake.fill(...(a.slice(1, 7).map(Number) as [number, number, number, number, number, number]), b(a[7]!));
    else if (a[0] === 'setblock') fake.setBlock(Number(a[1]), Number(a[2]), Number(a[3]), b(a[4]!));
  }
  const bread = fake.addEntity({ id: 77, type: 'other', name: 'item', at: BREAD, height: 0.25 });
  Object.assign(bread, { getDroppedItem: () => ({ name: 'bread', count: BREAD.count }) });
  fake.addEntity({ id: 90, type: 'player', name: 'player', username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner'), at: OWNER_AT, height: 1.8 } as never);
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 32, travelRadius: 128, ownerPolicy: { mode: 'offline_name', ownerName: 'FixtureOwner' }, admission: () => ({ serverOnlineMode: false }) });
  assert.equal(perception.admitTravelAnchor(1), true);
  const moveTo = (at: { x: number; z: number }) => { fake.bot.entity.position.x = at.x; fake.bot.entity.position.z = at.z; };
  return { perception, moveTo };
}
const breadSeenFrom = (at: { x: number; z: number }) => {
  const w = p4World();
  w.moveTo(at);
  return (w.perception.take(1) as ObservationSnapshot).drops.filter((d) => d.key === 'minecraft:bread').length;
};

const registry = new SkillRegistry(allSkills());
const request = (observation: ObservationSnapshot): PlannerRequest => ({
  requestId: 'req-p4', subject: { kind: 'goal', goalId: 'goal-d885cb5cd4bb', goalEpoch: 1 }, instruction: 'bring me some bread', turn: 8, maxTurns: 20, catalog: registry.catalog(), observation, knowledge: [],
  remaining: { plannerTurns: 12, tasks: 20, replans: 6, deadlineMs: 1_080_000, windowSteps: 8 },
});

describe('P-PLAN-R21 guidance A/B (instruction text)', () => {
  it('A: unspecified number of a named item defaults to 1 unless the words or job need more; given numbers bind; accepted outcomes are never rewritten', () => {
    assert.equal(PLANNER_INSTRUCTIONS_VERSION, 'gameplay-planner-v8');
    assert.match(PLANNER_INSTRUCTIONS, /Number omitted when obtaining or delivering a named item[^\n]*plan for 1 unless the owner's words or the job clearly require more[^\n]*state that assumption in the interpretation/);
    assert.match(PLANNER_INSTRUCTIONS, /A number the owner gives always binds exactly\. Never rewrite an accepted outcome to another quantity\./);
    assert.match(PLANNER_INSTRUCTIONS, /when acceptedOutcome is present, repeat it exactly/, 'existing immutability rule kept');
    assert.doesNotMatch(PLANNER_INSTRUCTIONS, /modest/i, 'the v7 "modest task-appropriate amount" default is gone');
    assert.doesNotMatch(NO_QUESTION_GUIDANCE, /modest/i, 'repair guidance agrees with the instructions');
    assert.match(NO_QUESTION_GUIDANCE, /1 of a named item unless/);
  });

  it('B: specific pointed-at targets keep the finite honest refusal; obtaining a resource searches unvisited frontiers in the ORIGINAL bound within existing limits', () => {
    assert.match(PLANNER_INSTRUCTIONS, /A SPECIFIC thing the owner points at \("that"\/"this"\/"the" \+ a thing\) that is not visible: plan one bounded survey\/explore step[^\n]*answer cannot_execute with the visibility\/path blocker/);
    const b = /- OBTAINING a named resource[^\n]*/.exec(PLANNER_INSTRUCTIONS)?.[0] ?? '';
    assert.match(b, /search before refusing/);
    assert.match(b, /visited flag is false/);
    assert.match(b, /ORIGINAL admission bound \(route\.admission when present, else observation\.perception\.travel; code refuses resource exploration beyond it\)/);
    assert.match(b, /spending only the existing turns, replans and deadline shown in remaining/);
    assert.match(b, /Prefer the nearby area and directions toward where the job ends/);
    assert.match(b, /One empty container or one fruitless direction does not prove that no source is available/);
    assert.match(b, /Answer cannot_execute only when no unvisited frontier remains inside that bound, verified attempts keep failing for the same reason, or the remaining turns, replans or deadline cannot cover another search step/);
    assert.match(PLANNER_INSTRUCTIONS, /Never use hidden lookups or invented coordinates, and never wander indefinitely/);
    assert.doesNotMatch(PLANNER_INSTRUCTIONS, /Target not visible: plan a bounded survey\/explore step/, 'the v7 single rule (early refusal for every unseen target) is replaced');
  });

  it('generic: no resource whitelist, no new numeric limit, no fallback model; owner seeking keeps its own guidance', () => {
    const ab = PLANNER_INSTRUCTIONS.split('\n').filter((l) => /^- (Number omitted|Material omitted|A SPECIFIC thing|OBTAINING|Never use hidden lookups)/.test(l));
    assert.equal(ab.length, 5);
    for (const l of ab) {
      assert.doesNotMatch(l, /bread|wheat|chest|minecraft:/i, l);
      assert.deepEqual(l.match(/\d+/g) ?? [], l.startsWith('- Number omitted') ? ['1'] : [], `no new numeric limit: ${l}`);
      assert.doesNotMatch(l, /model|provider|fallback/i, l);
    }
    assert.match(PLANNER_INSTRUCTIONS, /never survey or explore to find an unseen owner without guidance/, 'owner seeking is unchanged');
  });
});

describe('P-PLAN-R21 guidance B is grounded in what the planner actually receives (actual P4 scene, real perception)', () => {
  it('turn 6 (at the start) and turn 8 (after the actual north exploration): rendered frontiers, visited flags, ORIGINAL bound and the visible owner', () => {
    const w = p4World();
    const s6 = w.perception.take(1) as ObservationSnapshot;
    w.moveTo(EXPLORED);
    w.perception.recordVisited(); // explore_frontier records its arrival
    const s8 = w.perception.take(1) as ObservationSnapshot;
    for (const [label, s] of [['turn 6', s6], ['turn 8', s8]] as const) {
      const doc = JSON.parse(renderRequest(request(s), 8).split('\n')[1]!) as { observation: { frontiers: Array<{ direction: string; visited: boolean }>; owner: { visible: boolean }; perception: { travel: { anchor: { x: number; z: number }; radius: number } } }; remaining: Record<string, number> };
      const o = doc.observation;
      assert.deepEqual({ x: o.perception.travel.anchor.x, z: o.perception.travel.anchor.z, r: o.perception.travel.radius }, { x: START.x, z: START.z, r: 128 }, `${label}: the ORIGINAL admission bound is rendered`);
      assert.equal(o.owner.visible, true, `${label}: where the delivery ends is visible to the planner`);
      assert.ok(o.frontiers.length === 8 && o.frontiers.every((f) => typeof f.visited === 'boolean' && typeof f.direction === 'string'), label);
      assert.ok(o.frontiers.filter((f) => !f.visited).length >= 7, `${label}: distinct unvisited frontiers remain`);
      assert.deepEqual(Object.keys(doc.remaining).sort(), ['deadlineMs', 'plannerTurns', 'replans', 'tasks', 'windowSteps']);
    }
    assert.equal(s6.drops.length + s8.drops.length, 0, 'the bread is occluded in both actual decision states (no hidden lookup)');
  });

  it('following B (unvisited frontier inside the original bound nearest the visible owner) reveals the bread from both actual states; the actual north choice does not', () => {
    const w = p4World();
    const s6 = w.perception.take(1) as ObservationSnapshot;
    w.moveTo(EXPLORED);
    w.perception.recordVisited();
    const s8 = w.perception.take(1) as ObservationSnapshot;
    const north = s6.frontiers.find((f) => f.direction === 'north')!;
    assert.equal(breadSeenFrom(north.at), 0, 'the actual turn-6 choice (north) never reveals the bread');
    for (const [label, s] of [['turn 6', s6], ['turn 8', s8]] as const) {
      const owner = s.owner.at!;
      const inBound = s.frontiers.filter((f) => !f.visited && Math.hypot(f.at.x - START.x, f.at.z - START.z) <= 128);
      const toward = [...inBound].sort((a, b) => Math.hypot(a.at.x - owner.x, a.at.z - owner.z) - Math.hypot(b.at.x - owner.x, b.at.z - owner.z))[0]!;
      assert.equal(breadSeenFrom(toward.at), 1, `${label}: ${toward.direction} ${JSON.stringify(toward.at)} reveals the bread`);
    }
  });

  it('A: the A-shaped P4 outcome is schema-valid and attainable with the ONE bread the fixture supplies', () => {
    assert.equal(BREAD.count, 1);
    const outcome = { predicate: 'all', of: [{ predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' }, { predicate: 'near_target', target: { kind: 'owner' }, within: 2 }] };
    const proposal = { version: 1, disposition: 'plan', interpretation: 'Bringing you 1 bread; no amount was given.', outcome: { kind: 'finite', outcome }, tasks: [{ objective: 'Search a nearby unvisited frontier toward the owner for bread.', decisionInstruction: 'Explore the frontier.', allowedCapabilities: ['explore_frontier'], targetSelectors: [], parameters: {}, completion: { predicate: 'visited_location', target: { kind: 'owner' }, within: 24 } }], morePlanningNeeded: true };
    const r = PlannerProposalSchema.safeParse(proposal);
    assert.ok(r.success, JSON.stringify(!r.success && r.error.issues));
  });
});

// Real GoalEngine: a later plan cannot rewrite the accepted quantity ("never rewrite accepted outcome").
const bread = (n: number): OutcomePredicate => ({ predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: n, mode: 'possess' });
const nearOwner: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 2 };
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], targets: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
class Outcomes implements PredicateEvaluator {
  async captureBaseline(): Promise<InventoryBaseline> { return { capturedAtMs: 1, counts: {}, detail: 'fake admission inventory' }; }
  async bind(predicate: OutcomePredicate): Promise<BoundPredicate> { return { predicate, boundAtMs: 1, baselines: {} }; }
  async evaluate(): Promise<PredicateEvaluation> { return { status: 'unsatisfied', predicate: 'all', detail: '0/2 satisfied', evidence: {} }; }
}
class Tasks implements TaskExecutionPort {
  readonly runs: AdmittedTask[] = [];
  readiness(): Readiness { return { ready: true, detail: 'capture' }; }
  async run(t: AdmittedTask): Promise<TaskResult> {
    this.runs.push(t);
    return { taskId: t.taskId, status: 'completed', reason: 'completion_verified', detail: 'visited', rounds: 1, decisions: 0, actions: 1, localContinuations: 0, feedback: { taskId: t.taskId, objective: t.spec.objective, status: 'completed', reason: 'completion_verified', detail: 'visited', unavailable: [], recentOutcomes: [], exhaustedTargets: [], completion: null } };
  }
}
const plan = (outcome: OutcomePredicate): PlannerProposal => ({ version: 1, disposition: 'plan', interpretation: 'Bringing you bread.', outcome: { kind: 'finite', outcome: { predicate: 'all', of: [outcome, nearOwner] } }, tasks: [{ objective: 'Search one frontier.', decisionInstruction: 'Explore.', allowedCapabilities: ['explore_frontier'], targetSelectors: [], parameters: {}, completion: { predicate: 'visited_location', target: { kind: 'owner' }, within: 24 } }], morePlanningNeeded: true } as PlannerProposal);

describe('P-PLAN-R21 accepted quantity is immutable (real GoalEngine)', () => {
  it('a replan that lowers an accepted possess >= 3 to 1 is refused with the existing semantic rejection; repeating it exactly is accepted', async () => {
    const planner = new ScriptedPlanner();
    const tasks = new Tasks();
    const h = makeEngine({ planner, outcomes: new Outcomes(), tasks, capabilities: new StaticCapabilityRegistry({ catalogVersion: 'r21', capabilities: [cap('explore_frontier')] }), executor: { readiness: () => ({ ready: true, detail: 'unused' }), execute: async () => { throw new Error('unused'); } }, registry: new VersionKnowledge({ version: '26.2' }), limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 6, plannerTimeoutMs: 2_000, planWindowSteps: 8, totalTaskCeiling: 8, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 3 } });
    await h.engine.submit('bring me some bread', { surface: 'chat', principal: 'owner' });
    await until(() => planner.waiting === 1);
    planner.respond(plan(bread(3)));
    await until(() => tasks.runs.length === 1 && planner.waiting === 1);
    planner.respond(plan(bread(1)));
    await until(() => h.store.events.some((e) => e['type'] === 'planner_proposal_rejected') && planner.waiting === 1);
    const rejected = h.store.events.find((e) => e['type'] === 'planner_proposal_rejected')!;
    assert.match(JSON.stringify(rejected['problems']), /changes the accepted goal outcome; repeat acceptedOutcome exactly/);
    assert.deepEqual(planner.requests.at(-1)!.acceptedOutcome, { kind: 'finite', outcome: { predicate: 'all', of: [bread(3), nearOwner] } }, 'the repair turn still shows the ORIGINAL accepted quantity');
    planner.respond(plan(bread(3)));
    await until(() => tasks.runs.length === 2);
    await h.engine.stop('owner_stop', 'chat');
  });
});
