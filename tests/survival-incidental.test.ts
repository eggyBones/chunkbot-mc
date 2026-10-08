// MB-FLOW-003-C10 (offline, real SurvivalService + tracker, real
// ServerEvidence, the real go_to_death_site / recover_lost_items executors
// over a scripted fake bot). The leased trial batch002-2472442 saw bread 5 and
// cobblestone 84 on the server after a manifest of bread 4 / cobblestone 20:
// its packet log shows two set_slot gains 36-44 ms after the fresh respawn
// window sync (before any recovery action; the attempt's preparation already
// counted 5 food items) and exactly one recovery collect (cobblestone 20).
// These tests pin the corrected semantics:
//   - the loss is assessed against the FIRST full respawn sync, so a pickup
//     arriving before the health packet is never "retained";
//   - gains after that sync and before the first recovery action are reported
//     as incidental, never retained/regained;
//   - keep-inventory possessions are retained, not regained;
//   - walking to the site counts own planned drops picked up passively, stops
//     before foreign loot comes within pickup range, and reports any unplanned
//     collect as incidental (partial), never as regained.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ObservationSnapshot } from '../src/contracts/observation.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import type { AnySkill } from '../src/skills/definition.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import { OW, SESSION_OW, assessInput, cleanupRoots, dieWithItems, empty, harness, settle, slot, snapshot, type Harness, type Slot } from './survival-helpers.ts';
import { REGISTRY_26_1_2, fakeMineflayerBot, vec3, type FakeClient } from './skill-fakes.ts';

after(cleanupRoots);

const SWORD = slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: [{ id: 13, level: 3 }] } }]);
const KIT: Record<number, Slot> = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 200 }]), 37: slot('bread', 4), 38: slot('cobblestone', 20), 39: SWORD };
const SITE_BLOCK = { x: 30, y: 0, z: 10 };
const SITE = { x: 30.5, y: 0, z: 10.5 };
const GOAL = { goalId: 'goal-c10walk', goalEpoch: 5 };

function die(h: Harness, kit: Record<number, Slot> = KIT): void {
  h.packets.inventory(kit);
  h.packets.health(20, 20);
  dieWithItems(h, kit, 'death.attack.genericKill');
  h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
}

async function admit(h: Harness): Promise<SurvivalProposal> {
  await settle(h);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  const p = (d as { proposal: SurvivalProposal }).proposal;
  h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: GOAL.goalId, goalEpoch: GOAL.goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  await settle(h);
  return p;
}

const incident = (h: Harness) => h.service.status(h.clock.now()).incidents[0];

