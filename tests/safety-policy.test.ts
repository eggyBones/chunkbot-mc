// MB-FLOW-003-C11/C13 (offline): hazard classification and the conservative
// retreat-by-default / bounded-defense admission policy. No model, no world.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispositionOf, weaponFacts } from '../src/safety/dispositions.ts';
import { fluidHazards, planSafety, threatHazards, verifiedArmorPoints } from '../src/safety/policy.ts';
import { armed, config, inTag, item, mob, policyCtx, self, unarmed } from './safety-helpers.ts';

const respond = (p: ReturnType<typeof planSafety>) => (p.kind === 'respond' ? p : assert.fail(`expected respond, got ${p.kind}: ${'reason' in p ? p.reason : ''}`));

describe('dispositions (code policy, exact names)', () => {
  it('owner/player never hostile; passive never a threat; neutral and unknown only when provoked', () => {
    assert.equal(dispositionOf('minecraft:player', undefined).disposition, 'player');
    assert.equal(dispositionOf('cow', 'Passive mobs').disposition, 'passive');
    assert.equal(dispositionOf('enderman', 'Hostile mobs').disposition, 'neutral', 'registry calls enderman hostile; policy overrides');
    assert.equal(dispositionOf('zombified_piglin', 'Hostile mobs').disposition, 'neutral');
    assert.equal(dispositionOf('strider', 'Hostile mobs').disposition, 'passive');
    assert.equal(dispositionOf('sulfur_cube', 'Hostile mobs').disposition, 'unknown', '26.2-only mob without a curated policy');
    assert.equal(dispositionOf('brand_new_mob', undefined).disposition, 'unknown');
    assert.equal(dispositionOf('brand_new_hostile', 'Hostile mobs').disposition, 'hostile_other');
  });

  it('only a few adult melee mobs are defense-supported; a ranged item makes them ranged', () => {
    assert.equal(dispositionOf('zombie', 'Hostile mobs').defenseSupported, true);
    assert.equal(dispositionOf('skeleton', 'Hostile mobs').defenseSupported, false);
    assert.equal(dispositionOf('creeper', 'Hostile mobs').defenseSupported, false);
    assert.equal(dispositionOf('warden', 'Hostile mobs').defenseSupported, false);
    assert.equal(dispositionOf('enderman', 'Hostile mobs').defenseSupported, false);
    const d = dispositionOf('drowned', 'Hostile mobs', 'minecraft:trident');
    assert.equal(d.disposition, 'hostile_ranged');
    assert.equal(d.defenseSupported, false);
  });

  it('weapons: stone+ swords/axes by exact-version tags; wooden/golden/spears refused', () => {
    assert.equal(weaponFacts('minecraft:iron_sword', inTag)?.kind, 'sword');
    assert.equal(weaponFacts('minecraft:stone_axe', inTag)?.kind, 'axe');
    assert.equal(weaponFacts('minecraft:wooden_sword', inTag), undefined);
    assert.equal(weaponFacts('minecraft:golden_sword', inTag), undefined);
    assert.equal(weaponFacts('minecraft:iron_spear', inTag), undefined);
    assert.equal(weaponFacts('minecraft:iron_sword', () => false), undefined, 'not in this version tag');
  });
});

describe('water hazards', () => {
  it('submersion responds immediately without air metadata (unknown air is urgent, not full)', () => {
    const s = self({ fluid: { feetIn: 'water', eyeIn: 'water', support: 'solid', depth: 2, wadeable: false, headroom: 'open', surfaceDy: 0.3, onGround: true, source: 'local_estimate' } });
    const kinds = fluidHazards(s, config()).map((h) => h.kind);
    assert.deepEqual(kinds.sort(), ['low_air', 'submerged']);
    const p = respond(planSafety(s, [], policyCtx({ fluidExitAvailable: () => false })));
    assert.equal(p.response, 'escape_water', 'open headroom: surfacing starts even with no exit known');
  });

  it('a solid ceiling with no open column or exit is a declarative blocker, never a blind jump', () => {
    const s = self({ fluid: { feetIn: 'water', eyeIn: 'water', support: 'solid', depth: 4, wadeable: false, headroom: 'ceiling', surfaceDy: null, onGround: false, source: 'local_estimate' } });
    const p = planSafety(s, [], policyCtx({ fluidExitAvailable: () => false }));
    assert.equal(p.kind, 'blocked');
    assert.equal(p.kind === 'blocked' && p.reason, 'no_reachable_surface');
  });

  it('swimming depth with eyes out is deep_water; wading is not a hazard', () => {
    const deep = self({ fluid: { feetIn: 'water', eyeIn: 'none', support: 'solid', depth: 3, wadeable: false, headroom: 'dry', surfaceDy: null, onGround: false, source: 'local_estimate' } });
    assert.deepEqual(fluidHazards(deep, config()).map((h) => h.kind), ['deep_water']);
    const wade = self({ fluid: { feetIn: 'water', eyeIn: 'none', support: 'solid', depth: 1, wadeable: true, headroom: 'dry', surfaceDy: null, onGround: true, source: 'local_estimate' } });
    assert.deepEqual(fluidHazards(wade, config()), []);
  });

  it('low server air while refilling out of water is not re-triggered; falling low air is', () => {
    const surfaced = self({ air: { value: 40, max: 300, source: 'server_metadata', observedAtMs: 900, trend: 'rising' } });
    assert.deepEqual(fluidHazards(surfaced, config()), []);
    const falling = self({ air: { value: 40, max: 300, source: 'server_metadata', observedAtMs: 900, trend: 'falling' } });
    assert.deepEqual(fluidHazards(falling, config()).map((h) => h.kind), ['low_air']);
  });

  it('water precedes mobs (nothing is fought from water)', () => {
    const s = self({ fluid: { feetIn: 'water', eyeIn: 'none', support: 'fluid', depth: 5, wadeable: false, headroom: 'dry', surfaceDy: null, onGround: false, source: 'local_estimate' } });
    const p = respond(planSafety(s, [mob('zombie', 2)], policyCtx()));
    assert.equal(p.response, 'escape_water');
  });
});

