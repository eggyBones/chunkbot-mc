import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config/load.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { ChunkbotApp } from '../src/app/app.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { FakeGame, ScriptedPlanner, clarify, until } from './helpers.ts';

const config = parseConfig({
  minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' },
  bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true },
  owner: { name: 'FixtureOwner' },
});

const OWNER = { senderUuid: offlinePlayerUuid('FixtureOwner'), senderListName: 'FixtureOwner' };
const GUEST = { senderUuid: offlinePlayerUuid('FixtureGuest'), senderListName: 'FixtureGuest' };

function makeApp(planner?: ScriptedPlanner, exitOnConnectionEnd = false, extensions?: ConstructorParameters<typeof ChunkbotApp>[0]['extensions']) {
  const game = new FakeGame();
  game.selfUuid = offlinePlayerUuid('Chunkbot');
  const store = new MemoryRunStore();
  const lines: string[] = [];
  const app = new ChunkbotApp({
    config,
    game,
    store,
    clock: { now: () => Date.now() },
    ids: sequentialIds(),
    out: (l) => lines.push(l),
    runFacts: {},
    ...(planner ? { adapters: { planner } } : {}),
    exitOnConnectionEnd,
    ...(extensions ? { extensions } : {}),
  });
  return { app, game, store, lines };
}

async function readyApp(planner?: ScriptedPlanner) {
  const h = makeApp(planner);
  const connected = h.app.connect();
  h.game.completeJoin();
  await connected;
  return h;
}

describe('both control surfaces reach the same intake', () => {
  it('admits owner chat goals (implicit and alias) and terminal goals', async () => {
    const { app, game, store } = await readyApp();
    game.chat({ kind: 'player', text: '!chunkbot collect stone', ...OWNER });
    await until(() => app.engine.status().goal?.state === 'blocked');
    game.chat({ kind: 'player', text: '!chunkbot goal get resources and make yourself armor', ...OWNER });
    await until(() => app.engine.status().goal?.instruction === 'get resources and make yourself armor' && app.engine.status().goal?.state === 'blocked');
    await app.handleTerminalLine('follow me, then fish until sunset');
    await until(() => app.engine.status().goal?.instruction === 'follow me, then fish until sunset' && app.engine.status().goal?.state === 'blocked');
    const admitted = store.ofType('goal_admitted').map((e) => e['surface']);
    assert.deepEqual(admitted, ['chat', 'chat', 'terminal']);
    assert.ok(game.replies.some((r) => /accepted/.test(r)));
    assert.ok(game.replies.some((r) => /planner_not_ready/.test(r)));
  });

  it('status works from both surfaces without inference', async () => {
    const planner = new ScriptedPlanner();
    const { app, game, lines } = await readyApp(planner);
    await app.handleTerminalLine('status');
    game.chat({ kind: 'player', text: '!chunkbot status', ...OWNER });
    await until(() => game.replies.some((r) => r.startsWith('Status:')));
    assert.ok(lines.some((l) => /\[status\] connection: ready version=26\.1\.2 protocol=775 dimension=overworld/.test(l)));
    assert.ok(lines.some((l) => /\[status\] goal: idle/.test(l)));
    assert.equal(planner.requests.length, 0);
  });
});

describe('owner admission in the app', () => {
  it('ignores other players, server text, and unprefixed chat without creating goals or storing their text', async () => {
    const { app, game, store, lines } = await readyApp();
    game.chat({ kind: 'player', text: '!chunkbot come here', ...GUEST });
    game.chat({ kind: 'system', text: '<FixtureOwner> !chunkbot spoofed tellraw' });
    game.chat({ kind: 'profileless', text: '[Server] !chunkbot spoofed say' });
    game.chat({ kind: 'player', text: 'hello chunkbot, nice day', ...OWNER });
    game.chat({ kind: 'player', text: '!chunkbot echo', senderUuid: offlinePlayerUuid('Chunkbot'), senderListName: 'Chunkbot' });
    await until(() => store.ofType('chat_rejected').length === 4);
    assert.equal(app.engine.status().goal, undefined);
    assert.deepEqual(
      store.ofType('chat_rejected').map((e) => e['reason']),
      ['not_owner', 'system_message', 'profileless_message', 'self'],
    );
    const evidence = JSON.stringify(store.events);
    assert.ok(!evidence.includes('spoofed') && !evidence.includes('nice day') && !evidence.includes('come here'));
    assert.ok(lines.some((l) => /ignored player message addressed to Chunkbot \(not_owner\)/.test(l)));
  });
});

