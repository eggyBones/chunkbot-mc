// MB-FLOW-003-C12 (offline, inference-free): S implementation of the approved
// ContinuationSurvivalPort (src/contracts/continuation.ts, P 4409ba1) on the
// real SurvivalService + tracker + store:
//   - frozenInventory: packet-frozen last-alive counts of the latest own death
//     on THIS connection (server packets only), incident id = capture id;
//   - incidentReturns: server-attributed regained (recovery AND later ordinary
//     collectors) and retained, per key; anything unplaceable -> `unknown`;
//     C10 incidental gains, foreign identities, orbs never become returns;
//   - continuationGate: necessary recovery/support first, finite;
//   - persistCheckpoint: display-only bounded projection; restart shows
//     `restart_held`, never anything executable.
// Works without a durable store (memory/survival scope absent).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import type { ContinuationCheckpoint } from '../src/contracts/continuation.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { survivalScopeDirectory } from '../src/survival/store.ts';
import { continuationPort } from '../src/survival/wiring.ts';
import { NETHER, OW, Packets, SESSION_OW, assessInput, cleanupRoots, dieWithItems, harness, settle, slot, snapshot, type Harness, type Slot } from './survival-helpers.ts';

after(cleanupRoots);

const SITE_BLOCK = { x: 30, y: 64, z: 10 };
const NEAR = { x: 31, y: 64, z: 11 };
const FAR = { x: 80, y: 64, z: 80 };
const SWORD = slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: [{ id: 13, level: 3 }] } }]);
const KIT: Record<number, Slot> = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 200 }]), 37: slot('bread', 4), 38: slot('cobblestone', 20), 39: SWORD };

function dieAndRespawn(h: Harness, kit: Record<number, Slot> = KIT, keep: Record<number, Slot> = {}): string {
  h.packets.inventory(kit);
  h.packets.health(20, 20);
  dieWithItems(h, kit, 'death.attack.genericKill');
  const captureId = h.service.deathContext().captureId as string;
  h.service.linkIncident(captureId, 'mf-0001');
  h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
  h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
  h.packets.inventory(keep);
  h.packets.health(20, 20);
  return captureId;
}

const returns = (h: Harness, id: string) => h.service.incidentReturns(id);

describe('ContinuationSurvivalPort: frozenInventory', () => {
  it('returns the packet-frozen last-alive counts of the latest own death on this connection only (also without a durable store)', () => {
    for (const scoped of [true, false]) {
      const h = harness({ scoped, pid: 9001 });
      const id = dieAndRespawn(h);
      const f = h.service.frozenInventory(1);
      assert.deepEqual(f, { incidentId: id, counts: { 'minecraft:iron_pickaxe': 1, 'minecraft:bread': 4, 'minecraft:cobblestone': 20, 'minecraft:diamond_sword': 1 }, evidence: 'last_alive_server_packets' }, `scoped=${scoped}`);
      assert.equal(h.service.frozenInventory(2), null, 'another connection has no frozen inventory');
    }
  });

  it('no death yet -> null; a ready-seed (library model) last-alive copy is not server evidence -> null', () => {
    const h = harness({ pid: 9002 });
    assert.equal(h.service.frozenInventory(1), null);
    const seeded = harness({ pid: 9003 });
    seeded.service.attachConnection(seeded.packets.client, { connectionEpoch: 1, selfPosition: () => ({ dimension: SESSION_OW, at: { x: 0, y: 64, z: 0 } }), seed: { stacks: [{ slot: 36, key: 'minecraft:bread', count: 3, meta: { metadata: 'unknown' } }], vitals: { health: 20, food: 20, saturation: 5 } } });
    seeded.packets.login();
    seeded.packets.health(0, 20);
    seeded.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
    assert.equal(seeded.service.frozenInventory(1), null);
  });
});

