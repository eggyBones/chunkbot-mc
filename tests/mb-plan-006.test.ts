// MB-PLAN-006 — act without follow-up questions: the code-owned question
// detector, proposal policy, planner schema/instructions and target grounding
// (snapshot ordering, retired identities). Credential-free; no fixture, no
// provider, no inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, type CapabilityCatalog } from '../src/contracts/index.ts';
import { ownerQuestionIn, ownerQuestionProblems, isOwnerQuestionProblem, OWNER_QUESTION_PROBLEM } from '../src/goals/declarative.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { publicBlocker, publicOutcome, publicTaskLabel } from '../src/goals/public-text.ts';
import { GoalRecordSchema } from '../src/contracts/goal.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { PLANNER_INSTRUCTIONS, renderRequest } from '../src/planner/prompt.ts';
import { DISPOSITIONS, plannerOutputSchema, proposalFromWire, WireError } from '../src/planner/wire.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

describe('MB-PLAN-006 question detector (code-owned, not prompt wording)', () => {
  const questions = [
    'Which chicken do you mean?',
    'Please confirm which tree should be removed',
    'Let me know if you want oak or birch',
    'Should I build the house here',
    'Do you want me to collect more logs',
    'I need your confirmation before breaking blocks',
    'Waiting for your answer before continuing',
    'Reply with the number of logs',
    'answer q1 to continue',
    'If you prefer stone, tell me which kind',
    'Could you specify the site',
    'I will ask the owner which tree',
    'Choose which material to use',
    'Can I break the floating tree',
  ];
  for (const q of questions) it(`flags: ${q}`, () => assert.ok(ownerQuestionIn(q), q));

  const declarative = [
    'Attacking the closest visible chicken (ent-12).',
    'Removing the floating birch tree grp-3; the nearby oak stays intact.',
    'Building the default small home beside you at the visible site.',
    'No floating tree is visible from here; a bounded survey found none.',
    'Gathering 8 oak logs; choosing the nearest visible tree.',
    'Following you until stopped.',
    'logs => planks => sticks; then walk back',
  ];
  for (const d of declarative) it(`accepts: ${d}`, () => assert.equal(ownerQuestionIn(d), undefined, d));

  it('quotes never launder a question: only an exact echo of the actual owner words is data', () => {
    // Review bypass cases: planner-invented quotes are still questions.
    assert.ok(ownerQuestionIn('"Would you like stone or cobblestone?"'));
    assert.ok(ownerQuestionIn('"Please provide a location"'));
    assert.ok(ownerQuestionIn('\u201cWhich tree do you mean\u201d', 'cut down that tree'));
    assert.ok(ownerQuestionIn('"Would you like stone or cobblestone?"', 'get me some stone'), 'not an echo of the owner text');
    const owner = 'can you get me some logs?';
    assert.equal(ownerQuestionIn('Interpreting "can you get me some logs?" as collecting 8 oak logs and returning to you.', owner), undefined, 'exact owner echo');
    assert.ok(ownerQuestionIn('Interpreting "can you get me some logs?" as collecting 8 oak logs and returning to you.'), 'without code-known owner text nothing is exempt');
    assert.ok(ownerQuestionIn('Interpreting "can you get me some logs?" — which kind do you want?', owner), 'text outside the echo still checked');
    const problems = ownerQuestionProblems({ version: 1, disposition: 'cannot_execute', interpretation: 'x', missing: '"Would you like stone or cobblestone?"', missingCapabilities: [], verifiedProgress: '' }, 'get stone');
    assert.ok(isOwnerQuestionProblem(problems));
    const objective = ownerQuestionProblems({ version: 1, disposition: 'plan', interpretation: 'Going.', tasks: [{ objective: '"Please provide a location"' }] }, 'build a house');
    assert.ok(isOwnerQuestionProblem(objective));
  });

  it('flags the retired disposition and a question field; problems are marked for counting', () => {
    const legacy = ownerQuestionProblems({ version: 1, disposition: 'needs_clarification', interpretation: 'needs a detail', question: 'Oak or birch?' });
    assert.equal(legacy.length, 1);
    assert.ok(isOwnerQuestionProblem(legacy));
    assert.ok(legacy[0]!.startsWith(OWNER_QUESTION_PROBLEM));
    assert.ok(legacy[0]!.length < 300, 'fits the bounded repair rendering');
    const embedded = ownerQuestionProblems({ version: 1, disposition: 'plan', interpretation: 'Building here.', tasks: [{ objective: 'Ask the owner? no: choose a site' }] });
    assert.equal(embedded.length, 1);
    assert.match(embedded[0]!, /tasks\[0\]\.objective/);
    assert.deepEqual(ownerQuestionProblems({ version: 1, disposition: 'needs_information', interpretation: 'Looking up the oak plank recipe.', queries: [{ kind: 'recipe', output: 'minecraft:oak_planks' }] }), [], 'internal knowledge queries stay allowed');
  });

  it('checkProposal refuses owner questions as a policy problem before the schema', () => {
    const registry = new StaticCapabilityRegistry();
    const limits = { planWindowSteps: 4, remainingTaskAllowance: 20 };
    const legacy = checkProposal({ version: 1, disposition: 'needs_clarification', interpretation: 'x', question: 'which?' }, registry, limits);
    assert.equal(legacy.ok, false);
    assert.equal(!legacy.ok && legacy.kind, 'policy');
    const blocker = checkProposal({ version: 1, disposition: 'cannot_execute', interpretation: 'Two trees are visible', missing: 'Please tell me which one', missingCapabilities: [], verifiedProgress: '' }, registry, limits);
    assert.equal(!blocker.ok && blocker.kind, 'policy');
    const ok = checkProposal({ version: 1, disposition: 'cannot_execute', interpretation: 'No tree is visible.', missing: 'no tree is visible within 32 blocks', missingCapabilities: [], verifiedProgress: '' }, registry, limits);
    assert.equal(ok.ok, true);
  });
});

