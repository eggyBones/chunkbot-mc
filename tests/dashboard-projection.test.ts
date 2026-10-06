// MB-UI-001 publisher projection: server-backed vitals/inventory through the
// real evidence journal, epoch/death/disconnect semantics, directive states,
// schema validity and redaction of the published snapshot.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DashboardStatusSchema, type DashboardStatus } from '../src/contracts/dashboard.ts';
import type { GoalRecord } from '../src/contracts/index.ts';
import { inventoryIndexToWindowSlot } from '../src/dashboard/inventory.ts';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { attributeValue } from '../src/dashboard/vitals.ts';
import type { EngineStatus } from '../src/goals/goal-engine.ts';
import { FakeConnection, stack, window0 } from './dashboard-fakes.ts';

let dir: string;
let clock: { t: number };
let game: FakeConnection;
let engine: EngineStatus | undefined;

const READY = { ready: true, detail: 'ok' };
function engineStatus(goal?: Partial<GoalRecord>, task?: EngineStatus['task']): EngineStatus {
  return {
    goal: goal
      ? ({ id: 'goal-abcd', epoch: 1, instruction: 'collect 8 oak logs', origin: { surface: 'chat', principal: 'owner' }, state: 'executing', admittedAtMs: 1, updatedAtMs: 2, plannerTurns: 1, progress: '', ...goal } as GoalRecord)
      : undefined,
    readiness: { planner: READY, knowledge: READY, observation: READY, executor: READY, capabilityCount: 20, catalogVersion: 'skills-20-x', tasks: READY },
    ...(task ? { task } : {}),
  };
}

function publisher(extra: Partial<ConstructorParameters<typeof DashboardStatusPublisher>[0]> = {}) {
  return new DashboardStatusPublisher({
    statusPath: join(dir, 'status.json'),
    runId: 'run-test0001',
    pid: process.pid,
    now: () => clock.t,
    game,
    profile: { version: '26.1.2', supportLevel: 'upstream-tested' },
    engine: () => engine,
    decisionReadiness: () => ({ ready: false, detail: 'OPENROUTER_API_KEY is not set' }),
    ...extra,
  });
}