describe('ContinuationSurvivalPort: incidentReturns', () => {
  it('awaiting the fresh respawn sync -> unknown; after it: retained vs regained stay distinct', () => {
    const h = harness({ pid: 9010 });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    const id = h.service.deathContext().captureId as string;
    assert.equal(returns(h, id)?.attribution, 'unknown', 'no respawn sync yet');
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.packets.inventory({ 37: slot('bread', 4) }); // bread kept through respawn
    h.packets.health(20, 20);
    assert.deepEqual(returns(h, id), { incidentId: id, connectionEpoch: 1, regained: {}, retained: { 'minecraft:bread': 4 }, attribution: 'server_attributed' });
    assert.equal(h.service.incidentReturns('dcap-9-9'), null, 'unknown incident id');
  });

  it('recovery regains (C3-planned) and a LATER ordinary collector of an own drop both count as regained, bounded by the loss', async () => {
    const h = harness({ pid: 9011 });
    const id = dieAndRespawn(h);
    await settle(h);
    const d = h.service.assess(assessInput(h));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-c12rec', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    await settle(h);
    assert.equal(h.service.recordRegain({ goalId: 'goal-c12rec', goalEpoch: 5, connectionEpoch: 1 }, 'minecraft:cobblestone', 20, 'act-1'), 20);
    h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: 'goal-c12rec', goalEpoch: 5, state: 'blocked', reason: 'no_progress', detail: 'x', counters: { plannerTurns: 1, tasksAdmitted: 1, replans: 0 }, endedAtMs: h.clock.now() });
    // Later, an ordinary owner job walks near the site and collects the own bread passively.
    h.packets.spawnItem(700, slot('bread', 4), NEAR);
    h.packets.collect(700, 4);
    h.packets.destroy(700);
    assert.deepEqual(returns(h, id)?.regained, { 'minecraft:cobblestone': 20, 'minecraft:bread': 4 });
    assert.equal(returns(h, id)?.attribution, 'server_attributed');
    assert.ok(h.events.some((e) => e['type'] === 'survival_incident_return' && e['key'] === 'minecraft:bread'));
    // The same identity again (all 4 already returned) is not a return of this incident.
    h.packets.spawnItem(701, slot('bread', 2), NEAR);
    h.packets.collect(701, 2);
    assert.deepEqual(returns(h, id)?.regained, { 'minecraft:cobblestone': 20, 'minecraft:bread': 4 }, 'never above the loss');
  });

  it('valuable identity: only the exact lost component digest returns; another enchantment is foreign', () => {
    const h = harness({ pid: 9012 });
    const id = dieAndRespawn(h);
    h.packets.spawnItem(710, slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: [{ id: 13, level: 1 }] } }]), NEAR);
    h.packets.collect(710, 1);
    assert.deepEqual(returns(h, id)?.regained, {}, 'different identity is not this incident\'s sword');
    assert.equal(returns(h, id)?.attribution, 'server_attributed');
    h.packets.spawnItem(711, SWORD, NEAR);
    h.packets.collect(711, 1);
    assert.deepEqual(returns(h, id)?.regained, { 'minecraft:diamond_sword': 1 });
  });

  it('unplaceable collects make attribution UNKNOWN (never a regain): oversized pile, stack never stated near the site', () => {
    const big = harness({ pid: 9013 });
    const idBig = dieAndRespawn(big);
    big.packets.spawnItem(720, slot('cobblestone', 64), NEAR); // larger than the 20 lost: merged or foreign
    big.packets.collect(720, 64);
    assert.deepEqual(returns(big, idBig), { incidentId: idBig, connectionEpoch: 1, regained: {}, retained: {}, attribution: 'unknown' });
    const unstated = harness({ pid: 9014 });
    const idU = dieAndRespawn(unstated);
    unstated.packets.spawnItemWithoutStack(721, NEAR);
    unstated.packets.collect(721, 3);
    assert.equal(returns(unstated, idU)?.attribution, 'unknown');
    assert.deepEqual(returns(unstated, idU)?.regained, {});
  });

  it('S-C12-R3: actual own collect packets preserve exact returns, hold unknown entities, and ignore known non-items, with or without memory', async () => {
    for (const scoped of [false, true]) {
      for (const mode of ['own_item', 'unknown_entity', 'unstated_item', 'non_item'] as const) {
        const h = harness({ scoped });
        const id = dieAndRespawn(h, { 36: slot('bread', 4) });
        const port = continuationPort(h.service)!;
        const empty = { incidentId: id, connectionEpoch: 1, regained: {}, retained: {}, attribution: 'server_attributed' };
        assert.deepEqual(port.incidentReturns(id), empty);
        if (mode === 'own_item') h.packets.spawnItem(740, slot('bread', 4), NEAR);
        if (mode === 'unstated_item') h.packets.spawnItemWithoutStack(740, NEAR);
        if (mode === 'non_item') h.packets.spawnOther(740, NEAR);
        h.packets.collect(740, 4);
        h.packets.destroy(740);
        // A later full inventory sync is current possession, never proof of where a collect came from.
        h.packets.inventory({ 36: slot('bread', 4) });
        const unknown = mode === 'unknown_entity' || mode === 'unstated_item';
        assert.deepEqual(port.incidentReturns(id), {
          ...empty,
          regained: mode === 'own_item' ? { 'minecraft:bread': 4 } : {},
          attribution: unknown ? 'unknown' : 'server_attributed',
        }, `${mode}, scoped=${scoped}`);
        assert.deepEqual(port.frozenInventory(1)?.counts, { 'minecraft:bread': 4 }, 'original loss evidence is unchanged');
        assert.equal(h.events.filter((e) => e['type'] === 'survival_incident_attribution_unknown').length, unknown ? 1 : 0);
        assert.equal(h.events.filter((e) => e['type'] === 'survival_incident_return').length, mode === 'own_item' ? 1 : 0);
        await h.service.close();
      }
    }
  });

  it('S-C12-R3: an unknown own collect preserves verified partial returns; another collector cannot taint the incident', async () => {
    const h = harness({ scoped: false });
    const id = dieAndRespawn(h, { 36: slot('bread', 4) });
    h.packets.collect(750, 3, 99);
    assert.equal(returns(h, id)?.attribution, 'server_attributed');
    h.packets.spawnItem(751, slot('bread', 1), NEAR);
    h.packets.collect(751, 1);
    assert.deepEqual(returns(h, id)?.regained, { 'minecraft:bread': 1 });
    h.packets.collect(752, 3);
    assert.deepEqual(returns(h, id), { incidentId: id, connectionEpoch: 1, regained: { 'minecraft:bread': 1 }, retained: {}, attribution: 'unknown' });
    await h.service.close();
  });

  it('C12: a collect after the first respawn sync but before positive health cannot escape return attribution', async () => {
    for (const mode of ['own_item', 'unknown_entity', 'unstated_item', 'non_item'] as const) {
      const h = harness({ scoped: false });
      const kit = { 36: slot('bread', 4) };
      h.packets.inventory(kit);
      h.packets.health(20, 20);
      dieWithItems(h, kit);
      const id = h.service.frozenInventory(1)!.incidentId;
      h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
      h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
      h.packets.inventory({});
      if (mode === 'own_item') h.packets.spawnItem(760, slot('bread', 4), NEAR);
      if (mode === 'unstated_item') h.packets.spawnItemWithoutStack(760, NEAR);
      if (mode === 'non_item') h.packets.spawnOther(760, NEAR);
      h.packets.collect(760, 4);
      h.packets.inventory(kit);
      assert.equal(h.service.continuationGate(h.clock.now()).kind, 'wait', 'accounting is read-only; fresh positive health still gates continuation');
      h.packets.health(20, 20);
      assert.deepEqual(returns(h, id), {
        incidentId: id, connectionEpoch: 1,
        retained: {},
        regained: mode === 'own_item' ? { 'minecraft:bread': 4 } : {},
        attribution: mode === 'unknown_entity' || mode === 'unstated_item' ? 'unknown' : 'server_attributed',
      }, mode);
      await h.service.close();
    }
  });

  it('never a return: C10 incidental gains (respawn-point pickups), items outside the site radius, other connections, other collectors, orbs', () => {
    const h = harness({ pid: 9015 });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    const id = h.service.deathContext().captureId as string;
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.packets.inventory({});
    h.packets.setSlot(36, slot('bread', 5)); // respawn-point gain: no collect packet at all
    h.packets.health(20, 20);
    h.packets.spawnItem(730, slot('cobblestone', 20), FAR); // same identity, far from the site
    h.packets.collect(730, 20);
    h.packets.spawnItem(731, slot('bread', 4), NEAR);
    h.packets.collect(731, 4, 99); // another player collected it
    h.packets.spawnOther(732, NEAR); // experience orb
    h.packets.collect(732, 1);
    assert.deepEqual(returns(h, id), { incidentId: id, connectionEpoch: 1, regained: {}, retained: {}, attribution: 'server_attributed' });
  });

  it('a related death whose SERVER site is near the original site: both incidents become unknown (no per-incident split)', () => {
    const h = harness({ pid: 9016 });
    const first = dieAndRespawn(h);
    const second = dieAndRespawn(h, { 36: slot('bread', 2) });
    assert.notEqual(first, second);
    assert.equal(returns(h, second)?.attribution, 'unknown');
    assert.equal(returns(h, first)?.attribution, 'unknown');
    assert.equal(h.service.frozenInventory(1)?.incidentId, second, 'the latest death is the frozen one');
  });

  it('a related death away from the original site keeps the original attributable; the related losses are its own (unknown: merged accounting)', () => {
    const h = harness({ pid: 9018 });
    const first = dieAndRespawn(h);
    h.packets.inventory({ 36: slot('bread', 2) });
    h.packets.health(20, 20);
    dieWithItems(h, { 36: slot('bread', 2) });
    const second = h.service.deathContext().captureId as string;
    h.packets.respawn({ dimensionName: OW, location: { x: 90, y: 64, z: 90 } });
    h.packets.inventory({});
    h.packets.health(20, 20);
    assert.equal(returns(h, first)?.attribution, 'server_attributed');
    assert.equal(returns(h, second)?.attribution, 'unknown');
  });

  it('survival disabled: the optional port answers nothing (P holds lossy count atoms for provenance)', () => {
    const h = harness({ pid: 9017, config: { enabled: false } });
    assert.equal(h.service.frozenInventory(1), null);
    assert.equal(h.service.incidentReturns('dcap-1-1'), null);
    assert.deepEqual(h.service.continuationGate(h.clock.now()), { kind: 'clear' });
  });
});

