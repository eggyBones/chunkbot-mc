// R8/R9: installed real constructor, byte decoder, bundle dispatcher, loader/entities,
// tracker and visible reader. No sockets, joins, credentials or inference.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { SessionSafetyReader, registryFactsOf, type SafetySession } from '../src/safety/adapter.ts';
import { SafetyTracker } from '../src/safety/tracker.ts';
import { planSafety } from '../src/safety/policy.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';
import { policyCtx, self } from './safety-helpers.ts';

const require = createRequire(import.meta.url);
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer');
const mineflayer = require('mineflayer');
const injectEntities = require('mineflayer/lib/plugins/entities');
const UUID = '11111111-1111-1111-1111-111111111111';

function rig(version: string) {
  let connectRequests = 0;
  // Exercise the actual Mineflayer -> protocol createClient construction path.
  // Its injected connect hook performs no socket/DNS/world operation.
  const bot = mineflayer.createBot({ username: 'SafetyOffline', auth: 'offline', version, connect: () => { connectRequests++; }, loadInternalPlugins: false, hideErrors: true, logErrors: false });
  const client = bot._client;
  client.state = 'play';
  const serializer = createSerializer({ isServer: true, version, state: 'play' });
  const tracker = new SafetyTracker(); const facts = registryFactsOf(bot.registry);
  tracker.attach(client, { connectionEpoch: 1, registry: () => facts, now: () => 1000 });
  injectEntities(bot);
  const fake = fakeMineflayerBot(fakeClient());
  fake.fill(-15, -1, -15, 15, -1, 15, 'stone');
  Object.assign(bot, { world: fake.bot.world, game: fake.bot.game, entity: fake.bot.entity, inventory: fake.bot.inventory, quickBarSlot: 0, health: 20, food: 20 });
  const evidence = new ServerEvidence(client, bot.registry); evidence.attach();
  // Synthetic code-owned ping seam for this offline test, never a fixture fact.
  const session = { bot, connectionEpoch: 1, evidence, serverReported: { version, protocol: version === '26.1.2' ? 775 : 776 } } as SafetySession;
  let current: SafetySession | undefined = session;
  const reader = new SessionSafetyReader({ session: () => current, perception: { isOwnerEntity: () => false }, tracker, now: () => 1000 });
  const order: string[] = [];
  client.on('packet', (_p: unknown, m: { name: string }) => order.push(m.name));
  const send = (name: string, params: unknown = {}) => client.deserializer.write(serializer.createPacketBuffer({ name, params }));
  const spawn = (id = 50, species = 'zombie', uuid = UUID) => send('spawn_entity', { entityId: id, objectUUID: uuid, type: bot.registry.entitiesByName[species].id, x: 3, y: 0, z: 0.5, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0 });
  const meta = (value: unknown, type = 'boolean', id = 50) => send('entity_metadata', { entityId: id, metadata: [{ key: facts.metadataIndex('zombie', 'baby'), type, value }] });
  const visible = () => reader.entities({ scanRadius: 16, approachWindowMs: 1500, provokedWindowMs: 6000 }).find((e) => e.entityId === 50);
  const response = () => planSafety(self(), visible() ? [{ ...visible()!, aggressive: true }] : [], policyCtx());
  const close = () => { tracker.detach(); evidence.detach(); client.removeAllListeners(); bot.removeAllListeners(); client.serializer.destroy(); client.deserializer.destroy(); serializer.destroy(); };
  return { client, bot, session, tracker, send, spawn, meta, visible, response, order, close, connectRequests, setSession: (next: SafetySession | undefined) => { current = next; } };
}

