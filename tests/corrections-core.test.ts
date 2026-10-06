// Maintained regressions for coordinator corrections MB-SKL-001..004
// (knowledge scope, opaque fluids, owner identity, interface ownership). Each
// case exercises the real module with positive and negative inputs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { systemClock, type ExecutionOwner } from '../src/contracts/index.ts';
import { Actuator, InterfaceBusyError } from '../src/execution/actuator.ts';
import { INTERFACE_UNRESOLVED_MS, interfaceGate } from '../src/execution/interface-gate.ts';
import { ActuatorLeases, LeaseRevokedError } from '../src/execution/lease.ts';
import type { GameSession } from '../src/game/connection.ts';
import { isOwnerPlayer, offlinePlayerUuid, type OwnerPolicy } from '../src/game/identity.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { isBlockVisible, lineOfSight } from '../src/perception/visibility.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { tick } from './helpers.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, flatWorld, type FakeClient } from './skill-fakes.ts';

describe('MB-SKL-001 knowledge is scoped to verified mechanics', () => {
  it('answers recipes/fuels for exact 26.1.2 and reports other protocol-775 patches unavailable', () => {
    const exact = new VersionKnowledge({ version: '26.1.2' });
    assert.equal(exact.answerOne({ kind: 'recipe', output: 'minecraft:wooden_pickaxe' }).status, 'known');
    assert.equal(exact.answerOne({ kind: 'fuel', item: 'minecraft:oak_planks' }).status, 'known');
    for (const version of ['26.1.1', '26.1']) {
      const k = new VersionKnowledge({ version });
      const recipe = k.answerOne({ kind: 'recipe', output: 'minecraft:wooden_pickaxe' });
      assert.equal(recipe.status, 'unavailable', `${version} must not inherit 26.1.2 recipes`);
      assert.match(JSON.stringify(recipe), /26\.1\.2/, 'the limitation names the verified dataset');
      assert.equal(k.answerOne({ kind: 'fuel', item: 'minecraft:oak_planks' }).status, 'unavailable');
      assert.equal(k.recipes, undefined);
      const readiness = k.readiness();
      assert.equal(readiness.ready, true, 'items/blocks/harvest stay available (protocol compatibility)');
      assert.match(readiness.detail, /unavailable for 26\.1(\.1)?/, 'operator text says mechanics are unavailable for this release');
    }
    assert.match(exact.readiness().detail, /used only for exactly 26\.1\.2/);
  });
});

describe('MB-SKL-002 opaque fluids stop line of sight', () => {
  const EYE = { x: 0.5, y: 1.62, z: 0.5 };
  it('a lava source between the eye and a target hides it; water does not', () => {
    const lava = flatWorld(20);
    lava.setFluid(0, 1, 3, 'lava', 0);
    lava.set(0, 1, 6, 'gold_block');
    assert.equal(isBlockVisible(lava, EYE, 0, 1, 6), false, 'hidden behind lava');
    const water = flatWorld(20);
    water.setFluid(0, 1, 3, 'water', 0);
    water.set(0, 1, 6, 'gold_block');
    assert.equal(isBlockVisible(water, EYE, 0, 1, 6), true, 'visible through water');
  });

  it('flowing lava occludes only up to its fluid height; powder snow is opaque', () => {
    const w = flatWorld(20);
    w.setFluid(0, 0, 3, 'lava', 6); // level 6: fluid height (8-6)/9 of the block
    assert.equal(lineOfSight(w, EYE, { x: 0.5, y: 0.9, z: 6.5 }), true, 'ray above the thin flowing lava');
    assert.equal(lineOfSight(w, { x: 0.5, y: 0.1, z: 0.5 }, { x: 0.5, y: 0.1, z: 6.5 }), false, 'ray through the fluid layer');
    const snow = flatWorld(20);
    snow.set(0, 1, 3, 'powder_snow', []);
    snow.set(0, 1, 6, 'gold_block');
    assert.equal(isBlockVisible(snow, EYE, 0, 1, 6), false);
  });
});

