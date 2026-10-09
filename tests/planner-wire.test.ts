// Planner output wire format: generated strict schema, strict conversion to
// the shared proposal contract, normalization, and forbidden-content scans.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlannerProposalSchema } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { allSkills } from '../src/skills/index.ts';
import { WireError, plannerOutputSchema, proposalFromWire } from '../src/planner/wire.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const catalog = new SkillRegistry(allSkills()).catalog();

const base = { outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: null, missingCapabilities: [], verifiedProgress: null };
const near = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const plan = (over: Json = {}): Json => ({
  ...base,
  disposition: 'plan',
  interpretation: 'Walk to the owner.',
  outcome: { kind: 'finite', predicate: near },
  tasks: [{ objective: 'Walk to the owner.', decisionInstruction: 'Move next to the owner.', allowedCapabilities: ['move_near'], targetSelectors: [{ kind: 'owner' }], parameters: [], completion: near }],
  ...over,
});

function walk(schema: unknown, visit: (node: Json, path: string) => void, path = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Json;
  visit(node, path);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, visit, `${path}.${k}[${i}]`));
    else if (v && typeof v === 'object') walk(v, visit, `${path}.${k}`);
  }
}

describe('generated strict planner output schema', () => {
  const schema = plannerOutputSchema(catalog);
  it('closes every object (no additional properties; every property required) and keeps the root a single object', () => {
    assert.equal(schema['type'], 'object');
    assert.ok(!('anyOf' in schema), 'root is not a union');
    let objects = 0;
    walk(schema, (node, path) => {
      if (node['type'] !== 'object') return;
      objects += 1;
      assert.equal(node['additionalProperties'], false, `${path} forbids additional properties`);
      assert.deepEqual([...(node['required'] as string[])].sort(), Object.keys(node['properties'] as object).sort(), `${path} requires every property`);
    });
    assert.ok(objects > 15);
  });

  it('is generated from the implemented catalog: capability ids are exactly the registered ones', () => {
    const task = (schema['$defs'] as Json)['task'];
    assert.deepEqual(task.properties.allowedCapabilities.items.enum, catalog.capabilities.map((c) => c.id));
    const other = plannerOutputSchema({ catalogVersion: 'x', capabilities: [catalog.capabilities[0]!] });
    assert.deepEqual((other['$defs'] as Json)['task'].properties.allowedCapabilities.items.enum, [catalog.capabilities[0]!.id]);
  });

  it('uses one closed variant per predicate and selector kind (no irrelevant nullable fields)', () => {
    const defs = schema['$defs'] as Json;
    const predicateKinds = (defs['predicate'].anyOf as Json[]).flatMap((v) => v.properties.predicate.enum);
    for (const k of ['inventory_amount', 'inventory_delta', 'equipped', 'near_target', 'visited_location', 'block_state', 'container_state', 'crafting_result', 'smelting_result', 'entity_outcome', 'all', 'any', 'not']) assert.ok(predicateKinds.includes(k), k);
    const craft = (defs['predicate'].anyOf as Json[]).find((v) => v.properties.predicate.enum.includes('crafting_result'));
    assert.deepEqual(Object.keys(craft?.properties ?? {}).sort(), ['atLeast', 'output', 'predicate']);
    const selectorKinds = (defs['target'].anyOf as Json[]).map((v) => v.properties.kind.enum[0]);
    assert.deepEqual(selectorKinds.sort(), ['observed', 'owner', 'owner_destination', 'prior_result', 'registry', 'remembered_anchor']);
  });
});