describe('stop and no-question policy across surfaces (MB-PLAN-006)', () => {
  it('a legacy clarification never reaches chat or terminal; stop from chat cancels; a stray answer does not revive it', async () => {
    const planner = new ScriptedPlanner();
    const { app, game, lines } = await readyApp(planner);
    game.chat({ kind: 'player', text: '!chunkbot make armor', ...OWNER });
    await until(() => planner.waiting === 1);
    planner.respond(clarify('Leather or iron?'));
    await until(() => planner.requests.length === 2);
    assert.equal(planner.requests[1]?.turnKind, 'repair');
    assert.notEqual(app.engine.status().goal?.state, 'awaiting_owner');
    assert.ok(!lines.some((l) => /Leather or iron|Question q\d/.test(l)), 'terminal shows no question');
    assert.ok(!game.replies.some((r) => /Leather or iron|Question q\d/.test(r)), 'chat shows no question');
    game.chat({ kind: 'player', text: '!chunkbot stop', ...OWNER });
    await until(() => app.engine.status().goal?.state === 'cancelled');
    await app.handleTerminalLine('answer q1 iron');
    game.chat({ kind: 'player', text: '!chunkbot answer yes', ...OWNER });
    await until(() => game.replies.some((r) => /Reply not applied/.test(r)));
    assert.equal(app.engine.status().goal?.state, 'cancelled');
    assert.equal(planner.requests.length, 2);
  });

  it('terminal stop while idle reports nothing to stop', async () => {
    const { app, lines } = await readyApp();
    await app.handleTerminalLine('stop');
    assert.ok(lines.some((l) => /Nothing to stop; Chunkbot is idle/.test(l)));
  });

  it('with automatic work installed, idle stop and resume say what the latch means (MB-FLOW-001)', async () => {
    const h = makeApp(undefined, false, { autonomyStatus: () => ({ lines: [], chat: 'automatic: idle', automatic: true }) });
    const connected = h.app.connect();
    h.game.completeJoin();
    await connected;
    await h.app.handleTerminalLine('stop');
    assert.ok(h.lines.some((l) => /Nothing was running; automatic work stays paused until you say resume/.test(l)));
    assert.equal(h.app.engine.status().latch.paused, true);
    await h.app.handleTerminalLine('resume');
    assert.ok(h.lines.some((l) => /Resumed: automatic work is allowed again\. Nothing earlier is replayed; automatic work restarts from a fresh assessment\./.test(l)));
  });
});

describe('lifecycle', () => {
  it('stop during joining cancels the join', async () => {
    const { app, game, store } = makeApp();
    const join = app.connect();
    assert.equal(game.state, 'joining');
    await app.handleTerminalLine('stop');
    assert.equal(await join, undefined);
    assert.equal(game.state, 'ended');
    assert.equal(app.lastConnectionEnd?.reason, 'operator_stop');
    assert.equal(store.ofType('join_cancel_requested').length, 1);
  });

  it('goals are rejected while joining and after disconnect', async () => {
    const { app, game, store } = makeApp();
    void app.connect();
    await app.handleTerminalLine('collect stone');
    assert.equal(store.ofType('instruction_rejected')[0]?.['reason'], 'not_connected');
    game.completeJoin();
    game.end('kicked', 'Kicked by an operator');
    await app.handleTerminalLine('collect stone');
    assert.equal(store.ofType('instruction_rejected').length, 2);
  });

  it('death and dimension change end ownership; respawn and reconnect start idle', async () => {
    const planner = new ScriptedPlanner();
    const { app, game, lines } = await readyApp(planner);
    await app.handleTerminalLine('guard the house');
    await until(() => planner.waiting === 1);
    game.emit({ type: 'death', connectionEpoch: 1 });
    assert.ok(lines.some((l) => /bot died; ending active goal ownership/.test(l)));
    await until(() => app.engine.status().goal?.terminal?.reason === 'death');
    game.emit({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    assert.ok(lines.some((l) => /respawned in overworld; idle \(goals never auto-resume\)/.test(l)));
    assert.equal(planner.requests.length, 1);

    await app.handleTerminalLine('collect wood');
    await until(() => planner.waiting === 2);
    game.emit({ type: 'dimension_change', connectionEpoch: 1, from: 'overworld', to: 'the_nether' });
    assert.ok(lines.some((l) => /dimension changed overworld -> the_nether; ending active goal ownership/.test(l)));
    await until(() => app.engine.status().goal?.terminal?.reason === 'dimension_change');

    await app.handleTerminalLine('collect wood again');
    await until(() => planner.waiting === 3);
    game.end('kicked', 'Kicked by an operator');
    await until(() => app.engine.status().goal?.terminal?.reason === 'kicked');
    assert.ok(lines.some((l) => /Use \/reconnect to join again/.test(l)));

    const rejoin = app.handleTerminalLine('/reconnect');
    await until(() => game.state === 'joining');
    game.completeJoin();
    await rejoin;
    assert.equal(game.state, 'ready');
    assert.equal(app.engine.status().goal?.state, 'failed', 'previous goal stays terminal; nothing resumes');
    assert.equal(planner.requests.length, 3);
  });

  it('shutdown cancels the goal, disconnects the bot, closes evidence, and resolves closed', async () => {
    const planner = new ScriptedPlanner();
    const { app, game, store } = await readyApp(planner);
    await app.handleTerminalLine('build a tower');
    await until(() => planner.waiting === 1);
    const code = await app.shutdown('signal');
    assert.equal(code, 0);
    assert.equal(await app.closed, 0);
    assert.deepEqual(game.disconnects, ['shutdown_signal']);
    assert.equal(app.engine.status().goal?.terminal?.reason, 'shutdown');
    assert.equal(planner.signals[0]?.aborted, true);
    assert.equal((store.summary?.['lastGoal'] as Record<string, unknown>)['state'], 'cancelled');
    // Idempotent.
    assert.equal(await app.shutdown('operator_quit'), 0);
    assert.equal(game.disconnects.length, 1);
  });

  it('without an operator terminal, a lost connection shuts down with exit code 3 and closes evidence', async () => {
    const h = makeApp(undefined, true);
    const connected = h.app.connect();
    h.game.completeJoin();
    await connected;
    h.game.end('kicked', 'Kicked by an operator');
    assert.equal(await h.app.closed, 3);
    assert.equal(h.store.summary?.['shutdownReason'], 'connection_ended');
  });

  it('/quit during joining cancels the join and shuts down', async () => {
    const { app, game } = makeApp();
    void app.connect();
    await app.handleTerminalLine('/quit');
    assert.equal(await app.closed, 0);
    assert.equal(game.state, 'ended');
  });
});
