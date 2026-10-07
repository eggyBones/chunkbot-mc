// MB-LOC-001 L1/L2/L4/L6: owner-only attribution, coarse cues, hiding,
// expiry, lifecycle and connection scoping of locator statements. Exercises the
// real LocatorService with statements emitted on a client event emitter exactly
// as the pinned deserializer delivers them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { DEFAULT_LOCATOR_CONFIG, LocatorHintSchema, type LocatorConfig } from '../src/contracts/locator.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid, type OwnerPolicy } from '../src/game/identity.ts';
import { LocatorService } from '../src/locator/service.ts';

const OWNER_NAME = 'OwnerPlayer';
const OWNER_UUID = offlinePlayerUuid(OWNER_NAME);
const OTHER_UUID = offlinePlayerUuid('SomeoneElse');
const ONLINE_OWNER = 'a1b2c3d4-0000-4000-8000-123456789abc';

interface Harness {
  service: LocatorService;
  client: EventEmitter;
  bot: { entity: { position: { x: number; y: number; z: number } }; game: { dimension: string }; players: Record<string, { uuid: string; username: string } | undefined>; _client: EventEmitter };
  clock: { t: number; now(): number };
  session: { current: (GameSession & { connectionEpoch: number }) | undefined };
  events: Array<Record<string, unknown>>;
  online: { value: boolean };
  emit(op: string, uuid: string | { id: string }, type: string, data?: unknown): void;
}

function harness(options: { policy?: OwnerPolicy; config?: Partial<LocatorConfig>; listed?: boolean; version?: string } = {}): Harness {
  const client = new EventEmitter();
  const bot = { entity: { position: { x: 0.5, y: 64, z: 0.5 } }, game: { dimension: 'minecraft:overworld' }, players: {} as Harness['bot']['players'], _client: client };
  if (options.listed !== false) bot.players[OWNER_NAME] = { uuid: OWNER_UUID, username: OWNER_NAME };
  const clock = { t: 10_000, now() { return this.t; } };
  const session: Harness['session'] = { current: { bot, connectionEpoch: 1, evidence: {} } as unknown as GameSession & { connectionEpoch: number } };
  const events: Array<Record<string, unknown>> = [];
  const online = { value: false };
  const service = new LocatorService({
    config: { ...DEFAULT_LOCATOR_CONFIG, ...options.config },
    version: options.version ?? '26.2',
    ownerPolicy: options.policy ?? { mode: 'offline_name', ownerName: OWNER_NAME },
    admission: () => ({ serverOnlineMode: online.value }),
    session: () => session.current,
    clock,
    record: (e) => events.push(e),
  });
  service.attach(client, 1);
  client.emit('login', {});
  const emit: Harness['emit'] = (op, id, type, data) => {
    const identity = typeof id === 'string' ? { hasUUID: true, uuid: id } : { hasUUID: false, id: id.id };
    client.emit('tracked_waypoint', { operation: op, waypoint: { ...identity, icon: { style: 'minecraft:default', color: { red: 1, green: 2, blue: 3 } }, type, ...(data !== undefined ? { data } : {}) } });
  };
  return { service, client, bot, clock, session, events, online, emit };
}

/** No exact coordinate of the statement may appear anywhere in model/status-visible data. */
function assertNoCoordinates(value: unknown, forbidden: number[]): void {
  const text = JSON.stringify(value);
  for (const n of forbidden) assert.ok(!new RegExp(`(?<![0-9.])${String(n).replace('-', '\\-')}(?![0-9])`).test(text), `exact coordinate ${n} leaked: ${text}`);
}

