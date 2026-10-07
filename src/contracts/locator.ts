// MB-LOC-001 locator-assisted following and declared bounded route legs.
//
// Two code-owned concepts, both plain data (no Minecraft library imports):
//
// 1. LocatorHint — a COARSE, owner-only cue derived from the server's
//    `tracked_waypoint` (locator bar) packets: compass sector, distance band and
//    relative elevation where the received variant justifies it, with source,
//    receive time, freshness, connection epoch and dimension. Exact waypoint
//    coordinates are used only transiently inside src/locator/ to derive the
//    cue; they never appear in this contract, observations, planner/Jev
//    context, memory, status/dashboard or logs. A hint is NOT owner
//    visibility, an interaction target, or proof of arrival. Identity is bound
//    only by the configured verified owner UUID (or, in the trusted offline
//    fixture, the exact name's derived offline UUID AND that exact listed
//    name); never by icon colour, order, name similarity or nearest player.
//    String-identified waypoints and unknown UUIDs grant no identity.
//
// 2. RouteAuthorization — a typed, code-owned leg budget granted at goal
//    ADMISSION from operator policy (never by the planner). Each leg is a
//    finite local travel bound anchored at the bot's own position when the leg
//    begins, inside which the ordinary conservative skills operate on fresh
//    local geometry. Parent ceilings (legs, total leg distance, elapsed time,
//    stalled legs) are fixed at admission and cannot be reset by a new leg,
//    window, replan or planner output. The admission anchor and the goal's
//    accepted outcome/counters are unchanged by legs.
import { z } from 'zod';
import { BOUNDS, DimensionSchema, Vec3Schema, textSchema, type Vec3 } from './common.ts';
import { EpochSchema, GoalIdSchema } from './ids.ts';

// ---------------------------------------------------------------- locator hints

/** Eight compass sectors (+x east, +z south); the same vocabulary as observation frontiers. */
export const COMPASS_SECTORS = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'] as const;
export const CompassSectorSchema = z.enum(COMPASS_SECTORS);
export type CompassSector = z.infer<typeof CompassSectorSchema>;

/** Waypoint payload variants of the 26.x `tracked_waypoint` codec. */
export const WAYPOINT_VARIANTS = ['empty', 'vec3i', 'chunk', 'azimuth'] as const;
export const WaypointVariantSchema = z.enum(WAYPOINT_VARIANTS);
export type WaypointVariant = z.infer<typeof WaypointVariantSchema>;

/**
 * Horizontal distance band (blocks). `vec3i` justifies any band; `chunk` only
 * bands whose edges are not within the chunk-centre uncertainty; `azimuth`
 * and `empty` carry no distance (`unknown`).
 */
export const LOCATOR_DISTANCE_BANDS = ['close', 'near', 'far', 'very_far', 'unknown'] as const;
export const LocatorDistanceBandSchema = z.enum(LOCATOR_DISTANCE_BANDS);
export type LocatorDistanceBand = z.infer<typeof LocatorDistanceBandSchema>;
/** Upper edges of close/near/far (blocks, horizontal); beyond the last is very_far. */
export const LOCATOR_BAND_EDGES = { close: 32, near: 128, far: 512 } as const;

/** Relative height: only a block-precision (vec3i) statement justifies above/below/level. */
export const LOCATOR_ELEVATIONS = ['above', 'below', 'level', 'unknown'] as const;
export const LocatorElevationSchema = z.enum(LOCATOR_ELEVATIONS);
export type LocatorElevation = z.infer<typeof LocatorElevationSchema>;
/** |dy| at or below this is `level` (blocks). */
export const LOCATOR_LEVEL_TOLERANCE = 3;

/** Precision of the server statement the cue came from (never the statement itself). */
export const LOCATOR_PRECISIONS = ['block', 'chunk', 'direction_only', 'none'] as const;
export type LocatorPrecision = (typeof LOCATOR_PRECISIONS)[number];

/** Why a hint is not actionable (or `tracking` when it is). */
export const LOCATOR_HINT_REASONS = [
  'tracking', // a current server statement for the verified owner
  'never_received', // no owner waypoint on this connection/dimension yet
  'untracked', // the server withdrew the owner's waypoint (hidden: crouching, invisibility, head item, range, logout, ...)
  'expired', // the last statement is older than the freshness bound
  'no_position', // the server tracks the owner with an `empty` payload
  'dimension_changed', // a dimension change/respawn voided earlier statements
  'disconnected', // no ready connection (statements never carry across connections)
  'owner_identity_unverified', // the owner policy cannot verify identity on this connection (e.g. UUID mode on an offline-mode server)
  'unsupported_codec', // the installed protocol does not have the verified tracked_waypoint definition
  'disabled', // locator perception is disabled by configuration
] as const;
export const LocatorHintReasonSchema = z.enum(LOCATOR_HINT_REASONS);
export type LocatorHintReason = z.infer<typeof LocatorHintReasonSchema>;

/**
 * The ONLY model-visible locator data. Coarse, owner-only, freshness-labelled.
 * `actionable` is true only for a current statement with a direction on the
 * current connection and dimension.
 */
