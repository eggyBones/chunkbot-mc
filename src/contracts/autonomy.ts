// MB-FLOW-001 progression contracts: goal source/priority, operating mode,
// durable control (pause) and construction-project state and session limits.
// Companion ports are canonical in their own contracts and consumed as-is:
// survival (src/contracts/survival.ts: SurvivalPolicyPort, LowHealthAllowancePort,
// SurvivalStatus) and locator (src/contracts/locator.ts: LocatorPort, RoutePort,
// RouteStatus). This file owns GoalSource.
//
// Rules carried by these shapes:
// - ONE supervisor submits work through the ONE GoalEngine admission path.
//   A goal's source/priority is typed code-owned context; it is never a
//   resource goal/task enum and never changes the generic task language.
// - Priority order: lifecycle/stop revocation > immediate verified safety >
//   owner intent > necessary support/recovery > unrelated progression.
// - The pause latch is durable per explicit operator scope (world profile +
//   revision + bot profile). Missing, read-only, conflicted or corrupt scope
//   blocks AUTOMATIC work only; manual owner goals stay usable.
// - Session/attempt/cooldown limits are finite and never replenished by a
//   death, retry, restart within the run or a new automatic milestone. The
//   single per-run SpendLedger and per-goal planner limits are unchanged.
// - A construction project's approved footprint is code-selected from an
//   observed vacant site; only blueprint positions are ever placed, and only
//   the project's own temporary construction aid may be removed.
//
// No Minecraft library imports.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, DimensionSchema, RegistryKeySchema, Vec3Schema } from './common.ts';
import { GoalIdSchema } from './ids.ts';
import type { RouteStatus } from './locator.ts';
import { ProfileIdSchema } from './memory.ts';
import { GoalOutcomeContractSchema } from './predicate.ts';
import { EpisodeIdSchema, SurvivalRoutineSchema, type SurvivalPlannerContext, type SurvivalStatus } from './survival.ts';

export const AUTONOMY_SCHEMA_VERSION = 1 as const;
export const AUTONOMY_FILE_FORMAT = 'chunkbot-autonomy' as const;

// ---------------------------------------------------------------- goal source / priority

/** Policy priority, highest first. `lifecycle` is revocation, never an admitted goal source. */
export const AUTONOMY_PRIORITIES = ['lifecycle', 'safety', 'owner', 'support', 'progression'] as const;
export type AutonomyPriority = (typeof AUTONOMY_PRIORITIES)[number];

/** Routine ids are opaque, code-defined snake_case names (owned by the policy that issues them; not a goal whitelist). */
export const RoutineIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
export type RoutineId = z.infer<typeof RoutineIdSchema>;

/**
 * Who a goal is for. Code sets it at admission; the planner cannot set or
 * change it. `owner`: an owner/operator instruction. `progression`: a
 * supervisor milestone assessment. `support`: work admitted for a survival
 * policy proposal (MB-FLOW-003), either a planner goal or a small code-built
 * task; `safety` only for an immediate verified need.
 */
export const GoalSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z
    .object({
      kind: z.literal('progression'),
      /** 1-based admission number of progression goals in this application run. */
      sessionAttempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('support'),
      routine: SurvivalRoutineSchema,
      priority: z.enum(['safety', 'support']),
      /** Survival proposal correlation (opaque, code-generated). */
      proposalId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
      episodeId: EpisodeIdSchema.optional(),
      /** planner_goal: planned by the gameplay planner; code_task: a preapproved code-built task (no planner turn). */
      execution: z.enum(['planner_goal', 'code_task']),
      /** What the routine serves (survival proposal `serves`). */
      serves: z.enum(['owner_intent', 'progression', 'none']),
      /** Bounded, code-generated reason shown to the owner/status. */
      reason: z.string().min(1).max(BOUNDS.shortText),
      /** 1-based admission number of support goals in this application run. */
      sessionAttempt: z.number().int().positive(),
    })
    .strict(),
]);
export type GoalSource = z.infer<typeof GoalSourceSchema>;

export function priorityOfSource(source: GoalSource | undefined): Exclude<AutonomyPriority, 'lifecycle'> {
  if (!source || source.kind === 'owner') return 'owner';
  if (source.kind === 'support') return source.priority;
  return 'progression';
}

/** True for goals the supervisor (not the owner/operator) submitted. */
export function isAutomaticSource(source: GoalSource | undefined): boolean {
  return source !== undefined && source.kind !== 'owner';
}

// ---------------------------------------------------------------- planner-visible autonomy context

/**
 * Bounded planner context for an AUTOMATIC goal (progression or support). It
 * is data, not instructions: the planner still chooses the milestone and its
 * prerequisites from the same catalog, observation, knowledge and memory, and
 * its outcome is still code-verified.
 */
