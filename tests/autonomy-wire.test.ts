// MB-FLOW-001 planner wire: the home (structure_state) and survival
// (survival_state) predicates are offered to the planner only when their
// capabilities are in the catalog, convert to the shared contract without
// registry-key normalization of their enum words, and reject foreign fields.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityCatalog, PlannerRequest } from '../src/contracts/index.ts';
import { PlannerProposalSchema } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { allSkills } from '../src/skills/index.ts';
import { WireError, plannerOutputSchema, proposalFromWire } from '../src/planner/wire.ts';
import { PLANNER_INSTRUCTIONS, renderRequest } from '../src/planner/prompt.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const foundation = new SkillRegistry(allSkills()).catalog();
const fake = (id: string) => ({ ...foundation.capabilities[0]!, id });
const withIds = (...ids: string[]): CapabilityCatalog => ({ catalogVersion: 'test', capabilities: [...foundation.capabilities, ...ids.map(fake)] });

const kinds = (catalog: CapabilityCatalog) => ((plannerOutputSchema(catalog)['$defs'] as Json)['predicate'].anyOf as Json[]).flatMap((v) => v.properties.predicate.enum as string[]);
const base = { outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: null, missingCapabilities: [], verifiedProgress: null };
const homePlan = (predicate: Json): Json => ({
  ...base,
  disposition: 'plan',
  interpretation: 'Build the small home.',
  outcome: { kind: 'finite', predicate },
  tasks: [{ objective: 'Build the home.', decisionInstruction: 'Place the next blueprint block.', allowedCapabilities: ['build_home'], targetSelectors: [], parameters: [], completion: predicate }],
});

describe('autonomy predicates on the planner wire', () => {
  it('offers structure_state only with construction capabilities and survival_state only with survival capabilities', () => {
    assert.ok(!kinds(foundation).includes('structure_state'));
    assert.ok(!kinds(foundation).includes('survival_state'));
    assert.ok(kinds(withIds('select_home_site', 'build_home')).includes('structure_state'));
    assert.ok(!kinds(withIds('select_home_site', 'build_home')).includes('survival_state'));
    assert.ok(kinds(withIds('eat_safe_food')).includes('survival_state'));
    const v = ((plannerOutputSchema(withIds('build_home'))['$defs'] as Json)['predicate'].anyOf as Json[]).find((x) => x.properties.predicate.enum.includes('structure_state'))!;
    assert.deepEqual(Object.keys(v.properties).sort(), ['expect', 'predicate', 'structure']);
    assert.deepEqual(v.properties.expect.enum, ['site_approved', 'enclosed', 'complete']);
  });

  it('converts structure_state / survival_state without namespacing their enum words', () => {
    const p = proposalFromWire(homePlan({ predicate: 'structure_state', structure: 'home', expect: 'complete' }));
    assert.equal(PlannerProposalSchema.safeParse(p).success, true);
    assert.deepEqual(p.disposition === 'plan' && p.outcome?.kind === 'finite' && p.outcome.outcome, { predicate: 'structure_state', structure: 'home', expect: 'complete' });
    const s = proposalFromWire(homePlan({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }));
    assert.deepEqual(s.disposition === 'plan' && s.outcome?.kind === 'finite' && s.outcome.outcome, { predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' });
  });

  it('nests inside all/any and rejects foreign or missing fields', () => {
    const nested = proposalFromWire(homePlan({ predicate: 'all', of: [{ predicate: 'structure_state', structure: 'home', expect: 'enclosed' }, { predicate: 'inventory_amount', selector: 'cobblestone', atLeast: 1, mode: 'possess' }] }));
    assert.equal(PlannerProposalSchema.safeParse(nested).success, true);
    assert.throws(() => proposalFromWire(homePlan({ predicate: 'structure_state', structure: 'home', expect: 'complete', selector: 'minecraft:stone' })), WireError);
    assert.throws(() => proposalFromWire(homePlan({ predicate: 'structure_state', expect: 'complete' })), WireError);
    // Enum words outside the contract fail the shared proposal schema (applied after conversion).
    assert.equal(PlannerProposalSchema.safeParse(proposalFromWire(homePlan({ predicate: 'structure_state', structure: 'home', expect: 'built' }))).success, false);
  });
});

describe('automatic-goal context reaches the planner input', () => {
  const request = (over: Partial<PlannerRequest> = {}): PlannerRequest => ({ requestId: 'req-0001', subject: { kind: 'goal', goalId: 'goal-0001', goalEpoch: 1 }, instruction: 'Automatic progression: assess and choose one milestone', turn: 1, maxTurns: 20, catalog: foundation, observation: null, knowledge: [], ...over });
  const doc = (r: PlannerRequest) => JSON.parse(renderRequest(r, 8).split('\n')[1]!) as Json;
  it('an owner goal is labelled owner; no autonomy/route/locator blocks', () => {
    const d = doc(request({ instruction: 'get me two cobblestone' }));
    assert.equal(d.goal.origin, 'owner');
    assert.equal(d.goal.ownerInstruction, 'get me two cobblestone');
    assert.ok(!('autonomy' in d) && !('route' in d) && !('locator' in d));
  });
  it('an automatic goal is never presented as owner words and carries the bounded autonomy, route and locator data', () => {
    const d = doc(
      request({
        autonomy: {
          source: { kind: 'progression', sessionAttempt: 2 },
          reason: 'no owner instruction is pending',
          owner: { unresolvedIntent: null },
          recentMilestones: [{ interpretation: 'Collected one oak log.', atMs: 1 }],
          avoid: [{ interpretation: 'Smelt iron.', reason: 'no_visible_target', times: 2 }],
          session: { automaticGoalsLeft: 14, plannerTurnsLeft: 190 },
          home: null,
          rules: ['This goal was started automatically.'],
        },
        route: { authorized: true, destinations: ['owner'], ownDeathAvailable: false, state: null, status: null, admission: { anchor: { x: 1.04, y: 64, z: 2 }, radius: 128 } },
      }),
    );
    assert.equal(d.goal.origin, 'automatic_progression');
    assert.ok(!('ownerInstruction' in d.goal));
    assert.match(d.goal.automaticInstruction, /^Automatic progression/);
    assert.deepEqual(d.autonomy.recentMilestones, ['Collected one oak log.']);
    assert.equal(d.autonomy.session.plannerTurnsLeft, 190);
    assert.deepEqual(d.route.destinations, ['owner']);
    assert.equal(d.route.admission.anchor.x, 1);
    assert.match(PLANNER_INSTRUCTIONS, /structure_state/);
    assert.match(PLANNER_INSTRUCTIONS, /automatic_progression/);
  });
});
