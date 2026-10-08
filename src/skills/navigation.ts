// Conservative navigation over mineflayer-pathfinder 2.4.5.
//
// Verified installed behavior (node_modules/mineflayer-pathfinder):
//   - Movements defaults allow digging (canDig), pillar-placing
//     (allow1by1towers + scafoldingBlocks dirt/cobblestone), parkour and
//     sprinting. Placement only happens when countScaffoldingItems() > 0, which
//     reads `scafoldingBlocks`; digging only when `canDig`.
//   - setGoal(null) -> resetPath(): clears the path and control states
//     synchronously and stops a pathfinder-initiated dig. bot.pathfinder.stop()
//     waits for the next node and is NOT used for cancellation.
//   - goto() resolves successfully when a no-path result has an empty path, so
//     it is not used; we watch path_update/goal_reached and verify position.
// Policy: no digging, no placing/scaffolding, no towers, no parkour, no sprint,
// no door opening, drop at most 3 blocks, avoid fire/lava/magma/campfires/
// berry bushes/powder snow/wither roses, deep water refused, shallow wading allowed.
import pathfinderPkg from 'mineflayer-pathfinder';
import type { GameSession } from '../game/connection.ts';
import type { Actuator } from '../execution/actuator.ts';
import type { Vec } from '../perception/visibility.ts';
import { safetyWorld } from '../safety/adapter.ts';
import type { SafetyBlockReader } from '../safety/geometry.ts';
import { applyDeepWaterAvoidance } from './safety.ts';

type Bot = GameSession['bot'];
const navigationWorlds = new WeakMap<Bot, () => SafetyBlockReader | undefined>();
/** Runtime installs its authoritative server/prediction-filtered world view. */
export function bindNavigationWorld(bot: Bot, reader: () => SafetyBlockReader | undefined): void {
  navigationWorlds.set(bot, reader);
}
const { Movements, goals } = pathfinderPkg as unknown as {
  Movements: new (bot: Bot) => Record<string, unknown> & { blocksToAvoid: Set<number>; scafoldingBlocks: number[] };
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalNearXZ: new (x: number, z: number, range: number) => unknown;
    GoalFollow: new (entity: unknown, range: number) => unknown;
    GoalBlock: new (x: number, y: number, z: number) => unknown;
  };
};
export { goals };

/**
 * Within `range` of a block but never standing on top of it (pathfinder's
 * GoalNear and GoalGetToBlock both accept standing on the target, which hides
 * its top face and can put the bot on a workstation it means to use).
 */
export class GoalBesideBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  private readonly rangeSq: number;
  constructor(x: number, y: number, z: number, range: number) {
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
    this.rangeSq = range * range;
  }
  heuristic(node: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y);
  }
  isEnd(node: { x: number; y: number; z: number }): boolean {
    const onTop = node.x === this.x && node.z === this.z && node.y > this.y;
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    return !onTop && dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }
  hasChanged(): boolean {
    return false;
  }
  isValid(): boolean {
    return true;
  }
}

/** Whether the bot currently stands on top of block (x, y, z). */
export function standingOn(bot: Bot, x: number, y: number, z: number): boolean {
  const p = bot.entity.position;
  return Math.floor(p.x) === x && Math.floor(p.z) === z && p.y >= y + 0.9 && p.y <= y + 2;
}