export interface AutonomyPlannerContext {
  source: GoalSource;
  /** Why this goal was started now (code text, bounded). */
  reason: string;
  /** Owner presence/intent summary (no owner coordinates beyond the filtered observation). */
  owner: { unresolvedIntent: null | { instruction: string; state: OwnerIntentState; detail: string } };
  /** Recently completed (code-verified) automatic milestones this run, newest first (bounded). */
  recentMilestones: Array<{ interpretation: string; atMs: number }>;
  /** Recently blocked automatic outcomes to avoid repeating unchanged (bounded). */
  avoid: Array<{ interpretation: string; reason: string; times: number }>;
  /** Session allowance left (code-owned; the planner cannot change it). */
  session: { automaticGoalsLeft: number; plannerTurnsLeft: number };
  /** The scope's home project, when any (code-verified state only). */
  home: HomeProjectSummary | null;
  /** Survival-owned planner context, only for support planner goals. */
  support?: SurvivalPlannerContext;
  /** Guidance restated as data. */
  rules: string[];
}

// ---------------------------------------------------------------- owner intent

export const OWNER_INTENT_STATES = ['active', 'awaiting_answer', 'blocked', 'interrupted'] as const;
export type OwnerIntentState = (typeof OWNER_INTENT_STATES)[number];

/**
 * The latest unresolved owner instruction (MB-FLOW-001-C1). It stays visible
 * and holds unrelated progression until a NEW explicit owner instruction
 * supersedes it. Bare `resume` only clears the stop latch; it never dismisses,
 * replays, replaces or resets this record. First release: an interrupted or
 * blocked directive always requires an owner decision (no automatic
 * continuation). Support/recovery may run meanwhile.
 */
export interface OwnerIntentRecord {
  goalId: string;
  instruction: string;
  state: OwnerIntentState;
  /** Terminal/interruption reason code and bounded detail. */
  reason: string;
  detail: string;
  sinceMs: number;
  /** Accepted outcome, when one was bound (display only; never re-admitted by code). */
  outcome?: z.infer<typeof GoalOutcomeContractSchema>;
  interpretation?: string;
  /** Always true for blocked/interrupted intent in this release. */
  requiresOwnerDecision: boolean;
}

// ---------------------------------------------------------------- mode / status

/**
 * Supervisor operating mode (status only; reading it authorizes nothing).
 * disabled: autonomy off by config/CLI/inference-free planner profile.
 * scope_blocked: durable scope missing/read-only/conflicted/corrupt (manual goals still work).
 * not_connected: no ready connection (scheduling never connects).
 * paused: owner stop latch (durable) until explicit resume.
 * owner: an owner goal is pending/active.
 * owner_unresolved: owner intent blocked/interrupted/awaiting: progression held (support may run).
 * support / progression: an automatic goal of that source is active.
 * cooldown: waiting for a finite timer before the next assessment.
 * waiting: nothing useful can start until the world/owner/state changes (no polling).
 * provider_blocked: planner/Jev not ready, quota/auth, or spend cap (no polling, no fallback).
 * exhausted: the session allowance is used up for this application run.
 */
