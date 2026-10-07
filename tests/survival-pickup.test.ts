// MB-FLOW-003-C3 (offline, resolver/accounting level): recovery pickup scope
// and identity. Candidates come only from SERVER-stated drop stacks (never a
// display label); an oversized/merged pile is refused before movement; the
// task's named-target scope is honored; unrelated loot within pickup range of
// the target refuses it; a valuable item counts only on an exact server
// identity match and unproven identity is never collected or counted; valuable
// and custom stacks are preserved in food and tool selection. Collection and
// path revalidation are fixture gate G2 (no lease yet).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ObservationSnapshot } from '../src/contracts/observation.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import type { AnySkill, ResolveContext } from '../src/skills/definition.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import { safeFoods } from '../src/survival/items.ts';
import { OW, assessInput, cleanupRoots, dieWithItems, harness, registry, respawnFresh, slot, snapshot, type Harness, type Slot } from './survival-helpers.ts';

after(cleanupRoots);

const SITE = { x: 30.5, y: 64, z: 10.5 };
const SHARP3 = [{ type: 'enchantments', data: { levels: { sharpness: 3 } } }];
const SHARP1 = [{ type: 'enchantments', data: { levels: { sharpness: 1 } } }];

interface Drop {
  handle: string;
  entityId: number;
  stack?: Slot;
  at: { x: number; y: number; z: number };
  /** The perception label (client model), deliberately allowed to disagree with the server stack. */
  label?: string;
  key: string;
  visible?: boolean;
}

