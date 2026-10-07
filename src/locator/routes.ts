// MB-LOC-001 declared, code-owned route legs.
//
// A goal may travel beyond its admission travel radius ONLY through a route
// authorization granted at admission from operator policy (never from the
// planner), and only one bounded LEG at a time:
//
//   admit      -> one authorization per NEW goal epoch (a repeated or older
//                 epoch is refused: no callback can regrant/reset a route);
//                 ceilings and the route deadline are fixed here
//   beginLeg   -> code (a route skill executing under the fenced lease) asks
//                 for a new local bound anchored at the bot's OWN current
//                 position; refused once any parent ceiling is reached
//   sample     -> cumulative own movement (path length) from the bot's own
//                 position samples, server corrections labelled (C1)
//   revoke     -> goal end, replacement, stop, lifecycle: never steers again
//
// Ceilings: legs, CUMULATIVE own movement since the first leg (out-and-back and
// detours consume it), a wall-clock deadline fixed at admission, and
// consecutive legs without NET progress (stall). None is reset by a new leg,
// window, replan, retry, epoch/connection/dimension callback or planner output.
// The admission anchor is copied and never moved; the goal's accepted outcome
// and counters are not touched here. Leg bounds come from the bot's own
// position and the operator leg radius; no destination defines a bound.
import type { EventEmitter } from 'node:events';
import type { Clock, Vec3 } from '../contracts/index.ts';
import {
  RoutePolicySchema,
  type RouteAdmission,
  type RouteAuthorization,
  type RouteBlocker,
  type RouteDestinationKind,
  type RouteDestinationProvider,
  type RouteDistanceAccount,
  type RouteLegBounds,
  type RouteOwnerCoordinate,
  type RoutePolicy,
  type RoutePort,
  type RouteProposalContext,
  type RouteStatus,
} from '../contracts/locator.ts';
import type { GameSession } from '../game/connection.ts';

export interface RouteControllerOptions {
  policy: RoutePolicy;
  clock: Clock;
  record?: (event: { type: string } & Record<string, unknown>) => void;
  /** Survival seam (own_death destinations); absent: own_death is never available. */
  ownDeath?: RouteDestinationProvider;
}

interface LegRecord {
  index: number;
  destination: RouteDestinationKind;
  anchor: Vec3;
  radius: number;
  startedAtMs: number;
  /** Steering bearing at leg start (owner) or the fixed destination (code-owned). */
  bearingRad: number | null;
  destinationAt: Vec3 | null;
  /** Latest NET horizontal displacement from the leg anchor (bot's own position). */
  displacement: number;
  /** NET progress toward the destination (projection on the bearing / distance reduction). */
  netProgress: number;
  outcome: string;
}

interface RouteRecord {
  auth: RouteAuthorization;
  state: RouteStatus['state'];
  legs: LegRecord[];
  stalledLegs: number;
  blocker: { reason: RouteBlocker; detail: string } | null;
  ownerCoordinates: RouteOwnerCoordinate[];
  distance: RouteDistanceAccount;
  lastSample: Vec3 | null;
  /** First own_death destination id this route used (a change is refused). */
  boundOwnDeath: string | null;
}

export type BeginLegResult = { ok: true; leg: RouteLegBounds; status: RouteStatus } | { ok: false; blocker: RouteBlocker; detail: string; status: RouteStatus | null };

export interface RouteCtx {
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
}

export interface BeginLegRequest extends RouteCtx {
  /** The bot's own current position. */
  at: Vec3;
  destination: RouteDestinationKind;
  /** Internal steering bearing (owner cue) at leg start. */
  bearingRad?: number;
  /** Code-owned fixed destination (verified owner-typed coordinates or own death). */
  destinationAt?: Vec3;
}

