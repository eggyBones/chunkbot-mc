import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { BridgeBindingSchema, BridgeSampleSchema, type BridgeBinding, type BridgeDisplay, type BridgeIntentReceipt, type BridgeIntentRequest, type BridgeManagerPort, type BridgeManagerStatus, type BridgeSample, type BridgeTransport } from '../src/server-controls/types.ts';
import { decodeStorageReply, installationCommand, macroCommand, uuidWords, wordsUuid } from '../src/server-controls/protocol.ts';
import { VanillaControlBridge } from '../src/server-controls/bridge.ts';
import { createPrivateRconTransport } from '../src/server-controls/rcon.ts';
import { startManagedVanillaBridge } from '../src/server-controls/index.ts';

const binding: BridgeBinding = { protocol: 1, installation: 'a'.repeat(32), world: 'fixture', bot: 'chunkbot', ownerUuid: '8123456789abcdef01234567ffffffff', botUuid: '0'.repeat(32), version: '26.2', authority: 'trusted-offline-fixture' };
describe('vanilla bridge typed boundary', () => {
  it('round-trips signed Minecraft UUID words without a name or coordinates', () => {
    const words = uuidWords(binding.ownerUuid);
    assert.equal(words[0], -2128394905);
    assert.equal(words[3], -1);
    assert.equal(wordsUuid(words), binding.ownerUuid);
    assert.doesNotMatch(installationCommand(binding), /name=|Pos|position|tp /);
  });
  it('rejects unsupported releases, unknown binding fields and macro injection', () => {
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, version: '26.2.1' }));
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, command: 'stop' }));
    assert.throws(() => macroCommand('open', { session: 'x\nstop' }));
    assert.throws(() => installationCommand({ ...binding, world: 'x" run stop' }));
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, botUuid: binding.ownerUuid }));
  });
  it('accepts only the fixed storage envelope and bounded, unambiguous SNBT', () => {
    const decoded = decodeStorageReply('chunkbot_control:bridge has the following contents: {protocol: 1, owner: [I;-2128394905, -1985229329, 19088743, -1], version: "26_2", ownerPresent: 1b}');
    assert.equal((decoded as { version: string }).version, '26.2');
    assert.throws(() => decodeStorageReply('spoofed has the following contents: {}'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {protocol: 1, protocol: 1}'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {} trailing'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {owner: [I;1,2,3]}'));
    assert.equal(BridgeSampleSchema.safeParse(decoded).success, false, 'partial storage is not a request');
  });
});