describe('MB-LOC-001 owner attribution (L1)', () => {
  it('trusted offline fixture: the derived UUID of the exact owner name, listed under that exact name is the owner', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'vec3i', { x: 300, y: 64, z: 0 });
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, true, hint.note);
    assert.equal(hint.direction, 'east');
    assert.equal(hint.distanceBand, 'far');
    assert.equal(hint.elevation, 'level');
    assert.equal(hint.precision, 'block');
    LocatorHintSchema.parse(hint);
  });

  it('another player, a string id with the owner name, or icon colour/order never grant identity', () => {
    const h = harness();
    h.emit('track', OTHER_UUID, 'vec3i', { x: 10, y: 64, z: 10 });
    h.emit('track', { id: OWNER_NAME }, 'vec3i', { x: -50, y: 64, z: -50 });
    h.emit('track', { id: OWNER_UUID }, 'azimuth', 1.0);
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, false);
    assert.equal(hint.reason, 'never_received');
    assert.equal(hint.direction, null);
    const st = h.service.status();
    assert.equal(st.counters.ownerStatements, 0);
    assert.equal(st.counters.stringIds, 2);
    assert.equal(st.counters.otherTracked, 3);
    assertNoCoordinates(st, [10, -50]);
  });

  it('offline fixture: the owner UUID without the exact listed name is unverified (no direction)', () => {
    const h = harness({ listed: false });
    h.bot.players['ownerplayer'] = { uuid: OWNER_UUID, username: 'ownerplayer' };
    h.emit('track', OWNER_UUID, 'vec3i', { x: 300, y: 64, z: 0 });
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, false);
    assert.equal(hint.reason, 'owner_identity_unverified');
  });

  it('UUID mode: the configured UUID only on a verified online-mode connection', () => {
    const h = harness({ policy: { mode: 'uuid', ownerUuid: ONLINE_OWNER, requireSignedChat: false } });
    h.emit('track', ONLINE_OWNER.toUpperCase(), 'chunk', { chunkX: 20, chunkZ: 0 });
    assert.equal(h.service.ownerHint().reason, 'owner_identity_unverified', 'offline-mode server: no identity');
    h.online.value = true;
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, true, hint.note);
    assert.equal(hint.direction, 'east');
    h.emit('update', OWNER_UUID, 'vec3i', { x: -300, y: 64, z: 0 }); // the offline-derived UUID is not the configured owner here
    assert.equal(h.service.ownerHint().direction, 'east');
  });
});

describe('MB-LOC-001 coarse cues by variant (L2)', () => {
  it('vec3i: sector, band and above/below/level only from block precision; exact values never exposed', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'vec3i', { x: -37, y: 90, z: -261 });
    let hint = h.service.ownerHint();
    assert.equal(hint.direction, 'north');
    assert.equal(hint.distanceBand, 'far');
    assert.equal(hint.elevation, 'above');
    assertNoCoordinates([hint, h.service.status(), h.events], [-37, 90, -261]);
    h.emit('update', OWNER_UUID, 'vec3i', { x: 20, y: 40, z: 20 });
    hint = h.service.ownerHint();
    assert.equal(hint.direction, 'south_east');
    assert.equal(hint.distanceBand, 'close');
    assert.equal(hint.elevation, 'below');
    h.emit('update', OWNER_UUID, 'vec3i', { x: 0, y: 120, z: 0 });
    hint = h.service.ownerHint();
    assert.equal(hint.actionable, false, 'directly above: no horizontal direction');
    assert.equal(hint.reason, 'direction_undetermined');
    assert.equal(hint.elevation, 'above');
  });

  it('chunk: direction and a band only when the chunk uncertainty cannot cross a band edge; height unknown', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'chunk', { chunkX: 0, chunkZ: 18 }); // centre z=296
    let hint = h.service.ownerHint();
    assert.equal(hint.direction, 'south');
    assert.equal(hint.distanceBand, 'far');
    assert.equal(hint.elevation, 'unknown');
    assert.equal(hint.precision, 'chunk');
    h.emit('update', OWNER_UUID, 'chunk', { chunkX: 7, chunkZ: 0 }); // centre x=120: straddles the 128 edge
    hint = h.service.ownerHint();
    assert.equal(hint.direction, 'east');
    assert.equal(hint.distanceBand, 'unknown');
    h.emit('update', OWNER_UUID, 'chunk', { chunkX: 0, chunkZ: 0 }); // the bot's own chunk
    assert.equal(h.service.ownerHint().reason, 'direction_undetermined');
  });

  it('azimuth: direction only (no distance, no height); empty: tracked without position', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'azimuth', -Math.PI / 2); // yaw -90 = east
    let hint = h.service.ownerHint();
    assert.equal(hint.direction, 'east');
    assert.equal(hint.distanceBand, 'unknown');
    assert.equal(hint.elevation, 'unknown');
    assert.equal(hint.precision, 'direction_only');
    h.emit('update', OWNER_UUID, 'azimuth', Math.PI); // north
    assert.equal(h.service.ownerHint().direction, 'north');
    h.emit('update', OWNER_UUID, 'azimuth', 0); // south
    assert.equal(h.service.ownerHint().direction, 'south');
    h.emit('track', OWNER_UUID, 'empty');
    hint = h.service.ownerHint();
    assert.equal(hint.actionable, false);
    assert.equal(hint.reason, 'no_position');
  });
});