export type DestinationCheck =
  | { ok: true; kind: 'owner_destination'; at: Vec3; label: string }
  | { ok: true; kind: 'own_death'; at: Vec3; label: string; destinationId: string }
  | { ok: false; blocker: RouteBlocker; detail: string };

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const r1 = (n: number) => Math.round(n * 10) / 10;
const freezeVec = (v: Vec3): Vec3 => Object.freeze({ x: v.x, y: v.y, z: v.z });
const sameVec = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Owner-typed coordinate match (block centring tolerated), same rule as goals/owner-coordinates.ts. */
export function matchesRouteOwnerCoordinate(at: Vec3, coords: readonly RouteOwnerCoordinate[]): boolean {
  return coords.some((c) => Math.abs(at.x - c.x) <= 0.5 + 1e-9 && Math.abs(at.y - c.y) <= 0.5 + 1e-9 && Math.abs(at.z - c.z) <= 0.5 + 1e-9);
}

/** A single sample jump larger than this is a teleport-scale change (still counted, flagged). */
const LARGE_SAMPLE = 16;

export class RouteController implements RoutePort {
  private readonly options: RouteControllerOptions;
  readonly policy: RoutePolicy;
  private current: RouteRecord | undefined;
  private counter = 0;
  /** Highest goal epoch ever admitted (monotonic; no re-admission of an epoch). */
  private lastAdmittedEpoch = -1;
  private detachMovement: (() => void) | undefined;

  constructor(options: RouteControllerOptions) {
    this.options = options;
    this.policy = RoutePolicySchema.parse(options.policy);
  }

  /** Admission: grants the NEW goal epoch its frozen authorization (or declines) and revokes any earlier route. */
  admit(a: RouteAdmission): RouteAuthorization | undefined {
    if (a.goalEpoch <= this.lastAdmittedEpoch) {
      this.options.record?.({ type: 'route_admission_refused', goalId: a.goalId, goalEpoch: a.goalEpoch, reason: 'epoch_already_admitted', lastAdmittedEpoch: this.lastAdmittedEpoch });
      return undefined;
    }
    this.lastAdmittedEpoch = a.goalEpoch;
    if (this.current && this.current.state !== 'revoked') this.revoke('replaced_by_admission');
    this.current = undefined;
    const p = this.policy;
    if (!p.enabled || !(p.sources as readonly string[]).includes(a.source)) {
      this.options.record?.({ type: 'route_not_authorized', goalId: a.goalId, goalEpoch: a.goalEpoch, source: a.source, reason: p.enabled ? 'source_not_in_policy' : 'routes_disabled' });
      return undefined;
    }
    this.counter += 1;
    const ceilings = Object.freeze({
      legRadius: p.legRadius,
      maxLegs: p.maxLegs,
      maxTotalDistance: p.maxTotalDistance,
      routeDeadlineMs: Math.min(a.admittedAtMs + p.maxRouteMs, a.goalDeadlineMs),
      maxStalledLegs: p.maxStalledLegs,
      minLegProgress: p.minLegProgress,
    });
    const auth: RouteAuthorization = Object.freeze({
      routeId: `route-${this.counter}`,
      goalId: a.goalId,
      goalEpoch: a.goalEpoch,
      connectionEpoch: a.connectionEpoch,
      dimension: a.dimension,
      source: a.source,
      grantedBy: 'operator_policy' as const,
      grantedAtMs: a.admittedAtMs,
      destinations: Object.freeze([...p.destinations]),
      admissionAnchor: freezeVec(a.admissionAnchor),
      admissionRadius: a.admissionRadius,
      ceilings,
    });
    this.current = {
      auth,
      state: 'authorized',
      legs: [],
      stalledLegs: 0,
      blocker: null,
      ownerCoordinates: a.ownerCoordinates.slice(0, 8).map((c) => ({ x: c.x, y: c.y, z: c.z, source: c.source })),
      distance: { total: 0, clientPhysics: 0, serverCorrections: 0, correctionCount: 0 },
      lastSample: null,
      boundOwnDeath: null,
    };
    this.options.record?.({ type: 'route_authorized', routeId: auth.routeId, goalId: a.goalId, goalEpoch: a.goalEpoch, source: a.source, destinations: [...auth.destinations], legRadius: ceilings.legRadius, maxLegs: ceilings.maxLegs, maxTotalDistance: ceilings.maxTotalDistance, routeBudgetMs: ceilings.routeDeadlineMs - a.admittedAtMs, ownerCoordinates: this.current.ownerCoordinates.length });
    return auth;
  }

