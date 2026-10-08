// MB-LOC-001 route runner: one bounded execution window of locator-assisted
// owner seeking or code-owned destination travel.
//
// Each step re-reads the CURRENT state (owner visibility, locator steering or
// the code-owned destination, the active travel bound, fresh local geometry):
//
//   owner visible now      -> approach the VISIBLE owner (position read only
//                             while visible); proximity is verified from the
//                             bot's own position, never from a waypoint
//   otherwise              -> rank SAFE LOCAL FRONTIERS toward the bearing and
//                             walk to the best one inside the active bound
//   bound (not terrain)    -> ask the route controller for the next counted
//     limits progress         leg anchored at the bot's own position
//   no forward frontier    -> a BOUNDED detour around an OBSERVED obstacle
//                             (MB-LOC-002), else the specific local blocker
//   cue withdrawn/expired  -> stop advancing (never continue on old guidance)
//
// The runner issues movement only through the injected env (in production the
// fenced Actuator via navigate()); stop/replacement/lifecycle revoke that lease
// and every await is followed by a fenced sleep/ownership check. It performs
// no inference and never reads hidden entity positions.
import type { JsonValue, Vec3 } from '../contracts/index.ts';
import type { RouteAdmissionProof, RouteBlocker, RouteDestinationKind, RouteStatus } from '../contracts/locator.ts';
import type { RayHit, Vec, WorldView } from '../perception/visibility.ts';
import type { LocatorService, LocatorSteering } from './service.ts';
import type { RouteController } from './routes.ts';
import { angleBetween } from './geometry.ts';
import { boundLimited, classifyBlocker, detourFrontiers, detourJustified, frontierKey, frontiersToward, type BlockerReport, type Bounds, type FrontierChoice } from './terrain.ts';

/** Result of re-verifying a code-owned destination's provenance (C3). */
export type DestinationRecheck = { ok: true } | { ok: false; reason: string; detail: string };

export type RouteTarget =
  | { kind: 'owner' }
  | {
      kind: 'fixed';
      destination: Exclude<RouteDestinationKind, 'owner'>;
      dimension: string;
      at: Vec3;
      label: string;
      /** Re-verifies provenance (authorization, owner-typed coordinates, frozen own-incident identity) before every step and on every movement poll. */
      recheck: () => DestinationRecheck;
    };

export interface MoveResult {
  status: 'arrived' | 'no_path' | 'timeout' | 'stuck' | 'out_of_bounds';
  aborted?: string;
  finalDistance: number;
}

export interface MoveOptions {
  timeoutMs: number;
  /** Polled while moving; a returned reason stops the move. */
  abortIf?: () => string | undefined;
  /** Moving targets: a new position (read only while visible) when it moved enough. */
  retarget?: () => Vec3 | undefined;
}

/** Everything the runner may observe or do. Production: ExecuteContext; tests: a scripted world. */
export interface RouteEnv {
  goalEpoch: number;
  connectionEpoch(): number;
  dimension(): string;
  self(): Vec3;
  now(): number;
  /** Fenced sleep (throws when the lease is revoked). */
  sleep(ms: number): Promise<void>;
  /** A fresh observation of seen voxels (line of sight), or undefined when unavailable. */
  observe(): { seen: ReadonlyMap<string, RayHit> } | undefined;
  world(): WorldView | undefined;
  visited(): readonly Vec[];
  recordVisited(): void;
  /** The owner's position ONLY when the owner is visible now (identity-verified entity). */
  ownerVisible(): Vec3 | undefined;
  /**
   * The goal-owned ORIGINAL admission proof of this goal epoch (never a route
   * leg; C3). Undefined when no admission is proven: nothing moves.
   */
  admissionBounds(): RouteAdmissionProof | undefined;
  move(target: Vec3, within: number, bounds: Bounds, options: MoveOptions): Promise<MoveResult>;
  progress(evidence: Record<string, JsonValue>): void;
  observationRadius: number;
  ownerLossMs: number;
}

export interface RouteRunParams {
  within: number;
  durationMs: number;
}

