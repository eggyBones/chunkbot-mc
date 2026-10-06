// Engine-side proposal validation beyond the schema: registry/recipe facts,
// shown handles/anchors, verified prior results, owner-typed coordinates,
// declared parameters, outcome semantics.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OutcomePredicate, PlannerProposal, TaskSpec } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { matchesOwnerCoordinate, ownerCoordinates, parseOwnerCoordinates } from '../src/goals/owner-coordinates.ts';
import { checkProposal, type ProposalContext } from '../src/goals/proposal.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { allSkills } from '../src/skills/index.ts';

const registry = new SkillRegistry(allSkills());
const facts = new VersionKnowledge({ version: '26.1.2' });
const limits = { planWindowSteps: 8, remainingTaskAllowance: 64 };
const near: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['move_near'], targetSelectors: [], parameters: {}, completion: near, ...over });
const plan = (tasks: TaskSpec[], outcome: OutcomePredicate = near, kind: 'finite' | 'persistent' = 'finite', morePlanningNeeded = false): PlannerProposal =>
  ({ version: 1, disposition: 'plan', interpretation: 'x', outcome: kind === 'finite' ? { kind, outcome } : { kind, maintain: outcome }, tasks, morePlanningNeeded }) as PlannerProposal;
const ctx = (over: ProposalContext = {}): ProposalContext => ({ registry: facts, shown: new Map([['snap-0001', { handles: new Set(['blk-1', 'ent-2']), dimension: 'overworld' }]]), anchors: new Set(['anchor-1']), dimension: 'overworld', ownerCoordinates: [], priorResults: new Set(['act-placed01']), ...over });
const problems = (p: PlannerProposal, c = ctx()) => {
  const r = checkProposal(p, registry, limits, c);
  return r.ok ? [] : r.problems;
};

describe('owner-typed coordinates', () => {
  it('parses bare and labelled triples from owner text only', () => {
    assert.deepEqual(parseOwnerCoordinates('meet me at 214 -60 214 please', 'instruction').map((c) => [c.x, c.y, c.z]), [[214, -60, 214]]);
    assert.deepEqual(parseOwnerCoordinates('go to x=10, y=64, z=-3', 'instruction').map((c) => [c.x, c.y, c.z]), [[10, 64, -3]]);
    assert.deepEqual(parseOwnerCoordinates('(1.5, 70, 2.5)', 'answer').map((c) => [c.x, c.y, c.z]), [[1.5, 70, 2.5]]);
    assert.deepEqual(parseOwnerCoordinates('get me 2 cobblestone and 3 logs', 'instruction'), [], 'quantities are not coordinates');
    assert.deepEqual(parseOwnerCoordinates('go to 1 999 1', 'instruction'), [], 'implausible y rejected');
    const all = ownerCoordinates('go somewhere', [{ ref: 'q1', question: 'where?', answer: 'to 5 -60 7' }]);
    assert.deepEqual(all.map((c) => [c.x, c.y, c.z, c.source]), [[5, -60, 7, 'answer']]);
    assert.equal(matchesOwnerCoordinate({ x: 5.5, y: -60, z: 7.5 }, all), true, 'block centring tolerated');
    assert.equal(matchesOwnerCoordinate({ x: 6.1, y: -60, z: 7 }, all), false);
  });

  it('an owner_destination with an echoed ownerText label but invented numbers is rejected; owner-typed ones are accepted', () => {
    const dest = (x: number) => ({ kind: 'owner_destination' as const, dimension: 'overworld', at: { x, y: -60, z: 214 }, ownerText: 'meet me at 214 -60 214' });
    const p = (x: number) => plan([task({ targetSelectors: [dest(x)], completion: { predicate: 'near_target', target: dest(x), within: 2 } })], { predicate: 'near_target', target: dest(x), within: 2 });
    assert.match(problems(p(300)).join(' '), /not supplied by the owner \(owner-typed coordinates: none\)/);
    const typed = ctx({ ownerCoordinates: parseOwnerCoordinates('meet me at 214 -60 214', 'instruction') });
    assert.match(problems(p(300), typed).join(' '), /coordinates 300 -60 214 were not supplied by the owner/);
    assert.deepEqual(problems(p(214), typed), []);
    assert.match(problems(p(214), { ...typed, dimension: 'the_nether' }).join(' '), /not the current dimension/);
    // the same rule applies to a movement destination PARAMETER
    const param = plan([task({ parameters: { target: { kind: 'destination', dimension: 'overworld', x: 300, y: -60, z: 214 } } })]);
    assert.match(problems(param, typed).join(' '), /not supplied by the owner/);
  });
});

