// MB-FLOW-003-C11/C13 immediate safety contracts (water and mobs).
//
// Immediate safety is a bounded, CODE-OWNED local reflex over fresh
// player-visible state. It never calls a model, never owns a goal, never
// grants or widens permissions for goal work, and never completes, resets or
// refills an owner job: outcome, admission baseline, verified progress,
// planner turns, tasks, replans, travel anchor and the SpendLedger are
// untouched. It interrupts work only by SUSPENDING the current actuator lease
// holder (the goal stays admitted) and runs one finite, explicitly bounded
// response through the SAME executor/lease as every other action:
//
//   detect (local, no inference)
//     -> SafetyGrant (finite: expiry, action count, displacement, one
//        connection/dimension; fenced by grantCurrent)
//     -> preempt: synchronously revoke the current non-safety lease with
//        reason `safety_preempt` (controls cleared, interfaces closed)
//     -> execute code-built candidates of the registered safety skills with
//        owner `{ kind: 'safety' }` (one actuator lease)
//     -> release: the hold clears; suspended work re-observes fresh state and
//        continues (or stays blocked with a declarative reason).
//
// AUTHORITY (coordinator review 1): immediate safety does NOT depend on
// configured persistent memory, autonomous progression or the supervisor's
// scope-gated guard. The shared writer passes explicit CURRENT gameplay
// authority (`SafetyAuthority.basis`):
//   - `owner_goal`: an admitted, non-terminal MANUAL owner goal exists
//     (planning, provider waits, task/window transitions, blocker replans).
//     It authorizes its own protected motion EVEN WHILE the automatic pause
//     latch remains set; the raw latch never forbids that goal's protection.
//   - `unpaused`: no admitted owner goal, the explicit stop latch is clear
//     (idle, support/progression work, planner waits): idle coverage when
//     `coverIdle`.
//   - `none`: explicit stop with no newer admitted manual owner goal,
//     shutdown, logout, disconnect, death/respawn pending, not ready. No
//     safety motion at all: no hidden idle movement or buoyancy loop.
// Explicit stop, logout, death, disconnect and dimension change revoke the
// grant and every timer/control (status may still say the bot is submerged).
// Join/respawn starts from a fresh assessment; nothing is replayed.
//
// A planner/Jev task can never borrow safety authority: safety skills take no
// grant parameter; the executor passes the ACTUAL owner, and the displacement
// exception exists only for a verified `{ kind: 'safety' }` owner whose grant
// is current. Goal-owned use of a safety skill keeps the goal's travel bounds.
//
// Provenance is explicit everywhere: own air comes ONLY from server entity
// metadata addressed to the bot's own entity id (missing air is `unknown`,
// never a full reserve); fluid/ceiling/support are LOCAL estimates from the
// client world model and client physics; entity facts are visible-only
// (line of sight within a bounded radius) and their server metadata flags are
// labeled. Hidden mobs, global scans and owner coordinates never enter.
//
// This file has no Minecraft library imports.
import { z } from 'zod';
import type { ActionCandidate, SkillOutcome } from './action.ts';
import type { Vec3 } from './common.ts';
import type { GameLifecycleEvent } from './ports.ts';

export const SAFETY_SCHEMA_VERSION = 1 as const;

/** Vanilla maximum air supply (ticks of breath) for players in 26.1.x/26.2. */
export const AIR_MAX = 300;

/** Hard ceilings independent of config (a config can only be stricter). */
export const SAFETY_BOUNDS = {
  /** Visible entity facts considered per assessment. */
  entities: 24,
  /** Threats listed in status. */
  statusThreats: 8,
  /** Absolute ceiling on one episode's duration. */
  episodeMsCeiling: 60_000,
  /** Absolute ceiling on one episode's displacement from its origin (blocks). */
  displacementCeiling: 48,
  /** Absolute ceiling on executions (skill dispatches) in one grant. */
  actionsCeiling: 12,
  /** Absolute ceiling on melee attacks in one defensive engagement. */
  attacksCeiling: 10,
  /** Recent episode history kept for status/repeated-hazard accounting. */
  history: 16,
} as const;

// ---------------------------------------------------------------- config