export const AUTONOMY_MODES = ['disabled', 'scope_blocked', 'not_connected', 'paused', 'owner', 'owner_unresolved', 'support', 'progression', 'assessing', 'cooldown', 'waiting', 'provider_blocked', 'exhausted'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const PERSISTENCE_STATES = ['ready', 'missing_scope', 'read_only', 'conflict', 'corrupt', 'write_failed', 'disabled'] as const;
export type PersistenceState = (typeof PERSISTENCE_STATES)[number];

export interface AutonomyStatus {
  mode: AutonomyMode;
  /** Bounded human-readable reason for the mode. */
  detail: string;
  sinceMs: number;
  enabled: boolean;
  scope: { worldProfile: string; worldRevision: number; botProfile: string } | null;
  persistence: { state: PersistenceState; detail: string; revision: number; lastWriteAtMs?: number };
  latch: { paused: boolean; sinceMs?: number; source?: string; durable: 'loaded' | 'written' | 'pending' | 'failed' | 'none' };
  active: null | { goalId: string; source: GoalSource; priority: Exclude<AutonomyPriority, 'lifecycle'> };
  ownerIntent: null | { goalId: string; instruction: string; state: OwnerIntentState; detail: string; requiresOwnerDecision: boolean };
  nextAssessmentAtMs: number | null;
  session: AutonomySessionCounters & { limits: AutonomySessionLimits };
  lastOutcome: null | { goalId: string; source: GoalSource['kind']; state: string; reason: string; detail: string; atMs: number };
  blocker: null | { code: string; detail: string };
  home: HomeProjectSummary | null;
  /** Canonical survival status (MB-FLOW-003), when the policy is installed. */
  support: SurvivalStatus | null;
  /** Canonical route status (MB-LOC-001) of the active goal epoch, when any. */
  route: RouteStatus | null;
}

export interface AutonomySessionCounters {
  progressionGoals: number;
  supportGoals: number;
  /** Unsafe active work revoked for a survival safety decision. */
  safetyRevocations: number;
  /** Planner turns spent by automatic goals this run (from goal counters at terminal). */
  plannerTurns: number;
  completed: number;
  /** Consecutive automatic goals that ended without a verified outcome. */
  consecutiveUnproductive: number;
}

export const AutonomySessionLimitsSchema = z
  .object({
    /** Progression goals admitted per application run. */
    maxProgressionGoals: z.number().int().min(0).max(1_000).default(16),
    /** Support goals admitted per application run (safety/support routines). */
    maxSupportGoals: z.number().int().min(0).max(1_000).default(16),
    /** Planner turns all automatic goals may spend per run (each goal keeps its own per-goal limit too). */
    maxPlannerTurns: z.number().int().min(0).max(10_000).default(200),
    /** Consecutive unproductive automatic goals before waiting for a state change. */
    maxConsecutiveUnproductive: z.number().int().min(1).max(100).default(3),
    /** Times one blocked automatic outcome fingerprint may be attempted per run. */
    maxRepeatsPerFingerprint: z.number().int().min(1).max(100).default(2),
  })
  .strict();
export type AutonomySessionLimits = z.infer<typeof AutonomySessionLimitsSchema>;

// ---------------------------------------------------------------- construction project (home)

export const PROJECT_ROLES = ['wall', 'roof', 'entrance', 'workstation', 'storage', 'aid'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** One blueprint position. `accept` is a registry key or tag; `entrance` must stay passable (air or a door). */
export const BlueprintCellSchema = z
  .object({
    at: Vec3Schema,
    role: z.enum(PROJECT_ROLES),
    /** Build phase (lower first); code orders placements by phase. */
    phase: z.number().int().min(0).max(16),
    /** Accepted block(s): a key/tag for solid roles, the exact block for workstation/storage, `minecraft:air` for an open entrance. */
    accept: z.array(RegistryKeySchema).min(1).max(BOUNDS.listSmall),
  })
  .strict();
export type BlueprintCell = z.infer<typeof BlueprintCellSchema>;

export const ProjectCheckpointEntrySchema = z
  .object({
    at: Vec3Schema,
    /** Server-confirmed block the bot placed (or `minecraft:air` for a removed own aid). */
    to: RegistryKeySchema,
    confirmedAtMs: z.number().int().nonnegative(),
    capability: CapabilityIdSchema,
  })
  .strict();
export type ProjectCheckpointEntry = z.infer<typeof ProjectCheckpointEntrySchema>;

export const PROJECT_STATES = ['approved', 'building', 'interrupted', 'complete', 'blocked'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/**
 * The scope's single home construction project. `footprint` was approved by
 * code from an observed vacant site with natural flat ground (no demolition);
 * `cells` is the code-generated blueprint; `checkpoints` are server-confirmed
 * effects of the bot's own construction actions (the only blocks the project
 * may repair or, for the temporary aid, remove). `verified` is the latest code
 * verification of the actual site; it is historical once written.
 */
export const HomeProjectSchema = z
  .object({
    id: z.string().regex(/^proj-[a-z0-9]{4,24}$/),
    blueprint: z.literal('small_shelter_v1'),
    dimension: DimensionSchema,
    /** Floor level (y of the air layer above the natural ground) and footprint corner (min x/z). */
    origin: Vec3Schema,
    size: z.object({ outerX: z.number().int().min(4).max(7), outerZ: z.number().int().min(4).max(7), wallHeight: z.literal(2) }).strict(),
    /** Direction the entrance faces (outward normal). */
    entranceFacing: z.enum(['north', 'south', 'east', 'west']),
    cells: z.array(BlueprintCellSchema).max(128),
    state: z.enum(PROJECT_STATES),
    stateDetail: z.string().max(BOUNDS.shortText).default(''),
    approvedAtMs: z.number().int().nonnegative(),
    approval: z
      .object({
        basis: z.literal('observed_vacant_site'),
        /** Bounded statements of what code checked when approving (counts, materials). */
        checks: z.array(z.string().max(BOUNDS.shortText)).max(BOUNDS.listSmall),
        goalId: GoalIdSchema.optional(),
      })
      .strict(),
    checkpoints: z.array(ProjectCheckpointEntrySchema).max(128),
    /** Interrupted actions whose later effects are unknown (count only; fresh inspection resolves). */
    unknownEffects: z.number().int().nonnegative().default(0),
    verified: z
      .object({
        atMs: z.number().int().nonnegative(),
        status: z.enum(['complete', 'incomplete', 'unknown']),
        satisfied: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        detail: z.string().max(BOUNDS.text),
      })
      .strict()
      .optional(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type HomeProject = z.infer<typeof HomeProjectSchema>;

/** Planner/status-visible project summary (bounded; positions are the code-approved blueprint, not hidden terrain). */
export interface HomeProjectSummary {
  id: string;
  state: ProjectState;
  detail: string;
  dimension: string;
  origin: { x: number; y: number; z: number };
  outer: { x: number; z: number };
  entranceFacing: string;
  /** Cells by role: required / confirmed by own server-confirmed placements. */
  progress: { cells: number; ownConfirmed: number; byRole: Record<string, { required: number; ownConfirmed: number }> };
  /** Blocks still needed by role and accepted materials (from the blueprint; not a hidden plan). */
  materials: Array<{ role: string; count: number; accept: string[] }>;
  verified: HomeProject['verified'] | null;
  approvedAtMs: number;
  updatedAtMs: number;
}

// ---------------------------------------------------------------- durable control file

/** Pause latch as persisted (set by owner stop; cleared only by explicit resume). */
export const DurableLatchSchema = z
  .object({
    paused: z.boolean(),
    sinceMs: z.number().int().nonnegative().optional(),
    source: z.string().max(64).optional(),
  })
  .strict();
export type DurableLatch = z.infer<typeof DurableLatchSchema>;

export const AutonomyScopeSchema = z
  .object({
    worldProfile: ProfileIdSchema,
    worldRevision: z.number().int().min(1).max(1_000_000),
    botProfile: ProfileIdSchema,
  })
  .strict();
export type AutonomyScope = z.infer<typeof AutonomyScopeSchema>;

export const AutonomyBodySchema = z
  .object({
    scope: AutonomyScopeSchema,
    /** Endpoint first bound to this scope (connection metadata, never identity proof). */
    endpoint: z.string().max(300).optional(),
    latch: DurableLatchSchema,
    home: HomeProjectSchema.optional(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type AutonomyBody = z.infer<typeof AutonomyBodySchema>;

export const AutonomyFileSchema = z
  .object({
    format: z.literal(AUTONOMY_FILE_FORMAT),
    schemaVersion: z.literal(AUTONOMY_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    writtenAtMs: z.number().int().nonnegative(),
    /** sha256 over the canonical body JSON. */
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    body: AutonomyBodySchema,
  })
  .strict();
export type AutonomyFile = z.infer<typeof AutonomyFileSchema>;

// ---------------------------------------------------------------- config

export const AutonomyConfigSchema = z
  .object({
    /**
     * Progression after an authorized normal `run`. Default true; `run
     * --no-autonomy`, `models.planner.mode: "disabled"` and every diagnostic
     * command suppress it.
     */
    enabled: z.boolean().default(true),
    /** Durable scope; defaults to the configured memory scope. Absent both: automatic work is scope_blocked. */
    scope: AutonomyScopeSchema.optional(),
    /** Directory under storage.dataDir (default `autonomy`). */
    dir: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default('autonomy'),
    /** The first connection binds the endpoint; a different endpoint is a scope conflict unless rebound once. */
    rebindEndpoint: z.boolean().default(false),
    /** Settle time after a ready/respawn before the first assessment. */
    startDelayMs: z.number().int().min(0).max(600_000).default(5_000),
    /** Pause between a verified automatic completion and the next assessment. */
    afterCompletionMs: z.number().int().min(0).max(3_600_000).default(3_000),
    /** First cooldown after an unproductive automatic goal; doubles per consecutive one up to maxBackoffMs. */
    afterBlockedMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    maxBackoffMs: z.number().int().min(1_000).max(24 * 3_600_000).default(15 * 60_000),
    session: AutonomySessionLimitsSchema.default({ maxProgressionGoals: 16, maxSupportGoals: 16, maxPlannerTurns: 200, maxConsecutiveUnproductive: 3, maxRepeatsPerFingerprint: 2 }),
    home: z
      .object({
        /** Home construction capabilities are registered (catalog) when true. */
        enabled: z.boolean().default(true),
        /** Interior side length (outer = interior + 2); 3 gives room for table, furnace, chest and the entrance path. */
        interior: z.number().int().min(2).max(3).default(3),
        /** Max horizontal distance from the bot to a candidate site corner. */
        maxSiteDistance: z.number().int().min(4).max(48).default(16),
      })
      .strict()
      .default({ enabled: true, interior: 3, maxSiteDistance: 16 }),
  })
  .strict();
export type AutonomyConfig = z.output<typeof AutonomyConfigSchema>;
export type AutonomyConfigInput = z.input<typeof AutonomyConfigSchema>;