describe('MB-SKL-003 owner identity follows the admitted policy', () => {
  const uuidPolicy: OwnerPolicy = { mode: 'uuid', ownerUuid: '11111111-2222-3333-4444-555555555555', requireSignedChat: false };
  const offline: OwnerPolicy = { mode: 'offline_name', ownerName: 'FixtureOwner' };

  it('UUID mode: matching UUID on a verified online server only; never a name override', () => {
    const online = { serverOnlineMode: true };
    assert.equal(isOwnerPlayer(uuidPolicy, { username: 'Anyone', uuid: '11111111222233334444555555555555' }, online), true);
    assert.equal(isOwnerPlayer(uuidPolicy, { username: 'Anyone', uuid: '11111111-2222-3333-4444-555555555555' }, { serverOnlineMode: false }), false, 'unverified online mode');
    assert.equal(isOwnerPlayer(uuidPolicy, { username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner') }, online), false, 'name does not override UUID');
  });

  it('offline mode: exact name AND derived offline UUID', () => {
    const ctx = { serverOnlineMode: false };
    assert.equal(isOwnerPlayer(offline, { username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner') }, ctx), true);
    assert.equal(isOwnerPlayer(offline, { username: 'fixtureowner', uuid: offlinePlayerUuid('fixtureowner') }, ctx), false, 'case differs');
    assert.equal(isOwnerPlayer(offline, { username: 'FixtureOwner', uuid: '99999999-2222-3333-4444-555555555555' }, ctx), false, 'wrong UUID');
    assert.equal(isOwnerPlayer(offline, { username: 'FixtureOwner' }, ctx), false, 'no UUID');
  });

  it('perception labels only the admitted owner (both modes) and never another player', () => {
    for (const [policy, online, ownerUuid] of [
      [offline, false, offlinePlayerUuid('FixtureOwner')],
      [uuidPolicy, true, '11111111-2222-3333-4444-555555555555'],
    ] as const) {
      const client = fakeClient();
      const fake = fakeMineflayerBot(client);
      fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
      const session = { bot: fake.bot, connectionEpoch: 1, evidence: evidenceFor(client) } as unknown as GameSession;
      const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 16, travelRadius: 64, ownerPolicy: policy, admission: () => ({ serverOnlineMode: online }) });
      fake.addEntity({ id: 2, type: 'player', name: 'player', username: 'FixtureOwner', uuid: ownerUuid, at: { x: 3.5, y: 0, z: 0.5 }, height: 1.8 });
      fake.addEntity({ id: 3, type: 'player', name: 'player', username: 'fixtureowner', uuid: '99999999-2222-3333-4444-555555555555', at: { x: -3.5, y: 0, z: 0.5 }, height: 1.8 });
      const snap = perception.take(1);
      assert.ok(snap);
      const labels = snap.entities.map((e) => e.label);
      assert.deepEqual(labels.sort(), ['owner', 'player'], `${policy.mode}: exactly one owner`);
      assert.equal(snap.owner.visible, true);
      assert.equal(snap.owner.at?.x, 3.5, 'the owner is the admitted identity, not the look-alike');
    }
  });
});

// ---------------------------------------------------------------------------
// MB-SKL-004: interface ownership through the real Actuator + InterfaceGate.

function gateSession(client: FakeClient): GameSession {
  const slots: unknown[] = new Array(46).fill(null);
  const bot = {
    _client: client,
    registry: (fakeMineflayerBot(client).bot as { registry: unknown }).registry,
    currentWindow: null as { id: number } | null,
    inventory: { id: 0, slots, selectedItem: null, inventoryStart: 9, inventoryEnd: 45 },
    entity: { position: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 } },
    lookAt: () => Promise.resolve(),
    setControlState: () => undefined,
    closeWindow(w: { id: number }) {
      client.write('close_window', { windowId: w.id });
      if (bot.currentWindow?.id === w.id) bot.currentWindow = null;
    },
  };
  return { bot: bot as unknown as GameSession['bot'], connectionEpoch: 1, evidence: evidenceFor(client) };
}

function leasesFor() {
  return new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
}
const diag = (id: string): ExecutionOwner => ({ kind: 'diagnostic', diagnosticId: id });

/** Server sends an interface reply: open_window, then Mineflayer registers it. */
function openReply(client: FakeClient, session: GameSession, windowId: number): void {
  client.emit('open_window', { windowId, inventoryType: 2 });
  (session.bot as unknown as { currentWindow: { id: number } | null }).currentWindow = { id: windowId };
}

const closes = (client: FakeClient, windowId: number) => client.written.filter((w) => w.name === 'close_window' && w.data['windowId'] === windowId).length;

describe('MB-SKL-004 interface replies are attributed to their request', () => {
  it('stop before the reply: the late window is closed for the revoked request', async () => {
    const client = fakeClient();
    const session = gateSession(client);
    const leases = leasesFor();
    const lease = leases.acquire(diag('a'));
    const act = new Actuator(session, lease, systemClock);
    const opening = act.openBlockWindow({ x: 1, y: 0, z: 0 }, 'up', 2_000).catch((e: unknown) => e);
    await tick(5);
    leases.revoke(lease, 'owner_stop');
    assert.ok((await opening) instanceof LeaseRevokedError);
    openReply(client, session, 7);
    await tick(5);
    assert.equal(closes(client, 7), 1);
  });

  it('stop during content arrival (open seen, contents pending) closes the owned window', async () => {
    const client = fakeClient();
    const session = gateSession(client);
    const leases = leasesFor();
    const lease = leases.acquire(diag('a'));
    const act = new Actuator(session, lease, systemClock);
    const opening = act.openBlockWindow({ x: 1, y: 0, z: 0 }, 'up', 2_000).catch((e: unknown) => e);
    await tick(5);
    openReply(client, session, 4); // Mineflayer registers the window on open_window; windowOpen waits for contents
    await tick(5);
    leases.revoke(lease, 'owner_stop'); // stop before window_items arrives
    assert.ok((await opening) instanceof LeaseRevokedError);
    client.emit('window_items', { windowId: 4, stateId: 1, items: [] }); // contents arrive after the stop
    await tick(5);
    assert.ok(closes(client, 4) >= 1, 'the window opened for the revoked request is closed');
  });

  it('a reply after the request timed out is closed; the replacement waits and gets its own window', async () => {
    const client = fakeClient();
    const session = gateSession(client);
    const leases = leasesFor();
    const first = leases.acquire(diag('a'));
    const a = new Actuator(session, first, systemClock);
    await assert.rejects(a.openBlockWindow({ x: 1, y: 0, z: 0 }, 'up', 50), /no window opened/);
    leases.revoke(first, 'completed');
    const second = leases.acquire(diag('b'));
    const b = new Actuator(session, second, systemClock);
    const pending = b.openBlockWindow({ x: 2, y: 0, z: 0 }, 'up', 2_000);
    await tick(20);
    assert.equal(client.written.filter((w) => w.name === 'block_place').length, 1, 'replacement does not send while the old reply is unresolved');
    openReply(client, session, 7); // the OLD request's late reply
    await tick(5);
    assert.equal(closes(client, 7), 1, 'old late reply closed');
    (session.bot as unknown as { currentWindow: unknown }).currentWindow = null;
    await tick(150);
    assert.equal(client.written.filter((w) => w.name === 'block_place').length, 2, 'replacement sent its own request after the drain');
    openReply(client, session, 8);
    client.emit('window_items', { windowId: 8, stateId: 1, items: [] });
    const win = await Promise.race([pending, new Promise((r) => setTimeout(() => r('timeout'), 1_500))]);
    assert.notEqual(win, 'timeout');
    assert.equal((win as { id: number }).id, 8, 'replacement adopts only its own window');
    assert.equal(b.ownsWindow(7), false);
    leases.revoke(second, 'completed');
  });

  it('an acknowledgement without an interface resolves the request as none', async () => {
    const client = fakeClient((name, data) => ackSequenced(client, name, data));
    const session = gateSession(client);
    const leases = leasesFor();
    const lease = leases.acquire(diag('a'));
    const act = new Actuator(session, lease, systemClock);
    await assert.rejects(act.openBlockWindow({ x: 1, y: 0, z: 0 }, 'up', 2_000), /acknowledged the use without an interface/);
    assert.equal(interfaceGate(session, systemClock).pending().length, 0);
    leases.revoke(lease, 'completed');
  });

  it('entity use is ordered by a sequenced barrier; an earlier uncorrelated resync reply cannot release it', async () => {
    const client = fakeClient();
    const session = gateSession(client);
    const leases = leasesFor();
    // An earlier resync whose reply is still in flight.
    client.write('window_click', { windowId: 0, stateId: -1, slot: -999, mouseButton: 2, mode: 5, changedSlots: [], cursorItem: null });
    const old = leases.acquire(diag('old'));
    const oldAct = new Actuator(session, old, systemClock);
    await oldAct.useOnEntity(2);
    const barrier = client.written.find((w) => w.name === 'block_dig');
    assert.ok(barrier && barrier.data['status'] === 1 && typeof barrier.data['sequence'] === 'number', 'barrier is a sequenced out-of-range abort');
    leases.revoke(old, 'owner_stop');
    client.emit('window_items', { windowId: 0, stateId: 1, items: [] }); // late reply to the EARLIER resync
    const fresh = leases.acquire(diag('new'));
    const freshAct = new Actuator(session, fresh, systemClock);
    const pending = freshAct.openBlockWindow({ x: 1, y: 0, z: 0 }, 'up', 300).then(
      (w) => ({ id: (w as unknown as { id: number }).id }),
      (e: unknown) => ({ error: String(e) }),
    );
    await tick(10);
    openReply(client, session, 7); // the OLD entity interface
    await tick(5);
    const result = await pending;
    assert.equal('id' in result ? result.id : undefined, undefined, 'the fresh request never adopts the old entity interface');
    assert.equal(closes(client, 7), 1, 'old entity interface closed');
    leases.revoke(fresh, 'completed');
  });

  it('a passive late-window close scheduled before a lifecycle reset never closes the new scene’s reused window id', async () => {
    const client = fakeClient();
    const session = gateSession(client);
    const gate = interfaceGate(session, systemClock);
    gate.register(1, 1_000_001, session.evidence.seq, () => false); // revoked owner
    openReply(client, session, 7); // late reply: passive close scheduled
    gate.clear('lifecycle_dimension_change'); // window ids restart before the close runs
    (session.bot as unknown as { currentWindow: unknown }).currentWindow = null;
    gate.register(2, 1_000_002, session.evidence.seq, () => true);
    openReply(client, session, 7); // the new scene's window reuses id 7
    await new Promise(setImmediate);
    assert.equal((session.bot as unknown as { currentWindow: { id: number } | null }).currentWindow?.id, 7);
    assert.equal(closes(client, 7), 0, 'no stale close packet');
    assert.deepEqual(gate.windowsOf(2), [7]);
  });

  it('a request unresolved past the horizon makes the executor gate report busy/unknown, not ready', async () => {
    let now = 0;
    const clock = { now: () => now };
    const client = fakeClient();
    const session = gateSession(client);
    const leases = new ActuatorLeases({ clock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
    const lease = leases.acquire(diag('a'));
    const act = new Actuator(session, lease, clock);
    await act.useOnBlock({ x: 1, y: 0, z: 0 }, 'up', false);
    leases.revoke(lease, 'completed');
    now += INTERFACE_UNRESOLVED_MS + 1;
    assert.equal(interfaceGate(session, clock).unresolved().length, 1);
    const next = leases.acquire(diag('b'));
    const nextAct = new Actuator(session, next, clock);
    await assert.rejects(nextAct.useOnBlock({ x: 2, y: 0, z: 0 }, 'up', false), InterfaceBusyError);
    leases.revoke(next, 'completed');
    interfaceGate(session, clock).clear('test_reconnect');
    assert.equal(interfaceGate(session, clock).unresolved().length, 0, 'lifecycle reset clears the unknown state');
  });
});