/**
 * `safety` config block (proposed for ChunkbotConfig as
 * `safety: SafetyConfigSchema.optional()`; absent = enabled with these
 * defaults whenever gameplay runs; `enabled: false` turns the reflex off).
 * Every value is a bounded coordinator default; models can never supply or
 * change any of them.
 */
export const SafetyConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Local monitor cadence (fresh self/entity read; never an inference trigger). */
    tickMs: z.number().int().min(100).max(2_000).default(250),
    /** Cover periods with no admitted owner goal while the explicit stop latch is clear (basis `unpaused`). Owner goals are always covered. */
    coverIdle: z.boolean().default(true),
    water: z
      .object({
        /** Server air (0..300) at or below which low air is urgent even when the eyes just surfaced. */
        lowAirAtOrBelow: z.number().int().min(30).max(290).default(150),
        /** Horizontal search radius for an open water column when a solid ceiling is above. */
        surfaceSearchRadius: z.number().int().min(1).max(8).default(5),
        /** Search radius for a dry standable exit. */
        shoreSearchRadius: z.number().int().min(2).max(16).default(10),
        maxEpisodeMs: z.number().int().min(5_000).max(SAFETY_BOUNDS.episodeMsCeiling).default(25_000),
        maxDisplacement: z.number().min(4).max(SAFETY_BOUNDS.displacementCeiling).default(24),
        /** Ordinary navigation refuses unsupported (swimming-depth) water nodes. */
        avoidDeepWaterPaths: z.boolean().default(true),
      })
      .strict()
      .default({ lowAirAtOrBelow: 150, surfaceSearchRadius: 5, shoreSearchRadius: 10, maxEpisodeMs: 25_000, maxDisplacement: 24, avoidDeepWaterPaths: true }),
    mobs: z
      .object({
        enabled: z.boolean().default(true),
        /** Visible entities are assessed within this radius (<= observation radius). */
        scanRadius: z.number().min(4).max(32).default(16),
        /** A hostile melee mob inside this radius that is aggressive/approaching is a threat. */
        dangerRadius: z.number().min(2).max(16).default(8),
        /** Any hostile inside this radius is a threat regardless of flags. */
        closeRadius: z.number().min(1).max(6).default(3.5),
        /** A creeper inside this radius is a threat (fuse/ignited: always critical within scan). */
        creeperRadius: z.number().min(3).max(16).default(8),
        /** Ranged hostiles inside this radius that are aggressive or attacked us are threats. */
        rangedRadius: z.number().min(4).max(32).default(16),
        /** Two or more active threats inside this radius are a group (avoidance only). */
        groupRadius: z.number().min(4).max(24).default(12),
        /** Retreat aims for at least this separation from every active threat. */
        retreatSeparation: z.number().min(6).max(32).default(14),
        /** Maximum displacement of one retreat leg. */
        retreatLegMax: z.number().min(4).max(32).default(16),
        /** Server damage attributed to an entity makes it a provoked threat for this long. */
        provokedWindowMs: z.number().int().min(1_000).max(30_000).default(6_000),
        /** Distance trend window for "approaching". */
        approachWindowMs: z.number().int().min(500).max(5_000).default(1_500),
        maxEpisodeMs: z.number().int().min(5_000).max(SAFETY_BOUNDS.episodeMsCeiling).default(20_000),
        maxDisplacement: z.number().min(4).max(SAFETY_BOUNDS.displacementCeiling).default(32),
        defense: z
          .object({
            enabled: z.boolean().default(true),
            /** Engage only at or above this server health. */
            minHealth: z.number().min(6).max(20).default(14),
            /** Disengage (switch to retreat) at or below this health. */
            disengageHealth: z.number().min(2).max(18).default(10),
            /** Engage only at or above this food (sprint-capable reserve for an escape). */
            minFood: z.number().int().min(0).max(20).default(7),
            /** Minimum total equipped armor points (server-stated slots). */
            minArmorPoints: z.number().int().min(0).max(20).default(6),
            /** Weapon remaining uses must be at least this ... */
            minWeaponUses: z.number().int().min(1).max(512).default(16),
            /** ... and at least this fraction of max durability. */
            minWeaponFraction: z.number().min(0).max(0.9).default(0.15),
            /** Each counted armor piece must keep at least this fraction of durability. */
            minArmorFraction: z.number().min(0).max(0.9).default(0.1),
            maxAttacks: z.number().int().min(1).max(SAFETY_BOUNDS.attacksCeiling).default(8),
            /** Select an owned verified hotbar weapon (one hotbar packet; no inventory clicks). */
            allowHotbarSwitch: z.boolean().default(true),
            /** A target knocked out of reach may come back within this time; no pursuit. */
            reengageWaitMs: z.number().int().min(500).max(6_000).default(2_500),
          })
          .strict()
          .default({ enabled: true, minHealth: 14, disengageHealth: 10, minFood: 7, minArmorPoints: 6, minWeaponUses: 16, minWeaponFraction: 0.15, minArmorFraction: 0.1, maxAttacks: 8, allowHotbarSwitch: true, reengageWaitMs: 2_500 }),
      })
      .strict()
      .default({
        enabled: true,
        scanRadius: 16,
        dangerRadius: 8,
        closeRadius: 3.5,
        creeperRadius: 8,
        rangedRadius: 16,
        groupRadius: 12,
        retreatSeparation: 14,
        retreatLegMax: 16,
        provokedWindowMs: 6_000,
        approachWindowMs: 1_500,
        maxEpisodeMs: 20_000,
        maxDisplacement: 32,
        defense: { enabled: true, minHealth: 14, disengageHealth: 10, minFood: 7, minArmorPoints: 6, minWeaponUses: 16, minWeaponFraction: 0.15, minArmorFraction: 0.1, maxAttacks: 8, allowHotbarSwitch: true, reengageWaitMs: 2_500 },
      }),
    episodes: z
      .object({
        /** Dispatches one grant may make (each through the fenced executor). */
        maxActions: z.number().int().min(1).max(SAFETY_BOUNDS.actionsCeiling).default(6),
        /** Episodes allowed per rolling window before repeated hazards block. */
        maxPerWindow: z.number().int().min(1).max(32).default(8),
        /** Episodes without measurable improvement allowed per window before blocking. */
        maxFailedPerWindow: z.number().int().min(1).max(8).default(3),
        windowMs: z.number().int().min(30_000).max(600_000).default(120_000),
        /** A blocked hazard with an unchanged signature is not retried for this long. */
        blockedCooldownMs: z.number().int().min(5_000).max(600_000).default(30_000),
      })
      .strict()
      .default({ maxActions: 6, maxPerWindow: 8, maxFailedPerWindow: 3, windowMs: 120_000, blockedCooldownMs: 30_000 }),
  })
  .strict();
