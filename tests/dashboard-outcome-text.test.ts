// The goal outcome contract is shown to the owner as a concise sentence built
// generically from the code-owned predicate vocabulary; unreadable/truncated
// contracts are never guessed at (technical text only).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeOutcome } from '../src/dashboard/outcome-text.ts';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { remoteMetadata } from '../src/dashboard/remote.ts';
import { StatusFollower, buildViewModel } from '../src/dashboard/viewmodel.ts';
import { FakeConnection } from './dashboard-fakes.ts';

const fin = (p: unknown) => `finite: ${JSON.stringify(p)}`;

describe('goal outcome summary', () => {
  it('renders atomic predicates in plain words', () => {
    assert.equal(describeOutcome(fin({ predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 8, mayBeConsumedLater: false })).summary, 'Done when the bot gains 8 of any logs since the goal started.');
    assert.equal(describeOutcome(fin({ predicate: 'inventory_amount', selector: 'minecraft:oak_planks', atLeast: 4, mode: 'possess' })).summary, 'Done when the bot holds at least 4 oak planks.');
    assert.equal(describeOutcome(fin({ predicate: 'crafting_result', output: 'minecraft:crafting_table', atLeast: 1 })).summary, 'Done when the bot crafts 1 crafting table.');
    assert.equal(describeOutcome(fin({ predicate: 'equipped', selector: 'minecraft:iron_helmet', slot: 'head' })).summary, 'Done when the bot has iron helmet in its head slot.');
    assert.equal(describeOutcome(`persistent: ${JSON.stringify({ predicate: 'near_target', target: { kind: 'owner' }, within: 3 })}`).summary, 'Keeps going while the bot is within 3 blocks of you (until stopped or blocked).');
  });

  it('composes all/any/not generically', () => {
    const s = describeOutcome(
      fin({
        predicate: 'all',
        of: [
          { predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 3, mayBeConsumedLater: true },
          { predicate: 'any', of: [{ predicate: 'crafting_result', output: 'minecraft:stone_pickaxe', atLeast: 1 }, { predicate: 'equipped', selector: 'minecraft:stone_pickaxe', slot: 'hand' }] },
        ],
      }),
    ).summary;
    assert.equal(s, 'Done when the bot gains 3 cobblestone since the goal started (they may be used up afterwards) and (crafts 1 stone pickaxe or has stone pickaxe in its main hand).');
    assert.match(describeOutcome(fin({ predicate: 'not', of: { predicate: 'near_target', target: { kind: 'owner' }, within: 5 } })).summary!, /no longer meets this: is within 5 blocks of you/);
  });

  it('never invents a summary for truncated or foreign text', () => {
    const truncated = fin({ predicate: 'all', of: [{ predicate: 'crafting_result', output: 'minecraft:furnace', atLeast: 1 }] }).slice(0, 40) + '…';
    assert.deepEqual(describeOutcome(truncated), { summary: null, technical: truncated });
    assert.equal(describeOutcome(fin({ predicate: 'teleport_home' })).summary, null);
    assert.equal(describeOutcome('something else').summary, null);
  });

  it('the owner flow shows the sentence; raw JSON is only the optional technical detail', () => {
    const clock = { t: 1_000 };
    const raw = fin({ predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 8, mayBeConsumedLater: false });
    const pub = new DashboardStatusPublisher({
      statusPath: '/dev/null/never',
      runId: 'run-outcome1',
      pid: 1,
      now: () => clock.t,
      game: new FakeConnection(clock),
      profile: { version: '26.2', supportLevel: 'local-compat' },
      engine: () => ({ goal: { id: 'goal-oc01', epoch: 1, instruction: 'get logs', origin: { surface: 'chat', principal: 'owner' }, state: 'executing', admittedAtMs: 1, updatedAtMs: 1, plannerTurns: 1, progress: '', outcome: raw }, readiness: { planner: { ready: true, detail: '' }, knowledge: { ready: true, detail: '' }, observation: { ready: true, detail: '' }, executor: { ready: true, detail: '' }, capabilityCount: 1, catalogVersion: 'x', tasks: { ready: true, detail: '' } } }) as never,
    });
    const f = new StatusFollower();
    const s = pub.snapshot();
    f.accept({ kind: 'ok', status: { ...s, publisher: { ...s.publisher, seq: 1 } } });
    const vm = buildViewModel({ follower: f, now: clock.t, pidAlive: () => true, history: undefined, remote: remoteMetadata({}), timeZone: 'UTC' });
    const row = vm.directive.details.find((r) => r.label === 'Goal outcome')!;
    assert.equal(row.value, 'Done when the bot gains 8 of any logs since the goal started.');
    assert.ok(vm.directive.details.every((r) => !r.value.includes('{"predicate"')), 'no raw predicate JSON in the main flow');
    assert.equal(vm.directive.outcomeTechnical, raw);
  });
});
