// P-PLAN-R20/P10: an unimplemented mechanic must be named to the owner.
// Actual 262 real P10 (goal-3e279fd5e702, "enchant your pickaxe with
// efficiency"): the planner queried capabilities `enchanting` and `anvil`; the
// real catalog answered both `unknown` ("is not an implemented capability");
// the planner's cannot_execute listed its missing mechanic DESCRIPTIVELY, which
// the wire folds into the internal `missing` prose, so missingCapabilities was
// [] and the owner-facing detail named nothing ("the planner found no supported
// way to continue; planner turns 2 ..."). Actual composition: the real
// GoalEngine, the real wire conversion (proposalFromWire) of the planner output
// and the real VersionKnowledge over the real registered skill catalog.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerProposal } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { proposalFromWire } from '../src/planner/wire.ts';
import { allSkills } from '../src/skills/index.ts';
import { ScriptedPlanner, makeEngine, until } from './helpers.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const registry = new SkillRegistry(allSkills());
const wire = (over: Record<string, unknown>) => ({ disposition: 'cannot_execute', interpretation: '', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], missing: null, missingCapabilities: [], verifiedProgress: null, ...over });
// Actual turn 1 (journaled, normalized) and turn 2 (raw wire reconstructed so the real fold reproduces the journaled `missing` exactly).
const TURN1 = { kind: 'capability', key: 'enchanting' };
const ACTUAL_MISSING = 'The available capabilities cannot apply enchantments: enchanting and anvil operations are unimplemented, and block interaction closes interfaces without operating them. (also missing: enchanting or anvil enchantment application)';
const turn2 = () => proposalFromWire(wire({ interpretation: 'Apply Efficiency to my existing wooden pickaxe.', missing: 'The available capabilities cannot apply enchantments: enchanting and anvil operations are unimplemented, and block interaction closes interfaces without operating them.', missingCapabilities: ['enchanting or anvil enchantment application'], verifiedProgress: 'One wooden pickaxe was confirmed in the admission inventory; no enchantment has been applied.' }));

async function run(proposals: PlannerProposal[], opts: { stopBeforeLast?: boolean } = {}) {
  const planner = new ScriptedPlanner();
  const h = makeEngine({ planner, knowledge: new VersionKnowledge({ version: '26.2', catalog: () => registry.catalog() }), capabilities: registry, executor: { readiness: () => ({ ready: true, detail: 'unused' }), execute: async () => { throw new Error('unused'); } } });
  await h.engine.submit('enchant your pickaxe with efficiency', OWNER);
  for (let i = 0; i < proposals.length; i += 1) {
    await until(() => planner.waiting === 1);
    if (opts.stopBeforeLast && i === proposals.length - 1) await h.engine.stop('owner_stop', 'chat');
    planner.respond(proposals[i]!);
  }
  await until(() => Boolean(h.engine.status().goal?.terminal ?? h.store.events.find((e) => e['type'] === 'goal_terminal')));
  const terminal = h.store.events.find((e) => e['type'] === 'goal_terminal')!;
  return { h, terminal, detail: String(terminal['detail'] ?? '') };
}

describe('P-PLAN-R20 P10 cannot_execute names the code-verified missing mechanic', () => {
  it('actual R20 sequence: the catalog-checked unimplemented capabilities are named to the owner (no planner prose)', async () => {
    const t1 = proposalFromWire(wire({ disposition: 'needs_information', interpretation: 'Enchanting my existing wooden pickaxe with Efficiency.', queries: [TURN1, { kind: 'capability', key: 'anvil' }] }));
    const t2 = turn2();
    assert.equal(t2.disposition === 'cannot_execute' && t2.missing, ACTUAL_MISSING, 'the real wire fold reproduces the journaled text');
    assert.deepEqual(t2.disposition === 'cannot_execute' && t2.missingCapabilities, [], 'descriptive entry is not a capability id (as journaled)');
    const { terminal, detail, h } = await run([t1, t2]);
    assert.equal(terminal['reason'], 'cannot_execute');
    assert.match(detail, /not implemented \(checked against the capability catalog\): enchanting, anvil/);
    assert.ok(/enchant/i.test(detail) && detail.length > 30, 'P10 oracle: the missing mechanic is named');
    assert.ok(!/available capabilities cannot apply|block interaction closes|Efficiency/.test(detail), 'planner prose stays internal');
    assert.ok(detail.length <= 600);
    assert.equal(h.store.events.filter((e) => e['type'] === 'knowledge_answered').length, 1);
  });

  it('negative controls: a registered capability is never named missing; no capability query, no clause; ids stay code-shaped', async () => {
    const known = proposalFromWire(wire({ disposition: 'needs_information', interpretation: 'x', queries: [{ kind: 'capability', key: 'craft_item' }, { kind: 'capability', key: 'anvil' }] }));
    const a = await run([known, turn2()]);
    assert.match(a.detail, /not implemented \(checked against the capability catalog\): anvil(;|$)/);
    assert.ok(!/craft_item/.test(a.detail), 'registered capability never reported missing');
    const b = await run([turn2()]);
    assert.ok(!/not implemented/.test(b.detail), 'without a code-checked capability query nothing is claimed');
    assert.match(b.detail, /^the planner found no supported way to continue/);
    const c = await run([proposalFromWire(wire({ interpretation: 'x', missing: 'm', missingCapabilities: ['enchant_item'] }))]);
    assert.match(c.detail, /missing capabilities: enchant_item/, 'code-id-shaped planner entries are still shown as before');
  });

  it('bounded: at most four checked ids, duplicates merged, clause clipped', async () => {
    const many = proposalFromWire(wire({ disposition: 'needs_information', interpretation: 'x', queries: ['a_one', 'b_two', 'c_three', 'd_four', 'e_five', 'a_one'].map((key) => ({ kind: 'capability', key })) }));
    const { detail } = await run([many, turn2()]);
    assert.match(detail, /not implemented \(checked against the capability catalog\): a_one, b_two, c_three, d_four(;|$)/);
    assert.ok(!/e_five/.test(detail));
  });

  it('redaction: question-shaped or non-code ids are never relayed, even when the catalog says unknown', async () => {
    const q = proposalFromWire(wire({ disposition: 'needs_information', interpretation: 'x', queries: [{ kind: 'capability', key: 'can_you_enchant' }, { kind: 'capability', key: 'let_me_know' }, { kind: 'capability', key: 'anvil' }] }));
    const { detail } = await run([q, turn2()]);
    assert.match(detail, /not implemented \(checked against the capability catalog\): anvil(;|$)/);
    assert.ok(!/can_you_enchant|let_me_know/.test(detail));
  });

  it('late ownership: a stop before the final turn publishes no capability blocker', async () => {
    const t1 = proposalFromWire(wire({ disposition: 'needs_information', interpretation: 'x', queries: [TURN1] }));
    const { terminal, detail } = await run([t1, turn2()], { stopBeforeLast: true });
    assert.equal(terminal['reason'], 'owner_stop');
    assert.ok(!/not implemented/.test(detail));
  });
});
