// MineflayerConnection against a fake bot that emits the same events Mineflayer
// does. This verifies adapter wiring; the real join is covered by live checks.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { BotOptions } from 'mineflayer';
import type { ChatEnvelope, GameLifecycleEvent } from '../src/contracts/index.ts';
import { IdentityConflictError, MicrosoftSignInRequiredError } from '../src/game/auth.ts';
import { MineflayerConnection, reasonText, type ConnectionOptions } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { tick, until } from './helpers.ts';

class FakeClient extends EventEmitter {
  uuid = offlinePlayerUuid('Chunkbot');
  protocolVersion = 775;
  ended: string[] = [];
  /** Simulates a slow socket close (the real teardown bound is 2s). */
  endDelayMs = 0;
  socket = { destroyed: false, destroy: () => void (this.socket.destroyed = true) };
  end(reason?: string): void {
    this.ended.push(reason ?? '');
    setTimeout(() => this.emit('end', reason), this.endDelayMs);
  }
}

class FakeBot extends EventEmitter {
  _client = new FakeClient();
  username = 'Chunkbot';
  version = '26.1.2';
  health = 20;
  game: { dimension?: string; gameMode: string } = { gameMode: 'survival' };
  entity: { position: { x: number; y: number; z: number } } | undefined;
  players: Record<string, { username: string; uuid: string }> = {
    FixtureOwner: { username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner') },
  };
  whispers: Array<[string, string]> = [];
  constructor() {
    super();
    this._client.on('end', (reason: string) => this.emit('end', reason));
  }
  chunkDelayMs = 0;
  waitForChunksToLoad(): Promise<void> {
    return tick(this.chunkDelayMs);
  }
  whisper(name: string, text: string): void {
    this.whispers.push([name, text]);
  }
  chat(): void {}
  spawnInto(dimension = 'overworld'): void {
    this.emit('login');
    this.game.dimension = dimension;
    this.entity = { position: { x: 0.5, y: -60, z: 0.5 } };
    this.emit('spawn');
  }
}

function harness(overrides: Partial<ConnectionOptions> = {}) {
  const bots: FakeBot[] = [];
  const created: BotOptions[] = [];
  const pings: number[] = [];
  const events: GameLifecycleEvent[] = [];
  const chats: ChatEnvelope[] = [];
  const conn = new MineflayerConnection({
    host: '127.0.0.1',
    port: 25566,
    version: '26.1.2',
    auth: 'offline',
    username: 'Chunkbot',
    authDir: '/tmp/chunkbot-test-auth',
    joinTimeoutMs: 2_000,
    ownerName: 'FixtureOwner',
    replyMode: 'whisper',
    log: () => undefined,
    ping: async () => {
      pings.push(1);
      return { version: '26.1.2', protocol: 775 };
    },
    createBot: (options) => {
      created.push(options);
      const bot = new FakeBot();
      bots.push(bot);
      return bot as never;
    },
    ...overrides,
  });
  conn.onLifecycle((e) => events.push(e));
  conn.onChat((c) => chats.push(c));
  return { conn, bots, created, pings, events, chats };
}

describe('joining', () => {
  it('waits for spawn and valid world state, then reports version and dimension', async () => {
    const h = harness();
    const ready = h.conn.connect(new AbortController().signal);
    await until(() => h.bots.length === 1);
    assert.equal(h.conn.state, 'joining');
    h.bots[0]?.spawnInto('overworld');
    const info = await ready;
    assert.equal(h.conn.state, 'ready');
    assert.deepEqual(info, {
      serverVersion: '26.1.2',
      protocolVersion: 775,
      dimension: 'overworld',
      position: { x: 0.5, y: -60, z: 0.5 },
      gameMode: 'survival',
      serverOnlineMode: false,
    });
    assert.equal(h.created[0]?.auth, 'offline');
    assert.equal(h.created[0]?.profilesFolder, '/tmp/chunkbot-test-auth');
    assert.deepEqual(h.events.map((e) => e.type), ['joining', 'ready']);
  });

  it('refuses a server whose protocol differs from the configured version, before logging in', async () => {
    const h = harness({ ping: async () => ({ version: '26.2', protocol: 776 }) });
    await assert.rejects(h.conn.connect(new AbortController().signal), /server reports 26\.2 \(protocol 776\)/);
    assert.equal(h.bots.length, 0);
    assert.equal(h.conn.state, 'ended');
  });

  it('cancels joining on abort and closes the client', async () => {
    const h = harness();
    const abort = new AbortController();
    const ready = h.conn.connect(abort.signal);
    await until(() => h.bots.length === 1);
    abort.abort();
    await assert.rejects(ready, /join cancelled by operator/);
    assert.equal(h.conn.state, 'ended');
    assert.deepEqual(h.bots[0]?._client.ended, ['disconnect.quitting']);
    const ended = h.events.at(-1);
    assert.equal(ended?.type === 'ended' && ended.reason, 'operator_stop');
  });

  it('times out a join that never spawns', async () => {
    const h = harness({ joinTimeoutMs: 50 });
    await assert.rejects(h.conn.connect(new AbortController().signal), /no valid spawn within 50ms/);
  });

  it('refuses to join as the owner identity', async () => {
    const h = harness();
    const ready = h.conn.connect(new AbortController().signal);
    await until(() => h.bots.length === 1);
    const bot = h.bots[0];
    assert.ok(bot);
    bot.username = 'FixtureOwner';
    bot.emit('login');
    await assert.rejects(ready, /owner's player name/);
  });
});

describe('Microsoft auth guard', () => {
  it('fails with auth_required and no network contact when no token cache exists', async () => {
    const h = harness({ auth: 'microsoft', hasTokenCache: () => false });
    await assert.rejects(h.conn.connect(new AbortController().signal), /run `npm run chunkbot -- auth login`/);
    assert.equal(h.pings.length, 0);
    assert.equal(h.bots.length, 0);
    const ended = h.events.at(-1);
    assert.equal(ended?.type === 'ended' && ended.reason, 'auth_required');
  });

  it('maps an expired session to auth_required and an owner-identity bot to identity_conflict; never falls back to offline', async () => {
    const expired = harness({
      auth: 'microsoft',
      hasTokenCache: () => true,
      resolveProfile: async () => {
        throw new MicrosoftSignInRequiredError();
      },
    });
    await assert.rejects(expired.conn.connect(new AbortController().signal), /sign-in is required/);
    assert.equal(expired.bots.length, 0);

    const conflict = harness({
      auth: 'microsoft',
      hasTokenCache: () => true,
      resolveProfile: async () => {
        throw new IdentityConflictError();
      },
    });
    await assert.rejects(conflict.conn.connect(new AbortController().signal), /separate Minecraft account/);
    const ended = conflict.events.at(-1);
    assert.equal(ended?.type === 'ended' && ended.reason, 'identity_conflict');

    const ok = harness({ auth: 'microsoft', hasTokenCache: () => true, resolveProfile: async () => ({ name: 'Chunkbot', uuid: 'x' }) });
    void ok.conn.connect(new AbortController().signal).catch(() => undefined);
    await until(() => ok.created.length === 1);
    assert.equal(ok.created[0]?.auth, 'microsoft');
    assert.throws(() => ok.created[0]?.onMsaCode?.({} as never), MicrosoftSignInRequiredError);
    await ok.conn.disconnect('operator_stop');
  });
});

describe('late completions never take ownership (MB-FND-001)', () => {
  it('a profile lookup that finishes after the join timeout creates no client, and settles without waiting for it', async () => {
    let lookups = 0;
    const h = harness({
      auth: 'microsoft',
      joinTimeoutMs: 20,
      hasTokenCache: () => true,
      resolveProfile: async () => {
        lookups += 1;
        await tick(70);
        return { name: 'Chunkbot', uuid: 'x' };
      },
    });
    const started = Date.now();
    await assert.rejects(h.conn.connect(new AbortController().signal), /no valid spawn within 20ms/);
    assert.ok(Date.now() - started < 60, 'join settles at the timeout, not after the auth call');
    assert.equal(h.conn.state, 'ended');
    await tick(100);
    assert.equal(lookups, 1);
    assert.equal(h.bots.length, 0, 'no client may be created after timeout');
  });

  it('a late lookup from an abandoned join cannot affect a replacement connection', async () => {
    // Controlled resolution (MB-FND-003): the abandoned join's profile lookup is a
    // deferred promise released by the test only AFTER the replacement is ready,
    // so ordering does not depend on scheduler timing. The join window (150ms) is a
    // realistic success margin for the replacement; the abandoned join still times out.
    let releaseFirst: (() => void) | undefined;
    const firstLookup = new Promise<void>((resolve) => (releaseFirst = resolve));
    let lookups = 0;
    const h = harness({
      auth: 'microsoft',
      joinTimeoutMs: 150,
      hasTokenCache: () => true,
      resolveProfile: async () => {
        lookups += 1;
        if (lookups === 1) await firstLookup; // the abandoned join's lookup hangs until released
        return { name: 'Chunkbot', uuid: 'x' };
      },
    });
    await assert.rejects(h.conn.connect(new AbortController().signal), /no valid spawn within 150ms/);
    assert.equal(h.bots.length, 0, 'the timed-out join created no client');
    const replacement = h.conn.connect(new AbortController().signal);
    await until(() => h.bots.length === 1);
    h.bots[0]?.spawnInto('overworld');
    await replacement;
    releaseFirst?.(); // the first join's lookup completes now, after the replacement is ready
    await tick(50);
    assert.equal(lookups, 2);
    assert.equal(h.bots.length, 1, 'only the replacement created a client');
    assert.equal(h.conn.state, 'ready');
    assert.equal(h.conn.connectionEpoch, 2);
    await h.conn.disconnect('operator_stop');
  });

  it('a join that times out while chunks load never reports ready', async () => {
    const h = harness({ joinTimeoutMs: 30 });
    const pending = h.conn.connect(new AbortController().signal);
    await until(() => h.bots.length === 1);
    const bot = h.bots[0];
    assert.ok(bot);
    bot.chunkDelayMs = 80;
    bot._client.endDelayMs = 300; // the socket is still closing when chunks finish loading
    bot.spawnInto('overworld');
    await assert.rejects(pending, /no valid spawn within 30ms/);
    await tick(120);
    assert.notEqual(h.conn.state, 'ready');
    await tick(250);
    assert.equal(h.conn.state, 'ended');
    assert.ok(!h.events.some((e) => e.type === 'ready'), 'no ready event after timeout');
    assert.deepEqual(bot._client.ended, ['disconnect.quitting']);
  });

  it('abort during a slow lookup settles immediately and creates no client', async () => {
    const h = harness({
      auth: 'microsoft',
      hasTokenCache: () => true,
      resolveProfile: async () => {
        await tick(80);
        return { name: 'Chunkbot', uuid: 'x' };
      },
    });
    const abort = new AbortController();
    const pending = h.conn.connect(abort.signal);
    await tick(10);
    abort.abort();
    await assert.rejects(pending, /join cancelled by operator/);
    await tick(100);
    assert.equal(h.bots.length, 0);
  });
});

describe('after ready', () => {
  async function readyHarness() {
    const h = harness();
    const ready = h.conn.connect(new AbortController().signal);
    await until(() => h.bots.length === 1);
    const bot = h.bots[0];
    assert.ok(bot);
    bot.spawnInto('overworld');
    await ready;
    return { ...h, bot };
  }

  it('classifies player, system, and profileless chat by packet', async () => {
    const { bot, chats } = await readyHarness();
    bot._client.emit('playerChat', { sender: offlinePlayerUuid('FixtureOwner'), plainMessage: '!chunkbot status', verified: false });
    bot._client.emit('systemChat', { formattedMessage: JSON.stringify({ text: '<FixtureOwner> !chunkbot spoof' }), positionId: 1 });
    bot._client.emit('playerChat', { formattedMessage: JSON.stringify({ text: '!chunkbot console say' }), verified: false });
    bot._client.emit('systemChat', { formattedMessage: '"action bar"', positionId: 2 });
    assert.deepEqual(
      chats.map((c) => [c.kind, c.text, c.senderListName]),
      [
        ['player', '!chunkbot status', 'FixtureOwner'],
        ['system', '<FixtureOwner> !chunkbot spoof', undefined],
        ['profileless', '!chunkbot console say', undefined],
      ],
    );
  });

  it('emits death, respawn, and dimension change; ends on kick with the kick reason', async () => {
    const { bot, conn, events } = await readyHarness();
    bot.emit('death');
    bot.emit('spawn');
    bot.game.dimension = 'the_nether';
    bot.emit('game');
    bot.emit('kicked', JSON.stringify({ text: 'Kicked by an operator' }));
    bot._client.emit('end', 'socketClosed');
    await until(() => conn.state === 'ended');
    assert.deepEqual(
      events.slice(2).map((e) => (e.type === 'ended' ? `${e.type}:${e.reason}:${e.detail}` : e.type === 'dimension_change' ? `${e.type}:${e.from}->${e.to}` : e.type)),
      ['death', 'respawn', 'dimension_change:overworld->the_nether', 'ended:kicked:Kicked by an operator'],
    );
  });

  it('disconnect closes the client and is idempotent; replies whisper to the owner', async () => {
    const { bot, conn } = await readyHarness();
    conn.replyToOwner('/op me please\nnow');
    await tick(5);
    assert.deepEqual(bot.whispers, [['FixtureOwner', 'op me please now']]);
    await conn.disconnect('shutdown_signal');
    assert.equal(conn.state, 'ended');
    await conn.disconnect('shutdown_signal');
    assert.equal(bot._client.ended.length, 1);
  });
});

describe('reasonText', () => {
  it('flattens chat components', () => {
    assert.equal(reasonText({ translate: 'multiplayer.disconnect.kicked' }), 'multiplayer.disconnect.kicked');
    assert.equal(reasonText(JSON.stringify({ text: 'a', extra: [{ text: 'b' }] })), 'ab');
    assert.equal(reasonText('plain'), 'plain');
  });
});