  noteOwnerCoordinates(goalEpoch: number, coordinates: readonly RouteOwnerCoordinate[]): void {
    const r = this.current;
    if (!r || r.state === 'revoked' || r.auth.goalEpoch !== goalEpoch) return;
    for (const c of coordinates) {
      if (r.ownerCoordinates.length >= 8) break;
      if (!matchesRouteOwnerCoordinate(c, r.ownerCoordinates)) r.ownerCoordinates.push({ x: c.x, y: c.y, z: c.z, source: c.source });
    }
  }

  /** The authorization of a goal epoch on its EXACT connection/dimension, if not revoked. */
  authorization(ctx: RouteCtx): RouteAuthorization | undefined {
    const r = this.current;
    if (!r || r.state === 'revoked') return undefined;
    const a = r.auth;
    if (a.goalEpoch !== ctx.goalEpoch || a.connectionEpoch !== ctx.connectionEpoch || a.dimension !== ctx.dimension) return undefined;
    return a;
  }

  legBounds(ctx: RouteCtx): RouteLegBounds | undefined {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return undefined;
    const leg = r.legs.at(-1);
    if (!leg) return undefined;
    return { routeId: auth.routeId, goalEpoch: auth.goalEpoch, connectionEpoch: auth.connectionEpoch, dimension: auth.dimension, legIndex: leg.index, anchor: { ...leg.anchor }, radius: leg.radius, admissionAnchor: { ...auth.admissionAnchor }, admissionRadius: auth.admissionRadius };
  }

  /**
   * Reference implementation of the consumer rule for the perception hook: the
   * leg applies only when it belongs to exactly this goal-owned admission
   * anchor (same epochs, dimension and admission anchor).
   */
  static applies(leg: RouteLegBounds | undefined, anchor: { goalEpoch: number | undefined; connectionEpoch: number; dimension: string; at: Vec3 } | undefined): leg is RouteLegBounds {
    if (!leg || !anchor || anchor.goalEpoch === undefined) return false;
    return leg.goalEpoch === anchor.goalEpoch && leg.connectionEpoch === anchor.connectionEpoch && leg.dimension === anchor.dimension && sameVec(leg.admissionAnchor, anchor.at);
  }

  proposalContext(ctx: RouteCtx): RouteProposalContext {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { authorized: false, destinations: [], ownDeathAvailable: false, state: r && r.auth.goalEpoch === ctx.goalEpoch ? r.state : null };
    const ownDeathAvailable = auth.destinations.includes('own_death') && this.options.ownDeath?.current(ctx)?.provenance === 'own_incident';
    return { authorized: true, destinations: [...auth.destinations], ownDeathAvailable: Boolean(ownDeathAvailable), state: r.state };
  }