function blankSample(): BridgeSample {
  return { protocol: 1, installation: binding.installation, world: binding.world, bot: binding.bot,
    owner: uuidWords(binding.ownerUuid), version: binding.version, session: 'closed', clock: 0, heartbeat: 0,
    generation: 0, acknowledged: 0, display: 0, blocker: 7, managerGeneration: 0, ownerSession: 1, ownerPresent: 1,
    request: { generation: 0, tick: 0, action: 0, owner: uuidWords(binding.ownerUuid), ownerSession: 1, managerGeneration: 0 } };
}
class Mailbox implements BridgeTransport {
  value = blankSample();
  pulses: BridgeDisplay[] = [];
  acknowledgments: Array<{ generation: number; disposition: string }> = [];
  failAck = false;
  closes = 0;
  async sample(): Promise<unknown> { return structuredClone(this.value); }
  async open(_b: BridgeBinding, session: string): Promise<void> { this.value = { ...blankSample(), session, heartbeat: 100 }; }
  async heartbeat(session: string, display: BridgeDisplay, _blocker: BridgeManagerStatus['blocker'], managerGeneration: number): Promise<void> {
    assert.equal(session, this.value.session); this.value.heartbeat = 100; this.value.managerGeneration = managerGeneration; this.pulses.push(display);
  }
  async acknowledge(session: string, generation: number, disposition: BridgeIntentReceipt['disposition']): Promise<void> {
    assert.equal(session, this.value.session);
    if (this.failAck) throw new Error('private raw server reply');
    this.acknowledgments.push({ generation, disposition });
    if (this.value.request.generation === generation) { this.value.acknowledged = generation; this.value.request.action = 0; }
  }
  async close(session: string): Promise<void> { if (this.value.session === session) { this.value.session = 'closed'; this.value.heartbeat = 0; this.closes++; } }
  request(action: 1 | 2): void {
    this.value.clock += 5;
    this.value.generation++;
    this.value.request = { generation: this.value.generation, tick: this.value.clock, action, owner: uuidWords(binding.ownerUuid), ownerSession: this.value.ownerSession, managerGeneration: this.value.managerGeneration };
  }
}
class Manager implements BridgeManagerPort {
  now = 10_000;
  requests: BridgeIntentRequest[] = [];
  reads = 0;
  starts = 0;
  hung = false;
  readHung = false;
  value: BridgeManagerStatus = { managerInstance: 'b'.repeat(32), intentGeneration: 0, observedAtMs: this.now, world: binding.world, bot: binding.bot, desired: 'off', state: 'offline', child: 'absent', connection: 'absent', connectionEpoch: null, botUuid: null, blocker: 'none' };
  async readStatus(): Promise<BridgeManagerStatus> { this.reads++; if (this.readHung) return new Promise(() => {}); return structuredClone({ ...this.value, observedAtMs: this.now }); }
  async submitIntent(r: BridgeIntentRequest, signal: AbortSignal): Promise<BridgeIntentReceipt> {
    this.requests.push(structuredClone(r));
    if (this.hung) return new Promise(() => {}); // deliberately ignores cancellation
    signal.throwIfAborted();
    const same = r.action === 'on' && this.value.desired === 'on';
    this.value.intentGeneration++;
    this.value.desired = r.action;
    if (r.action === 'on' && !same) { this.starts++; this.value.state = 'joining'; this.value.child = 'owned'; this.value.connection = 'joining'; }
    if (r.action === 'off') this.value.state = 'logging_out';
    return { bridgeSession: r.bridgeSession, generation: r.generation, managerInstance: this.value.managerInstance, intentGeneration: this.value.intentGeneration, disposition: same ? 'noop' : 'queued', reason: 'none' };
  }
  offline(): void { Object.assign(this.value, { state: 'offline', desired: 'off', child: 'absent', connection: 'absent', connectionEpoch: null, botUuid: null }); }
  online(): void { Object.assign(this.value, { state: 'online', desired: 'on', child: 'owned', connection: 'spawn_verified', connectionEpoch: 1, botUuid: binding.botUuid }); }
}
function rig(timeoutMs = 50) {
  const mailbox = new Mailbox(), manager = new Manager();
  let mono = 1000;
  const bridge = new VanillaControlBridge({ binding, transport: mailbox, manager, now: () => manager.now, monotonic: () => mono, sessionToken: () => 'c'.repeat(32), timeoutMs });
  return { mailbox, manager, bridge, advance: (ms: number) => { mono += ms; manager.now += ms; } };
}

