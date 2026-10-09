// P-C11-R6: production ordinary navigation over the installed pathfinder.
// No connection, providers, fixture or duplicate safety policy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { GameSession } from '../src/game/connection.ts';
import { bindNavigationWorld, conservativeMovements, goals, NAVIGATION_POLICY } from '../src/skills/navigation.ts';
import { deepWaterStepCost } from '../src/safety/geometry.ts';
import { safetyWorld } from '../src/safety/adapter.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

type Node = { x: number; y: number; z: number };
type Movements = { getNeighbors(node: unknown): Node[]; exclusionAreasStep: Array<(b: { position: Node }) => number> };
const require = createRequire(import.meta.url);
const Move = require('mineflayer-pathfinder/lib/move.js') as new (x: number, y: number, z: number, remaining: number, cost: number) => unknown;
const AStar = require('mineflayer-pathfinder/lib/astar.js') as new (start: unknown, movements: unknown, goal: unknown, timeout: number, tickTimeout: number, radius: number) => { compute(): { status: string; path: Node[] } };
const RawMovements = (pathfinderPkg as unknown as { Movements: new (bot: unknown) => Movements }).Movements;

function setup(channel = false, wading = false) {
  const fake = fakeMineflayerBot(fakeClient(), { at: { x: -7.5, y: 0, z: 0.5 }, loaded: 30 });
  fake.fill(-30, -6, -30, 30, -1, 30, 'stone');
  fake.fill(-2, wading ? 0 : -3, channel ? -30 : -2, 2, wading ? 0 : -1, channel ? 30 : 2, 'water');
  Object.assign(fake.bot, { pathfinder: { bestHarvestTool: () => null } });
  const bot = fake.bot as unknown as GameSession['bot'];
  const view = safetyWorld({ bot, evidence: { predictionPending: () => false } } as unknown as GameSession);
  bindNavigationWorld(bot, () => view);
  const ordinary = conservativeMovements(bot).movements as Movements;
  return { fake, bot, view, ordinary };
}

function plan(m: Movements) {
  const astar = new AStar(new Move(-8, 0, 0, 0, 0), m, new goals.GoalNear(8, 0, 0, 1), 5_000, 5_000, 40);
  let result = astar.compute();
  for (let n = 0; result.status === 'partial' && n < 10; n += 1) result = astar.compute();
  return result;
}

describe('ordinary deep-water navigation', () => {
  it('removes the actual diagonal liquid landings that step costs alone admit', () => {
    const { bot, view, ordinary } = setup(true);
    const stepOnly = new RawMovements(bot);
    Object.assign(stepOnly, NAVIGATION_POLICY);
    stepOnly.exclusionAreasStep.push((b) => deepWaterStepCost(view, b.position.x, b.position.y, b.position.z));
    const wet = (m: Movements) => m.getNeighbors(new Move(-3, 0, 0, 0, 0)).filter((n) => view.blockAt(n.x, n.y, n.z)?.name === 'water' || view.blockAt(n.x, n.y + 1, n.z)?.name === 'water').map((n) => [n.x, n.y, n.z]);
    assert.deepEqual(wet(stepOnly), [[-2, -1, -1], [-2, -1, 1]], 'the adverse control reproduces the installed library bypass');
    assert.deepEqual(wet(ordinary), [], 'the actual production factory closes both bypasses');
    assert.ok(ordinary.getNeighbors(new Move(-3, 0, 0, 0, 0)).length > 0, 'dry alternatives remain');
  });

  it('uses a dry detour around a finite pond', () => {
    const { ordinary, view } = setup();
    const result = plan(ordinary);
    assert.equal(result.status, 'success');
    assert.ok(result.path.every((n) => view.blockAt(n.x, n.y, n.z)?.name !== 'water' && view.blockAt(n.x, n.y - 1, n.z)?.name !== 'water'));
  });

  it('returns no route when the only crossing is deep water', () => {
    const { ordinary } = setup(true);
    const result = plan(ordinary);
    assert.notEqual(result.status, 'success');
    assert.ok(result.path.every((n) => n.x < -2));
  });

  it('retains shallow wading over a solid floor', () => {
    const { ordinary } = setup(true, true);
    const result = plan(ordinary);
    assert.equal(result.status, 'success');
    assert.ok(result.path.some((n) => n.x >= -2 && n.x <= 2));
  });

  it('reads the authoritative live world when it differs from library predictions', () => {
    const { bot, view } = setup(true);
    const authoritative = { blockAt: (x: number, y: number, z: number) => x >= -2 && x <= 2 && y === 0 ? { name: 'water', shapes: [], level: 0 } : view.blockAt(x, y, z) };
    bindNavigationWorld(bot, () => authoritative);
    const m = conservativeMovements(bot).movements as Movements;
    assert.ok(m.exclusionAreasStep.some((g) => g({ position: { x: -2, y: 0, z: 0 } }) === 100), 'server view refuses water the library currently calls air');
  });
});