describe('ContinuationSurvivalPort: continuationGate (necessary recovery/support first, finite)', () => {
  it('C12: initial attachment, ended connection and replacement seed cannot clear the gate without current server state', async () => {
    const h = harness({ scoped: false });
    const port = continuationPort(h.service)!;
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'attachment alone is not readiness');
    h.packets.health(20, 20);
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'health alone is not a full inventory sync');
    h.packets.inventory({});
    assert.deepEqual(port.continuationGate(h.clock.now()), { kind: 'clear' });
    h.service.onLifecycle({ type: 'ended', connectionEpoch: 1, reason: 'operator_stop', detail: 'test logout' });
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'detached old state is historical');
    h.packets.inventory({});
    h.packets.health(20, 20);
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'the old source has no listeners');
    const current = new Packets();
    h.service.attachConnection(current.client, {
      connectionEpoch: 2, selfPosition: () => h.pos,
      seed: { stacks: [], vitals: { health: 20, food: 20, saturation: 5 } },
    });
    current.login();
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'library seed cannot replace current server synchronization');
    current.inventory({});
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'seeded health is not the replacement connection\'s health packet');
    current.health(20, 20);
    assert.deepEqual(port.continuationGate(h.clock.now()), { kind: 'clear' });
    await h.service.close();
    assert.equal(port.continuationGate(h.clock.now()).kind, 'wait', 'closing the service detaches readiness');
  });

  it('C12: a lifecycle death without a zero-health packet still requires health after respawn', async () => {
    const h = harness({ scoped: false });
    h.packets.inventory({});
    h.packets.health(20, 20);
    h.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
    h.packets.inventory({});
    assert.equal((h.service.continuationGate(h.clock.now()) as { reason?: string }).reason, 'not_alive', 'last-alive health cannot serve as post-respawn health');
    h.packets.health(20, 20);
    assert.deepEqual(h.service.continuationGate(h.clock.now()), { kind: 'clear' });
    await h.service.close();
  });

  it('not alive -> wait; open recovery -> wait; running support -> wait; low health -> wait; none -> clear', async () => {
    const h = harness({ pid: 9020 });
    h.packets.health(20, 20);
    h.packets.inventory({ 36: slot('bread', 4) });
    assert.deepEqual(h.service.continuationGate(h.clock.now()), { kind: 'clear' });
    h.packets.inventory(KIT);
    dieWithItems(h, KIT);
    assert.equal((h.service.continuationGate(h.clock.now()) as { reason?: string }).reason, 'not_alive');
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    h.packets.respawn({ dimensionName: OW, location: SITE_BLOCK });
    h.packets.inventory({});
    h.packets.health(20, 20);
    await settle(h);
    assert.equal((h.service.continuationGate(h.clock.now()) as { reason?: string }).reason, 'recovery_open');
    const d = h.service.assess(assessInput(h));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-c12gate', goalEpoch: 6, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    assert.equal((h.service.continuationGate(h.clock.now()) as { reason?: string }).reason, 'recovery_open', 'the recovery support goal runs');
    h.service.abandonRecovery('owner redirected', h.clock.now());
    h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: 'goal-c12gate', goalEpoch: 6, state: 'cancelled', reason: 'replaced', detail: 'x', counters: { plannerTurns: 0, tasksAdmitted: 0, replans: 0 }, endedAtMs: h.clock.now() });
    assert.deepEqual(h.service.continuationGate(h.clock.now()), { kind: 'clear' }, 'concluded recovery no longer holds continuation');
    h.packets.health(6, 20);
    assert.equal((h.service.continuationGate(h.clock.now()) as { reason?: string }).reason, 'support_running', 'necessary eat/rest first');
  });

  it('a recovery blocked by a non-transient condition it cannot clear (other dimension) does not hold continuation forever', async () => {
    const h = harness({ pid: 9021 });
    h.packets.inventory(KIT);
    h.packets.health(20, 20);
    dieWithItems(h, KIT);
    h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
    h.packets.respawn({ dimensionName: NETHER, location: SITE_BLOCK });
    h.packets.inventory({});
    h.packets.health(20, 20);
    await settle(h);
    h.service.assess(assessInput(h, { connection: { ready: true, connectionEpoch: 1, dimension: 'overworld' }, snapshot: snapshot() }));
    assert.deepEqual(h.service.status(h.clock.now()).blocked.filter((b) => b.routine === 'death_recovery').map((b) => b.reason), ['cross_dimension'], 'recovery cannot act (non-transient)');
    assert.deepEqual(h.service.continuationGate(h.clock.now()), { kind: 'clear' });
  });
});