  /**
   * Verifies a fixed destination's provenance for this route (resolver AND
   * executor): owner_destination must match coordinates the owner typed for THIS
   * goal; own_death must come from the installed provider (own incident), in
   * this dimension, and equal the destination first bound by this route.
   */
  verifyDestination(ctx: RouteCtx, kind: 'owner_destination', at: Vec3, dimension: string): DestinationCheck;
  verifyDestination(ctx: RouteCtx, kind: 'own_death'): DestinationCheck;
  verifyDestination(ctx: RouteCtx, kind: 'owner_destination' | 'own_death', at?: Vec3, dimension?: string): DestinationCheck {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { ok: false, blocker: 'not_authorized', detail: 'no route authorization for this goal on this connection and dimension' };
    if (!auth.destinations.includes(kind)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${kind} destinations` };
    if (kind === 'owner_destination') {
      if (!at || dimension !== ctx.dimension) return { ok: false, blocker: 'dimension_mismatch', detail: 'the destination is not in the current dimension' };
      if (!matchesRouteOwnerCoordinate(at, r.ownerCoordinates)) return { ok: false, blocker: 'destination_unverified', detail: 'these coordinates were not typed by the owner for this goal' };
      return { ok: true, kind, at: { ...at }, label: `owner-supplied destination ${at.x},${at.y},${at.z}` };
    }
    const dest = this.options.ownDeath?.current(ctx);
    if (!dest || dest.provenance !== 'own_incident') return { ok: false, blocker: 'destination_unverified', detail: 'no recorded own death location from the installed provider' };
    if (dest.dimension !== ctx.dimension) return { ok: false, blocker: 'dimension_mismatch', detail: `the recorded own death location is in ${dest.dimension}` };
    if (r.boundOwnDeath !== null && r.boundOwnDeath !== dest.destinationId) return { ok: false, blocker: 'destination_changed', detail: 'the recorded own death location changed after this route began; a fresh owner decision is needed' };
    return { ok: true, kind, at: { ...dest.at }, label: dest.label.slice(0, 80), destinationId: dest.destinationId };
  }

  /** Binds the own_death destination id at first use by this route. */
  bindOwnDeath(ctx: RouteCtx, destinationId: string): boolean {
    const r = this.current;
    if (!r || !this.authorization(ctx)) return false;
    if (r.boundOwnDeath !== null) return r.boundOwnDeath === destinationId;
    r.boundOwnDeath = destinationId;
    return true;
  }

  /**
   * One own-position sample (C1): adds the horizontal path length since the
   * previous sample, once the route's first leg has begun. Server position
   * corrections are counted and labelled. Exceeding the ceiling exhausts the
   * route (no new legs; route skills stop).
   */
  sample(ctx: RouteCtx, at: Vec3, source: 'client_physics' | 'server_correction' = 'client_physics'): void {
    const r = this.current;
    if (!r || !this.authorization(ctx) || r.legs.length === 0) return;
    if (r.lastSample) {
      const d = horizontal(r.lastSample, at);
      if (d > 0) {
        r.distance.total += d;
        if (source === 'server_correction') {
          r.distance.serverCorrections += d;
          r.distance.correctionCount += 1;
        } else r.distance.clientPhysics += d;
        if (d > LARGE_SAMPLE) this.options.record?.({ type: 'route_large_sample', routeId: r.auth.routeId, source, blocks: r1(d) });
      }
    }
    r.lastSample = { x: at.x, y: at.y, z: at.z };
    const leg = r.legs.at(-1);
    if (leg) {
      leg.displacement = horizontal(leg.anchor, at);
      leg.netProgress = this.progressOf(leg, at);
    }
    if (r.distance.total >= r.auth.ceilings.maxTotalDistance && (r.state === 'leg_active' || r.state === 'authorized')) {
      r.state = 'exhausted';
      r.blocker = { reason: 'distance_limit', detail: `${Math.round(r.distance.total)} of ${r.auth.ceilings.maxTotalDistance} route blocks of own movement are used` };
      this.options.record?.({ type: 'route_exhausted', routeId: r.auth.routeId, goalEpoch: r.auth.goalEpoch, blocker: 'distance_limit', distanceUsed: r1(r.distance.total) });
    }
  }

  /**
   * Samples every own position change of one connection (bot `move`) and every
   * server position correction (evidence journal). Called by composition when a
   * connection becomes ready; replaced on the next connection.
   */
  attachMovement(session: GameSession, goalEpoch: () => number): () => void {
    this.detachMovement?.();
    const bot = session.bot as unknown as EventEmitter & { entity: { position: Vec3 }; game: { dimension: unknown } };
    const ctx = (): RouteCtx => ({ goalEpoch: goalEpoch(), connectionEpoch: session.connectionEpoch, dimension: String(bot.game.dimension) });
    const onMove = () => this.sample(ctx(), bot.entity.position, 'client_physics');
    bot.on('move', onMove);
    const offRecord = session.evidence.onRecord((e) => {
      if (e.kind === 'position_correction') this.sample(ctx(), { x: e.x, y: e.y, z: e.z }, 'server_correction');
    });
    const detach = () => {
      bot.off('move', onMove);
      offRecord();
      if (this.detachMovement === detach) this.detachMovement = undefined;
    };
    this.detachMovement = detach;
    return detach;
  }

  /** Whether route movement may continue (not exhausted by distance or time). */
  budget(ctx: RouteCtx): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const r = this.current;
    if (!r || !this.authorization(ctx)) return { ok: true }; // inside the admission bound: no route budget applies
    if (r.state === 'exhausted' || r.state === 'blocked') return { ok: false, blocker: r.blocker?.reason ?? 'leg_limit', detail: r.blocker?.detail ?? 'route ended' };
    if (r.legs.length > 0 && this.options.clock.now() >= r.auth.ceilings.routeDeadlineMs) return { ok: false, blocker: 'time_limit', detail: 'the route time budget of this goal is spent' };
    return { ok: true };
  }

  private progressOf(leg: LegRecord, at: Vec3): number {
    if (leg.destinationAt) return horizontal(leg.anchor, leg.destinationAt) - horizontal(at, leg.destinationAt);
    if (leg.bearingRad !== null) return (at.x - leg.anchor.x) * Math.cos(leg.bearingRad) + (at.z - leg.anchor.z) * Math.sin(leg.bearingRad);
    return 0;
  }

  /** Whether a new leg could begin now (no side effects). */
  canBegin(ctx: RouteCtx, destination: RouteDestinationKind): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { ok: false, blocker: 'not_authorized', detail: 'no route authorization for this goal on this connection and dimension' };
    if (!auth.destinations.includes(destination)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${destination} destinations` };
    return this.ceilingCheck(r, this.options.clock.now(), r.stalledLegs);
  }