describe('MB-PLAN-006 app-owned public text and historical evidence', () => {
  it('public outcome/step/blocker text is rendered from structured data only', () => {
    const outcome = publicOutcome({ kind: 'finite', outcome: { predicate: 'entity_outcome', target: { kind: 'observed', snapshotId: 'snap-0001', handle: 'ent-3' }, outcome: 'observed_defeated' } });
    assert.match(outcome, /^Done when the bot sees a target it observed defeated\.$/);
    assert.match(publicTaskLabel({ allowedCapabilities: ['move_near', 'attack_entity'], completion: { predicate: 'blocks_removed', target: { kind: 'observed', snapshotId: 'snap-0001', handle: 'grp-2' }, selector: '#minecraft:logs' } }), /^move_near, attack_entity until the bot confirms a target it observed no longer has any any logs$/);
    const blocker = publicBlocker({ missingCapabilities: ['fly_to', 'which_tree_do_you_want', 'Elytra flight'], feedback: [{ taskId: 'task-1', objective: 'Please tell me which tree?', status: 'blocked', reason: 'no_candidates', detail: 'x', unavailable: [{ capability: 'mine_block', reason: 'no_visible_target', detail: 'd', evidence: {} }], recentOutcomes: [], exhaustedTargets: [], completion: null }] });
    assert.equal(blocker, 'the planner found no supported way to continue; missing capabilities: fly_to; last step blocked (no grounded action was available); no matching target is visible');
    assert.equal(ownerQuestionIn(blocker), undefined);
  });

  it('pre-MB-PLAN-006 goal records still parse: legacy clarifications kept as history, questionRefusals defaults to 0', () => {
    const old = {
      id: 'goal-0001',
      epoch: 1,
      instruction: 'make armor',
      origin: { surface: 'chat', principal: 'owner' },
      state: 'completed',
      admittedAtMs: 1,
      updatedAtMs: 2,
      plannerTurns: 3,
      counters: { plannerTurns: 3, knowledgeRounds: 0, repairs: 0, retries: 0, clarifications: 2, replans: 0, windows: 1, tasksAdmitted: 1, preparationTurns: 0, lookaheads: 0 },
      pendingClarification: { id: 'clar-0001', goalId: 'goal-0001', goalEpoch: 1, ref: 'q1', question: 'Leather or iron?', askedAtMs: 1 },
      progress: '',
    };
    const parsed = GoalRecordSchema.safeParse(old);
    assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
    assert.equal(parsed.data!.counters?.clarifications, 2, 'history preserved, not relabeled');
    assert.equal(parsed.data!.counters?.questionRefusals, 0);
    assert.equal(parsed.data!.counters?.plannerTurns, 3, 'counts unchanged');
  });
});

describe('MB-PLAN-006 planner schema and instructions', () => {
  const catalog: CapabilityCatalog = { catalogVersion: 'test', capabilities: [] };
  it('the generated output schema has no question disposition or field', () => {
    const schema = plannerOutputSchema(catalog) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    assert.deepEqual([...DISPOSITIONS], ['plan', 'needs_information', 'cannot_execute']);
    assert.deepEqual(schema.properties['disposition']?.enum, ['plan', 'needs_information', 'cannot_execute']);
    assert.equal('question' in schema.properties, false);
    assert.equal(schema.required.includes('question'), false);
  });

  it('wire conversion turns a legacy question into a counted policy WireError, never a proposal', () => {
    try {
      proposalFromWire({ disposition: 'needs_clarification', interpretation: 'x', question: 'Which tree?', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], missing: null, missingCapabilities: [], verifiedProgress: null });
      assert.fail('should throw');
    } catch (error) {
      assert.ok(error instanceof WireError);
      assert.ok(isOwnerQuestionProblem(error.problems));
    }
  });

  it('instructions forbid owner questions and state grounded defaults; the request renders no clarification exchanges', () => {
    assert.doesNotMatch(PLANNER_INSTRUCTIONS, /"needs_clarification":/);
    assert.match(PLANNER_INSTRUCTIONS, /NEVER ask the owner/);
    assert.match(PLANNER_INSTRUCTIONS, /CLOSEST reachable/);
    assert.match(PLANNER_INSTRUCTIONS, /"here": the visible owner's current position/);
    const text = renderRequest({ requestId: 'req-0001', subject: { kind: 'goal', goalId: 'goal-0001', goalEpoch: 1 }, instruction: 'kill that chicken', turn: 1, maxTurns: 8, catalog, observation: null, knowledge: [] }, 4);
    assert.doesNotMatch(text, /clarifications|ownerAnswer/);
  });
});