describe('world and evidence references', () => {
  it('accepts shown handles/anchors and verified prior results; rejects invented ones', () => {
    const ok = plan([task({ targetSelectors: [{ kind: 'observed', snapshotId: 'snap-0001', handle: 'blk-1' }, { kind: 'remembered_anchor', anchorId: 'anchor-1' }, { kind: 'prior_result', actionId: 'act-placed01' }] })]);
    assert.deepEqual(problems(ok), []);
    assert.match(problems(plan([task({ targetSelectors: [{ kind: 'observed', snapshotId: 'snap-0001', handle: 'blk-999' }] })])).join(), /handle blk-999 is not in snapshot/);
    assert.match(problems(plan([task({ targetSelectors: [{ kind: 'observed', snapshotId: 'snap-9999', handle: 'blk-1' }] })])).join(), /was not shown to the planner/);
    assert.match(problems(plan([task({ targetSelectors: [{ kind: 'remembered_anchor', anchorId: 'anchor-77' }] })])).join(), /anchor-77 was not shown/);
    assert.match(problems(plan([task({ targetSelectors: [{ kind: 'prior_result', actionId: 'act-madeupid' }] })])).join(), /not a verified prior result/);
    assert.match(problems(plan([task({ parameters: { target: { kind: 'handle', snapshotId: 'snap-0001', handle: 'ent-404' } } })])).join(), /ent-404/);
  });

  it('checks registry keys, tags and recipe families against the exact version', () => {
    const inv = (selector: string): OutcomePredicate => ({ predicate: 'inventory_amount', selector, atLeast: 1, mode: 'possess' });
    assert.deepEqual(problems(plan([task()], inv('#minecraft:logs'))), []);
    assert.match(problems(plan([task()], inv('minecraft:unobtainium'))).join(), /not an item in the 26\.1\.2 registry/);
    assert.match(problems(plan([task()], inv('#minecraft:not_a_tag'))).join(), /not an item tag/);
    assert.match(problems(plan([task()], { predicate: 'crafting_result', output: 'minecraft:egg', atLeast: 1 })).join(), /no crafting recipe produces minecraft:egg/);
    assert.deepEqual(problems(plan([task()], { predicate: 'smelting_result', output: 'minecraft:stone', atLeast: 4 })), [], 'stone is a furnace output (from cobblestone)');
    assert.match(problems(plan([task()], { predicate: 'smelting_result', output: 'minecraft:oak_planks', atLeast: 1 })).join(), /no furnace-type recipe produces/);
    assert.match(problems(plan([task()], { predicate: 'block_state', target: { kind: 'owner' }, expect: 'minecraft:stick' })).join(), /not a block/);
    assert.match(problems(plan([task()], { predicate: 'entity_outcome', target: { kind: 'registry', key: 'minecraft:cow' }, outcome: 'observed_defeated' })).join(), /observed entity handle or the owner/);
    const { registry: _omit, ...withoutFacts } = ctx();
    void _omit;
    const noFacts = checkProposal(plan([task()], inv('minecraft:stick')), registry, limits, withoutFacts);
    assert.equal(noFacts.ok, false, 'without registry facts, item references cannot be verified and are rejected');
  });

  it('parameters must be declared by an allowed capability and satisfy its type/range/enum', () => {
    assert.deepEqual(problems(plan([task({ allowedCapabilities: ['craft_item'], parameters: { output: 'minecraft:stick', count: 4 } })])), []);
    assert.match(problems(plan([task({ parameters: { speed: 99 } })])).join(), /no allowed capability declares parameter "speed"/);
    assert.match(problems(plan([task({ parameters: { timeoutMs: 999_999 } })])).join(), /forbidden field/, 'limit-like parameters are rejected even before declaration checks');
    assert.match(problems(plan([task({ allowedCapabilities: ['craft_item'], parameters: { count: 99_999 } })])).join(), /outside 1\.\.576/);
    assert.match(problems(plan([task({ allowedCapabilities: ['equip_item'], parameters: { slot: 'pocket' } })])).join(), /one of hand, off_hand/);
    assert.match(problems(plan([task({ allowedCapabilities: ['craft_item'], parameters: { output: 'minecraft:unobtainium' } })])).join(), /unobtainium/);
  });

  it('a persistent outcome needs a maintaining task unless more planning follows', () => {
    assert.match(problems(plan([task({ completion: { predicate: 'visited_location', target: { kind: 'owner' }, within: 3 } })], near, 'persistent')).join(), /persistent outcome needs a task/);
    assert.deepEqual(problems(plan([task({ completion: near })], near, 'persistent')), []);
    assert.deepEqual(problems(plan([task({ completion: { predicate: 'visited_location', target: { kind: 'owner' }, within: 3 } })], near, 'persistent', true)), []);
  });
});