const read = (): DashboardStatus => DashboardStatusSchema.parse(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-proj-'));
  clock = { t: 1_000_000 };
  game = new FakeConnection(clock);
  engine = engineStatus();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('dashboard projection: vitals and inventory from server evidence', () => {
  it('before any server packet everything is unknown, never zero', () => {
    const p = publisher();
    game.join();
    game.ready();
    const s = p.snapshot();
    assert.equal(s.vitals.health.known, false);
    assert.equal(s.vitals.xp.known, false);
    assert.equal(s.vitals.maxHealth.known, false);
    assert.equal(s.inventory.contents.known, false);
    assert.match(JSON.stringify(s.vitals), /no health packet|no experience packet/);
  });

  it('projects health/food/XP/max health and slot inventory with provenance', () => {
    const p = publisher();
    game.join();
    game.ready();
    clock.t += 10;
    game.health(17, 18, 3.5);
    game.xp(7, 0.42, 123);
    game.bot.entity.attributes = { 'minecraft:max_health': { value: 20, modifiers: [{ amount: 4, operation: 0 }] } };
    game.bot.quickBarSlot = 2;
    game.windowItems(0, window0({ 5: stack(3, 1), 9: stack(1, 32), 36: stack(6, 1), 38: stack(5, 6), 45: stack(4, 1) }));
    const s = p.snapshot();
    assert.deepEqual(s.vitals.health, { known: true, value: 17, source: 'server_packet', observedAtMs: 1_000_010 });
    assert.equal(s.vitals.food.known && s.vitals.food.value, 18);
    assert.equal(s.vitals.saturation.known && s.vitals.saturation.value, 3.5);
    assert.equal(s.vitals.maxHealth.known && s.vitals.maxHealth.value, 24);
    assert.deepEqual(s.vitals.xp.known && s.vitals.xp.value, { level: 7, progress: 0.42, totalPoints: 123 });
    assert.ok(s.inventory.contents.known);
    assert.equal(s.inventory.contents.source, 'server_sync');
    assert.deepEqual(
      s.inventory.contents.value.slots.map((x) => [x.slot, x.item, x.count]),
      [
        [5, 'minecraft:iron_helmet', 1],
        [9, 'minecraft:oak_log', 32],
        [36, 'minecraft:stone_pickaxe', 1],
        [38, 'minecraft:bread', 6],
        [45, 'minecraft:shield', 1],
      ],
    );
    assert.equal(s.inventory.contents.value.complete, true);
    assert.deepEqual(s.inventory.selectedHotbar.known && [s.inventory.selectedHotbar.value, s.inventory.selectedHotbar.source], [2, 'client_selected']);
  });

  it('follows later set_slot and set_player_inventory updates (slot mapping incl. armor/off hand)', () => {
    const p = publisher();
    game.join();
    game.ready();
    game.windowItems(0, window0({ 9: stack(1, 1) }));
    game.setSlot(0, 9, stack(1, 5));
    game.setSlot(0, 10, stack(2, 64));
    game.playerSlot(0, stack(6, 1)); // hotbar 0 -> window 36
    game.playerSlot(39, stack(3, 1)); // head -> window 5
    game.playerSlot(40, stack(4, 1)); // off hand -> 45
    game.setSlot(0, 9, null); // emptied
    const s = p.snapshot();
    assert.ok(s.inventory.contents.known);
    assert.deepEqual(s.inventory.contents.value.slots.map((x) => `${x.slot}:${x.item}x${x.count}`), ['5:minecraft:iron_helmetx1', '10:minecraft:cobblestonex64', '36:minecraft:stone_pickaxex1', '45:minecraft:shieldx1']);
    assert.equal(inventoryIndexToWindowSlot(36), 8); // feet
    assert.equal(inventoryIndexToWindowSlot(41), undefined); // body slot is not a player inventory slot
  });

  it('maps the player region of an open container and distinguishes the container', () => {
    const p = publisher();
    game.join();
    game.ready();
    game.windowItems(0, window0({ 9: stack(1, 3), 5: stack(3, 1) }));
    game.openWindow(7, 27);
    // chest window: 0..26 chest slots, 27..53 main, 54..62 hotbar
    const items = Array.from({ length: 63 }, () => null as { itemId: number; itemCount: number } | null);
    items[0] = stack(2, 10); // chest content: NOT player inventory
    items[27] = stack(1, 7); // player main slot 9
    items[54] = stack(6, 1); // hotbar 0
    game.windowItems(7, items);
    const s = p.snapshot();
    assert.ok(s.inventory.contents.known);
    assert.deepEqual(s.inventory.contents.value.slots.map((x) => `${x.slot}:${x.count}`), ['5:1', '9:7', '36:1']);
    assert.equal(s.inventory.openContainer?.windowType, 'minecraft:generic_9x3');
    game.bot.currentWindow = null; // client closed it (no server packet)
    assert.equal(p.snapshot().inventory.openContainer, null);
  });

  it('death invalidates the inventory until the server restates it; a restatement before the respawn event is kept', () => {
    const p = publisher();
    p.start();
    game.join();
    game.ready();
    game.windowItems(0, window0({ 9: stack(1, 30) }));
    game.health(0, 0);
    game.emit({ type: 'death', connectionEpoch: game.connectionEpoch });
    let s = p.snapshot();
    assert.equal(s.inventory.contents.known, false);
    assert.match(s.inventory.contents.known ? '' : s.inventory.contents.reason, /died/);
    game.windowItems(0, window0({})); // server restatement after respawn (empty: items dropped)
    game.health(20, 20);
    game.emit({ type: 'respawn', connectionEpoch: game.connectionEpoch, dimension: 'overworld' });
    s = p.snapshot();
    assert.ok(s.inventory.contents.known && s.inventory.contents.value.complete);
    assert.equal(s.inventory.contents.known && s.inventory.contents.value.slots.length, 0);
    p.stop('test');
  });

  it('a new connection epoch keeps the old readings only as an older epoch until the new one reports', () => {
    const p = publisher();
    p.start();
    game.join();
    game.ready();
    game.health(12, 15);
    game.windowItems(0, window0({ 9: stack(1, 4) }));
    let s = p.snapshot();
    assert.equal(s.vitals.epoch, 1);
    game.end();
    s = p.snapshot();
    assert.equal(s.connection.state, 'ended');
    assert.equal(s.connection.lastEnd?.reason, 'disconnected');
    assert.equal(s.connection.botName.known, false);
    assert.equal(s.vitals.epoch, 1); // historical: the viewer compares against connection.epoch
    game.join();
    game.ready();
    s = p.snapshot();
    assert.equal(s.connection.epoch, 2);
    assert.equal(s.vitals.epoch, 1, 'old readings stay tagged with their epoch');
    game.health(20, 20);
    s = p.snapshot();
    assert.equal(s.vitals.epoch, 2);
    assert.equal(s.inventory.epoch, 2);
    assert.equal(s.inventory.contents.known, false, 'old inventory never carries into the new epoch');
    p.stop('test');
  });
});

describe('dashboard projection: directive, readiness, publishing', () => {
  it('distinguishes directive phases and keeps clarification/terminal details', () => {
    const p = publisher();
    engine = engineStatus({ state: 'awaiting_owner', pendingClarification: { ref: 'q1', question: 'Which chest?', reason: 'ambiguous target' } as never });
    let s = p.snapshot();
    assert.equal(s.directive.mode, 'owner_directive');
    assert.equal(s.directive.goal?.phase, 'awaiting_owner');
    assert.equal(s.directive.goal?.clarification?.ref, 'q1');
    engine = engineStatus({ state: 'blocked', terminal: { reason: 'no_progress', detail: 'no log reachable', atMs: 5 } }, undefined);
    s = p.snapshot();
    assert.equal(s.directive.mode, 'idle', 'a terminal goal no longer owns control');
    assert.equal(s.directive.goal?.terminal?.reason, 'no_progress');
    engine = engineStatus({ state: 'executing', kind: 'operator_task_diagnostic' }, { taskId: 'task-0001', objective: 'gather logs', mode: 'complete', startedAtMs: 9 });
    s = p.snapshot();
    assert.equal(s.directive.mode, 'operator_diagnostic');
    assert.equal(s.directive.task.current?.objective, 'gather logs');
    assert.equal(s.integrations.handoff, false);
    assert.equal(s.directive.pending, undefined);
  });

  it('shows a prepared next directive only through the handoff seam, as pending', () => {
    engine = engineStatus({ state: 'executing' });
    const p = publisher({ pending: () => ({ instruction: 'then build a hut', state: 'preparing', sinceMs: 5 }) });
    const s = p.snapshot();
    assert.equal(s.integrations.handoff, true);
    assert.equal(s.directive.pending?.state, 'preparing');
    assert.equal(s.directive.goal?.instruction, 'collect 8 oak logs');
  });

  it('writes a schema-valid, owner-only, redacted snapshot without the server endpoint', () => {
    engine = engineStatus({ instruction: 'use key sk-or-v1-abcdefghijklmnop0123456789 now', state: 'planning' });
    const p = publisher();
    game.join();
    game.ready();
    p.publish();
    const text = readFileSync(join(dir, 'status.json'), 'utf8');
    const s = read();
    assert.equal(s.publisher.seq, 1);
    assert.doesNotMatch(text, /sk-or-v1-abcdefghijklmnop/);
    assert.match(s.directive.goal!.instruction, /\[redacted\]/);
    assert.doesNotMatch(text, /127\.0\.0\.1|25566/);
    assert.equal(statSync(join(dir, 'status.json')).mode & 0o077, 0);
    p.publish();
    assert.equal(read().publisher.seq, 2, 'seq is monotonic per run');
  });

  it('a graceful stop leaves a final snapshot marked stopped; publishing never throws on a broken adapter', () => {
    const p = publisher({ engine: () => { throw new Error('boom'); }, memory: () => { throw new Error('nope'); } });
    p.start();
    const s1 = read();
    assert.equal(s1.publisher.state, 'running');
    assert.equal(s1.memory.known, false);
    p.stop('operator_quit');
    const s2 = read();
    assert.equal(s2.publisher.state, 'stopped');
    assert.equal(s2.publisher.stoppedReason, 'operator_quit');
  });

  it('attribute math follows vanilla modifier order', () => {
    assert.equal(attributeValue({ value: 20, modifiers: [{ amount: 4, operation: 0 }, { amount: 0.5, operation: 1 }, { amount: 0.1, operation: 2 }] }), (24 + 24 * 0.5) * 1.1);
    assert.equal(attributeValue({ value: Number.NaN, modifiers: [] }), undefined);
  });

  it('own position: client model with a separately labeled server-set position; never another player', () => {
    const p = publisher();
    game.join();
    game.ready();
    game.bot.entity.position = { x: 10.04, y: 64, z: -3.26 };
    let s = p.snapshot();
    assert.deepEqual(s.connection.position.known && [s.connection.position.value, s.connection.position.source], [{ x: 10, y: 64, z: -3.3 }, 'client_model']);
    assert.equal(s.connection.serverPosition.known, false);
    clock.t += 50;
    game.serverTeleport(100.5, 70, 100.5);
    s = p.snapshot();
    assert.deepEqual(s.connection.serverPosition.known && [s.connection.serverPosition.value, s.connection.serverPosition.source, s.connection.serverPosition.observedAtMs], [{ x: 100.5, y: 70, z: 100.5 }, 'server_packet', clock.t]);
    game.end();
    s = p.snapshot();
    assert.equal(s.connection.position.known, false, 'no live position while disconnected');
  });

  it('pause latch is projected when the app reports it, and absent otherwise', () => {
    engine = engineStatus({ state: 'executing' });
    let s = publisher().snapshot();
    assert.equal(s.integrations.pause, false);
    assert.equal(s.directive.pause, undefined);
    s = publisher({ pause: () => ({ paused: true, reason: 'owner said stop', sinceMs: 7, manualGoalsAllowed: true }) }).snapshot();
    assert.equal(s.integrations.pause, true);
    assert.deepEqual(s.directive.pause, { paused: true, reason: 'owner said stop', sinceMs: 7, manualGoalsAllowed: true });
  });

  it('memory summary is bounded/redacted and carries world profile and home provenance', () => {
    const long = 'x'.repeat(5_000);
    const s = publisher({
      memory: () => ({
        items: Array.from({ length: 40 }, (_, i) => ({ label: `spot ${i} ${long}`, kind: 'resource', source: 'observed', observedAtMs: 3, at: { x: 1.234, y: 2, z: 3 } })),
        totalItems: 40,
        worldProfile: { id: 'fixture-world', revision: 2 },
        home: { label: 'home sk-or-v1-abcdefghijklmnop0123456789', dimension: 'minecraft:overworld', at: { x: 5.55, y: 64, z: 9 }, source: 'owner_designated', observedAtMs: 4, stale: false },
      }),
    }).snapshot();
    assert.ok(s.memory.known);
    assert.equal(s.memory.value.items.length, 16);
    assert.ok(s.memory.value.items[0]!.label.length <= 200);
    assert.deepEqual(s.memory.value.worldProfile, { id: 'fixture-world', revision: 2 });
    assert.doesNotMatch(s.memory.value.home!.label, /abcdefghijklmnop/);
    assert.deepEqual(s.memory.value.home!.at, { x: 5.6, y: 64, z: 9 });
    assert.ok(DashboardStatusSchema.safeParse(s).success);
  });
});