  private ceilingCheck(r: RouteRecord, now: number, stalled: number): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const c = r.auth.ceilings;
    if (r.state === 'blocked' || r.state === 'exhausted') return { ok: false, blocker: r.blocker?.reason ?? 'leg_limit', detail: r.blocker?.detail ?? 'route ended' };
    if (stalled >= c.maxStalledLegs) return { ok: false, blocker: 'stalled', detail: `${stalled} consecutive legs made less than ${c.minLegProgress} blocks of net progress toward the destination` };
    if (r.legs.length >= c.maxLegs) return { ok: false, blocker: 'leg_limit', detail: `all ${c.maxLegs} route legs of this goal are used` };
    if (r.distance.total >= c.maxTotalDistance) return { ok: false, blocker: 'distance_limit', detail: `${Math.round(r.distance.total)} of ${c.maxTotalDistance} route blocks of own movement are used` };
    if (now >= c.routeDeadlineMs) return { ok: false, blocker: 'time_limit', detail: 'the route time budget of this goal is spent' };
    return { ok: true };
  }

  /** Begins the next leg at the bot's own position (code-owned; counted; never refunded). */
  beginLeg(req: BeginLegRequest): BeginLegResult {
    const ctx: RouteCtx = { goalEpoch: req.goalEpoch, connectionEpoch: req.connectionEpoch, dimension: req.dimension };
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) {
      const mismatch = this.current && this.current.state !== 'revoked' && this.current.auth.goalEpoch === req.goalEpoch && this.current.auth.dimension !== req.dimension;
      return { ok: false, blocker: mismatch ? 'dimension_mismatch' : 'not_authorized', detail: mismatch ? 'the route was authorized in another dimension' : 'no route authorization for this goal on this connection and dimension', status: null };
    }
    if (!auth.destinations.includes(req.destination)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${req.destination} destinations`, status: this.status(req.goalEpoch) };
    const now = this.options.clock.now();
    this.sample(ctx, req.at);
    // Close the active leg from the bot's own position; the stall run uses NET progress.
    const prev = r.legs.at(-1);
    let stalled = r.stalledLegs;
    if (prev) {
      prev.displacement = horizontal(prev.anchor, req.at);
      prev.netProgress = this.progressOf(prev, req.at);
      prev.outcome = prev.netProgress >= auth.ceilings.minLegProgress ? 'progressed' : 'stalled';
      stalled = prev.outcome === 'stalled' ? stalled + 1 : 0;
      r.stalledLegs = stalled;
    }
    const check = this.ceilingCheck(r, now, stalled);
    if (!check.ok) {
      if (r.state !== 'exhausted' && r.state !== 'blocked') {
        r.state = check.blocker === 'stalled' ? 'blocked' : 'exhausted';
        r.blocker = { reason: check.blocker, detail: check.detail };
      }
      this.options.record?.({ type: 'route_leg_refused', routeId: auth.routeId, goalEpoch: auth.goalEpoch, blocker: check.blocker, legsUsed: r.legs.length, distanceUsed: r1(r.distance.total) });
      return { ok: false, blocker: check.blocker, detail: check.detail, status: this.status(req.goalEpoch) };
    }
    const leg: LegRecord = {
      index: r.legs.length + 1,
      destination: req.destination,
      anchor: { x: req.at.x, y: req.at.y, z: req.at.z },
      radius: auth.ceilings.legRadius,
      startedAtMs: now,
      bearingRad: req.bearingRad ?? null,
      destinationAt: req.destinationAt ? { ...req.destinationAt } : null,
      displacement: 0,
      netProgress: 0,
      outcome: 'active',
    };
    r.legs.push(leg);
    r.state = 'leg_active';
    r.lastSample ??= { x: req.at.x, y: req.at.y, z: req.at.z };
    this.options.record?.({ type: 'route_leg_started', routeId: auth.routeId, goalEpoch: auth.goalEpoch, leg: leg.index, maxLegs: auth.ceilings.maxLegs, radius: leg.radius, destination: req.destination, distanceUsed: r1(r.distance.total) });
    return { ok: true, leg: this.legBounds(ctx) as RouteLegBounds, status: this.status(req.goalEpoch) as RouteStatus };
  }

  status(goalEpoch?: number): RouteStatus | null {
    const r = this.current;
    if (!r || (goalEpoch !== undefined && r.auth.goalEpoch !== goalEpoch)) return null;
    const a = r.auth;
    const leg = r.legs.at(-1);
    const last = r.legs.length > 1 ? r.legs.at(-2) : undefined;
    return {
      routeId: a.routeId,
      goalId: a.goalId,
      state: r.state,
      destinations: [...a.destinations],
      legsUsed: r.legs.length,
      maxLegs: a.ceilings.maxLegs,
      distanceUsed: r1(r.distance.total),
      distanceSources: { clientPhysics: r1(r.distance.clientPhysics), serverCorrections: r1(r.distance.serverCorrections), correctionCount: r.distance.correctionCount },
      maxTotalDistance: a.ceilings.maxTotalDistance,
      remainingMs: Math.max(0, Math.round(a.ceilings.routeDeadlineMs - this.options.clock.now())),
      stalledLegs: r.stalledLegs,
      legRadius: a.ceilings.legRadius,
      currentLeg: leg && r.state !== 'revoked' ? { index: leg.index, destination: leg.destination, anchor: { x: r1(leg.anchor.x), y: r1(leg.anchor.y), z: r1(leg.anchor.z) }, radius: leg.radius } : null,
      lastLeg: last ? { index: last.index, outcome: last.outcome, netProgress: r1(last.netProgress), displacement: r1(last.displacement) } : null,
      blocker: r.blocker,
    };
  }

  revoke(reason: string, goalEpoch?: number): void {
    const r = this.current;
    if (!r || r.state === 'revoked') return;
    if (goalEpoch !== undefined && r.auth.goalEpoch !== goalEpoch) return;
    r.state = 'revoked';
    this.options.record?.({ type: 'route_revoked', routeId: r.auth.routeId, goalEpoch: r.auth.goalEpoch, reason: reason.slice(0, 64), legsUsed: r.legs.length, distanceUsed: r1(r.distance.total) });
  }
}