export interface RouteRunResult {
  status: 'succeeded' | 'partial' | 'failed';
  reason?: string;
  effect: string;
  evidence: Record<string, JsonValue>;
}

export interface RouteDeps {
  routes: RouteController;
  locator?: LocatorService;
}

const MAX_STEPS = 48;
const EDGE_MARGIN = 12;
const MAX_MOVE_FAILURES = 4;
/**
 * MB-LOC-002 bounded detour around an OBSERVED obstacle (wall, drop, lava,
 * water) across the bearing. An episode starts only when no forward frontier
 * exists and the observed geometry justifies it; it keeps the cue bearing at
 * its start as a FIXED frame and one committed side, never retreats sideways
 * toward its origin line by more than DETOUR_RETREAT_SLACK, and spends at most
 * MAX_DETOUR_STEPS steps and MAX_DETOUR_BLOCKS of walked PATH on that side. If
 * the side is closed or its budget is spent, it switches ONCE to the other side
 * with twice the budget (the walk back past the origin plus the same search).
 * The allowance is enforced DURING each step (the move is aborted when the polled
 * path reaches it), so an episode's path is at most 3 x MAX_DETOUR_BLOCKS plus
 * one movement poll per side (DETOUR_POLL_SLACK documents that finite slack). It clears (eventual progress) only when the bot
 * is DETOUR_CLEAR_PROGRESS past its origin in the frame AND the current cue has
 * a forward frontier again; otherwise the observed blocker is reported. At most
 * MAX_DETOUR_EPISODES per window. Route legs/distance/time ceilings still bound
 * everything, and a window continues locally only with NET progress along the
 * cue (detours that briefly increase the distance are allowed; wandering is not
 * progress).
 */
export const MAX_DETOUR_STEPS = 8;
export const MAX_DETOUR_BLOCKS = 96;
export const MAX_DETOUR_EPISODES = 3;
/**
 * Honest overshoot of a detour allowance: the movement between two abort polls.
 * The shared navigate() polls abortIf every 100 ms (300 ms around its arrival
 * settle), i.e. under 2 blocks at walking speed; the test simulator moves at most
 * sqrt(2) per poll. Per side, at most once.
 */
export const DETOUR_POLL_SLACK = 2;
/** Sideways retreat (blocks) toward the episode origin's frame line that a choice may make during an episode. */
export const DETOUR_RETREAT_SLACK = 8;
/** Progress in the episode's frame beyond its origin that clears a detour (the obstacle line is behind). */
export const DETOUR_CLEAR_PROGRESS = 8;
/** Net progress along the cue a window needs to continue locally (blocks). */
export const MIN_WINDOW_PROGRESS = 4;
const r1 = (n: number) => Math.round(n * 10) / 10;
const horizontal = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const inside = (b: Bounds, p: Vec) => horizontal(b.anchor, p) <= b.radius;

