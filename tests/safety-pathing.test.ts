// MB-FLOW-003-C11 (offline): the deep-water path policy against the INSTALLED
// mineflayer-pathfinder 2.4.5 A* and Movements with the project's conservative
// policy, over a Mineflayer-shaped bot on the installed 26.1.2 registry.
// Without the policy the installed Movements offer a step from the bank down
// into swimming-depth water (diagonal step-down / liquid landing; the seam
// behind the reported drowning); with applyDeepWaterAvoidance no such entry is
// offered, A* takes a dry detour, and with no dry route it finds no path
// instead of entering swimming-depth water (a truthful crossing blocker).
// Shallow wading stays allowed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import pathfinderPkg from 'mineflayer-pathfinder';
import { applyDeepWaterAvoidance } from '../src/skills/safety.ts';
import { conservativeMovements, goals, NAVIGATION_POLICY } from '../src/skills/navigation.ts';
import { deepWaterStepCost } from '../src/safety/geometry.ts';
import { safetyWorld } from '../src/safety/adapter.ts';
import type { GameSession } from '../src/game/connection.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

const require = createRequire(import.meta.url);
const AStar = require('mineflayer-pathfinder/lib/astar.js') as new (start: unknown, movements: unknown, goal: unknown, timeout: number, tickTimeout?: number, searchRadius?: number) => { compute(): { status: string; path: Array<{ x: number; y: number; z: number }> } };
const Move = require('mineflayer-pathfinder/lib/move.js') as new (x: number, y: number, z: number, remaining: number, cost: number) => unknown;
const RawMovements = (pathfinderPkg as unknown as { Movements: new (bot: unknown) => { exclusionAreasStep: Array<(b: { position: { x: number; y: number; z: number } }) => number> } }).Movements;

function world(opts: { channel?: boolean; depth?: number }) {
  const fake = fakeMineflayerBot(fakeClient(), { at: { x: -7.5, y: 0, z: 0.5 }, dimension: 'overworld', loaded: 30 });
  fake.fill(-30, -6, -30, 30, -1, 30, 'stone');
  const depth = opts.depth ?? 3;
  const zr = opts.channel ? 30 : 2;
  fake.fill(-2, -depth, -zr, 2, -1, zr, 'water');
  const bot = fake.bot as unknown as Record<string, unknown>;
  Object.assign(bot, { pathfinder: { bestHarvestTool: () => null } });
  const session = { bot, connectionEpoch: 1, evidence: { predictionPending: () => false } } as unknown as GameSession;
  return { bot, session };
}

function plan(withPolicy: boolean, opts: { channel?: boolean; depth?: number }) {
  const { bot, session } = world(opts);
  const { movements } = conservativeMovements(bot as never);
  if (withPolicy) applyDeepWaterAvoidance(movements, safetyWorld(session));
  const astar = new AStar(new Move(-8, 0, 0, 0, 0), movements, new goals.GoalNear(8, 0, 0, 1), 5_000, 5_000, 40);
  let r = astar.compute();
  while (r.status === 'partial') r = astar.compute();
  const view = safetyWorld(session);
  const wetNodes = r.path.filter((n) => view.blockAt(n.x, n.y, n.z)?.name === 'water' || view.blockAt(n.x, n.y - 1, n.z)?.name === 'water');
  return { status: r.status, path: r.path, wetNodes };
}

function neighbors(withPolicy: boolean, opts: { channel?: boolean; depth?: number }) {
  const { bot, session } = world(opts);
  const view = safetyWorld(session);
  // The production factory now installs the complete reviewed policy. Keep
  // the former step-cost-only implementation as an explicit adverse control.
  const movements = withPolicy ? conservativeMovements(bot as never).movements : new RawMovements(bot);
  if (!withPolicy) {
    Object.assign(movements as object, NAVIGATION_POLICY);
    (movements as InstanceType<typeof RawMovements>).exclusionAreasStep.push((b) => deepWaterStepCost(view, b.position.x, b.position.y, b.position.z));
  }
  const from = new Move(-3, 0, 0, 0, 0);
  const list = (movements as unknown as { getNeighbors(n: unknown): Array<{ x: number; y: number; z: number }> }).getNeighbors(from);
  const intoWater = list.filter((n) => view.blockAt(n.x, n.y, n.z)?.name === 'water' || view.blockAt(n.x, n.y + 1, n.z)?.name === 'water');
  return { list, intoWater };
}

describe('deep-water path policy over the installed pathfinder', () => {
  it('legacy step-cost-only baseline: the installed Movements step diagonally into swimming-depth water', () => {
    const r = neighbors(false, { channel: true });
    assert.deepEqual(r.intoWater.map((n) => [n.x, n.y, n.z]), [[-2, -1, -1], [-2, -1, 1]], 'retain both actual library bypasses as the adverse control');
  });

  it('with the C11 policy the bank offers no entry into swimming-depth water', () => {
    const r = neighbors(true, { channel: true });
    assert.equal(r.intoWater.length, 0, JSON.stringify(r.intoWater));
    assert.ok(r.list.length > 0, 'dry neighbours remain');
  });

  it('with the C11 policy: a dry detour around a pond (A*)', () => {
    const r = plan(true, {});
    assert.equal(r.status, 'success');
    assert.equal(r.wetNodes.length, 0, `no water nodes: ${JSON.stringify(r.wetNodes.slice(0, 3))}`);
  });

  it('with the C11 policy and no dry route: no successful path and never a water node (truthful crossing blocker)', () => {
    const r = plan(true, { channel: true });
    assert.notEqual(r.status, 'success');
    assert.ok(r.path.every((n) => n.x < -2), 'never enters the channel');
  });
});

describe('wading stays allowed', () => {
  it('one block of water in the walking layer over solid ground is crossed with the policy', () => {
    const fake = fakeMineflayerBot(fakeClient(), { at: { x: -7.5, y: 0, z: 0.5 }, dimension: 'overworld', loaded: 30 });
    fake.fill(-30, -6, -30, 30, -1, 30, 'stone');
    fake.fill(-2, 0, -30, 2, 0, 30, 'water');
    const bot = fake.bot as unknown as Record<string, unknown>;
    Object.assign(bot, { pathfinder: { bestHarvestTool: () => null } });
    const session = { bot, connectionEpoch: 1, evidence: { predictionPending: () => false } } as unknown as GameSession;
    const { movements } = conservativeMovements(bot as never);
    applyDeepWaterAvoidance(movements, safetyWorld(session));
    const astar = new AStar(new Move(-8, 0, 0, 0, 0), movements, new goals.GoalNear(8, 0, 0, 1), 5_000, 5_000, 40);
    let r = astar.compute();
    while (r.status === 'partial') r = astar.compute();
    assert.equal(r.status, 'success');
    assert.ok(r.path.some((n) => n.x >= -2 && n.x <= 2), 'path wades through the shallow water');
  });
});