describe('mob threats', () => {
  it('passive, neutral (unprovoked), owner and players are never threats', () => {
    const entities = [mob('cow', 2, { disposition: 'passive' }), mob('enderman', 2), mob('wolf', 1.5), { ...mob('player', 1), disposition: 'player' as const }, { ...mob('player', 1), disposition: 'owner' as const }];
    assert.equal(threatHazards(entities, config(), 1_000).hazards.length, 0);
    assert.equal(planSafety(self(), entities, policyCtx()).kind, 'none');
  });

  it('a provoked neutral (server damage attribution) becomes an avoidance-only threat', () => {
    const golem = mob('iron_golem', 3, { damagedSelfAtMs: 800 });
    const p = respond(planSafety(self(), [golem], policyCtx()));
    assert.equal(p.response, 'retreat');
    assert.ok(p.defense?.refusals.includes('neutral_or_unknown_threat'));
  });

  it('a far idle hostile is not a threat; an approaching or aggressive one is', () => {
    assert.equal(planSafety(self(), [mob('zombie', 7)], policyCtx()).kind, 'none');
    assert.equal(planSafety(self(), [mob('zombie', 7, { approaching: true })], policyCtx()).kind, 'respond');
    assert.equal(planSafety(self(), [mob('zombie', 7, { aggressive: true })], policyCtx()).kind, 'respond');
  });

  it('retreat is the default: armed and ready, a zombie that is near but not engaging is avoided', () => {
    const p = respond(planSafety(self(), [mob('zombie', 3, { approaching: true })], policyCtx()));
    assert.equal(p.response, 'retreat');
    assert.equal(p.defense?.admitted, true, 'readiness passed, still retreat');
    assert.match(p.reason, /retreat default/);
    assert.equal(respond(planSafety(self(), [mob('zombie', 6, { aggressive: true })], policyCtx())).response, 'retreat', 'engaging but not in melee contact');
  });

  it('armed, armored and healthy: a single supported zombie in melee contact and engaging is defended', () => {
    const z = mob('zombie', 2.5, { aggressive: true });
    const p = respond(planSafety(self(), [z], policyCtx()));
    assert.equal(p.response, 'defend');
    assert.equal(p.defense?.target?.entityId, z.entityId);
    assert.equal(p.defense?.armorPoints, 8);
  });

  it('gear alone is insufficient: creeper, skeleton, groups and babies retreat', () => {
    assert.equal(respond(planSafety(self(), [mob('creeper', 5)], policyCtx())).response, 'retreat');
    assert.equal(respond(planSafety(self(), [mob('creeper', 14, { fuse: { swelling: true, ignited: false } })], policyCtx())).response, 'retreat', 'fuse is critical at any visible distance');
    assert.equal(respond(planSafety(self(), [mob('skeleton', 10, { aggressive: true })], policyCtx())).response, 'retreat');
    const group = planSafety(self(), [mob('zombie', 2.5), mob('zombie', 3)], policyCtx());
    assert.equal(respond(group).response, 'retreat');
    assert.ok(respond(group).defense?.refusals.includes('group'));
    assert.equal(respond(planSafety(self(), [mob('zombie', 2, { baby: true })], policyCtx())).response, 'retreat');
    assert.equal(respond(planSafety(self(), [mob('vindicator', 2)], policyCtx())).response, 'retreat', 'unsupported matchup');
  });

  it('missing/unknown gear facts, low health or food refuse defense (grounded retreat)', () => {
    const z = () => [mob('zombie', 2.5)];
    const cases: Array<[string, Parameters<typeof self>[0]]> = [
      ['no_verified_weapon', { equipment: unarmed() }],
      ['equipment_not_server_stated', { equipment: { ...armed(), source: 'unavailable' } }],
      ['weapon_nearly_worn', { equipment: { ...armed(), mainHand: item('iron_sword', 36, 250, 10), hotbar: [item('iron_sword', 36, 250, 10)] } }],
      ['weapon_durability_unknown', { equipment: { ...armed(), mainHand: item('iron_sword', 36, null, null), hotbar: [] } }],
      ['armor_below_minimum', { equipment: { ...armed(), armor: [item('leather_helmet', 5, 55, 50)] } }],
      ['health_below_minimum', { health: 12 }],
      ['food_below_minimum', { food: 4 }],
      ['vitals_not_server_stated', { vitalsSource: 'client_model' }],
    ];
    for (const [refusal, over] of cases) {
      const p = respond(planSafety(self(over), z(), policyCtx()));
      assert.equal(p.response, 'retreat', refusal);
      assert.ok(p.defense?.refusals.includes(refusal), `${refusal} in ${p.defense?.refusals.join(',')}`);
    }
  });

  it('worn armor pieces do not count; a hotbar weapon can be selected', () => {
    const s = self({ equipment: { ...armed(), armor: [item('iron_chestplate', 6, 240, 5), item('iron_helmet', 5, 165, 160)] } });
    assert.equal(verifiedArmorPoints(s, 0.1), 2);
    const switchable = self({ equipment: { ...armed(), mainHand: item('dirt', 36), heldHotbar: 0, hotbar: [item('dirt', 36), item('stone_sword', 38, 131, 120)] } });
    const p = respond(planSafety(switchable, [mob('zombie', 2.5, { aggressive: true })], policyCtx()));
    assert.equal(p.response, 'defend');
    assert.equal(p.defense?.weapon?.switchFromHotbar, 2);
    const noSwitch = respond(planSafety(switchable, [mob('zombie', 2.5, { aggressive: true })], policyCtx({ config: config({ mobs: { defense: { allowHotbarSwitch: false } } }) })));
    assert.equal(noSwitch.response, 'retreat');
  });

  it('cornered: escape terrain is never waived — no retreat leg is a declarative blocker, never a fight', () => {
    const engaged = () => [mob('zombie', 2.5, { aggressive: true })];
    const ready = planSafety(self(), engaged(), policyCtx({ retreatAvailable: () => false }));
    assert.equal(ready.kind, 'blocked', 'even fully ready: no cornered defense');
    assert.equal(ready.kind === 'blocked' && ready.reason, 'no_retreat_leg');
    assert.match(ready.kind === 'blocked' ? ready.detail : '', /no_retreat_space/);
    for (const [label, entities, over] of [
      ['unready', engaged(), { equipment: unarmed() }],
      ['creeper', [mob('creeper', 3)], {}],
      ['ranged', [mob('skeleton', 3, { aggressive: true })], {}],
      ['group', [mob('zombie', 2.5, { aggressive: true }), mob('husk', 3)], {}],
      ['unknown', [mob('mystery', 3, { approaching: true })], {}],
    ] as const) {
      assert.equal(planSafety(self(over), entities, policyCtx({ retreatAvailable: () => false })).kind, 'blocked', label);
    }
  });

  it('unknown/new entities: established visible danger is avoided without waiting for damage; never attacked', () => {
    const unknownNear = mob('mystery', 5, { approaching: true });
    assert.equal(unknownNear.disposition, 'unknown');
    const p = respond(planSafety(self(), [unknownNear], policyCtx()));
    assert.equal(p.response, 'retreat');
    assert.ok(p.hazards.some((h) => h.kind === 'unknown_threat'));
    assert.equal(planSafety(self(), [mob('mystery', 5)], policyCtx()).kind, 'none', 'idle unknown at distance: no threat');
    const angryWolf = mob('wolf', 4, { aggressive: true });
    assert.equal(respond(planSafety(self(), [angryWolf], policyCtx())).response, 'retreat', 'aggressive neutral is avoided');
    assert.ok(respond(planSafety(self(), [mob('mystery', 2, { approaching: true, aggressive: true })], policyCtx())).defense?.refusals.includes('neutral_or_unknown_threat'), 'never a defense target');
  });

  it('defense disabled or mobs disabled by config', () => {
    assert.equal(respond(planSafety(self(), [mob('zombie', 2.5, { aggressive: true })], policyCtx({ config: config({ mobs: { defense: { enabled: false } } }) }))).response, 'retreat');
    assert.equal(planSafety(self(), [mob('zombie', 2.5)], policyCtx({ config: config({ mobs: { enabled: false } }) })).kind, 'none');
  });
});