/** A sector label for a bearing (radians, atan2(dz, dx)). */
function sectorOf(bearing: number): string {
  const names = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'];
  const idx = ((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8;
  return names[idx] as string;
}

export async function runRoute(env: RouteEnv, target: RouteTarget, params: RouteRunParams, deps: RouteDeps): Promise<RouteRunResult> {
  const started = env.now();
  const start = env.self();
  const destKind: RouteDestinationKind = target.kind === 'owner' ? 'owner' : target.destination;
  const ctx = () => ({ goalEpoch: env.goalEpoch, connectionEpoch: env.connectionEpoch(), dimension: env.dimension() });
  const failedFrontiers = new Set<string>();
  let steps = 0;
  let moveFailures = 0;
  let legsBegun = 0;
  let ownerSeen = false;
  let lastSteer: Pick<LocatorSteering, 'direction' | 'distanceBand' | 'elevation' | 'precision' | 'ageMs'> | undefined;
  /** MB-LOC-002: NET progress along the cue, accumulated per step (conservative: see stepProgress; sideways ~0, back negative). */
  let netProgress = 0;
  /** An active detour episode: a fixed frame (the cue bearing when it began), its origin and committed side. */
  let detour: { side: 1 | -1; steps: number; blocks: number; blocker: BlockerReport; switched: boolean; frame: number; origin: Vec3; maxLateral: number; spentBlocks: number } | undefined;
  /** Signed sideways offset of a point from the episode's frame line through its origin (positive on the committed side). */
  const lateralOf = (d: NonNullable<typeof detour>, p: Vec3) => d.side * (Math.cos(d.frame) * (p.z - d.origin.z) - Math.sin(d.frame) * (p.x - d.origin.x));
  /** A choice during an episode must not retreat sideways back across the obstacle (local-minimum backtracking). */
  const retreats = (d: NonNullable<typeof detour>, p: Vec3) => lateralOf(d, p) < d.maxLateral - DETOUR_RETREAT_SLACK;
  /** Per-side budget: the first side gets the base budget; the second side also has to walk back past the origin. */
  const sideBudget = (d: NonNullable<typeof detour>) => (d.switched ? { steps: 2 * MAX_DETOUR_STEPS, blocks: 2 * MAX_DETOUR_BLOCKS } : { steps: MAX_DETOUR_STEPS, blocks: MAX_DETOUR_BLOCKS });
  const sideSpent = (d: NonNullable<typeof detour>) => d.steps >= sideBudget(d).steps || d.blocks >= sideBudget(d).blocks;
  /**
   * The committed side's budget is spent without clearing: search the OTHER side
   * once (an out-of-sight opening may be on either side), else report.
   */
  const switchSide = (d: NonNullable<typeof detour>): boolean => {
    if (d.switched) return false;
    detourLog.push({ side: d.side, steps: d.steps, blocks: r1(d.blocks), obstacle: d.blocker.reason, outcome: 'side_switched' });
    d.switched = true;
    d.side = d.side === 1 ? -1 : 1;
    d.spentBlocks += d.blocks;
    d.steps = 0;
    d.blocks = 0;
    d.maxLateral = lateralOf(d, env.self());
    lastDetourSide = d.side;
    return true;
  };
  let detourEpisodes = 0;
  /** The side of the last detour in this window (a new episode keeps it: no ping-pong). */
  let lastDetourSide: 1 | -1 | undefined;
  const detourLog: Array<Record<string, JsonValue>> = [];

  // The active bound: the live route leg only when it belongs to exactly this
  // goal's admission proof (same epochs, dimension, anchor, radius); else the
  // unchanged admission bound. An unproven admission moves nothing.
  const bounds = (): Bounds | undefined => {
    const proof = env.admissionBounds();
    if (!proof || proof.goalEpoch !== env.goalEpoch || proof.connectionEpoch !== env.connectionEpoch() || proof.dimension !== env.dimension()) return undefined;
    const t = deps.routes.effectiveTravel(proof);
    return { anchor: t.anchor, radius: t.radius };
  };
  const routeStatus = (): RouteStatus | null => {
    deps.routes.sample(ctx(), env.self());
    return deps.routes.status(env.goalEpoch);
  };
  const evidence = (extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => {
    const st = routeStatus();
    return {
      target: destKind,
      steps,
      legsBegunNow: legsBegun,
      ownerSeen,
      movedBlocks: r1(horizontal(start, env.self())),
      netProgress: r1(netProgress),
      ...(detourLog.length > 0 || detour ? { detours: [...detourLog, ...(detour ? [{ side: detour.side, steps: detour.steps, blocks: r1(detour.blocks + detour.spentBlocks), obstacle: detour.blocker.reason, outcome: 'active' }] : [])] } : {}),
      ...(lastSteer ? { cue: { direction: lastSteer.direction, distanceBand: lastSteer.distanceBand, elevation: lastSteer.elevation, precision: lastSteer.precision, ageMs: lastSteer.ageMs } } : {}),
      route: st ? { routeId: st.routeId, state: st.state, legsUsed: st.legsUsed, maxLegs: st.maxLegs, distanceUsed: st.distanceUsed, distanceSources: st.distanceSources, maxTotalDistance: st.maxTotalDistance, remainingMs: st.remainingMs, stalledLegs: st.stalledLegs } : null,
      ...extra,
    };
  };
  const fail = (reason: string, effect: string, extra: Record<string, JsonValue> = {}): RouteRunResult => ({ status: 'failed', reason, effect, evidence: evidence(extra) });
  /**
   * Conservative NET progress of one step: the smaller projection of the
   * displacement on the bearing at the step's start and at its end (a large
   * sideways return toward the bearing line is not credited as progress).
   */
  const stepProgress = (from: Vec3, to: Vec3, startBearing: number): number => {
    const endBearing = target.kind === 'owner' ? (deps.locator?.steering()?.bearingRad ?? startBearing) : Math.atan2(target.at.z - to.z, target.at.x - to.x);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return Math.min(dx * Math.cos(startBearing) + dz * Math.sin(startBearing), dx * Math.cos(endBearing) + dz * Math.sin(endBearing));
  };
  const beginLeg = (bearingRad: number | undefined): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } => {
    const r = deps.routes.beginLeg({ ...ctx(), at: env.self(), destination: destKind, ...(bearingRad !== undefined ? { bearingRad } : {}), ...(target.kind === 'fixed' ? { destinationAt: target.at } : {}) });
    if (!r.ok) return r;
    legsBegun += 1;
    env.progress({ routeLeg: r.leg.legIndex, legsUsed: r.status.legsUsed, distanceUsed: r.status.distanceUsed });
    return { ok: true };
  };

  if (target.kind === 'fixed' && target.dimension !== env.dimension()) return fail('dimension_mismatch', `${target.label} is in ${target.dimension}; no cross-dimension travel`);

  // Every movement poll samples the bot's own position into the route's
  // cumulative distance (C1) and stops as soon as a route budget is spent.
  let budgetStop: { blocker: RouteBlocker; detail: string } | undefined;
  let destinationStop: { reason: string; detail: string } | undefined;
  const destinationFail = (d: { reason: string; detail: string }) => fail(d.reason, `route movement stopped: ${d.detail}`);
  const move = (to: Vec3, within: number, bb: Bounds, options: MoveOptions): Promise<MoveResult> =>
    env.move(to, within, bb, {
      ...options,
      abortIf: () => {
        deps.routes.sample(ctx(), env.self());
        const budget = deps.routes.budget(ctx());
        if (!budget.ok) {
          budgetStop = budget;
          return 'route_budget';
        }
        if (target.kind === 'fixed') {
          const check = target.recheck();
          if (!check.ok) {
            destinationStop = check;
            return 'destination_invalid';
          }
        }
        return options.abortIf?.();
      },
    });
  const budgetFail = (b: { blocker: RouteBlocker; detail: string }) => fail(`route_${b.blocker}`, `route movement stopped: ${b.detail}`, { blocker: b.blocker });

  while (env.now() - started < params.durationMs && steps < MAX_STEPS) {
    steps += 1;
    await env.sleep(0); // ownership/lease fence before every step
    deps.routes.sample(ctx(), env.self());
    const budget = deps.routes.budget(ctx());
    if (!budget.ok) return budgetFail(budget);
    if (target.kind === 'fixed') {
      const check = target.recheck();
      if (!check.ok) return destinationFail(check);
    }
    const self = env.self();
    const b = bounds();
    if (!b) return fail('travel_anchor_not_admitted', 'no travel bound for this goal; nothing was moved');

    // 1. A visible owner takes over from any locator cue.
    if (target.kind === 'owner') {
      const seen = env.ownerVisible();
      if (seen) {
        ownerSeen = true;
        if (detour) {
          // The visible owner takes over; a later cue starts afresh (no stale detour frame).
          detourLog.push({ side: detour.side, steps: detour.steps, blocks: r1(detour.blocks + detour.spentBlocks), obstacle: detour.blocker.reason, outcome: 'owner_visible' });
          detour = undefined;
        }
        const d = dist3(self, seen);
        if (d <= params.within + 0.25) {
          return { status: 'succeeded', reason: 'owner_reached', effect: `the owner is visible and ${r1(d)} blocks away (within ${params.within}); verified from the bot's own position`, evidence: evidence({ ownerDistance: r1(d) }) };
        }
        let active = b;
        if (!inside(active, seen)) {
          const leg = beginLeg(Math.atan2(seen.z - self.z, seen.x - self.x));
          if (!leg.ok) return fail(leg.blocker === 'not_authorized' ? 'owner_outside_travel_bounds' : `route_${leg.blocker}`, `the owner is visible but outside the travel bound, and no route leg can begin (${leg.detail})`);
          active = bounds() as Bounds;
        }
        let lostSince: number | undefined;
        let goalAt = seen;
        // MB-LOC-002: conservative progress while approaching the VISIBLE owner,
        // sampled at every movement poll. A displacement between two polls is
        // credited only by the smaller of its projections on the bearing to the
        // owner seen at both ends; while the owner is not visible nothing can be
        // credited (only lost: min(0, projection on the last visible bearing)).
        // Hidden owner positions are never read: ownerVisible() is visibility-first.
        let lastSelf = env.self();
        let lastBearing = Math.atan2(seen.z - self.z, seen.x - self.x);
        const trackVisible = () => {
          const now = env.self();
          const o = env.ownerVisible();
          const dx = now.x - lastSelf.x;
          const dz = now.z - lastSelf.z;
          const onLast = dx * Math.cos(lastBearing) + dz * Math.sin(lastBearing);
          if (o) {
            const b2 = Math.atan2(o.z - now.z, o.x - now.x);
            netProgress += Math.min(onLast, dx * Math.cos(b2) + dz * Math.sin(b2));
            lastBearing = b2;
          } else netProgress += Math.min(0, onLast);
          lastSelf = now;
        };
        const res = await move(seen, params.within, active, {
          timeoutMs: Math.max(5_000, params.durationMs - (env.now() - started)),
          retarget: () => {
            const p = env.ownerVisible(); // visibility first; a hidden owner is never read
            if (!p) return undefined;
            if (dist3(p, goalAt) < 1.5) return undefined;
            goalAt = p;
            return p;
          },
          abortIf: () => {
            trackVisible();
            if (env.ownerVisible()) {
              lostSince = undefined;
              return undefined;
            }
            lostSince ??= env.now();
            return env.now() - lostSince > env.ownerLossMs ? 'owner_lost' : undefined;
          },
        });
        trackVisible();
        env.recordVisited();
        if (res.aborted === 'route_budget' && budgetStop) return budgetFail(budgetStop);
        if (res.aborted === 'destination_invalid' && destinationStop) return destinationFail(destinationStop);
        if (res.status === 'arrived') continue; // re-verified at the top of the next step
        if (res.aborted === 'owner_lost') continue; // fall back to the locator cue (if any)
        if (res.status === 'out_of_bounds') continue; // the next step may begin a leg
        moveFailures += 1;
        if (moveFailures > MAX_MOVE_FAILURES) return fail('no_safe_path', `no safe walking path to the visible owner (${res.status})`, { ownerDistance: r1(dist3(env.self(), seen)) });
        continue;
      }
    }

    // 2. Direction: a current locator cue (owner) or the code-owned destination.
    let bearing: number;
    let elevation: 'above' | 'below' | 'level' | 'unknown' = 'unknown';
    if (target.kind === 'owner') {
      const steer = deps.locator?.steering();
      if (!steer) {
        const hint = deps.locator?.ownerHint();
        const why = hint ? `${hint.reason}: ${hint.note}` : 'locator perception is not installed';
        if (steps > 1 && horizontal(start, env.self()) >= 2) return fail('hint_withdrawn', `stopped advancing: the owner locator cue is no longer current (${why})`, { hintReason: hint?.reason ?? 'unavailable' });
        return fail('no_actionable_hint', `the owner is not visible and there is no current locator cue (${why})`, { hintReason: hint?.reason ?? 'unavailable' });
      }
      lastSteer = { direction: steer.direction, distanceBand: steer.distanceBand, elevation: steer.elevation, precision: steer.precision, ageMs: steer.ageMs };
      bearing = steer.bearingRad;
      elevation = steer.elevation;
    } else {
      const d = horizontal(self, target.at);
      if (d <= params.within + 0.25 && Math.abs(self.y - target.at.y) <= Math.max(2, params.within)) {
        return { status: 'succeeded', reason: 'arrived', effect: `arrived within ${params.within} of ${target.label} (bot's own position; presence of anything there is not verified)`, evidence: evidence({ destinationDistance: r1(dist3(self, target.at)) }) };
      }
      bearing = Math.atan2(target.at.z - self.z, target.at.x - self.x);
      // A destination inside the active bound and loaded: walk to it directly (conservative path).
      const world = env.world();
      if (inside(b, target.at) && world?.blockAt(Math.floor(target.at.x), Math.floor(target.at.y), Math.floor(target.at.z)) && !failedFrontiers.has(frontierKey(target.at))) {
        const from = env.self();
        const res = await move(target.at, params.within, b, { timeoutMs: Math.max(5_000, params.durationMs - (env.now() - started)) });
        env.recordVisited();
        const to = env.self();
        netProgress += stepProgress(from, to, bearing);
        if (res.aborted === 'route_budget' && budgetStop) return budgetFail(budgetStop);
        if (res.aborted === 'destination_invalid' && destinationStop) return destinationFail(destinationStop);
        if (res.status === 'arrived') continue;
        failedFrontiers.add(frontierKey(target.at));
        moveFailures += 1;
        if (moveFailures > MAX_MOVE_FAILURES) return fail('no_safe_path', `no safe walking path toward ${target.label} (${res.status})`);
        continue;
      }
    }
    const direction = sectorOf(bearing);

    // 3. Safe local frontier toward the bearing inside the active bound.
    const obs = env.observe();
    const world = env.world();
    if (!obs || !world) return fail('not_connected', 'no current observation');
    if (detour && angleBetween(detour.frame, bearing) > Math.PI / 2) {
      // The cue itself moved to another side: the old detour frame is stale guidance.
      detourLog.push({ side: detour.side, steps: detour.steps, blocks: r1(detour.blocks + detour.spentBlocks), obstacle: detour.blocker.reason, outcome: 'cue_changed' });
      detour = undefined;
    }
    const floorSeenNow = (x: number, y: number, z: number) => obs.seen.has(`${x},${y},${z}`);
    if (
      detour &&
      (env.self().x - detour.origin.x) * Math.cos(detour.frame) + (env.self().z - detour.origin.z) * Math.sin(detour.frame) >= DETOUR_CLEAR_PROGRESS &&
      frontiersToward({ world, self: env.self(), bearingRad: bearing, bounds: b, radius: Math.min(env.observationRadius, 24), floorSeen: floorSeenNow, visited: env.visited(), exclude: failedFrontiers, elevation }).choices.some((c) => !retreats(detour as NonNullable<typeof detour>, c.at))
    ) {
      // Eventual progress: well past where the detour began (in its own frame) AND the current cue has a forward frontier again.
      detourLog.push({ side: detour.side, steps: detour.steps, blocks: r1(detour.blocks + detour.spentBlocks), obstacle: detour.blocker.reason, outcome: 'cleared' });
      detour = undefined;
    }
    // During a detour episode every choice is ranked in the episode's FIXED frame
    // (the cue bearing when it began), so a cue that rotates as the bot walks
    // sideways cannot pull it back into the obstacle (no local-minimum ping-pong).
    const frame = detour ? detour.frame : bearing;
    const query = (bb: Bounds) => ({
      world,
      self: env.self(),
      bearingRad: frame,
      bounds: bb,
      radius: Math.min(env.observationRadius, 24),
      floorSeen: floorSeenNow,
      visited: env.visited(),
      exclude: failedFrontiers,
      elevation,
    });
    let active = b;
    let choices: FrontierChoice[] = frontiersToward(query(active)).choices;
    const nearEdge = horizontal(active.anchor, env.self()) >= active.radius - EDGE_MARGIN;
    if (choices.length === 0 || (nearEdge && (choices[0]?.forward ?? 0) < EDGE_MARGIN)) {
      if (boundLimited(query(active)) || (nearEdge && choices.length > 0)) {
        const leg = beginLeg(bearing);
        if (!leg.ok) {
          if (choices.length === 0) return fail(`route_${leg.blocker}`, `progress ${direction} is limited by the travel bound and no further route leg is allowed (${leg.detail})`, { blocker: leg.blocker });
        } else {
          active = bounds() as Bounds;
          choices = frontiersToward(query(active)).choices;
        }
      }
    }
    if (detour) {
      const d = detour;
      choices = choices.filter((c) => !retreats(d, c.at));
    }
    let pick: FrontierChoice | undefined = choices[0];
    let detourStep = false;
    if (pick && detour) {
      // Forward steps (in the episode frame) are part of the episode, same budget, until it clears.
      if (sideSpent(detour) && switchSide(detour)) continue;
      if (sideSpent(detour)) {
        const spent = detour;
        detourLog.push({ side: spent.side, steps: spent.steps, blocks: r1(spent.blocks + spent.spentBlocks), obstacle: spent.blocker.reason, outcome: 'detour_budget_spent' });
        detour = undefined;
        return fail(spent.blocker.reason, `${spent.blocker.detail}; a bounded detour around the observed obstacle did not get past it (detour_budget_spent)`, { blocker: spent.blocker.reason, blockerEvidence: spent.blocker.evidence as unknown as JsonValue });
      }
      detour.steps += 1;
      detourStep = true;
    }
    if (!pick) {
      const blocker = detour?.blocker ?? classifyBlocker(world, env.self(), bearing, obs.seen, { elevation, direction });
      const blockerFail = (outcome: string) => {
        if (detour) detourLog.push({ side: detour.side, steps: detour.steps, blocks: r1(detour.blocks + detour.spentBlocks), obstacle: detour.blocker.reason, outcome });
        detour = undefined;
        return fail(blocker.reason, outcome === 'not_justified' ? blocker.detail : `${blocker.detail}; a bounded detour around the observed obstacle did not find a way forward (${outcome})`, { blocker: blocker.reason, blockerEvidence: blocker.evidence as unknown as JsonValue });
      };
      // MB-LOC-002: a bounded sideways detour, only around an OBSERVED obstacle.
      if (!detourJustified(blocker)) return blockerFail('not_justified');
      if (!detour) {
        if (detourEpisodes >= MAX_DETOUR_EPISODES) return blockerFail('episode_limit');
      } else if (sideSpent(detour)) {
        if (switchSide(detour)) continue;
        return blockerFail('detour_budget_spent');
      }
      let side = detour?.side ?? lastDetourSide;
      let options = detourFrontiers({ ...query(active), ...(side !== undefined ? { side } : {}) });
      if (detour) {
        const d = detour;
        options = options.filter((o) => o.side !== d.side || !retreats(d, o.at));
      }
      if (side !== undefined && !options.some((o) => o.side === side)) {
        // The committed side is closed in sight: switch once per episode (never ping-pong).
        if (detour?.switched) return blockerFail('both_sides_closed');
        side = side === 1 ? -1 : 1;
        options = options.filter((o) => o.side === side);
        if (detour) detour.switched = true;
      } else if (side !== undefined) options = options.filter((o) => o.side === side);
      const lateral = options[0];
      if (!lateral) return blockerFail(detour ? 'no_sideways_frontier' : 'no_sideways_frontier_in_sight');
      if (!detour) {
        detourEpisodes += 1;
        detour = { side: lateral.side, steps: 0, blocks: 0, blocker, switched: false, frame, origin: env.self(), maxLateral: 0, spentBlocks: 0 };
      }
      if (detour.side !== lateral.side) detour.maxLateral = lateralOf({ ...detour, side: lateral.side }, env.self()); // switched: measure the new side from here
      detour.side = lateral.side;
      lastDetourSide = lateral.side;
      detour.steps += 1;
      detourStep = true;
      pick = lateral;
    }

    // 4. Walk to it; stop on a withdrawn cue, switch on a visible owner.
    const steerSeq = target.kind === 'owner' ? deps.locator?.steering()?.statementSeq : undefined;
    const before = env.self();
    // MB-LOC-002: a detour step may walk only the episode's remaining path allowance
    // (polled path length; the honest bound is the allowance plus one poll's movement).
    const allowance = detourStep && detour ? sideBudget(detour).blocks - detour.blocks : Number.POSITIVE_INFINITY;
    let walked = 0;
    let lastPoll = before;
    const res = await move(pick.at, 2, active, {
      timeoutMs: Math.min(60_000, Math.max(5_000, params.durationMs - (env.now() - started))),
      abortIf: () => {
        const now = env.self();
        walked += horizontal(lastPoll, now);
        lastPoll = now;
        if (walked >= allowance) return 'detour_allowance';
        if (target.kind !== 'owner') return undefined;
        if (env.ownerVisible()) return 'owner_visible';
        const s = deps.locator?.steering();
        if (!s) return 'hint_withdrawn';
        if (s.statementSeq !== steerSeq && angleBetween(s.bearingRad, bearing) > Math.PI / 3) return 'hint_changed';
        return undefined;
      },
    });
    env.recordVisited();
    const st = routeStatus();
    const after = env.self();
    netProgress += stepProgress(before, after, bearing);
    walked += horizontal(lastPoll, after);
    if (detourStep && detour) {
      detour.blocks += walked; // polled PATH length, not straight displacement
      detour.maxLateral = Math.max(detour.maxLateral, lateralOf(detour, after));
    }
    env.progress({ routeSteps: steps, movedBlocks: r1(horizontal(start, after)), netProgress: r1(netProgress), legsUsed: st?.legsUsed ?? 0, distanceUsed: st?.distanceUsed ?? 0, ...(detour ? { detourSteps: detour.steps } : {}) });
    if (res.aborted === 'route_budget' && budgetStop) return budgetFail(budgetStop);
    if (res.aborted === 'destination_invalid' && destinationStop) return destinationFail(destinationStop);
    if (res.aborted === 'owner_visible' || res.aborted === 'hint_changed') continue;
    if (res.aborted === 'hint_withdrawn') continue; // re-evaluated at step 2 (stops advancing there)
    if (res.status === 'arrived') {
      moveFailures = 0;
      continue;
    }
    if (res.status === 'out_of_bounds') continue;
    failedFrontiers.add(frontierKey(pick.at));
    moveFailures += 1;
    if (moveFailures > MAX_MOVE_FAILURES) return fail('no_safe_path', `walking ${direction} repeatedly failed (${res.status}); no safe walkable route found`);
  }

  // Window ended without reaching the target. MB-LOC-002: a window continues
  // locally only with conservative NET progress — along the cue, or toward the
  // owner while freshly visible. Raw movement (sideways, back and forth, or after
  // the owner was lost) is never progress.
  const moved = horizontal(start, env.self());
  if (netProgress >= MIN_WINDOW_PROGRESS) {
    return { status: 'partial', reason: 'route_window_elapsed', effect: `moved ${r1(moved)} blocks ${target.kind === 'owner' ? 'toward the owner cue' : `toward ${target.label}`} (${steps} steps); not there yet`, evidence: evidence() };
  }
  // A window that ends inside (or right after) an unsuccessful detour reports the OBSERVED obstacle, not a generic no-progress.
  const lastDetour = detour ?? undefined;
  if (lastDetour) {
    detourLog.push({ side: lastDetour.side, steps: lastDetour.steps, blocks: r1(lastDetour.blocks + lastDetour.spentBlocks), obstacle: lastDetour.blocker.reason, outcome: 'window_ended' });
    detour = undefined;
    return fail(lastDetour.blocker.reason, `${lastDetour.blocker.detail}; the window ended during a bounded detour around the observed obstacle without net progress`, { blocker: lastDetour.blocker.reason, blockerEvidence: lastDetour.blocker.evidence as unknown as JsonValue });
  }
  return fail('no_progress', `no progress ${target.kind === 'owner' ? 'toward the owner cue' : `toward ${target.label}`} in this window`);
}