export const LocatorHintSchema = z
  .object({
    target: z.literal('owner'),
    source: z.literal('server_locator_waypoint'),
    actionable: z.boolean(),
    reason: LocatorHintReasonSchema,
    direction: CompassSectorSchema.nullable(),
    distanceBand: LocatorDistanceBandSchema,
    elevation: LocatorElevationSchema,
    precision: z.enum(LOCATOR_PRECISIONS),
    /** Age of the last owner statement at view time (null: none received). */
    ageMs: z.number().int().nonnegative().nullable(),
    /** Remaining freshness (null: not actionable). */
    expiresInMs: z.number().int().nonnegative().nullable(),
    connectionEpoch: EpochSchema,
    dimension: DimensionSchema.nullable(),
    note: textSchema(BOUNDS.shortText),
  })
  .strict();
export type LocatorHint = z.infer<typeof LocatorHintSchema>;

/** Bounded counters for status/evidence (counts only; never positions or other players' identities). */
export interface LocatorCounters {
  packets: number;
  track: number;
  update: number;
  untrack: number;
  /** Statements attributed to the verified owner. */
  ownerStatements: number;
  /** Waypoints currently tracked that are NOT the verified owner (count only). */
  otherTracked: number;
  /** String-identified waypoints received (never granted identity). */
  stringIds: number;
  /** Packets refused as malformed/unknown variant. */
  rejected: number;
  byVariant: Record<WaypointVariant, number>;
}

export const LOCATOR_SUPPORT = ['available', 'unsupported_codec', 'disabled', 'not_connected'] as const;
export type LocatorSupport = (typeof LOCATOR_SUPPORT)[number];

export interface LocatorStatus {
  support: LocatorSupport;
  /** The protocol version whose codec was verified (e.g. 26.2), when available. */
  codecVersion: string | null;
  connectionEpoch: number;
  owner: LocatorHint;
  counters: LocatorCounters;
}

// ---------------------------------------------------------------- configuration

/**
 * Operator route policy (proposed ChunkbotConfig `locator.routes`, added by the
 * designated writer). The planner never supplies or changes these values.
 */
export const RoutePolicySchema = z
  .object({
    /** Off: no route authorization is ever granted; travel stays inside the admission radius. */
    enabled: z.boolean().default(true),
    /** Local bound of one leg (blocks, horizontal) around the bot's position when the leg begins. */
    legRadius: z.number().int().min(16).max(256).default(96),
    /** Legs per goal, including legs that made no progress. */
    maxLegs: z.number().int().min(1).max(64).default(12),
    /** Sum of leg displacements per goal (blocks, horizontal). */
    maxTotalDistance: z.number().int().min(64).max(8_192).default(1_024),
    /** Wall-clock budget from the first leg (ms); also bounded by the goal deadline. */
    maxRouteMs: z.number().int().min(10_000).max(3_600_000).default(15 * 60_000),
    /** Consecutive legs whose progress toward the destination is below minLegProgress before the route is blocked. */
    maxStalledLegs: z.number().int().min(1).max(8).default(3),
    minLegProgress: z.number().int().min(1).max(64).default(8),
    /** Destination kinds a goal may route toward. */
    destinations: z.array(z.enum(['owner', 'owner_destination', 'own_death'])).min(1).max(3).default(['owner', 'owner_destination']),
    /** Goal sources that receive an authorization at admission. */
    sources: z.array(z.enum(['owner', 'progression', 'support'])).min(1).max(3).default(['owner']),
  })
  .strict();
export type RoutePolicy = z.infer<typeof RoutePolicySchema>;

export const LocatorConfigSchema = z
  .object({
    /** Locator perception (waypoint packets -> coarse owner hint). */
    enabled: z.boolean().default(true),
    /** A tracked owner statement older than this is `expired` (not actionable). */
    hintMaxAgeMs: z.number().int().min(1_000).max(600_000).default(60_000),
    routes: RoutePolicySchema.default(RoutePolicySchema.parse({})),
  })
  .strict();
export type LocatorConfig = z.infer<typeof LocatorConfigSchema>;
export const DEFAULT_LOCATOR_CONFIG: LocatorConfig = LocatorConfigSchema.parse({});

// ---------------------------------------------------------------- routes

export const RouteIdSchema = z.string().regex(/^route-[a-z0-9]{1,32}$/);
export type RouteId = z.infer<typeof RouteIdSchema>;

export const ROUTE_DESTINATION_KINDS = ['owner', 'owner_destination', 'own_death'] as const;
export type RouteDestinationKind = (typeof ROUTE_DESTINATION_KINDS)[number];

/** Who the admitted goal belongs to (typed code-owned context; not a goal/task enum). */
export const ROUTE_GOAL_SOURCES = ['owner', 'progression', 'support', 'diagnostic'] as const;
export type RouteGoalSource = (typeof ROUTE_GOAL_SOURCES)[number];