for (const version of ['26.1.2', '26.2']) describe(`R8/R9 installed constructor/pairing/reader (${version})`, () => {
  it('both library labels normalize; exact current ping plus closed omitted pairing admits adult defense', () => {
    const r = rig(version);
    try {
      assert.equal(r.client.version, version === '26.1.2' ? '26.1' : '26.2');
      assert.equal(r.bot.version, version === '26.1.2' ? '26.1' : '26.2');
      assert.equal(r.connectRequests, 1); assert.equal(r.client.socket, undefined);
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
      const report = r.session.serverReported;
      delete (r.session as { serverReported?: unknown }).serverReported;
      assert.equal(r.visible()?.ageEvidence, 'unknown', 'aliases/exact library labels without ping are not exact release proof');
      Object.assign(r.session, { serverReported: report });
      const registry = r.bot.registry; r.bot.registry = require('minecraft-data')(version === '26.1.2' ? '26.2' : '26.1.2');
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.bot.registry = registry;
      delete r.bot.entities[50].uuid; assert.equal(r.visible()?.ageEvidence, 'unknown', 'missing current identity is not proof');
      assert.equal(r.tracker.counts.ageSpawns, 2); assert.equal(r.tracker.counts.explicitAgeValues, 1);
      assert.deepEqual(r.tracker.pairingEvidence(50), { complete: true, age: 'omitted', uuidKnown: true });
    } finally { r.close(); }
  });

  it('missing/alias/ambiguous/unsupported/mismatched reports or protocols never admit an omitted adult', () => {
    const r = rig(version);
    try {
      r.send('bundle_delimiter'); r.spawn(); r.send('bundle_delimiter');
      const report = r.session.serverReported;
      for (const serverReported of [undefined, { version: '26.1', protocol: 775 }, { version: 'vanilla 26.1.2', protocol: 775 }, { version: '26.1.2 / 26.2', protocol: 775 }, { version: '26.1.3', protocol: 775 }, { version: '26.2.1', protocol: 776 }, { version: '26.3', protocol: 777 }, { version, protocol: version === '26.1.2' ? 776 : 775 }, { version, protocol: NaN }, { version: version === '26.1.2' ? '26.2' : '26.1.2', protocol: version === '26.1.2' ? 776 : 775 }]) {
        Object.assign(r.session, { serverReported });
        assert.equal(r.visible()?.ageEvidence, 'unknown', JSON.stringify(serverReported));
        const p = r.response(); assert.equal(p.kind === 'respond' ? p.response : p.kind, 'retreat');
      }
      Object.assign(r.session, { serverReported: report });
      assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default');
      const protocol = r.bot.protocolVersion; r.bot.protocolVersion = 774;
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.bot.protocolVersion = protocol;
      const clientVersion = r.client.version; r.client.version = '26.2.1';
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.client.version = clientVersion;
      const botVersion = r.bot.version; r.bot.version = '26.2.1';
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.bot.version = botVersion;
      const registryProtocol = r.bot.registry.version.version; r.bot.registry.version.version = 774;
      assert.equal(r.visible()?.ageEvidence, 'unknown'); r.bot.registry.version.version = registryProtocol;
      assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default');
    } finally { r.close(); }
  });

  it('a prior ready report cannot authorize an absent/replaced session, old epoch or foreign current entity', () => {
    const r = rig(version);
    try {
      r.send('bundle_delimiter'); r.spawn(); r.send('bundle_delimiter');
      r.setSession(undefined); assert.equal(r.visible(), undefined);
      r.setSession({ ...r.session, connectionEpoch: 2 });
      assert.equal(r.visible()?.ageEvidence, 'unknown');
      r.setSession(r.session); assert.equal(r.visible()?.ageEvidence, 'vanilla_spawn_default');
      r.bot.entities[50].uuid = '22222222-2222-2222-2222-222222222222';
      assert.equal(r.visible()?.ageEvidence, 'unknown');
      r.send('entity_destroy', { entityIds: [50] });
      r.spawn(50, 'zombie', '22222222-2222-2222-2222-222222222222');
      assert.equal(r.visible()?.ageEvidence, 'unknown', 'unbundled reuse cannot inherit the old current report/pairing');
      r.client.emit('respawn', {}); assert.equal(r.visible()?.ageEvidence, 'unknown');
      r.tracker.detach(); assert.equal(r.visible()?.ageEvidence, 'unknown');
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