const checkpoint = (over: Partial<ContinuationCheckpoint> = {}): ContinuationCheckpoint => ({
  version: 1,
  goalId: 'goal-own1job',
  sessionId: 'run-aaaa',
  connectionEpoch: 1,
  dimension: SESSION_OW,
  instruction: 'collect 10 oak logs',
  publicOutcome: '10 more oak logs',
  outcome: { kind: 'finite', outcome: { predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 10, mayBeConsumedLater: false } },
  outcomeCanonical: 'inventory_delta(minecraft:oak_log,10)',
  admissionBaseline: { capturedAtMs: 1, counts: { 'minecraft:oak_log': 8 }, detail: 'server' },
  anchor: { dimension: SESSION_OW, at: { x: 1, y: 64, z: 2 }, radius: 128 },
  counters: { plannerTurns: 3, knowledgeRounds: 0, repairs: 0, retries: 0, clarifications: 0, replans: 1, windows: 2, tasksAdmitted: 4, preparationTurns: 0, lookaheads: 0 } as ContinuationCheckpoint['counters'],
  caps: { plannerTurns: 20, tasks: 64, replans: 8 },
  admittedTasks: 4,
  deadlineAtMs: 9_999_999,
  grounding: [{ path: 'root', predicate: 'inventory_delta', status: 'groundable' }],
  counts: [],
  removal: [],
  route: null,
  verifiedEffects: ['collected 4 oak_log'],
  continuations: { used: 0, max: 2 },
  interruptions: [{ reason: 'death', atMs: 5, epoch: 3 }],
  state: 'held',
  stateReason: 'waiting:recovery_open',
  stateAtMs: 6,
  ...over,
});