export interface RouteCeilings {
  legRadius: number;
  maxLegs: number;
  maxTotalDistance: number;
  /** Absolute wall-clock end of the route budget (ms since epoch); min(admission + maxRouteMs, goal deadline). */
  routeDeadlineMs: number;
  maxStalledLegs: number;
  minLegProgress: number;
}

/** Immutable once granted (Object.freeze); only the route controller holds mutable usage. */
export interface RouteAuthorization {
  routeId: RouteId;
  goalId: string;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  source: RouteGoalSource;
  grantedBy: 'operator_policy';
  grantedAtMs: number;
  destinations: readonly RouteDestinationKind[];
  /** Copy of the goal's admission anchor; never moved by a leg. */
  admissionAnchor: Vec3;
  admissionRadius: number;
  ceilings: Readonly<RouteCeilings>;
}

/** Input of the synchronous admission hook (called with the travel-anchor capture). */
export interface RouteAdmission {
  goalId: string;
  goalEpoch: number;
  admittedAtMs: number;
  source: RouteGoalSource;
  /** Absolute goal deadline (ms since epoch). */
  goalDeadlineMs: number;
  connectionEpoch: number;
  dimension: string;
  admissionAnchor: Vec3;
  admissionRadius: number;
}

export const ROUTE_STATES = ['authorized', 'leg_active', 'exhausted', 'blocked', 'revoked'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export const ROUTE_BLOCKERS = [
  'leg_limit',
  'distance_limit',
  'time_limit',
  'stalled', // maxStalledLegs consecutive legs without progress toward the destination
  'no_actionable_hint', // owner not visible and no current locator statement
  'destination_not_authorized',
  'dimension_mismatch',
  'not_authorized', // no route authorization for this goal epoch/connection
] as const;
export type RouteBlocker = (typeof ROUTE_BLOCKERS)[number];

/** Effective local travel bound of the active leg (consumed by the perception travel guard). */
export interface RouteLegBounds {
  routeId: RouteId;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  legIndex: number;
  /** The bot's own position when the leg began (not a hidden coordinate). */
  anchor: Vec3;
  radius: number;
}

/** Model/status-visible route progress (no destination coordinates, no hidden positions). */
export const RouteStatusSchema = z
  .object({
    routeId: RouteIdSchema,
    goalId: GoalIdSchema,
    state: z.enum(ROUTE_STATES),
    legsUsed: z.number().int().nonnegative(),
    maxLegs: z.number().int().positive(),
    distanceUsed: z.number().nonnegative(),
    maxTotalDistance: z.number().positive(),
    remainingMs: z.number().int().nonnegative(),
    stalledLegs: z.number().int().nonnegative(),
    legRadius: z.number().positive(),
    currentLeg: z
      .object({ index: z.number().int().positive(), destination: z.enum(ROUTE_DESTINATION_KINDS), anchor: Vec3Schema, radius: z.number().positive() })
      .strict()
      .nullable(),
    lastLeg: z
      .object({ index: z.number().int().positive(), outcome: z.string().max(64), progress: z.number(), displacement: z.number().nonnegative() })
      .strict()
      .nullable(),
    blocker: z.object({ reason: z.enum(ROUTE_BLOCKERS), detail: textSchema(BOUNDS.shortText) }).strict().nullable(),
  })
  .strict();
export type RouteStatus = z.infer<typeof RouteStatusSchema>;

// ---------------------------------------------------------------- ports

/** Coarse owner locator (src/locator/). Plain data only. */
export interface LocatorPort {
  /** The coarse owner hint for the CURRENT connection/dimension (never exact coordinates). */
  ownerHint(): LocatorHint;
  status(): LocatorStatus;
}

/**
 * Code-owned route legs (src/locator/routes.ts). The planner has no access to
 * this port; proposals cannot grant, extend or reset authorizations.
 */
export interface RoutePort {
  /** Synchronous admission hook: grants (or declines, returning undefined) a route authorization for the new goal epoch from operator policy. */
  admit(admission: RouteAdmission): RouteAuthorization | undefined;
  /** Active leg bounds for (goalEpoch, connectionEpoch, dimension), else undefined (the admission bound applies). */
  legBounds(ctx: { goalEpoch: number; connectionEpoch: number; dimension: string }): RouteLegBounds | undefined;
  /** Route progress for a goal epoch (status/observation); null when none. */
  status(goalEpoch?: number): RouteStatus | null;
  /** Goal end / replacement / lifecycle: the route can never steer again. */
  revoke(reason: string, goalEpoch?: number): void;
}

/**
 * Seam for a CODE-OWNED historical destination (e.g. the survival module's own
 * last death position, recorded from the bot's own server-confirmed state).
 * Not a planner coordinate, not another player's position. The route module
 * only routes toward it when the goal's authorization lists `own_death`.
 */
export interface RouteDestinationProvider {
  readonly kind: 'own_death';
  current(ctx: { connectionEpoch: number; dimension: string; goalEpoch: number }): { destinationId: string; dimension: string; at: Vec3; recordedAtMs: number; label: string } | undefined;
}