describe('vanilla bridge ownership and lifecycle', () => {
  it('consumes on with bot absent, distinguishes joining/spawn, deduplicates and retains service through off', async () => {
    const r = rig();
    assert.equal((await r.bridge.start()).display, 'offline');
    r.mailbox.request(1);
    const p = r.bridge.poll(); assert.equal(r.bridge.poll(), p, 'one poll owns delivery');
    assert.equal((await p).display, 'joining');
    await r.bridge.poll(); assert.equal(r.manager.requests.length, 1, 'duplicate mailbox delivery does not dispatch');
    r.manager.online(); assert.equal((await r.bridge.poll()).display, 'online');
    r.mailbox.request(1); await r.bridge.poll(); assert.equal(r.manager.starts, 1, 'on while online uses manager idempotence');
    r.mailbox.request(2); assert.equal((await r.bridge.poll()).display, 'logging_out');
    r.manager.offline(); assert.equal((await r.bridge.poll()).display, 'offline');
    r.mailbox.request(1); await r.bridge.poll(); assert.equal(r.manager.starts, 2, 'later explicit on is eligible');
    assert.deepEqual(r.manager.requests.map((x) => x.action), ['on', 'on', 'off', 'on']);
    assert.equal(r.manager.requests[0]?.binding.ownerUuid, binding.ownerUuid);
    assert.ok(r.manager.requests.every((x) => x.expiresAtMs <= r.manager.now + 50));
    await r.bridge.stop();
  });
  it('clears stale persisted on at startup and refuses adoption of a live bridge', async () => {
    const r = rig(); r.mailbox.request(1);
    await r.bridge.start(); await r.bridge.poll(); assert.equal(r.manager.requests.length, 0);
    await r.bridge.stop();
    const active = rig(); active.mailbox.value.session = 'd'.repeat(32); active.mailbox.value.heartbeat = 10;
    assert.equal((await active.bridge.start()).reason, 'binding'); assert.equal(active.manager.requests.length, 0);
    await active.bridge.stop();
  });
  it('rejects stale on across local logout authority and on until verified logout completes', async () => {
    const r = rig(); await r.bridge.start(); r.mailbox.request(1);
    r.manager.value.intentGeneration++; // external local logout, after previous bridge pulse
    await r.bridge.poll(); assert.equal(r.manager.starts, 0);
    assert.equal(r.mailbox.acknowledgments[0]?.disposition, 'rejected');
    r.mailbox.request(2); await r.bridge.poll();
    r.mailbox.request(1); await r.bridge.poll(); assert.equal(r.manager.starts, 0, 'queued off is not completed logout');
    r.manager.offline(); await r.bridge.poll(); r.mailbox.request(1); await r.bridge.poll(); assert.equal(r.manager.starts, 1);
    await r.bridge.stop();
  });
  for (const mutation of [
    { name: 'spoofed UUID', change: (s: BridgeSample) => { s.request.owner = [1, 2, 3, 4]; } },
    { name: 'another world', change: (s: BridgeSample) => { s.world = 'other'; } },
    { name: 'old bridge session', change: (s: BridgeSample) => { s.session = 'e'.repeat(32); } },
    { name: 'expired request', change: (s: BridgeSample) => { s.clock = s.request.tick + 61; } },
    { name: 'future tick', change: (s: BridgeSample) => { s.request.tick = s.clock + 1; } },
    { name: 'owner logout', change: (s: BridgeSample) => { s.ownerPresent = 0; } },
    { name: 'old owner login session', change: (s: BridgeSample) => { s.ownerSession++; } },
    { name: 'heartbeat expiry', change: (s: BridgeSample) => { s.heartbeat = 0; } },
    { name: 'altered value', change: (s: BridgeSample) => { (s.request as { action: number }).action = 9; } },
  ]) it(`fails closed for ${mutation.name}`, async () => {
    const r = rig(); await r.bridge.start(); r.mailbox.request(1); mutation.change(r.mailbox.value);
    assert.equal((await r.bridge.poll()).state, 'unavailable'); assert.equal(r.manager.requests.length, 0);
    await r.bridge.stop();
  });
  it('cannot process an on after wake, server reload, manager restart, or regressed authority', async () => {
    for (const mode of ['wake', 'reload', 'manager', 'generation']) {
      const r = rig(); await r.bridge.start(); r.mailbox.request(1);
      if (mode === 'wake') r.advance(2501);
      if (mode === 'reload') r.mailbox.value.session = 'closed';
      if (mode === 'manager') r.manager.value.managerInstance = 'd'.repeat(32);
      if (mode === 'generation') { r.mailbox.request(2); await r.bridge.poll(); r.manager.value.intentGeneration = 0; r.mailbox.request(1); }
      assert.equal((await r.bridge.poll()).state, 'unavailable');
      assert.equal(r.manager.starts, 0); await r.bridge.stop();
    }
  });
  it('never replays ambiguously dispatched on after ack failure or a hung admission', async () => {
    for (const mode of ['ack', 'hung']) {
      const r = rig(20); await r.bridge.start(); r.mailbox.request(1);
      if (mode === 'ack') r.mailbox.failAck = true;
      else r.manager.hung = true;
      assert.equal((await r.bridge.poll()).state, 'unavailable');
      await r.bridge.poll(); assert.equal(r.manager.requests.length, 1);
      assert.doesNotMatch(JSON.stringify(r.bridge.status()), /private raw/);
      await r.bridge.stop();
    }
  });
  it('stop revokes a hung start and in-flight manager turn without late pulses', async () => {
    const starting = rig(20); starting.manager.readHung = true;
    const start = starting.bridge.start(); await delay(1); await starting.bridge.stop(); await start;
    assert.equal(starting.bridge.status().state, 'stopped'); assert.equal(starting.mailbox.pulses.length, 0);
    const r = rig(20); await r.bridge.start(); r.manager.hung = true; r.mailbox.request(1);
    const p = r.bridge.poll(); await delay(1); const before = r.mailbox.pulses.length;
    await r.bridge.stop(); await p; assert.equal(r.mailbox.pulses.length, before); assert.equal(r.bridge.status().state, 'stopped');
  });
  it('dead/stale manager and unproven child/socket/spawn state cannot extend online feedback', async () => {
    for (const mode of ['dead', 'stale', 'spawn', 'socket', 'identity', 'offline']) {
      const r = rig(20); r.manager.online(); await r.bridge.start();
      if (mode === 'dead') r.manager.readHung = true;
      if (mode === 'stale') r.manager.now -= 3000;
      if (mode === 'spawn') r.manager.value.connectionEpoch = null;
      if (mode === 'socket') r.manager.value.connection = 'unknown';
      if (mode === 'identity') r.manager.value.botUuid = 'f'.repeat(32);
      if (mode === 'offline') { r.manager.offline(); r.manager.value.child = 'unknown'; }
      const pulses = r.mailbox.pulses.length;
      if (mode === 'stale') { r.manager.readStatus = async () => ({ ...r.manager.value, observedAtMs: 1 }); }
      assert.equal((await r.bridge.poll()).state, 'unavailable'); assert.equal(r.mailbox.pulses.length, pulses);
      await r.bridge.stop();
    }
  });
  it('receipt cannot claim another manager/session/generation or unsupported status', async () => {
    const r = rig(); await r.bridge.start(); r.mailbox.request(1);
    r.manager.submitIntent = async (request) => ({ bridgeSession: request.bridgeSession, generation: request.generation + 1, managerInstance: 'b'.repeat(32), intentGeneration: 1, disposition: 'queued', reason: 'none' });
    assert.equal((await r.bridge.poll()).reason, 'manager'); assert.equal(r.mailbox.acknowledgments.length, 0);
    await r.bridge.stop();
  });
  it('re-reads owner session and newer off after awaiting manager status', async () => {
    for (const mode of ['off', 'owner_session', 'logout']) {
      const r = rig(); await r.bridge.start(); r.mailbox.request(1);
      const read = r.manager.readStatus.bind(r.manager); let changed = false;
      r.manager.readStatus = async () => {
        if (!changed) {
          changed = true;
          if (mode === 'off') r.mailbox.request(2);
          if (mode === 'owner_session') r.mailbox.value.ownerSession++;
          if (mode === 'logout') r.mailbox.value.ownerPresent = 0;
        }
        return read();
      };
      await r.bridge.poll();
      assert.equal(r.manager.starts, 0);
      assert.deepEqual(r.manager.requests.map((x) => x.action), mode === 'off' ? ['off'] : []);
      await r.bridge.stop();
    }
  });
  it('a delayed old on acknowledgment cannot erase a newer off mailbox', async () => {
    const r = rig(); await r.bridge.start(); r.mailbox.request(1);
    const submit = r.manager.submitIntent.bind(r.manager);
    r.manager.submitIntent = async (request, signal) => {
      const receipt = await submit(request, signal);
      if (request.action === 'on') r.mailbox.request(2);
      return receipt;
    };
    await r.bridge.poll(); assert.equal(r.mailbox.value.request.action, 2);
    await r.bridge.poll(); assert.deepEqual(r.manager.requests.map((x) => x.action), ['on', 'off']);
    assert.equal(r.manager.value.desired, 'off'); assert.equal(r.bridge.status().display, 'logging_out');
    const first = r.bridge.stop(); assert.equal(r.bridge.stop(), first, 'one cleanup even with two lifecycle callers'); await first;
  });
  it('an old on remains fenced after the bridge has already observed a newer local logout', async () => {
    const r = rig(); await r.bridge.start();
    r.manager.value.intentGeneration = 1; await r.bridge.poll();
    r.mailbox.request(1); r.mailbox.value.request.managerGeneration = 0;
    await r.bridge.poll(); assert.equal(r.manager.starts, 0); assert.equal(r.mailbox.acknowledgments[0]?.disposition, 'rejected');
    r.mailbox.request(1); await r.bridge.poll(); assert.equal(r.manager.starts, 1, 'new on carries the freshly published fence');
    await r.bridge.stop();
  });
});