describe('respawn-time incidental effects (C10)', () => {
  it('a pickup between the respawn sync and the health packet is neither retained nor regained; later gains are incidental', async () => {
    const h = harness({ pid: 8101 });
    die(h);
    // Trial order: respawn > window_items (empty) > [pickup] > update_health > [pickup].
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
    h.packets.inventory({});
    h.packets.setSlot(36, slot('bread', 5));
    h.packets.health(20, 20);
    h.packets.setSlot(37, slot('cobblestone', 64));
    const before = incident(h);
    assert.ok(before);
    assert.deepEqual(before.retained ?? [], [], 'nothing was kept through respawn');
    assert.deepEqual(
      before.missing.map((m) => [m.key, m.lost, m.count]).sort(),
      [
        ['minecraft:bread', 4, 4],
        ['minecraft:cobblestone', 20, 20],
        ['minecraft:diamond_sword', 1, 1],
        ['minecraft:iron_pickaxe', 1, 1],
      ],
    );
    assert.deepEqual(before.incidental, [{ source: 'after_respawn_sync', key: 'minecraft:bread', count: 5 }], 'the pre-health pickup is reported, not retained');
    await admit(h);
    const after = incident(h);
    assert.deepEqual(
      after?.incidental?.map((x) => [x.key, x.count]),
      [
        ['minecraft:bread', 5],
        ['minecraft:cobblestone', 64],
      ],
      'gains before the first recovery action are incidental (reported once each)',
    );
    assert.equal(after?.regained.length, 0, 'incidental gains never count as regained');
    const lines = h.service.statusLines(h.clock.now()).join('\n');
    assert.match(lines, /incidental 69 \(not this incident's\)/);
    await h.service.close();
  });

  it('keep-inventory: the respawn sync retains the kit (no trip); a later pickup does not change the retained manifest', async () => {
    const h = harness({ pid: 8102 });
    die(h);
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    h.packets.setSlot(10, slot('bread', 3));
    const i = incident(h);
    assert.equal(i?.status, 'no_loss');
    assert.deepEqual(i?.missing, []);
    assert.deepEqual(
      (i?.retained ?? []).map((r) => [r.key, r.count]).sort(),
      [
        ['minecraft:bread', 4],
        ['minecraft:cobblestone', 20],
        ['minecraft:diamond_sword', 1],
        ['minecraft:iron_pickaxe', 1],
      ],
    );
    assert.equal(i?.regained.length, 0, 'retained possessions are never regained');
    const retainedUpdate = h.memory.updates.find((u) => (u.update as { retained?: unknown[] }).retained);
    assert.ok(retainedUpdate, 'memory receives the retained (not regained) manifest');
    assert.equal((retainedUpdate.update as { regained?: unknown[] }).regained, undefined);
    await h.service.close();
  });
});

// ------------------------------------------------------------------ travel executor scene

interface Loot {
  entityId: number;
  stack?: Slot;
  at: { x: number; y: number; z: number };
  /** Collected passively when the bot comes this close (horizontal); undefined: only by unannounced collect. */
  announce?: boolean;
}

/** go_to_death_site over a scripted bot walking from x=18 toward the site along z=10.5. */
async function walk(h: Harness, loot: Loot[], opts: { unannouncedCollect?: { entityId: number; count: number; atX: number } } = {}) {
  const client = h.packets.client as unknown as FakeClient;
  const fake = fakeMineflayerBot(client, { dimension: SESSION_OW, at: { x: 18.5, y: 0, z: 10.5 } });
  fake.fill(0, -1, 0, 40, -1, 20, 'grass_block');
  const bot = fake.bot as unknown as { entity: { position: ReturnType<typeof vec3> }; entities: Record<number, unknown>; game: { dimension: string } };
  bot.game.dimension = SESSION_OW;
  const evidence = new ServerEvidence(h.packets.client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence };
  for (const l of loot) {
    if (l.stack) h.packets.spawnItem(l.entityId, l.stack, l.at);
    else h.packets.spawnItemWithoutStack(l.entityId, l.at);
    if (l.announce !== false) bot.entities[l.entityId] = { id: l.entityId, name: 'item', position: vec3(l.at.x, l.at.y, l.at.z) };
  }
  let goal: { x: number; y: number; z: number } | undefined;
  let moving = false;
  const collected = new Set<number>();
  (fake.bot as unknown as { pathfinder: unknown }).pathfinder = { setMovements: () => undefined, isMoving: () => moving, searchRadius: -1, thinkTimeout: 0 };
  const act = {
    bot: fake.bot,
    session,
    fence: () => undefined,
    setPathGoal: (g: { x: number; y: number; z: number }) => {
      goal = { x: g.x, y: g.y, z: g.z };
      moving = true;
    },
    clearPathGoal: () => {
      moving = false;
    },
    sleep: async () => {
      const p = bot.entity.position;
      if (goal && moving) {
        const dx = goal.x + 0.5 - p.x;
        if (Math.abs(dx) <= 3.5) moving = false;
        else bot.entity.position = vec3(p.x + Math.sign(dx) * 0.4, p.y, p.z);
      }
      const q = bot.entity.position;
      // Vanilla pickup reach: bot box inflated by 1 horizontally (~1.3 from centre).
      for (const l of loot) {
        if (collected.has(l.entityId) || l.announce === false) continue;
        if (Math.hypot(l.at.x - q.x, l.at.z - q.z) <= 1.3) {
          collected.add(l.entityId);
          h.packets.client.emit('collect', { collectedEntityId: l.entityId, collectorEntityId: 42, pickupItemCount: l.stack?.itemCount ?? 1 });
          h.packets.destroy(l.entityId);
          delete bot.entities[l.entityId];
        }
      }
      const u = opts.unannouncedCollect;
      if (u && !collected.has(u.entityId) && q.x >= u.atX) {
        collected.add(u.entityId);
        h.packets.client.emit('collect', { collectedEntityId: u.entityId, collectorEntityId: 42, pickupItemCount: u.count });
      }
    },
  };
  const snap: ObservationSnapshot = snapshot({ goalEpoch: GOAL.goalEpoch, at: { x: 18.5, y: 0, z: 10.5 } });
  const ledger: Array<{ item: string; count: number }> = [];
  const ctx = {
    act,
    session,
    services: {
      perception: { latest: () => snap, withinTravel: () => true, travelBounds: () => undefined, recordVisited: () => undefined },
      limits: { travelRadius: 128 },
      ledger: { add: (e: { item: string; count: number }) => ledger.push(e) },
    },
    candidate: { id: 'act-c10-walk', timeoutMs: 20_000 },
    owner: { kind: 'goal', goalId: GOAL.goalId, goalEpoch: GOAL.goalEpoch, taskId: 'task-c10' },
    progress: () => undefined,
  };
  const skill = survivalSkills(h.service).find((s) => s.descriptor.id === 'go_to_death_site') as AnySkill;
  const outcome = await skill.execute(ctx as never, {} as never);
  evidence.detach?.();
  return { outcome, collected, ledger, at: bot.entity.position };
}

async function boundWalker(pid: number): Promise<Harness> {
  const h = harness({ pid });
  die(h);
  h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
  h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
  h.packets.inventory({});
  h.packets.health(20, 20);
  h.pos.at = { x: 18.5, y: 0, z: 10.5 };
  h.snap.value = snapshot({ at: h.pos.at });
  await admit(h);
  return h;
}

describe('passive pickup while walking to the death site (C10)', () => {
  it('an own planned drop collected on the way counts as regained (server collect packet)', async () => {
    const h = await boundWalker(8201);
    const r = await walk(h, [{ entityId: 900, stack: slot('cobblestone', 20), at: { x: 24.5, y: 0, z: 10.5 } }]);
    assert.equal(r.outcome.status, 'succeeded', JSON.stringify(r.outcome));
    assert.equal(r.outcome.evidence?.['countedRegained'], 20);
    assert.ok(r.collected.has(900));
    const i = incident(h);
    assert.equal(i?.regained.reduce((n, x) => n + x.count, 0), 20);
    assert.equal(i?.missing.find((m) => m.key === 'minecraft:cobblestone'), undefined, 'cobblestone fully regained');
    assert.deepEqual(i?.incidental ?? [], []);
    await settle(h);
    assert.equal(h.events.filter((e) => e['type'] === 'survival_write_failed').length, 0);
    await h.service.close();
  });

  it('foreign loot on the route stops the walk BEFORE pickup range (never walked over); far from the site it is a blocker', async () => {
    const h = await boundWalker(8202);
    const r = await walk(h, [{ entityId: 901, stack: slot('dirt', 3), at: { x: 23.5, y: 0, z: 10.5 } }]);
    assert.equal(r.outcome.status, 'failed');
    assert.equal(r.outcome.reason, 'unrelated_loot_on_route');
    assert.equal(r.collected.has(901), false, 'the foreign dirt was not collected');
    assert.ok(Math.abs(r.at.x - 23.5) > 1.3, `stopped outside pickup reach (at x=${r.at.x})`);
    assert.equal(incident(h)?.regained.length, 0);
    await h.service.close();
  });

  it('an oversized own-key pile near the site stops short at the site (search continues from there), not collected', async () => {
    const h = await boundWalker(8203);
    const r = await walk(h, [{ entityId: 902, stack: slot('bread', 64), at: { x: 28.5, y: 0, z: 10.5 } }]);
    assert.equal(r.outcome.status, 'succeeded', JSON.stringify(r.outcome));
    assert.match(r.outcome.effect, /stopped .* not this incident's is within pickup range/);
    assert.equal(r.collected.has(902), false);
    await h.service.close();
  });

  it('an unplanned collect (entity never announced) is reported as incidental, never regained', async () => {
    const h = await boundWalker(8204);
    const r = await walk(h, [], { unannouncedCollect: { entityId: 903, count: 7, atX: 22 } });
    assert.equal(r.outcome.status, 'partial');
    assert.equal(r.outcome.reason, 'incidental_pickup');
    const i = incident(h);
    assert.equal(i?.regained.length, 0);
    assert.deepEqual(i?.incidental?.map((x) => [x.source, x.count]), [['unplanned_collect', 7]]);
    await h.service.close();
  });
});

describe('manifest item states stay distinct (C10)', () => {
  it('full, partial, unknown and retained are different labels; a concluded remainder is unknown, not regained', async () => {
    const h = harness({ pid: 8301 });
    die(h, { 36: slot('iron_pickaxe'), 37: slot('bread', 4), 38: slot('cobblestone', 20), 39: slot('oak_log', 3) });
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
    h.packets.inventory({ 40: slot('oak_log', 3) });
    h.packets.health(20, 20);
    const p = await admit(h);
    const owner = { ...GOAL, connectionEpoch: 1 };
    assert.equal(h.service.recordRegain(owner, 'minecraft:cobblestone', 20, 'a1'), 20);
    assert.equal(h.service.recordRegain(owner, 'minecraft:bread', 1, 'a2'), 1);
    h.service.abandonRecovery('owner redirected', h.clock.now());
    await settle(h);
    const i = incident(h);
    assert.equal(i?.status, 'abandoned');
    const byKey = Object.fromEntries((i?.missing ?? []).map((m) => [m.key, [m.state, m.lost, m.regained, m.count]]));
    assert.deepEqual(byKey['minecraft:bread'], ['unknown', 4, 1, 3]);
    assert.deepEqual(byKey['minecraft:iron_pickaxe'], ['unknown', 1, 0, 1]);
    assert.equal(byKey['minecraft:cobblestone'], undefined, 'fully regained is not missing');
    assert.deepEqual(i?.retained, [{ key: 'minecraft:oak_log', count: 3 }]);
    void p;
    void empty;
    await h.service.close();
  });
});