export type SafetyConfig = z.output<typeof SafetyConfigSchema>;
export type SafetyConfigInput = z.input<typeof SafetyConfigSchema>;

// ---------------------------------------------------------------- facts (plain data, provenance-labeled)

/** Own air. `server_metadata`: entity metadata `air_supply` addressed to the bot's own entity id. */
export const SafetyAirFactSchema = z
  .object({
    value: z.number().int().min(-20).max(AIR_MAX).nullable(),
    max: z.literal(AIR_MAX),
    source: z.enum(['server_metadata', 'unknown']),
    observedAtMs: z.number().int().nonnegative().nullable(),
    /** Direction of the last two server statements (unknown with fewer). */
    trend: z.enum(['falling', 'rising', 'steady', 'unknown']),
  })
  .strict();
export type SafetyAirFact = z.infer<typeof SafetyAirFactSchema>;

/**
 * Fluid/support/ceiling around the bot. LOCAL estimate: client world model
 * (server chunk/block data) plus the bot's client-physics position; never a
 * server statement about the bot's body.
 */
export const SafetyFluidFactSchema = z
  .object({
    feetIn: z.enum(['water', 'lava', 'none']),
    eyeIn: z.enum(['water', 'lava', 'none']),
    /** What is under the feet: solid support, more fluid, or nothing. */
    support: z.enum(['solid', 'fluid', 'none', 'unknown']),
    /** Contiguous fluid blocks from the feet block down (bounded; null when not in fluid). */
    depth: z.number().int().min(0).max(32).nullable(),
    /** Standing on the floor beneath keeps the eyes above the fluid (null: not in fluid). */
    wadeable: z.boolean().nullable(),
    /**
     * Straight up from the eye: `open` (fluid then air, `surfaceDy` blocks up),
     * `ceiling` (a solid block before any air), `unknown` (unloaded/too deep).
     */
    headroom: z.enum(['open', 'ceiling', 'unknown', 'dry']),
    surfaceDy: z.number().min(0).max(32).nullable(),
    onGround: z.boolean(),
    source: z.literal('local_estimate'),
  })
  .strict();
