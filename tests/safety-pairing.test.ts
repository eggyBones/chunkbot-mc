// R8: installed byte decoder, bundle dispatcher, Mineflayer loader/entities,
// tracker and visible reader. No sockets, joins, credentials or inference.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { SessionSafetyReader, registryFactsOf } from '../src/safety/adapter.ts';
import { SafetyTracker } from '../src/safety/tracker.ts';
import { planSafety } from '../src/safety/policy.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';
import { policyCtx, self } from './safety-helpers.ts';

const require = createRequire(import.meta.url);
// The installed internal Client constructor does not create/connect a socket.
const Client = require('minecraft-protocol/src/client');
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer');
const mineflayer = require('mineflayer');
const injectEntities = require('mineflayer/lib/plugins/entities');
const UUID = '11111111-1111-1111-1111-111111111111';

function rig(version: string) {
  const client = new Client(false, version, undefined, true);
  const bot = mineflayer.createBot({ client, version, loadInternalPlugins: false, logErrors: false });
  client.state = 'play';
  const serializer = createSerializer({ isServer: true, version, state: 'play' });
  const tracker = new SafetyTracker(); const facts = registryFactsOf(bot.registry);
  tracker.attach(client, { connectionEpoch: 1, registry: () => facts, now: () => 1000 });
  injectEntities(bot);
  const fake = fakeMineflayerBot(fakeClient());
  fake.fill(-15, -1, -15, 15, -1, 15, 'stone');
  Object.assign(bot, { world: fake.bot.world, game: fake.bot.game, entity: fake.bot.entity, inventory: fake.bot.inventory, quickBarSlot: 0, health: 20, food: 20 });
  const evidence = new ServerEvidence(client, bot.registry); evidence.attach();
  const session = { bot, connectionEpoch: 1, evidence } as GameSession;
  const reader = new SessionSafetyReader({ session: () => session, perception: { isOwnerEntity: () => false }, tracker, now: () => 1000 });
  const order: string[] = [];
  client.on('packet', (_p: unknown, m: { name: string }) => order.push(m.name));
  const send = (name: string, params: unknown = {}) => client.deserializer.write(serializer.createPacketBuffer({ name, params }));
  const spawn = (id = 50, species = 'zombie', uuid = UUID) => send('spawn_entity', { entityId: id, objectUUID: uuid, type: bot.registry.entitiesByName[species].id, x: 3, y: 0, z: 0.5, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0 });
  const meta = (value: unknown, type = 'boolean', id = 50) => send('entity_metadata', { entityId: id, metadata: [{ key: facts.metadataIndex('zombie', 'baby'), type, value }] });
  const visible = () => reader.entities({ scanRadius: 16, approachWindowMs: 1500, provokedWindowMs: 6000 }).find((e) => e.entityId === 50);
  const response = () => planSafety(self(), visible() ? [{ ...visible()!, aggressive: true }] : [], policyCtx());
  const close = () => { tracker.detach(); evidence.detach(); client.removeAllListeners(); bot.removeAllListeners(); client.serializer.destroy(); client.deserializer.destroy(); serializer.destroy(); };
  return { client, bot, session, tracker, send, spawn, meta, visible, response, order, close };
}