const AVOID = ['fire', 'soul_fire', 'lava', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cobweb', 'pointed_dripstone'];

export const NAVIGATION_POLICY = {
  canDig: false,
  allow1by1towers: false,
  scafoldingBlocks: [] as number[],
  allowParkour: false,
  allowSprinting: false,
  canOpenDoors: false,
  dontCreateFlow: true,
  dontMineUnderFallingBlock: true,
  maxDropDown: 3,
  infiniteLiquidDropdownDistance: false,
  allowFreeMotion: false,
  allowEntityDetection: true,
  liquidCost: 4,
} as const;

/**
 * Builds pathfinder Movements with the conservative policy and returns the
 * verified settings. With travel bounds, every step outside the goal-anchored
 * radius adds 100 to its move cost (installed exclusionAreasStep), and the installed
 * pathfinder rejects any move whose cost exceeds 100,
 * so searches and detours stay inside the bound.
 */
export function conservativeMovements(bot: Bot, bounds?: { anchor: Vec; radius: number }): { movements: unknown; verified: Record<string, unknown> } {
  const m = new Movements(bot);
  // W's reviewed geometry policy is shared by EVERY movement capability,
  // including locator legs and ordinary follow/navigation. The bot-only
  // fallback is for standalone callers without a connection evidence journal.
  const world = navigationWorlds.get(bot)?.() ?? safetyWorld({ bot } as GameSession);
  // Step costs alone miss installed diagonal/drop liquid landings. Use W's
  // complete instance policy, including its getBlock safety fence.
  applyDeepWaterAvoidance(m, world);
  if (bounds) {
    (m as unknown as { exclusionAreasStep: Array<(b: { position: Vec }) => number> }).exclusionAreasStep.push((b: { position: Vec }) => (Math.hypot(b.position.x + 0.5 - bounds.anchor.x, b.position.z + 0.5 - bounds.anchor.z) > bounds.radius ? 100 : 0));
  }
  for (const [k, v] of Object.entries(NAVIGATION_POLICY)) (m as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  for (const name of AVOID) {
    const id = (bot.registry as unknown as { blocksByName: Record<string, { id: number } | undefined> }).blocksByName[name]?.id;
    if (id !== undefined) m.blocksToAvoid.add(id);
  }
  const verified: Record<string, unknown> = {};
  for (const k of Object.keys(NAVIGATION_POLICY)) verified[k] = Array.isArray(m[k]) ? (m[k] as unknown[]).length : m[k];
  return { movements: m, verified };
}

/** Throws if the installed Movements object does not hold the policy (guards against library drift). */
export function assertPolicy(verified: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(NAVIGATION_POLICY)) {
    const expected = Array.isArray(v) ? v.length : v;
    if (verified[k] !== expected) throw new Error(`navigation policy not applied: ${k}=${String(verified[k])}`);
  }
}

export interface NavigateResult {
  status: 'arrived' | 'no_path' | 'timeout' | 'stuck' | 'out_of_bounds';
  finalDistance: number;
  elapsedMs: number;
  pathUpdates: number;
  corrections: number;
}

export interface NavigateOptions {
  goal: unknown;
  /** Arrival check on the actual current position. */
  arrived: () => boolean;
  distance: () => number;
  timeoutMs: number;
  stuckMs?: number;
  dynamic?: boolean;
  /** Called every poll; return a reason string to abort (e.g. target lost). */
  abortIf?: () => string | undefined;
  /** Bounds the A* search area (blocks); an unreachable goal then ends as no-path instead of searching forever. */
  searchRadius?: number;
  /**
   * Moving targets: called every poll; returns a replacement goal when the target
   * moved enough. (pathfinder's dynamic GoalFollow was observed live to stop
   * re-pathing with the target still out of range, so it is not used.)
   */
  retarget?: () => unknown | undefined;
  /** Live travel guard on the bot's actual position (checked every poll). */
  inBounds?: () => boolean;
  /** Goal-anchored travel bounds applied to the path search itself. */
  bounds?: { anchor: Vec; radius: number };
}

/**
 * Fenced navigation: sets the conservative movements and goal, polls while
 * fenced (stop clears the goal through the lease), and verifies arrival from
 * the bot's actual position (client physics; server corrections are counted).
 */
export async function navigate(act: Actuator, options: NavigateOptions): Promise<NavigateResult & { aborted?: string }> {
  const bot = act.bot;
  const pf = (bot as unknown as { pathfinder: { setMovements(m: unknown): void; searchRadius: number; thinkTimeout: number } }).pathfinder;
  const { movements, verified } = conservativeMovements(bot, options.bounds);
  assertPolicy(verified);
  act.fence();
  pf.setMovements(movements);
  pf.thinkTimeout = 4_000;
  pf.searchRadius = options.searchRadius ?? -1;
  let noPath = false;
  let pathUpdates = 0;
  let reached = false;
  const startSeq = act.session.evidence.seq;
  const onUpdate = (r: { status: string; path: unknown[] }) => {
    pathUpdates += 1;
    if (r.status === 'noPath') noPath = true;
  };
  const onReached = () => {
    reached = true;
  };
  bot.on('path_update' as never, onUpdate as never);
  bot.on('goal_reached' as never, onReached as never);
  const started = Date.now();
  let lastMoveAt = Date.now();
  let lastPos = bot.entity.position.clone();
  const stuckMs = options.stuckMs ?? 6_000;
  const result = (status: NavigateResult['status'], aborted?: string) => ({
    status,
    finalDistance: Math.round(options.distance() * 100) / 100,
    elapsedMs: Date.now() - started,
    pathUpdates,
    corrections: act.session.evidence.since(startSeq, 'position_correction').length,
    ...(aborted ? { aborted } : {}),
  });
  const bounds = options.bounds;
  const inBounds =
    options.inBounds ??
    (bounds ? () => Math.hypot(bot.entity.position.x - bounds.anchor.x, bot.entity.position.z - bounds.anchor.z) <= bounds.radius : undefined);
  const outside = () => (inBounds ? !inBounds() : false);
  try {
    // The live travel guard runs before every success path, including "already there".
    if (outside()) return result('out_of_bounds');
    if (options.arrived()) return result('arrived');
    act.setPathGoal(options.goal, options.dynamic ?? false);
    while (true) {
      await act.sleep(100);
      if (outside()) return result('out_of_bounds');
      const abort = options.abortIf?.();
      if (abort) return result('stuck', abort);
      const next = options.retarget?.();
      if (next !== undefined) {
        noPath = false;
        reached = false;
        lastMoveAt = Date.now();
        act.setPathGoal(next, false);
      }
      if (options.arrived() && (reached || options.dynamic || !(bot as unknown as { pathfinder: { isMoving(): boolean } }).pathfinder.isMoving())) {
        // settle briefly so a server position correction can show up
        await act.sleep(200);
        if (outside()) return result('out_of_bounds');
        if (options.arrived()) return result('arrived');
      }
      const pos = bot.entity.position;
      if (pos.distanceTo(lastPos) > 0.15) {
        lastPos = pos.clone();
        lastMoveAt = Date.now();
      }
      const moving = (bot as unknown as { pathfinder: { isMoving(): boolean } }).pathfinder.isMoving();
      if (noPath && !moving) return result('no_path');
      if (Date.now() - started > options.timeoutMs) return result('timeout');
      if (!options.dynamic && Date.now() - lastMoveAt > stuckMs) return result(noPath ? 'no_path' : 'stuck');
    }
  } finally {
    bot.off('path_update' as never, onUpdate as never);
    bot.off('goal_reached' as never, onReached as never);
    act.clearPathGoal();
  }
}

export function distanceTo(bot: Bot, p: Vec): number {
  const e = bot.entity.position;
  return Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z);
}