describe('ContinuationSurvivalPort: persistCheckpoint (display only)', () => {
  it('stores a bounded projection without executable data; a restart shows it as restart_held; the same session keeps its state', async () => {
    const h = harness({ pid: 9030, sessionId: 'run-aaaa' });
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(1_000);
      h.service.persistCheckpoint(checkpoint({ goalId: `goal-own${i}job` }));
    }
    h.service.persistCheckpoint(checkpoint());
    await settle(h);
    const st = h.service.status(h.clock.now());
    assert.equal(st.checkpoints?.length, 4, 'bounded to the newest 4');
    assert.equal(st.checkpoints?.[0]?.state, 'held', 'same application session keeps its state');
    const dir = survivalScopeDirectory(h.root, { worldProfile: 'test-world', worldRevision: 1, botProfile: 'chunkbot' });
    const file = readdirSync(dir).filter((n) => /^survival-\d{8}\.json$/.test(n)).sort().at(-1) as string;
    const raw = readFileSync(`${dir}/${file}`, 'utf8');
    for (const forbidden of ['"outcome"', 'outcomeCanonical', '"route"', '"counts"', '"grounding"', '"anchor"', '"epoch"', 'inventory_delta']) assert.ok(!raw.includes(forbidden), `nothing executable stored (${forbidden})`);
    await h.service.close();
    const restarted = harness({ root: h.root, pid: 9031, sessionId: 'run-bbbb' });
    const st2 = restarted.service.status(restarted.clock.now());
    assert.ok(st2.checkpoints?.length && st2.checkpoints.every((c) => c.state === 'restart_held'), 'another session only displays them');
    assert.match(st2.checkpoints?.[0]?.stateReason ?? '', /another application session .* never continued/);
    await restarted.service.close();
  });

  it('without a durable store persistence is a no-op (P keeps the in-memory checkpoint)', () => {
    const h = harness({ scoped: false, pid: 9032 });
    h.service.persistCheckpoint(checkpoint());
    assert.equal(h.service.status(h.clock.now()).checkpoints, undefined);
  });
});