describe('MB-LOC-001 withdrawal, freshness and lifecycle (L4/L6)', () => {
  it('untrack (hidden: crouching/invisibility/head item/range/disabled/left) clears the direction; a fresh track restores it', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    assert.equal(h.service.ownerHint().actionable, true);
    h.emit('untrack', OWNER_UUID, 'empty');
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, false);
    assert.equal(hint.reason, 'untracked');
    assert.equal(hint.direction, null);
    assert.equal(h.service.steering(), undefined, 'route code gets no steering either');
    h.emit('track', OWNER_UUID, 'vec3i', { x: 0, y: 64, z: 200 });
    assert.equal(h.service.ownerHint().direction, 'south');
  });

  it('a statement older than hintMaxAgeMs expires (no direction); a newer statement is current again', () => {
    const h = harness({ config: { hintMaxAgeMs: 5_000 } });
    h.emit('track', OWNER_UUID, 'azimuth', 0);
    h.clock.t += 4_000;
    const fresh = h.service.ownerHint();
    assert.equal(fresh.actionable, true);
    assert.equal(fresh.ageMs, 4_000);
    assert.equal(fresh.expiresInMs, 1_000);
    h.clock.t += 2_000;
    const old = h.service.ownerHint();
    assert.equal(old.reason, 'expired');
    assert.equal(old.direction, null);
    h.emit('update', OWNER_UUID, 'azimuth', 0);
    assert.equal(h.service.ownerHint().actionable, true);
  });

  it('a respawn packet (dimension change / death respawn) and death/dimension lifecycle events void statements', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    h.client.emit('respawn', {});
    assert.equal(h.service.ownerHint().reason, 'dimension_changed');
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    assert.equal(h.service.ownerHint().actionable, true);
    h.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
    assert.equal(h.service.ownerHint().reason, 'dimension_changed');
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    h.service.onLifecycle({ type: 'dimension_change', connectionEpoch: 1, from: 'minecraft:overworld', to: 'minecraft:the_nether' });
    assert.equal(h.service.ownerHint().actionable, false);
  });

  it('logout/disconnect clears everything; packets of an old client never steer a new connection (fresh broadcast required)', () => {
    const h = harness();
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    h.service.onLifecycle({ type: 'ended', connectionEpoch: 1, reason: 'disconnected', detail: 'x' });
    h.session.current = undefined;
    assert.equal(h.service.ownerHint().reason, 'disconnected');
    // New connection 2 with a new client.
    const client2 = new EventEmitter();
    h.bot._client = client2;
    h.session.current = { bot: h.bot, connectionEpoch: 2, evidence: {} } as unknown as GameSession & { connectionEpoch: number };
    h.service.onLifecycle({ type: 'joining', connectionEpoch: 2 });
    h.service.attach(client2, 2);
    client2.emit('login', {});
    // A late packet on the OLD client:
    h.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    const hint = h.service.ownerHint();
    assert.equal(hint.actionable, false);
    assert.equal(hint.reason, 'never_received');
    assert.equal(hint.connectionEpoch, 2);
    client2.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 's' }, type: 'vec3i', data: { x: -200, y: 64, z: 0 } } });
    assert.equal(h.service.ownerHint().direction, 'west');
  });

  it('disabled configuration and an unverified codec expose nothing', () => {
    const off = harness({ config: { enabled: false } });
    off.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    assert.equal(off.service.ownerHint().reason, 'disabled');
    assert.equal(off.service.status().support, 'disabled');
    const old = harness({ version: '1.21.1' });
    old.emit('track', OWNER_UUID, 'vec3i', { x: 200, y: 64, z: 0 });
    assert.equal(old.service.ownerHint().reason, 'unsupported_codec');
    assert.equal(old.service.status().support, 'unsupported_codec');
  });

  it('telemetry records state transitions and counts only, never positions', () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.emit('update', OWNER_UUID, 'vec3i', { x: 1_234 + i, y: 77, z: -4_321 });
    h.emit('untrack', OWNER_UUID, 'empty');
    h.emit('track', OTHER_UUID, 'vec3i', { x: 999, y: 88, z: 555 });
    h.client.emit('tracked_waypoint', { operation: 5, waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 's' }, type: 'empty' } });
    const states = h.events.filter((e) => e['type'] === 'locator_owner_state');
    assert.deepEqual(states.map((e) => e['state']), ['tracked:vec3i', 'untracked:empty']);
    assert.equal(h.events.filter((e) => e['type'] === 'locator_rejected').length, 1);
    assertNoCoordinates(h.events, [1234, 1235, -4321, 77, 999, 555]);
  });
});