describe('wire -> PlannerProposal conversion', () => {
  it('converts a plan to the shared contract (which then parses)', () => {
    const p = proposalFromWire(plan());
    assert.equal(PlannerProposalSchema.safeParse(p).success, true);
    assert.equal(p.disposition, 'plan');
  });

  it('normalizes bare registry names to the vanilla namespace (registry existence is checked later)', () => {
    const p = proposalFromWire(
      plan({
        outcome: { kind: 'finite', predicate: { predicate: 'inventory_amount', selector: 'cobblestone', atLeast: 2, mode: 'collect_additional' } },
        tasks: [{ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['mine_block'], targetSelectors: [{ kind: 'registry', key: '#logs' }], parameters: [], completion: { predicate: 'crafting_result', output: 'stick', atLeast: 1 } }],
      }),
    );
    assert.equal(p.disposition === 'plan' && (p.outcome as Json).outcome.selector, 'minecraft:cobblestone');
    assert.equal(p.disposition === 'plan' && (p.tasks[0]!.targetSelectors[0] as Json).key, '#minecraft:logs');
    assert.equal(p.disposition === 'plan' && (p.tasks[0]!.completion as Json).output, 'minecraft:stick');
  });

  it('maps not/all/any and parses parameter values as JSON data', () => {
    const p = proposalFromWire(
      plan({
        tasks: [
          {
            objective: 'o',
            decisionInstruction: 'd',
            allowedCapabilities: ['craft_item'],
            targetSelectors: [],
            parameters: [{ name: 'count', valueJson: '4' }, { name: 'output', valueJson: '"minecraft:stick"' }],
            completion: { predicate: 'all', of: [{ predicate: 'not', of: [near] }, { predicate: 'crafting_result', output: 'minecraft:stick', atLeast: 4 }] },
          },
        ],
      }),
    );
    assert.ok(p.disposition === 'plan');
    assert.deepEqual(p.tasks[0]!.parameters, { count: 4, output: 'minecraft:stick' });
    assert.equal((p.tasks[0]!.completion as Json).of[0].of.predicate, 'near_target');
    assert.throws(() => proposalFromWire(plan({ tasks: [{ ...plan().tasks[0], completion: { predicate: 'not', of: [near, near] } }] })), WireError);
    assert.throws(() => proposalFromWire(plan({ tasks: [{ ...plan().tasks[0], parameters: [{ name: 'count', valueJson: 'four' }] }] })), /not JSON/);
  });

  it('rejects fields that do not belong to a predicate or selector kind', () => {
    assert.throws(() => proposalFromWire(plan({ outcome: { kind: 'finite', predicate: { ...near, selector: 'minecraft:stone' } } })), /selector must be null for this kind/);
    assert.throws(() => proposalFromWire(plan({ outcome: { kind: 'finite', predicate: { predicate: 'near_target', target: { kind: 'owner', key: 'minecraft:stone' }, within: 3 } } })), /key must be null/);
    assert.throws(() => proposalFromWire(plan({ outcome: { kind: 'finite', predicate: { predicate: 'crafting_result', atLeast: 1 } } })), /output is required/);
  });

  it('rejects executable code, code-bearing text and limit/provider/model fields before anything else', () => {
    assert.throws(() => proposalFromWire({ ...plan(), code: 'bot.dig()' }), /forbidden field/);
    assert.throws(() => proposalFromWire({ ...plan(), limits: { plannerTurnsPerGoal: 999 } }), /forbidden field/);
    assert.throws(() => proposalFromWire(plan({ tasks: [{ ...plan().tasks[0], model: 'other-model' }] })), /forbidden field/);
    assert.throws(() => proposalFromWire(plan({ interpretation: 'do this: function go() { return 1 }' })), /code-bearing/);
    assert.throws(() => proposalFromWire(plan({ tasks: [{ ...plan().tasks[0], decisionInstruction: 'const x = require("child_process")' }] })), /code-bearing/);
    // ordinary prose with arrows and semicolons is fine
    assert.doesNotThrow(() => proposalFromWire(plan({ interpretation: 'logs => planks => sticks; then walk back' })));
  });

  it('non-plan dispositions ignore plan-only fields (they never act); cannot_execute folds descriptive missing entries into text', () => {
    const info = proposalFromWire({ ...base, disposition: 'needs_information', interpretation: 'need recipes', outcome: plan().outcome, tasks: plan().tasks, morePlanningNeeded: true, queries: [{ kind: 'recipe', key: 'stick' }] });
    assert.deepEqual(info, { version: 1, interpretation: 'need recipes', disposition: 'needs_information', queries: [{ kind: 'recipe', output: 'minecraft:stick' }] });
    const cannot = proposalFromWire({ ...base, disposition: 'cannot_execute', interpretation: 'x', missing: 'No way to fly.', missingCapabilities: ['fly_to', 'Elytra flight support'], verifiedProgress: 'none', outcome: plan().outcome });
    assert.ok(cannot.disposition === 'cannot_execute');
    assert.deepEqual(cannot.missingCapabilities, ['fly_to']);
    assert.match(cannot.missing, /also missing: Elytra flight support/);
    assert.throws(() => proposalFromWire({ ...base, disposition: 'needs_clarification', interpretation: 'x', question: 'which?', queries: [{ kind: 'item', key: 'x' }] }), /owner_question_refused/);
    assert.throws(() => proposalFromWire({ ...base, disposition: 'cannot_execute', interpretation: 'x', missing: 'm', question: 'which?' }), /owner_question_refused/);
    assert.throws(() => proposalFromWire({ ...base, disposition: 'do_anything', interpretation: 'x' }), /disposition/);
  });
});