function perceptionScene() {
  const client = fakeClient();
  const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
  scene.fill(-30, -1, -30, 30, -1, 30, 'grass_block');
  const evidence = evidenceFor(client);
  const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const perception = new PerceptionService({ session: () => session, clock: { now: () => 1_000 }, ids: sequentialIds(), observationRadius: 24, travelRadius: 128, rays: 600, ownerName: 'Jake' });
  return { scene, perception, session };
}

describe('MB-PLAN-006 N-G1 target availability in snapshots', () => {
  it('a nearby chicken is never crowded out by farther entities listed first; the owner is always reported', () => {
    const { scene, perception } = perceptionScene();
    // 40 farther cows registered BEFORE the chicken in the client entity table.
    for (let i = 0; i < 40; i += 1) scene.addEntity({ id: 100 + i, type: 'mob', name: 'cow', height: 1.4, at: { x: -18 + (i % 10) * 4, y: 0, z: 12 + Math.floor(i / 10) * 2 } });
    scene.addEntity({ id: 500, type: 'player', name: 'player', username: 'Jake', uuid: offlinePlayerUuid('Jake'), height: 1.8, at: { x: 0.5, y: 0, z: 22 } });
    scene.addEntity({ id: 999, type: 'mob', name: 'chicken', height: 0.7, at: { x: 2.5, y: 0, z: 0.5 } });
    const snap = perception.take(0)!;
    assert.equal(snap.entities[0]?.key, 'minecraft:chicken', 'the nearest target is listed first');
    assert.equal(snap.entities[0]?.inReach, true);
    assert.equal(snap.entities.length, 32);
    assert.equal(snap.perception?.truncated, true);
    assert.equal(snap.owner.visible, true, 'owner visible even past the entity cap');
    assert.ok(snap.entities.some((e) => e.label === 'owner'));
    for (let i = 1; i < snap.entities.length - 1; i += 1) assert.ok(snap.entities[i - 1]!.distance <= snap.entities[i]!.distance, 'sorted by distance');
  });

  it('equidistant matches are ordered deterministically regardless of entity table order', () => {
    const a = perceptionScene();
    a.scene.addEntity({ id: 7, type: 'mob', name: 'chicken', height: 0.7, at: { x: 3.5, y: 0, z: 0.5 } });
    a.scene.addEntity({ id: 8, type: 'mob', name: 'chicken', height: 0.7, at: { x: -2.5, y: 0, z: 0.5 } });
    const b = perceptionScene();
    b.scene.addEntity({ id: 8, type: 'mob', name: 'chicken', height: 0.7, at: { x: -2.5, y: 0, z: 0.5 } });
    b.scene.addEntity({ id: 7, type: 'mob', name: 'chicken', height: 0.7, at: { x: 3.5, y: 0, z: 0.5 } });
    const sa = a.perception.take(0)!.entities.map((e) => e.at.x);
    const sb = b.perception.take(0)!.entities.map((e) => e.at.x);
    assert.deepEqual(sa, sb);
    assert.deepEqual(sa, [-2.5, 3.5]);
  });

  it('a named target re-grounds to the SAME entity after its snapshot was evicted; never after a lifecycle invalidation', () => {
    const { scene, perception } = perceptionScene();
    scene.addEntity({ id: 999, type: 'mob', name: 'chicken', height: 0.7, at: { x: 2.5, y: 0, z: 0.5 } });
    scene.addEntity({ id: 998, type: 'mob', name: 'chicken', height: 0.7, at: { x: 6.5, y: 0, z: 0.5 } });
    const first = perception.take(0)!;
    const handle = first.entities.find((e) => e.at.x === 2.5)!.handle;
    let latest = first;
    for (let i = 0; i < 12; i += 1) latest = perception.take(0)!;
    assert.ok('error' in perception.resolve(first.id, handle), 'expired handles are not executable');
    const translated = perception.translateHandle(first.id, handle, latest.id);
    assert.ok(translated, 'still the same visible chicken');
    const rec = perception.resolve(latest.id, translated!);
    assert.ok(!('error' in rec) && rec.target.kind === 'entity' && rec.target.entityId === 999);
    // The chicken leaves sight: no fallback to the other chicken.
    delete (scene.bot.entities as Record<number, unknown>)[999];
    const after = perception.take(0)!;
    assert.equal(perception.translateHandle(first.id, handle, after.id), undefined);
    // Lifecycle invalidation drops retired identities.
    scene.addEntity({ id: 999, type: 'mob', name: 'chicken', height: 0.7, at: { x: 2.5, y: 0, z: 0.5 } });
    perception.invalidate('death');
    const fresh = perception.take(0)!;
    assert.equal(perception.translateHandle(first.id, handle, fresh.id), undefined);
  });
});