/** A recovery goal bound for `kit` lost at SITE (exact link), admitted at goal epoch 5. */
function bound(kit: Record<number, Slot>): Harness {
  const h = harness();
  h.packets.inventory(kit);
  h.packets.health(20, 20);
  dieWithItems(h, kit);
  h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  const p = (d as { proposal: SurvivalProposal }).proposal;
  assert.ok(h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-pick5', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() }) === undefined);
  return h;
}

/** Resolve context whose drops are server-announced item entities (stated stacks optional). */
function ctxWithDrops(h: Harness, drops: Drop[], hints: Partial<ResolveContext['hints']> = {}): ResolveContext {
  for (const d of drops) {
    if (d.stack) h.packets.spawnItem(d.entityId, d.stack, d.at);
    else h.packets.spawnItemWithoutStack(d.entityId, d.at);
  }
  const snap: ObservationSnapshot = snapshot({
    goalEpoch: 5,
    at: { x: 29.5, y: 64, z: 10.5 },
    drops: drops.filter((d) => d.visible !== false).map((d) => ({ handle: d.handle, key: d.key, at: d.at, distance: 1, ...(d.label ? { label: d.label } : {}) })),
  });
  const entities: Record<string, { id: number; name: string; position: { x: number; y: number; z: number } }> = {};
  for (const d of drops) entities[String(d.entityId)] = { id: d.entityId, name: 'item', position: d.at };
  return {
    task: { objective: 'x', decisionInstruction: 'x', allowedCapabilities: ['recover_lost_items'], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' } },
    hints: { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: {}, memoryRefs: [], ...hints },
    snapshot: snap,
    session: { connectionEpoch: 1, bot: { entities } } as unknown as ResolveContext['session'],
    services: {
      perception: {
        withinTravel: () => true,
        latest: () => snap,
        resolve: (_s: string, handle: string) => {
          const d = drops.find((x) => x.handle === handle);
          return d ? { target: { kind: 'drop', entityId: d.entityId, item: d.key, count: 1 } } : { error: 'unknown_handle' };
        },
      },
    } as unknown as ResolveContext['services'],
  };
}

const recover = (h: Harness): AnySkill => survivalSkills(h.service).find((s) => s.descriptor.id === 'recover_lost_items') as AnySkill;
const offered = (r: ReturnType<AnySkill['resolve']>) => r.drafts.map((d) => (d.parameters['target'] as { handle: string }).handle);
const reasons = (r: ReturnType<AnySkill['resolve']>) => (r.unavailable ?? []).map((u) => u.reason);

describe('recovery pickup scope and identity (C3)', () => {
  it('an oversized server-stated pile is refused before movement, whatever the label says', () => {
    const h = bound({ 37: slot('bread', 1) });
    const r = recover(h).resolve(ctxWithDrops(h, [{ handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 64), at: { x: 31, y: 64, z: 11 }, label: 'x1' }]));
    assert.deepEqual(offered(r), []);
    assert.deepEqual(reasons(r), ['oversized_stack']);
  });

  it('a pile within the missing count is offered; unknown server stack facts are not', () => {
    const h = bound({ 37: slot('bread', 4) });
    const r = recover(h).resolve(
      ctxWithDrops(h, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 4), at: { x: 31, y: 64, z: 11 } },
        { handle: 'drp-2', entityId: 901, key: 'minecraft:bread', at: { x: 27, y: 64, z: 6 } },
      ]),
    );
    assert.deepEqual(offered(r), ['drp-1']);
    assert.ok(reasons(r).includes('stack_facts_unknown'));
  });

  it('named-target scope: only the named handle is eligible; a stale name admits nothing', () => {
    const h = bound({ 37: slot('bread', 4), 9: slot('cobblestone', 20) });
    const drops: Drop[] = [
      { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 4), at: { x: 31, y: 64, z: 14 } },
      { handle: 'drp-2', entityId: 901, key: 'minecraft:cobblestone', stack: slot('cobblestone', 20), at: { x: 27, y: 64, z: 6 } },
    ];
    const named = recover(h).resolve(ctxWithDrops(h, drops, { handles: [{ snapshotId: 'snap-1', handle: 'drp-2' }] }));
    assert.deepEqual(offered(named), ['drp-2']);
    const stale = recover(h).resolve(ctxWithDrops(h, [], { handles: [{ snapshotId: 'snap-old', handle: 'drp-9' }] }));
    assert.deepEqual(offered(stale), []);
    assert.match(reasons(stale)[0] ?? '', /^named_target_/);
  });

  it('unrelated loot within pickup range refuses the target (visible or not); acceptable own neighbours are fine', () => {
    const h = bound({ 37: slot('bread', 4), 9: slot('cobblestone', 20) });
    const withDirt = recover(h).resolve(
      ctxWithDrops(h, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 4), at: { x: 31, y: 64, z: 11 } },
        { handle: 'drp-2', entityId: 901, key: 'minecraft:dirt', stack: slot('dirt', 3), at: { x: 31.8, y: 64, z: 11.4 } },
      ]),
    );
    assert.deepEqual(offered(withDirt), []);
    assert.ok(reasons(withDirt).includes('unrelated_loot_nearby'));
    const h2 = bound({ 37: slot('bread', 4), 9: slot('cobblestone', 20) });
    const hidden = recover(h2).resolve(
      ctxWithDrops(h2, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 4), at: { x: 31, y: 64, z: 11 } },
        { handle: 'drp-x', entityId: 905, key: 'minecraft:dirt', stack: slot('dirt', 1), at: { x: 31.5, y: 64, z: 12 }, visible: false },
      ]),
    );
    assert.deepEqual(offered(hidden), [], 'an unobserved item entity within pickup range still refuses (conservative)');
    const h3 = bound({ 37: slot('bread', 4), 9: slot('cobblestone', 20) });
    const own = recover(h3).resolve(
      ctxWithDrops(h3, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 4), at: { x: 31, y: 64, z: 11 } },
        { handle: 'drp-2', entityId: 901, key: 'minecraft:cobblestone', stack: slot('cobblestone', 20), at: { x: 31.8, y: 64, z: 11.4 } },
      ]),
    );
    assert.deepEqual(offered(own).sort(), ['drp-1', 'drp-2']);
    // Two piles together exceeding the missing count are not both acceptable.
    const h4 = bound({ 37: slot('bread', 4) });
    const merged = recover(h4).resolve(
      ctxWithDrops(h4, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:bread', stack: slot('bread', 3), at: { x: 31, y: 64, z: 11 } },
        { handle: 'drp-2', entityId: 901, key: 'minecraft:bread', stack: slot('bread', 3), at: { x: 31.8, y: 64, z: 11.4 } },
      ]),
    );
    assert.deepEqual(offered(merged), []);
    assert.ok(reasons(merged).every((x) => x === 'unrelated_loot_nearby'));
  });

  it('a valuable item counts only on an exact server identity; different enchantments are a mismatch', () => {
    const h = bound({ 36: slot('diamond_sword', 1, SHARP3), 37: slot('bread', 4) });
    const r = recover(h).resolve(
      ctxWithDrops(h, [
        { handle: 'drp-1', entityId: 900, key: 'minecraft:diamond_sword', stack: slot('diamond_sword', 1, SHARP1), at: { x: 27, y: 64, z: 6 } },
        { handle: 'drp-2', entityId: 901, key: 'minecraft:diamond_sword', stack: slot('diamond_sword', 1, SHARP3), at: { x: 31, y: 64, z: 14 } },
      ]),
    );
    assert.deepEqual(offered(r), ['drp-2']);
    assert.ok(reasons(r).includes('metadata_mismatch'));
    const f = { goalId: 'goal-pick5', goalEpoch: 5, connectionEpoch: 1 };
    const wrong = h.service.dropFacts(1, 900);
    const right = h.service.dropFacts(1, 901);
    assert.equal(h.service.recordRegain(f, 'minecraft:diamond_sword', 1, 'act-1', wrong?.meta), 0, 'a different sword never counts');
    assert.equal(h.service.recordRegain(f, 'minecraft:diamond_sword', 1, 'act-2'), 0, 'no identity, no count');
    assert.equal(h.service.recordRegain(f, 'minecraft:diamond_sword', 1, 'act-3', right?.meta), 1);
    assert.equal(h.service.recordRegain(f, 'minecraft:diamond_sword', 1, 'act-4', right?.meta), 0, 'never counted twice');
  });

  it('unproven valuable identity (pre-death metadata unknown) is never collected or claimed', () => {
    const h = harness();
    // Ready seed: the library model without server component metadata.
    h.service.attachConnection(h.packets.client, { connectionEpoch: 1, selfPosition: () => ({ dimension: OW, at: { x: 0, y: 64, z: 0 } }), seed: { stacks: [{ slot: 36, key: 'minecraft:diamond_sword', count: 1, meta: { metadata: 'unknown' } }, { slot: 37, key: 'minecraft:bread', count: 4, meta: { metadata: 'unknown' } }], vitals: { health: 20, food: 20, saturation: 5 } } });
    h.packets.login();
    dieWithItems(h, {});
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
    const d = h.service.assess(assessInput(h));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    assert.equal(p?.routine, 'death_recovery');
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-pick6', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    const r = recover(h).resolve(ctxWithDrops(h, [{ handle: 'drp-1', entityId: 900, key: 'minecraft:diamond_sword', stack: slot('diamond_sword', 1, SHARP3), at: { x: 31, y: 64, z: 11 } }]));
    assert.deepEqual(offered(r), []);
    assert.deepEqual(reasons(r), ['valuable_identity_unproven']);
    assert.equal(h.service.recordRegain({ goalId: 'goal-pick6', goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:diamond_sword', 1, 'act-1', h.service.dropFacts(1, 900)?.meta), 0);
    assert.equal(h.service.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, { goalId: 'goal-pick6', goalEpoch: 5 }).status, 'unsatisfied');
  });

  it('valuable/custom stacks are preserved in food and tool selection', () => {
    const named = { key: 'minecraft:bread', count: 3, meta: { metadata: 'server_slot' as const, customName: true } };
    assert.deepEqual(safeFoods([named, { key: 'minecraft:cooked_beef', count: 1 }], registry, 10).map((f) => f.key), ['minecraft:cooked_beef']);
    const h = harness();
    h.packets.inventory({ 36: slot('bread', 2, [{ type: 'custom_name', data: 'Grandma' }]), 37: slot('bread', 5) });
    h.packets.health(20, 10);
    const d = h.service.assess(assessInput(h));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'eat', 'a key with a custom-named stack is never auto-eaten');
  });
});
