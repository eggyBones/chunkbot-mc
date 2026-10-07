// MB-FLOW-003 skills (resolvers, offline): only safe owned food at real hunger;
// rest needs food and no visible threat; death-site travel and recovery
// candidates exist only for the bound recovery goal, inside the travel bound,
// and only for still-sought drops near the site (no unrelated loot);
// equip_suitable_tool prefers the cheapest capable unworn tool.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ObservationSnapshot } from '../src/contracts/observation.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import type { AnySkill, ResolveContext } from '../src/skills/definition.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, slot, snapshot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

function ctxFor(h: Harness, snap: ObservationSnapshot, hints: Partial<ResolveContext['hints']> = {}, travel = 128): ResolveContext {
  return {
    task: { objective: 'x', decisionInstruction: 'x', allowedCapabilities: ['eat_safe_food'], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' } },
    hints: { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: {}, memoryRefs: [], ...hints },
    snapshot: snap,
    session: { connectionEpoch: 1, bot: {} } as unknown as ResolveContext['session'],
    services: {
      perception: { withinTravel: (at: { x: number; z: number }) => Math.hypot(at.x, at.z) <= travel, latest: () => snap },
      knowledge: { isBlock: (k: string) => k === 'minecraft:stone' || k === 'minecraft:iron_ore', harvestTools: (b: string) => (b === 'minecraft:iron_ore' ? ['minecraft:stone_pickaxe', 'minecraft:iron_pickaxe'] : b === 'minecraft:stone' ? ['minecraft:wooden_pickaxe', 'minecraft:stone_pickaxe', 'minecraft:iron_pickaxe'] : []) },
    } as unknown as ResolveContext['services'],
  };
}

const skill = (h: Harness, id: string): AnySkill => {
  const s = survivalSkills(h.service).find((x) => x.descriptor.id === id);
  assert.ok(s, id);
  return s;
};

describe('survival skills', () => {
  it('registers nothing when survival is disabled', () => {
    assert.equal(survivalSkills(undefined).length, 0);
    assert.equal(survivalSkills(harness({ config: { enabled: false } }).service).length, 0);
    assert.deepEqual(survivalSkills(harness().service).map((s) => s.descriptor.id), ['eat_safe_food', 'rest_in_place', 'go_to_death_site', 'recover_lost_items', 'equip_suitable_tool']);
  });

  it('eat_safe_food offers only safe owned foods and nothing at full hunger', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 2), 37: slot('rotten_flesh', 3), 38: slot('golden_apple', 1), 39: slot('cooked_beef', 1) });
    h.packets.health(20, 12);
    const r = skill(h, 'eat_safe_food').resolve(ctxFor(h, snapshot()));
    assert.deepEqual(r.drafts.map((d) => d.parameters['item']).sort(), ['minecraft:bread', 'minecraft:cooked_beef']);
    h.packets.health(20, 20);
    const full = skill(h, 'eat_safe_food').resolve(ctxFor(h, snapshot()));
    assert.equal(full.drafts.length, 0);
    assert.equal(full.unavailable?.[0]?.reason, 'not_hungry');
  });

  it('rest_in_place requires food >= 18 and no visible hostile', () => {
    const h = harness();
    h.packets.inventory({});
    h.packets.health(10, 12);
    assert.equal(skill(h, 'rest_in_place').resolve(ctxFor(h, snapshot())).unavailable?.[0]?.reason, 'regeneration_needs_food');
    h.packets.health(10, 20);
    assert.equal(skill(h, 'rest_in_place').resolve(ctxFor(h, snapshot())).drafts.length, 1);
    const threat = snapshot({ entities: [{ handle: 'ent-1', key: 'minecraft:skeleton', at: { x: 4, y: 64, z: 0 }, distance: 4 }] });
    assert.equal(skill(h, 'rest_in_place').resolve(ctxFor(h, threat)).unavailable?.[0]?.reason, 'threat_nearby');
  });

  it('death-site travel and recovery candidates exist only for the bound goal, scoped to sought drops near the site', () => {
    const h = harness();
    const kit = { 36: slot('iron_pickaxe'), 37: slot('bread', 4) };
    h.packets.inventory(kit);
    h.packets.health(20, 20);
    dieWithItems(h, kit);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    const unbound = skill(h, 'go_to_death_site').resolve(ctxFor(h, snapshot({ goalEpoch: 5 })));
    assert.equal(unbound.unavailable?.[0]?.reason, 'not_a_recovery_goal');
    const d = h.service.assess(assessInput(h));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-rec5', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    const go = skill(h, 'go_to_death_site').resolve(ctxFor(h, snapshot({ goalEpoch: 5 })));
    assert.equal(go.drafts.length, 1);
    // Outside the travel bound: never relaxed.
    assert.equal(skill(h, 'go_to_death_site').resolve(ctxFor(h, snapshot({ goalEpoch: 5 }), {}, 20)).unavailable?.[0]?.reason, 'outside_travel_bounds');
    // Another goal epoch: nothing.
    assert.equal(skill(h, 'go_to_death_site').resolve(ctxFor(h, snapshot({ goalEpoch: 6 }))).drafts.length, 0);
    // Lava at the site: refused.
    const lava = snapshot({ goalEpoch: 5, blocks: [{ handle: 'blk-1', key: 'minecraft:lava', at: { x: 30, y: 64, z: 11 }, distance: 30 }] });
    assert.equal(skill(h, 'go_to_death_site').resolve(ctxFor(h, lava)).unavailable?.[0]?.reason, 'site_hazard_visible');
    const drops = snapshot({
      goalEpoch: 5,
      at: { x: 29, y: 64, z: 10 },
      drops: [
        { handle: 'drp-1', key: 'minecraft:bread', at: { x: 31, y: 64, z: 11 }, distance: 2 },
        { handle: 'drp-2', key: 'minecraft:diamond_sword', at: { x: 31, y: 64, z: 11 }, distance: 2 },
        { handle: 'drp-3', key: 'minecraft:iron_pickaxe', at: { x: 60, y: 64, z: 10 }, distance: 31 },
      ],
    });
    const rec = skill(h, 'recover_lost_items').resolve(ctxFor(h, drops));
    assert.deepEqual(rec.drafts.map((x) => (x.parameters['target'] as { handle: string }).handle), ['drp-1'], 'only a still-sought drop within the search radius');
    const none = skill(h, 'recover_lost_items').resolve(ctxFor(h, snapshot({ goalEpoch: 5, at: { x: 30, y: 64, z: 10 } })));
    assert.equal(none.unavailable?.[0]?.reason, 'no_scoped_drops_visible');
  });

  it('equip_suitable_tool prefers the cheapest capable unworn tool; unknown block gets no tool', () => {
    const h = harness();
    h.packets.inventory({ 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 10 }]), 37: slot('stone_pickaxe', 1, [{ type: 'damage', data: 128 }]) });
    h.packets.health(20, 20);
    const r = skill(h, 'equip_suitable_tool').resolve(ctxFor(h, snapshot(), { keys: ['minecraft:iron_ore'] }));
    assert.equal(r.drafts[0]?.parameters['item'], 'minecraft:iron_pickaxe', 'the stone pickaxe is nearly worn, so the healthy iron one is chosen');
    h.packets.setSlot(37, slot('stone_pickaxe', 1));
    const r2 = skill(h, 'equip_suitable_tool').resolve(ctxFor(h, snapshot(), { keys: ['minecraft:iron_ore'] }));
    assert.equal(r2.drafts[0]?.parameters['item'], 'minecraft:stone_pickaxe', 'cheapest capable tool preserves the better one');
    const r3 = skill(h, 'equip_suitable_tool').resolve(ctxFor(h, snapshot(), { keys: ['minecraft:dirt'] }));
    assert.equal(r3.drafts.length, 0);
  });
});
