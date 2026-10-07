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
//   no frontier at all     -> report the specific local blocker
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
import { boundLimited, classifyBlocker, frontierKey, frontiersToward, type Bounds, type FrontierChoice } from './terrain.ts';

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
  let bestProgress = 0;
  let initialBearing: number | undefined;

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
      ...(lastSteer ? { cue: { direction: lastSteer.direction, distanceBand: lastSteer.distanceBand, elevation: lastSteer.elevation, precision: lastSteer.precision, ageMs: lastSteer.ageMs } } : {}),
      route: st ? { routeId: st.routeId, state: st.state, legsUsed: st.legsUsed, maxLegs: st.maxLegs, distanceUsed: st.distanceUsed, distanceSources: st.distanceSources, maxTotalDistance: st.maxTotalDistance, remainingMs: st.remainingMs, stalledLegs: st.stalledLegs } : null,
      ...extra,
    };
  };
  const fail = (reason: string, effect: string, extra: Record<string, JsonValue> = {}): RouteRunResult => ({ status: 'failed', reason, effect, evidence: evidence(extra) });
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
            if (env.ownerVisible()) {
              lostSince = undefined;
              return undefined;
            }
            lostSince ??= env.now();
            return env.now() - lostSince > env.ownerLossMs ? 'owner_lost' : undefined;
          },
        });
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
        const res = await move(target.at, params.within, b, { timeoutMs: Math.max(5_000, params.durationMs - (env.now() - started)) });
        env.recordVisited();
        if (res.aborted === 'route_budget' && budgetStop) return budgetFail(budgetStop);
        if (res.aborted === 'destination_invalid' && destinationStop) return destinationFail(destinationStop);
        if (res.status === 'arrived') continue;
        failedFrontiers.add(frontierKey(target.at));
        moveFailures += 1;
        if (moveFailures > MAX_MOVE_FAILURES) return fail('no_safe_path', `no safe walking path toward ${target.label} (${res.status})`);
        continue;
      }
    }
    initialBearing ??= bearing;
    const direction = sectorOf(bearing);

    // 3. Safe local frontier toward the bearing inside the active bound.
    const obs = env.observe();
    const world = env.world();
    if (!obs || !world) return fail('not_connected', 'no current observation');
    const query = (bb: Bounds) => ({
      world,
      self: env.self(),
      bearingRad: bearing,
      bounds: bb,
      radius: Math.min(env.observationRadius, 24),
      floorSeen: (x: number, y: number, z: number) => obs.seen.has(`${x},${y},${z}`),
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
    const pick = choices[0];
    if (!pick) {
      const blocker = classifyBlocker(world, env.self(), bearing, obs.seen, { elevation, direction });
      return fail(blocker.reason, blocker.detail, { blocker: blocker.reason, blockerEvidence: blocker.evidence as unknown as JsonValue });
    }

    // 4. Walk to it; stop on a withdrawn cue, switch on a visible owner.
    const steerSeq = target.kind === 'owner' ? deps.locator?.steering()?.statementSeq : undefined;
    const res = await move(pick.at, 2, active, {
      timeoutMs: Math.min(60_000, Math.max(5_000, params.durationMs - (env.now() - started))),
      abortIf: () => {
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
    const progressNow = initialBearing !== undefined ? (env.self().x - start.x) * Math.cos(initialBearing) + (env.self().z - start.z) * Math.sin(initialBearing) : 0;
    bestProgress = Math.max(bestProgress, progressNow);
    env.progress({ routeSteps: steps, movedBlocks: r1(horizontal(start, env.self())), legsUsed: st?.legsUsed ?? 0, distanceUsed: st?.distanceUsed ?? 0 });
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

  // Window ended without reaching the target.
  const moved = horizontal(start, env.self());
  if (bestProgress >= 4 || moved >= 4) {
    return { status: 'partial', reason: 'route_window_elapsed', effect: `moved ${r1(moved)} blocks ${target.kind === 'owner' ? 'toward the owner cue' : `toward ${target.label}`} (${steps} steps); not there yet`, evidence: evidence() };
  }
  return fail('no_progress', `no progress ${target.kind === 'owner' ? 'toward the owner cue' : `toward ${target.label}`} in this window`);
}