for (const version of ['26.1.2', '26.2']) describe(`R8 installed pairing/reader (${version})`, () => {
  it('retains exact client release through library normalization; only closed omitted age admits adult defense', () => {
    const r = rig(version);
    try {
      assert.equal(r.client.version, version);
      assert.equal(r.bot.version, version === '26.1.2' ? '26.1' : '26.2');
      r.send('bundle_delimiter'); r.spawn();
      assert.equal(r.visible(), undefined, 'installed decoder buffers the incomplete pairing');
      r.send('bundle_delimiter');
      assert.deepEqual(r.order, ['bundle_delimiter', 'spawn_entity', 'bundle_delimiter']);
      assert.equal(r.bot.entities[50].uuid, UUID);
      assert.equal(r.bot.entities[50].metadata[r.bot.registry.entitiesByName.zombie.metadataKeys.indexOf('baby')], undefined);
      assert.equal(r.tracker.adultDefault(50, 'zombie', version), true);
      assert.equal(r.visible()?.baby, false);
      assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default');
      const p = r.response(); assert.equal(p.kind === 'respond' ? p.response : p.kind, 'defend');
    } finally { r.close(); }
  });

  it('the actual >32 dispatcher fallback retains delimiters, blocks incomplete proof and processes explicit baby', () => {
    const r = rig(version);
    try {
      r.send('bundle_delimiter'); r.spawn();
      for (let i = 0; i < 31; i++) r.send('entity_head_rotation', { entityId: 50, headYaw: 0 });
      assert.equal(r.client._hasBundlePacket, false, 'actual installed fallback occurred');
      assert.equal(r.visible()?.ageEvidence, 'unknown');
      r.meta(true); r.send('bundle_delimiter');
      assert.equal(r.visible()?.baby, true);
      assert.equal(r.tracker.adultDefault(50, 'zombie', version), false);
      const p = r.response(); assert.equal(p.kind === 'respond' ? p.response : p.kind, 'retreat');
      r.send('entity_destroy', { entityIds: [50] });
      r.send('bundle_delimiter'); r.spawn(); r.send('bundle_delimiter');
      assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default', 'subsequent complete pairing still requires both passed-through delimiters');
    } finally { r.close(); }
  });

  it('explicit current boolean age survives decoding; null, alias-only and mismatched registry never prove an omitted adult', () => {
    const r = rig(version);
    try {
      r.send('bundle_delimiter'); r.spawn(); r.meta(false); r.send('bundle_delimiter');
      assert.equal(r.visible()?.baby, false); assert.equal(r.visible()?.ageEvidence, 'server_metadata');
      assert.equal(r.tracker.adultDefault(50, 'zombie', version), false, 'explicit age is a different proof');
      r.send('entity_destroy', { entityIds: [50] }); r.send('bundle_delimiter'); r.spawn(); r.send('bundle_delimiter');
      const key = r.bot.registry.entitiesByName.zombie.metadataKeys.indexOf('baby');
      r.bot.entities[50].metadata[key] = null; assert.equal(r.visible()?.ageEvidence, 'unknown'); delete r.bot.entities[50].metadata[key];
      r.client.version = version === '26.1.2' ? '26.1' : '26.2.1'; assert.equal(r.visible()?.ageEvidence, 'unknown'); r.client.version = version;
      const registry = r.bot.registry; r.bot.registry = require('minecraft-data')(version === '26.1.2' ? '26.2' : '26.1.2');
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.bot.registry = registry;
      delete r.bot.entities[50].uuid; assert.equal(r.visible()?.ageEvidence, 'unknown', 'missing current identity is not proof');
      assert.equal(r.tracker.counts.ageSpawns, 2); assert.equal(r.tracker.counts.explicitAgeValues, 1);
      assert.deepEqual(r.tracker.pairingEvidence(50), { complete: true, age: 'omitted', uuidKnown: true });
    } finally { r.close(); }
  });

  it('unbundled, nonboolean, foreign metadata, unsupported release and reused/lifecycle identities never borrow default proof', () => {
    const r = rig(version);
    try {
      r.spawn(); r.send('bundle_delimiter'); r.send('bundle_delimiter');
      assert.equal(r.visible()?.ageEvidence, 'unknown');
      r.send('entity_destroy', { entityIds: [50] });
      r.send('bundle_delimiter'); r.spawn(); r.meta(0, 'byte'); r.send('bundle_delimiter');
      assert.equal(r.visible()?.ageEvidence, 'unknown');
      assert.equal(r.tracker.adultDefault(50, 'zombie', version), false);
      r.send('entity_destroy', { entityIds: [50] });
      r.send('bundle_delimiter'); r.spawn(); r.meta(false, 'boolean', 51); r.send('bundle_delimiter');
      assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default');
      assert.equal(r.tracker.adultDefault(51, 'zombie', version), false, 'foreign explicit value grants no spawn proof');
      r.client.version = '26.2.1'; assert.equal(r.visible()?.ageEvidence, 'unknown'); r.client.version = version;
      Object.assign(r.session, { connectionEpoch: 2 }); assert.equal(r.visible()?.ageEvidence, 'unknown'); Object.assign(r.session, { connectionEpoch: 1 });
      r.bot.entities[50].uuid = '22222222-2222-2222-2222-222222222222'; assert.equal(r.visible()?.ageEvidence, 'unknown', 'same id with foreign UUID cannot borrow proof'); r.bot.entities[50].uuid = UUID;
      r.send('entity_destroy', { entityIds: [50] }); r.spawn(50, 'zombie', '22222222-2222-2222-2222-222222222222');
      assert.equal(r.visible()?.ageEvidence, 'unknown', 'unbundled id reuse does not inherit old pairing');
      r.client.emit('respawn', {}); assert.equal(r.tracker.adultDefault(50, 'zombie', version), false);
      r.tracker.detach(); assert.equal(r.tracker.adultDefault(50, 'zombie', version), false);
    } finally { r.close(); }
  });
});