export type SafetyFluidFact = z.infer<typeof SafetyFluidFactSchema>;

export const SafetyItemFactSchema = z
  .object({
    key: z.string().max(100),
    /** Window-0 slot (36..44 hotbar, 5..8 armor, 45 off hand). */
    slot: z.number().int().min(0).max(45),
    maxDurability: z.number().int().positive().nullable(),
    remainingUses: z.number().int().nonnegative().nullable(),
    /** `server_slot`: the server stated this exact stack (component patch seen). */
    metadata: z.enum(['server_slot', 'unknown']),
  })
  .strict();
export type SafetyItemFact = z.infer<typeof SafetyItemFactSchema>;

export const SafetyEquipmentFactSchema = z
  .object({
    /** Main hand: the CLIENT-selected hotbar slot's server-stated stack. */
    mainHand: SafetyItemFactSchema.nullable(),
    heldHotbar: z.number().int().min(0).max(8).nullable(),
    /** Server-stated hotbar stacks (for an optional hotbar weapon switch). */
    hotbar: z.array(SafetyItemFactSchema).max(9),
    armor: z.array(SafetyItemFactSchema).max(4),
    source: z.enum(['server_slots', 'unavailable']),
    observedAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SafetyEquipmentFact = z.infer<typeof SafetyEquipmentFactSchema>;

export const SafetySelfFactsSchema = z
  .object({
    connectionEpoch: z.number().int().nonnegative(),
    dimension: z.string().max(100),
    observedAtMs: z.number().int().nonnegative(),
    position: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    health: z.number().min(0).max(1_024),
    food: z.number().min(0).max(20),
    /** `server_update_health` once the server sent health on this connection, else the library value. */
    vitalsSource: z.enum(['server_update_health', 'client_model']),
    air: SafetyAirFactSchema,
    fluid: SafetyFluidFactSchema,
    equipment: SafetyEquipmentFactSchema,
    /** Server damage_event addressed to the bot within the provoked window (newest first). */
    recentDamage: z
      .array(
        z
          .object({
            atMs: z.number().int().nonnegative(),
            /** Entity responsible (sourceCauseId - 1), or null (environment / unknown). */
            causeEntityId: z.number().int().nullable(),
            directEntityId: z.number().int().nullable(),
            damageTypeId: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type SafetySelfFacts = z.infer<typeof SafetySelfFactsSchema>;

/**
 * How code treats an entity type for safety (documented code policy per
 * exact version; never a model decision). `owner`/`player`: never a combat
 * target. `hostile_*`: may be a threat when visible and near. `neutral`:
 * a threat only after server-attributed damage (provoked); never attacked.
 * `passive`: never a threat. `unknown`: avoided only when it demonstrably
 * damaged the bot; never attacked.
 */
export const SAFETY_DISPOSITIONS = ['owner', 'player', 'hostile_melee', 'hostile_ranged', 'hostile_explosive', 'hostile_other', 'neutral', 'passive', 'unknown'] as const;
export type SafetyDisposition = (typeof SAFETY_DISPOSITIONS)[number];

/** One VISIBLE entity (line of sight within the scan radius at observation time). */
export interface SafetyEntityFact {
  /** Code-only protocol entity id (never sent to a model). */
  entityId: number;
  key: string;
  disposition: SafetyDisposition;
  at: Vec3;
  distance: number;
  height: number;
  /** Distance trend over the approach window (null: not enough visible samples). */
  approaching: boolean | null;
  /** Server metadata: mob aggressive flag (`mob_flags` bit 0x04), when the type has it. */
  aggressive: boolean | null;
  baby: boolean | null;
  /** Creeper server metadata: swelling (`swell_dir` > 0) and/or ignited. */
  fuse: { swelling: boolean; ignited: boolean } | null;
  /** Main-hand item stated by the server (entity_equipment), or null when none/unknown. */
  heldItem: string | null;
  /** Server damage_event naming this entity as cause, within the provoked window. */
  damagedSelfAtMs: number | null;
  observedAtMs: number;
}

// ---------------------------------------------------------------- hazards and responses

export const SAFETY_HAZARD_KINDS = [
  /** Eyes in water. */
  'submerged',
  /** Feet in water without solid support (swimming depth) while not submerged. */
  'deep_water',
  /** Server air at/below the low threshold or unknown while submerged. */
  'low_air',
  'in_lava',
  /** A creeper near, swelling or ignited. */
  'creeper',
  'melee_threat',
  'ranged_threat',
  /** Two or more active threats. */
  'group_threat',
  /** A neutral or unknown entity that the server says damaged the bot. */
  'provoked_threat',
] as const;
export type SafetyHazardKind = (typeof SAFETY_HAZARD_KINDS)[number];

export interface SafetyHazard {
  kind: SafetyHazardKind;
  severity: 'critical' | 'high' | 'moderate';
  detail: string;
  /** Visible entities involved (code-only ids). */
  entityIds: number[];
}

/** The three bounded responses (registered skill ids in SAFETY_CAPABILITIES). */
export const SAFETY_RESPONSES = ['escape_water', 'retreat', 'defend'] as const;
export type SafetyResponseKind = (typeof SAFETY_RESPONSES)[number];

/** Why defense is or is not admitted right now (every check is listed; none is assumed). */
export interface DefenseReadiness {
  admitted: boolean;
  /** Refusal reasons (empty when admitted), e.g. `no_verified_weapon`, `armor_below_minimum`, `creeper`. */
  refusals: string[];
  target: { entityId: number; key: string; distance: number } | null;
  weapon: { key: string; slot: number; remainingUses: number | null; switchFromHotbar: number | null } | null;
  armorPoints: number;
  health: number;
  food: number;
}

export type SafetyPlan =
  | { kind: 'none'; reason: string }
  | {
      kind: 'respond';
      response: SafetyResponseKind;
      hazards: SafetyHazard[];
      reason: string;
      /** Defense: the single admitted target and readiness evidence. */
      defense?: DefenseReadiness;
      /** Signature of the hazard condition (unchanged signature after a block is not retried before cooldown). */
      signature: string;
    }
  | { kind: 'blocked'; hazards: SafetyHazard[]; reason: string; detail: string; signature: string };

// ---------------------------------------------------------------- grants and episodes

/** Grant ids are code-generated (`sg-...`); episode ids `se-...`. */
export const SafetyGrantIdSchema = z.string().regex(/^sg-[a-z0-9]{4,24}$/);
export const SafetyEpisodeIdSchema = z.string().regex(/^se-[a-z0-9]{4,24}$/);

/**
 * Finite, code-owned authority for ONE response episode. Never issued by a
 * model, never renewed or extended: a later hazard gets a NEW grant counted
 * against the repeated-hazard window. Valid only while: not revoked, not
 * expired, same connection epoch and dimension, authority basis not `none` and the bot
 * alive. Displacement is measured from `origin` (an explicit narrow exception
 * to the goal travel radius; the goal anchor is never moved).
 */
export interface SafetyGrant {
  readonly grantId: string;
  readonly episodeId: string;
  readonly connectionEpoch: number;
  readonly dimension: string;
  /** First response; a later step of the SAME episode may switch (e.g. defend -> retreat when readiness changes), each step counted. */
  readonly initialResponse: SafetyResponseKind;
  readonly hazards: readonly SafetyHazardKind[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly maxActions: number;
  actionsUsed: number;
  readonly origin: Vec3;
  readonly maxDisplacement: number;
  /** Work suspended when issued (informational; never authority). */
  readonly suspended: { goalId: string; goalEpoch: number } | null;
  revoked?: string;
}

/**
 * Executor owner for safety dispatches (ExecutionOwner variant proposed for
 * ports.ts). Only SafetyService constructs it. The executor/leases verify
 * `grantCurrent(grantId)` at acquisition and in every fence; a goal/task
 * dispatch can never carry it (TaskRuntime always passes its goal owner).
 */
export interface SafetyExecutionOwner {
  kind: 'safety';
  grantId: string;
  episodeId: string;
  connectionEpoch: number;
}

export const SAFETY_EPISODE_OUTCOMES = [
  /** Hazard gone (fresh facts). */
  'resolved',
  /** Measurably better (surfaced/air rising/separation increased) but not fully resolved within bounds. */
  'improved',
  /** Bounded attempt ended without measurable improvement. */
  'unresolved',
  /** No supported response (no exit/retreat); declarative blocker. */
  'blocked',
  /** Stop/logout/death/disconnect/dimension change or grant fence. */
  'revoked',
] as const;
export type SafetyEpisodeOutcome = (typeof SAFETY_EPISODE_OUTCOMES)[number];

export interface SafetyEpisodeResult {
  episodeId: string;
  grantId: string;
  response: SafetyResponseKind;
  outcome: SafetyEpisodeOutcome;
  reason: string;
  detail: string;
  hazardsBefore: SafetyHazardKind[];
  hazardsAfter: SafetyHazardKind[];
  actions: number;
  elapsedMs: number;
  displacement: number;
  /** Server-confirmed facts only (air/health statements, damage/death events); local estimates are labeled. */
  evidence: Record<string, unknown>;
  endedAtMs: number;
}

// ---------------------------------------------------------------- ports

/** Raw protocol packet source (the bot's protocol client); EventEmitter-like. */
export interface SafetyPacketSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export const SAFETY_AUTHORITY_BASES = ['owner_goal', 'unpaused', 'none'] as const;
export type SafetyAuthorityBasis = (typeof SAFETY_AUTHORITY_BASES)[number];

/**
 * Fresh EXPLICIT authority the host computes synchronously (every tick, in
 * every grant fence and before every dispatch) from the GoalEngine's current
 * goal/source/state and the explicit stop latch, the connection and the
 * lifecycle. It is never derived from memory/progression configuration.
 *   basis `owner_goal`: admitted non-terminal manual owner goal (latch may be set).
 *   basis `unpaused`:   no owner goal and the explicit stop latch is clear.
 *   basis `none`:       anything else (stopped without a newer owner goal,
 *                       shutting down, not ready, dead, respawn pending).
 * `goal` is informational (what would be suspended); never safety authority.
 */
export interface SafetyAuthority {
  basis: SafetyAuthorityBasis;
  /** Short reason for status/evidence, e.g. `owner goal goal-ab12 executing`, `explicit stop`. */
  detail: string;
  connection: { ready: boolean; connectionEpoch: number; dimension: string } | null;
  alive: boolean;
  goal: { goalId: string; goalEpoch: number; source: 'owner' | 'support' | 'progression' | 'diagnostic' | 'unknown' } | null;
  /** The admitted goal's travel bounds (retreat targets prefer staying inside). */
  travel: { anchor: Vec3; radius: number } | null;
}

/**
 * Actuation seam implemented by the shared writer over the existing
 * ActuatorLeases and SkillExecutorImpl (no second controller).
 */
export interface SafetyActuationPort {
  /**
   * Synchronously revokes the CURRENT lease if it is not a safety lease, with
   * reason `safety_preempt` (invalidate, abort, owned interfaces closed,
   * shared controls cleared). The goal is NOT ended; its running action
   * returns `cancelled`/`safety_preempt`.
   */
  preemptCurrent(reason: 'safety_preempt'): { revoked: boolean; holder: string | null; clearMs: number | null };
  /** One code-built safety candidate through the shared executor under owner kind `safety`. */
  execute(candidate: ActionCandidate, signal: AbortSignal, owner: SafetyExecutionOwner): Promise<SkillOutcome>;
}

/** Why ordinary dispatch must wait right now. */
export interface SafetyHold {
  reason: 'episode' | 'initial_assessment' | 'blocked';
  episodeId: string | null;
  response: SafetyResponseKind | null;
  hazards: SafetyHazardKind[];
  sinceMs: number;
  detail: string;
}

export type SafetyClear =
  | { status: 'clear'; waitedMs: number; episodes: number }
  /** A hazard persists without a supported response: the caller reports one declarative blocker (no retry loop). */
  | { status: 'blocked'; waitedMs: number; reason: string; detail: string; hazards: SafetyHazardKind[] }
  /** The caller's signal aborted, or authority/connection ended while waiting. */
  | { status: 'aborted'; waitedMs: number; reason: string }
  | { status: 'timeout'; waitedMs: number };

/**
 * Consumer surface for the shared writer (TaskRuntime, route runner,
 * executor fencing, GoalEngine/supervisor, status/dashboard). Every method
 * is local, synchronous or locally awaited, and inference-free.
 */
export interface SafetyPort {
  readonly enabled: boolean;
  /** ActuatorLeases.ownerCurrent for `{ kind: 'safety' }` (grant fence incl. expiry/epoch/pause). */
  grantCurrent(grantId: string): boolean;
  /** The CURRENT grant (copy) for a verified safety owner, else undefined (skills read bounds from here, never from parameters). */
  grant(grantId: string): Readonly<SafetyGrant> | undefined;
  /** Non-null while ordinary work must not dispatch (episode, first post-join assessment, active blocker). */
  hold(): SafetyHold | null;
  /** Resolves when the hold clears, a blocker is declared, the signal aborts, or `maxWaitMs` passes. */
  waitClear(signal: AbortSignal, maxWaitMs?: number): Promise<SafetyClear>;
  status(nowMs: number): SafetyStatus;
}

/** Lifecycle/latch hooks (synchronous; never awaited on the revocation path). */
export interface SafetyLifecyclePort {
  /** `onBotCreated`: attach the packet tracker before login (own id, air, health, equipment, damage). */
  attachConnection(source: SafetyPacketSource, ctx: { connectionEpoch: number }): void;
  /** Called by SkillRuntime.onLifecycle BEFORE lease/ledger invalidation: death/ended/dimension_change/respawn revoke the grant. */
  onLifecycle(event: GameLifecycleEvent): void;
  /**
   * Synchronous nudge on explicit stop / resume / owner goal admission or
   * terminal: safety re-reads `SafetyAuthority` immediately (stop revokes the
   * grant and controls before returning). Authority is never cached from it.
   */
  onAuthorityChanged(cause: 'owner_stop' | 'resume' | 'owner_goal_admitted' | 'goal_terminal'): void;
  /** Starts the local monitor (after composition). */
  start(): void;
  /** Stops the monitor, revokes any grant, detaches listeners (bounded). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------- status projection

export interface SafetyStatus {
  enabled: boolean;
  /** `monitoring`: watching; `responding`: an episode owns control; `blocked`: hazard without a supported response; `no_authority`: explicit stop without an owner goal, or not ready/alive. */
  state: 'disabled' | 'no_authority' | 'monitoring' | 'responding' | 'blocked';
  authority: { basis: SafetyAuthorityBasis; detail: string };
  connectionEpoch: number | null;
  vitals: { health: number; food: number; source: SafetySelfFacts['vitalsSource']; air: { value: number | null; source: SafetyAirFact['source']; ageS: number | null } } | null;
  fluid: { feetIn: SafetyFluidFact['feetIn']; eyeIn: SafetyFluidFact['eyeIn']; support: SafetyFluidFact['support']; headroom: SafetyFluidFact['headroom']; source: 'local_estimate' } | null;
  threats: Array<{ key: string; disposition: SafetyDisposition; distance: number; hazard: SafetyHazardKind | null }>;
  episode: { episodeId: string; response: SafetyResponseKind; hazards: SafetyHazardKind[]; sinceS: number; actions: number; maxActions: number; displacement: number; suspended: { goalId: string } | null } | null;
  lastEpisode: Pick<SafetyEpisodeResult, 'episodeId' | 'response' | 'outcome' | 'reason' | 'detail'> & { endedAgoS: number } | null;
  blocker: { reason: string; detail: string; hazards: SafetyHazardKind[]; retryInS: number | null } | null;
  counters: { episodes: number; resolved: number; improved: number; unresolved: number; blocked: number; revoked: number; preemptions: number; retreats: number; defenses: number; attacksSent: number; hitsConfirmed: number; defeatsConfirmed: number };
  /** Honest labels for limits of this release. */
  limits: string[];
}

/** Capability ids registered by src/skills/safety.ts (single source for wiring). */
export const SAFETY_CAPABILITIES = {
  escapeWater: 'escape_water',
  retreatFromThreat: 'retreat_from_threat',
  defendAgainstThreat: 'defend_against_threat',
} as const satisfies Record<string, string>;

export const SAFETY_CAPABILITY_FOR: Record<SafetyResponseKind, string> = {
  escape_water: SAFETY_CAPABILITIES.escapeWater,
  retreat: SAFETY_CAPABILITIES.retreatFromThreat,
  defend: SAFETY_CAPABILITIES.defendAgainstThreat,
};