function snbt(value: unknown, key = ''): string {
  if (Array.isArray(value)) return `${key === 'owner' ? '[I;' : '['}${value.join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${k}: ${snbt(v, k)}`).join(', ')}}`;
  if (typeof value === 'string') return JSON.stringify(key === 'version' ? value.replaceAll('.', '_') : value);
  return String(value);
}
function rconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body); const b = Buffer.alloc(payload.length + 14);
  b.writeInt32LE(payload.length + 10); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8); payload.copy(b, 12); return b;
}
async function fakeRcon(options: { badAuth?: boolean; noEffect?: boolean; badId?: boolean; hang?: boolean; fragment?: boolean } = {}) {
  const mailbox = new Mailbox();
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= buffered.readInt32LE(0) + 4) {
        const length = buffered.readInt32LE(0); const p = buffered.subarray(0, length + 4); buffered = buffered.subarray(length + 4);
        const id = p.readInt32LE(4), type = p.readInt32LE(8), command = p.subarray(12, p.length - 2).toString();
        if (options.hang) continue;
        if (type === 3) { socket.write(rconPacket(options.badAuth || command !== 'dummy-test-only' ? -1 : id, 2, '')); continue; }
        commands.push(command);
        let body = '';
        if (command === 'data get storage chunkbot_control:bridge state') body = `chunkbot_control:bridge has the following contents: ${snbt(mailbox.value)}`;
        else if (command === 'data get storage chunkbot_control:bridge state.protocol') body = 'chunkbot_control:bridge has the following contents: 1';
        else {
          const match = /^function chunkbot_control:(open|ack|pulse|close) (\{.*\})$/.exec(command);
          assert.ok(match, 'only fixed namespace control commands are issued');
          const args = JSON.parse(match[2]!) as Record<string, string | number>;
          if (!options.noEffect) {
            if (match[1] === 'open') mailbox.value = { ...blankSample(), session: String(args['session']), heartbeat: 100 };
            if (match[1] === 'ack' && mailbox.value.session === args['session'] && mailbox.value.request.generation === args['generation']) { mailbox.value.acknowledged = Number(args['generation']); mailbox.value.request.action = 0; }
            if (match[1] === 'pulse' && mailbox.value.session === args['session']) { mailbox.value.heartbeat = Number(args['ticks']); mailbox.value.display = Number(args['display']); mailbox.value.blocker = Number(args['blocker']); mailbox.value.managerGeneration = Number(args['manager_generation']); mailbox.pulses.push(['unavailable', 'offline', 'joining', 'online', 'logging_out', 'blocked'][Number(args['display'])] as BridgeDisplay); }
            if (match[1] === 'close' && mailbox.value.session === args['session']) { mailbox.value.session = 'closed'; mailbox.value.heartbeat = 0; }
          }
          body = 'Executed function chunkbot_control:fake';
        }
        const response = rconPacket(options.badId ? id + 10 : id, 0, body);
        if (options.fragment) { socket.write(response.subarray(0, 2)); socket.write(response.subarray(2, 8)); socket.write(response.subarray(8)); }
        else socket.write(response);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { mailbox, commands, port: address.port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe('private vanilla control transport and real owned entry point (fake TCP peer only)', () => {
  it('correlates fragmented RCON frames, reads back effects, and never runs installation', async () => {
    const fake = await fakeRcon({ fragment: true });
    try {
      const options = { host: '127.0.0.1' as const, port: fake.port, password: 'dummy-test-only' };
      const transport = createPrivateRconTransport(options);
      (options as { host: string }).host = 'untrusted.invalid';
      const signal = new AbortController().signal, session = 'c'.repeat(32);
      await transport.open(binding, session, signal);
      await transport.heartbeat(session, 'offline', 'none', 0, signal);
      fake.mailbox.request(1); await transport.acknowledge(session, 1, 'queued', signal);
      assert.equal(fake.mailbox.value.acknowledged, 1);
      await transport.close(session, signal); assert.equal(fake.mailbox.value.session, 'closed');
      assert.ok(fake.commands.every((x) => /^(data get storage chunkbot_control:bridge state(?:\.protocol)?|function chunkbot_control:(open|ack|pulse|close) \{)/.test(x)));
      assert.doesNotMatch(fake.commands.join('\n'), /dummy-test-only|function chunkbot_control:install\b|tp |execute as|Pos|Players/);
    } finally { await fake.close(); }
  });
  it('refuses false success text, failed auth, wrong correlation and timeout without echoing replies/credentials', async () => {
    for (const options of [{ noEffect: true }, { badAuth: true }, { badId: true }, { hang: true }]) {
      const fake = await fakeRcon(options);
      try {
        const transport = createPrivateRconTransport({ host: '127.0.0.1', port: fake.port, password: 'dummy-test-only', timeoutMs: 20 });
        await assert.rejects(transport.open(binding, 'c'.repeat(32), new AbortController().signal), (error: unknown) => error instanceof Error && !/dummy-test-only|Executed function/.test(error.message));
      } finally { await fake.close(); }
    }
  });
  it('rejects a non-private endpoint and cancelled work before connecting', async () => {
    assert.throws(() => createPrivateRconTransport({ host: 'public-host' as '127.0.0.1', port: 25575, password: 'dummy-test-only' }));
    assert.throws(() => createPrivateRconTransport({ host: '127.0.0.1', port: 25575, password: 'dummy\nkey' }));
    const transport = createPrivateRconTransport({ host: '127.0.0.1', port: 1, password: 'dummy-test-only' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(transport.sample(controller.signal), /cancelled/);
  });
  it('a still-positive old lease cannot confirm a failed status publication', async () => {
    const options = { noEffect: false }; const fake = await fakeRcon(options);
    try {
      const transport = createPrivateRconTransport({ host: '127.0.0.1', port: fake.port, password: 'dummy-test-only' });
      const session = 'c'.repeat(32), signal = new AbortController().signal;
      await transport.open(binding, session, signal); await transport.heartbeat(session, 'offline', 'none', 0, signal);
      options.noEffect = true;
      await assert.rejects(transport.heartbeat(session, 'online', 'none', 0, signal), /heartbeat unconfirmed/);
      await assert.rejects(transport.heartbeat(session, 'offline', 'auth_required', 0, signal), /heartbeat unconfirmed/);
      assert.equal(fake.mailbox.value.display, 1); assert.equal(fake.mailbox.value.blocker, 0);
    } finally { await fake.close(); }
  });
  it('wires exported managed entry point from fake owner mailbox through manager on/off/status and teardown', async () => {
    const fake = await fakeRcon(), manager = new Manager(), controller = new AbortController();
    const health: string[] = [];
    try {
      const handle = await startManagedVanillaBridge({ binding, manager, rcon: { host: '127.0.0.1', port: fake.port, password: 'dummy-test-only' }, signal: controller.signal, now: () => manager.now, onHealth: (h) => health.push(h.display) });
      assert.equal(handle.status().state, 'ready'); fake.mailbox.request(1);
      for (let n = 0; n < 100 && manager.requests.length < 1; n++) await delay(10);
      assert.equal(manager.requests[0]?.action, 'on'); manager.online();
      for (let n = 0; n < 100 && !health.includes('online'); n++) await delay(10);
      assert.ok(health.includes('online')); fake.mailbox.request(2);
      for (let n = 0; n < 100 && manager.requests.length < 2; n++) await delay(10);
      assert.equal(manager.requests[1]?.action, 'off'); manager.offline();
      for (let n = 0; n < 100 && handle.status().display !== 'offline'; n++) await delay(10);
      assert.equal(handle.status().display, 'offline');
      assert.equal(handle.status().state, 'ready', 'bot logout does not stop bridge');
      await handle.stop(); await handle.done; assert.equal(fake.mailbox.value.session, 'closed');
    } finally { controller.abort(); await fake.close(); }
  });
});

describe('pack structure and authority surface (syntax/world proof deferred)', () => {
  it('has closed function references, task-owned objectives, exact modern pack metadata and no gameplay/admin escape', () => {
    const root = new URL('../assets/datapacks/chunkbot-control/', import.meta.url);
    const pack = JSON.parse(readFileSync(new URL('pack.mcmeta', root), 'utf8')) as { pack: { min_format: number[]; max_format: number[] } };
    assert.deepEqual(pack.pack.min_format, [101, 1]); assert.deepEqual(pack.pack.max_format, [107, 1]);
    const dir = new URL('data/chunkbot_control/function/', root);
    const functions = readdirSync(dir).filter((x) => x.endsWith('.mcfunction'));
    assert.ok(functions.length >= 20);
    for (const filename of functions) {
      const text = readFileSync(new URL(filename, dir), 'utf8');
      for (const match of text.matchAll(/function chunkbot_control:([a-z_]+)/g)) assert.ok(functions.includes(`${match[1]}.mcfunction`), `${filename} reference ${match[1]} exists`);
      assert.doesNotMatch(text, /(?:^|\n)\$?(?:op |deop |stop(?:\s|$)|save-|fill |setblock |tp |teleport |summon |kill |forceload |gamerule )/);
      assert.doesNotMatch(text, /\b(?:Pos|position|SelectedItem|Inventory)\b/);
      assert.doesNotMatch(text, /if data storage chunkbot_control:bridge state \{/, 'NBT path matcher is part of the path token');
      for (const m of text.matchAll(/scoreboard objectives (?:add|remove) (\w+)/g)) assert.ok(['chunkbot_on', 'chunkbot_off', 'chunkbot_status', 'cb_ctl', 'cb_leave'].includes(m[1]!));
    }
    const owner = readFileSync(new URL('tick_owner.mcfunction', dir), 'utf8');
    assert.ok(owner.indexOf('request_off') < owner.indexOf('request_on'), 'off precedence before on');
    assert.match(owner, /#off_latch cb_ctl matches 0/);
    assert.match(readFileSync(new URL('pulse_apply.mcfunction', dir), 'utf8'), /#display cb_ctl matches 1 if score #request cb_ctl matches 0/);
    assert.match(readFileSync(new URL('request.mcfunction', dir), 'utf8'), /set from entity @s UUID/);
    assert.match(readFileSync(new URL('tick_bound.mcfunction', dir), 'utf8'), /nbt=\{UUID:\[I;\$\(a\),\$\(b\),\$\(c\),\$\(d\)\]\}/);
    assert.match(readFileSync(new URL('load.mcfunction', dir), 'utf8'), /function chunkbot_control:reset/);
    assert.match(readFileSync(new URL('status.mcfunction', dir), 'utf8'), /heartbeat expired/);
    const fence = readFileSync(new URL('fence_on.mcfunction', dir), 'utf8');
    assert.match(fence, /scoreboard players reset \* chunkbot_on/); assert.doesNotMatch(fence, /scoreboard players reset .* chunkbot_off/);
    assert.match(readFileSync(new URL('request.mcfunction', dir), 'utf8'), /state.request.managerGeneration/);
  });
});
