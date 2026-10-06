// MB-FLOW-002 through the real application composition (fake game/ports, no inference):
// owner chat during an executing goal is acknowledged and prepared, status shows
// the active task and the pending instruction separately, a chat stop clears
// both and sets the pause latch, and the config `flow` section is backward compatible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config/load.ts';
import { parseChatLine, parseTerminalLine } from '../src/commands/parse.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { ChunkbotApp } from '../src/app/app.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { FakeGame, until } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, cobble, finitePlan, followPlan, holdUntilRevoked, task } from './handoff-fakes.ts';

const base = {
  minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' },
  bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true },
  owner: { name: 'FixtureOwner' },
};
const OWNER = { senderUuid: offlinePlayerUuid('FixtureOwner'), senderListName: 'FixtureOwner' };
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });

async function readyApp(raw: Record<string, unknown> = base) {
  const config = parseConfig(raw);
  const game = new FakeGame();
  game.selfUuid = offlinePlayerUuid('Chunkbot');
  const store = new MemoryRunStore();
  const lines: string[] = [];
  const log: string[] = [];
  const planner = new DelayedPlanner((r) => (r.instruction === 'follow me' ? { kind: 'reply', proposal: followPlan() } : { kind: 'reply', proposal: finitePlan([task('mine two', cobble(2))], cobble(2), false), delayMs: 400 }));
  const tasks = new FakeTaskRuntime(log);
  tasks.behaviors.set('stay near the owner', holdUntilRevoked);
  tasks.behaviors.set('mine two', holdUntilRevoked);
  const app = new ChunkbotApp({
    config,
    game,
    store,
    clock: { now: () => Date.now() },
    ids: sequentialIds(),
    out: (l) => lines.push(l),
    runFacts: {},
    adapters: {
      planner,
      tasks,
      outcomes: new FakeServer(log),
      observation: new FakeWorld(),
      capabilities: new StaticCapabilityRegistry({ catalogVersion: 'test-app', capabilities: [cap('mine_block'), cap('follow_entity')] }),
      executor: { readiness: () => ({ ready: true, detail: 'fake' }), execute: async () => { throw new Error('unused'); } },
      registry: new VersionKnowledge({ version: '26.1.2' }),
    },
  });
  const connected = app.connect();
  game.completeJoin();
  await connected;
  return { app, game, store, lines, planner, tasks };
}

describe('smooth handoff through the application', () => {
  it('owner chat while following is acknowledged in game, status shows both contexts, and the switch happens after the draft', async () => {
    const h = await readyApp();
    h.game.chat({ kind: 'player', text: '!chunkbot follow me', ...OWNER });
    await until(() => h.tasks.runs.length === 1 && h.app.engine.status().goal?.state === 'executing');
    h.game.chat({ kind: 'player', text: '!chunkbot get two cobblestone', ...OWNER });
    await until(() => h.game.replies.some((r) => /^Preparing your new instruction: "get two cobblestone"; continuing the current task until handoff\.$/.test(r)));
    await h.app.handleTerminalLine('status');
    h.game.chat({ kind: 'player', text: '!chunkbot status', ...OWNER });
    await until(() => h.game.replies.some((r) => r.startsWith('Status:')));
    assert.ok(h.lines.some((l) => /\[status\] goal: goal-0001 executing "follow me"/.test(l)));
    assert.ok(h.lines.some((l) => /\[status\] task: task-0001 \(maintain\) "stay near the owner"/.test(l)));
    assert.ok(h.lines.some((l) => /\[status\] pending instruction: intent-0001 preparing "get two cobblestone" \(planner turns 1; not admitted; goal-0001 keeps control until handoff\)/.test(l)), h.lines.join('\n'));
    assert.match(h.game.replies.find((r) => r.startsWith('Status:'))!, /goal executing, new instruction preparing/);
    await until(() => h.app.engine.status().goal?.instruction === 'get two cobblestone' && h.tasks.runs.length === 2, 3_000);
    assert.ok(h.game.replies.some((r) => /^Goal goal-0002 accepted: "get two cobblestone" \(prepared while the previous work continued; 1 planner turn\)/.test(r)));
    await h.app.shutdown('operator_quit');
  });

  it('a chat stop during preparation clears both contexts and shows the pause latch', async () => {
    const h = await readyApp();
    await h.app.handleTerminalLine('follow me');
    await until(() => h.tasks.runs.length === 1);
    await h.app.handleTerminalLine('get two cobblestone');
    await until(() => h.planner.count === 2);
    h.game.chat({ kind: 'player', text: '!chunkbot stop', ...OWNER });
    await until(() => h.app.engine.status().goal?.state === 'cancelled');
    assert.equal(h.app.engine.status().pending, undefined);
    assert.equal(h.planner.signals[1]?.aborted, true);
    await h.app.handleTerminalLine('status');
    assert.ok(h.lines.some((l) => /\[status\] paused: stop latch set from chat/.test(l)));
    assert.ok(h.lines.some((l) => /handoff totals: preparations 1 \(handed off 0, discarded 1; discarded planner turns 1\/40/.test(l)));
    await h.app.shutdown('operator_quit');
  });

  it('resume is a bare command that clears the stop latch; longer text stays an instruction', async () => {
    assert.deepEqual(parseChatLine('!chunkbot resume', '!chunkbot'), { kind: 'resume' });
    assert.deepEqual(parseTerminalLine('Resume.', '!chunkbot'), { kind: 'resume' });
    assert.deepEqual(parseChatLine('!chunkbot resume mining the tunnel', '!chunkbot'), { kind: 'goal', instruction: 'resume mining the tunnel', via: 'implicit' });
    const h = await readyApp();
    h.game.chat({ kind: 'player', text: '!chunkbot resume', ...OWNER });
    await until(() => h.game.replies.includes('Not paused; nothing to resume.'));
    h.game.chat({ kind: 'player', text: '!chunkbot stop', ...OWNER });
    await until(() => h.app.engine.status().latch.paused);
    assert.equal(h.app.engine.autonomyAllowed(), false);
    h.game.chat({ kind: 'player', text: '!chunkbot resume', ...OWNER });
    await until(() => h.game.replies.some((r) => r.startsWith('Resumed: the stop latch is cleared')));
    assert.equal(h.app.engine.autonomyAllowed(), true);
    assert.equal(h.planner.count, 0, 'resume starts nothing and replays nothing');
    await h.app.shutdown('operator_quit');
  });

  it('flow config defaults are backward compatible and strict', () => {
    const cfg = parseConfig(base);
    assert.deepEqual(cfg.flow, { handoff: 'smooth', lookahead: true, preparationTurnsPerRun: 40 });
    assert.equal(parseConfig({ ...base, flow: { handoff: 'immediate' } }).flow.handoff, 'immediate');
    assert.throws(() => parseConfig({ ...base, flow: { handoff: 'eventually' } }));
    assert.throws(() => parseConfig({ ...base, flow: { unknownKnob: true } }));
  });
});
