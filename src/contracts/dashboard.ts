// MB-UI-001 dashboard contract: the bounded, redacted, versioned status
// snapshot Chunkbot publishes for the local read-only viewer, and the durable
// dated usage aggregates. Pure data (zod only): no Minecraft library, no file
// system, no network.
//
// Rules carried by the shapes:
// - Unknown is never zero. Every measured value is `Known<T>`: either a value
//   with its provenance and observation time, or `{ known: false, reason }`.
// - Transient world state carries the connection epoch it was observed in; a
//   new epoch, death or dimension change replaces it rather than mixing.
// - Only whitelisted fields exist. No server endpoint, player chat, account
//   identity, keys/auth, prompts, private reasoning or raw provider envelopes.
// - Usage separates confirmed charges, retained (ambiguous) maxima, pending
//   reservations and the local cap. Aggregates never grant spending allowance.
import { z } from 'zod';

export const DASHBOARD_STATUS_SCHEMA = 'chunkbot.dashboard.status' as const;
export const DASHBOARD_STATUS_VERSION = 1 as const;
export const DASHBOARD_HISTORY_SCHEMA = 'chunkbot.dashboard.usage-history' as const;
export const DASHBOARD_HISTORY_VERSION = 1 as const;

/** Bounds for the published snapshot (the viewer rejects larger files). */
export const DASHBOARD_BOUNDS = {
  maxStatusBytes: 256 * 1024,
  maxHistoryBytes: 1024 * 1024,
  shortText: 200,
  text: 600,
  /** Window-0 player inventory slots 5..45 (armor, main, hotbar, off hand). */
  maxSlots: 41,
  historyDays: 400,
  historyRuns: 64,
  memoryItems: 16,
} as const;

const shortText = z.string().max(DASHBOARD_BOUNDS.shortText);
const text = z.string().max(DASHBOARD_BOUNDS.text);
const ms = z.number().int().nonnegative();
const nonNegInt = z.number().int().nonnegative();
const finite = z.number().finite();
const itemKey = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(DASHBOARD_BOUNDS.shortText);

/**
 * Where a value came from.
 * - server_packet: a server packet value held by the client library (health, food, XP, attributes)
 * - server_sync: server-sent window contents/slot updates (evidence journal)
 * - client_model: the client library's local model (may contain optimistic predictions)
 * - client_selected: chosen by this client and not echoed by the server (selected hotbar slot)
 * - app_state: Chunkbot's own code-owned state (goal engine, lifecycle)
 * - provider_reported: a validated provider response (Jev usage, planner transport usage)
 * - app_accounting: Chunkbot's conservative local accounting (spend ledger)
 * - remote_metadata: an optional backend-fetched account/key read
 */
export const DASHBOARD_PROVENANCE = ['server_packet', 'server_sync', 'client_model', 'client_selected', 'app_state', 'provider_reported', 'app_accounting', 'remote_metadata'] as const;
export const ProvenanceSchema = z.enum(DASHBOARD_PROVENANCE);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const UnknownSchema = z.object({ known: z.literal(false), reason: shortText }).strict();
export type UnknownValue = z.infer<typeof UnknownSchema>;

/** A measured value or an explicit unknown. Never substitute 0 for unknown. */
export function knownSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('known', [
    z.object({ known: z.literal(true), value, source: ProvenanceSchema, observedAtMs: ms }).strict(),
    UnknownSchema,
  ]);
}
export type Known<T> = { known: true; value: T; source: Provenance; observedAtMs: number } | UnknownValue;

export const unknown = (reason: string): UnknownValue => ({ known: false, reason: reason.slice(0, DASHBOARD_BOUNDS.shortText) });
export const known = <T>(value: T, source: Provenance, observedAtMs: number): Known<T> => ({ known: true, value, source, observedAtMs });

// ------------------------------------------------------------------ publisher

export const PUBLISHER_STATES = ['running', 'stopping', 'stopped'] as const;
export const PublisherSchema = z
  .object({
    runId: z.string().regex(/^run-[a-z0-9]{4,32}$/),
    pid: z.number().int().positive(),
    startedAtMs: ms,
    /** Monotonic per run; the viewer ignores a snapshot whose seq is not newer. */
    seq: nonNegInt,
    publishedAtMs: ms,
    /** The publisher promises a snapshot at least this often while running. */
    heartbeatIntervalMs: z.number().int().min(50).max(60_000),
    state: z.enum(PUBLISHER_STATES),
    /** Present after a graceful stop. */
    stoppedReason: shortText.optional(),
  })
  .strict();
export type DashboardPublisher = z.infer<typeof PublisherSchema>;

// ------------------------------------------------------------------ connection

export const ConnectionSectionSchema = z
  .object({
    state: z.enum(['disconnected', 'joining', 'ready', 'ended']),
    epoch: nonNegInt,
    /** The bot's own in-game name (never the owner's or any account identifier). */
    botName: Known_(shortText),
    /** Configured Minecraft version and its support level; never the server address. */
    profile: z.object({ version: shortText, supportLevel: shortText }).strict(),
    dimension: Known_(shortText),
    gameMode: Known_(shortText),
    /** Last state transition time. */
    changedAtMs: ms,
    lastEnd: z.object({ reason: shortText, detail: text, atMs: ms }).strict().optional(),
    alive: Known_(z.boolean()),
  })
  .strict();

function Known_<T extends z.ZodType>(value: T) {
  return knownSchema(value);
}

// ------------------------------------------------------------------ vitals

export const XpSchema = z
  .object({
    level: nonNegInt,
    /** Fraction 0..1 toward the next level. */
    progress: z.number().min(0).max(1),
    totalPoints: nonNegInt,
  })
  .strict();

export const VitalsSectionSchema = z
  .object({
    epoch: nonNegInt,
    health: Known_(z.number().min(0).max(2048)),
    /** From the max_health attribute (with modifiers) when the server sent it. */
    maxHealth: Known_(z.number().min(0).max(2048)),
    food: Known_(z.number().min(0).max(20)),
    saturation: Known_(z.number().min(0).max(20)),
    xp: Known_(XpSchema),
  })
  .strict();
export type DashboardVitals = z.infer<typeof VitalsSectionSchema>;

// ------------------------------------------------------------------ inventory

export const SlotSchema = z
  .object({
    /** Window-0 slot number: 5..8 armor, 9..35 main, 36..44 hotbar, 45 off hand. */
    slot: z.number().int().min(5).max(45),
    item: itemKey,
    count: z.number().int().min(1).max(127),
  })
  .strict();
export type DashboardSlot = z.infer<typeof SlotSchema>;

export const InventoryStateSchema = z
  .object({
    /** Non-empty slots only. */
    slots: z.array(SlotSchema).max(DASHBOARD_BOUNDS.maxSlots),
    /** True once a full window-0 contents packet was seen in this epoch. */
    complete: z.boolean(),
  })
  .strict();

export const InventorySectionSchema = z
  .object({
    epoch: nonNegInt,
    contents: Known_(InventoryStateSchema),
    /** 0..8. */
    selectedHotbar: Known_(z.number().int().min(0).max(8)),
    /** A container window is open; the player inventory shown is still window 0. */
    openContainer: z.object({ windowId: z.number().int(), windowType: shortText, sinceMs: ms }).strict().nullable(),
  })
  .strict();
export type DashboardInventory = z.infer<typeof InventorySectionSchema>;

// ------------------------------------------------------------------ directive

export const DIRECTIVE_PHASES = ['idle', 'planning', 'executing', 'awaiting_owner', 'stopping', 'completed', 'cancelled', 'blocked', 'failed'] as const;
export const DirectivePhaseSchema = z.enum(DIRECTIVE_PHASES);

export const GoalSectionSchema = z
  .object({
    id: shortText,
    kind: z.enum(['owner_goal', 'operator_task_diagnostic']),
    epoch: nonNegInt,
    instruction: text,
    phase: DirectivePhaseSchema,
    interpretation: text.optional(),
    outcome: text.optional(),
    progress: text.optional(),
    admittedAtMs: ms,
    updatedAtMs: ms,
    terminal: z.object({ reason: shortText, detail: text, atMs: ms }).strict().optional(),
    clarification: z.object({ ref: shortText, question: text }).strict().optional(),
    counters: z
      .object({ plannerTurns: nonNegInt, repairs: nonNegInt, retries: nonNegInt, replans: nonNegInt, windows: nonNegInt, tasksAdmitted: nonNegInt })
      .strict()
      .optional(),
  })
  .strict();
export type DashboardGoal = z.infer<typeof GoalSectionSchema>;

export const TaskSectionSchema = z
  .object({
    current: z.object({ taskId: shortText, objective: text, mode: shortText, startedAtMs: ms }).strict().optional(),
    /** Last finished task of the latest goal. A finished task is never goal completion. */
    last: z
      .object({ taskId: shortText, status: shortText, reason: shortText, detail: text, decisions: nonNegInt, actions: nonNegInt })
      .strict()
      .optional(),
  })
  .strict();

/**
 * MB-FLOW-002 seam: a replacement directive being prepared while the current
 * one continues. "Pending" never means started.
 */
export const PendingDirectiveSchema = z
  .object({
    instruction: text,
    state: z.enum(['preparing', 'awaiting_owner', 'ready_to_switch', 'rejected']),
    sinceMs: ms,
    detail: text.optional(),
  })
  .strict();
export type DashboardPendingDirective = z.infer<typeof PendingDirectiveSchema>;

/** MB-FLOW-003 seam (not assigned): survival/recovery state when that feature exists. */
export const SurvivalSectionSchema = z
  .object({
    routine: shortText,
    reason: text,
    phase: shortText.optional(),
    attempt: nonNegInt.optional(),
    sinceMs: ms,
  })
  .strict();

export const DirectiveSectionSchema = z
  .object({
    /** Which authority currently owns control. */
    mode: z.enum(['idle', 'owner_directive', 'operator_diagnostic']),
    goal: GoalSectionSchema.optional(),
    task: TaskSectionSchema,
    pending: PendingDirectiveSchema.optional(),
    survival: SurvivalSectionSchema.optional(),
  })
  .strict();

// ------------------------------------------------------------------ readiness

export const ReadinessItemSchema = z.object({ ready: z.boolean(), detail: text }).strict();
export const ReadinessSectionSchema = z
  .object({
    planner: ReadinessItemSchema,
    decision: ReadinessItemSchema,
    perception: ReadinessItemSchema,
    skills: ReadinessItemSchema,
    tasks: ReadinessItemSchema,
    knowledge: ReadinessItemSchema,
    capabilityCount: nonNegInt,
  })
  .strict();

// ------------------------------------------------------------------ usage

/** USD amounts are carried as integer nano-dollars (1e-9 USD) so sums stay exact. */
export const nanoUsd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usdToNano = (usd: number): number => Math.max(0, Math.round(usd * 1e9));
export const nanoToUsd = (nano: number): number => nano / 1e9;

export const JevSessionUsageSchema = z
  .object({
    /** Attempts that reserved spend (includes retries). */
    attempts: nonNegInt,
    /** Attempts that were the single transient retry of a decision. */
    retries: nonNegInt,
    validatedResponses: nonNegInt,
    /** Charged with a trustworthy reported cost although the answer was unusable. */
    chargedFailures: nonNegInt,
    /** Charge ambiguous: the full reservation is retained as spent. */
    retainedAttempts: nonNegInt,
    /** Provider certainly did not run: reservation released. */
    releasedAttempts: nonNegInt,
    /** Refused locally before dispatch (cap could not be guaranteed, etc.). */
    refused: nonNegInt,
    inputTokens: nonNegInt,
    outputTokens: nonNegInt,
    /** Attempts whose token usage is known (validated responses). */
    tokensKnownAttempts: nonNegInt,
    /** Charged or ambiguous attempts whose token usage is unknown. */
    tokensUnknownAttempts: nonNegInt,
    confirmedNanoUsd: nanoUsd,
    retainedNanoUsd: nanoUsd,
    pendingNanoUsd: nanoUsd,
    capNanoUsd: nanoUsd,
    /** cap - confirmed - retained - pending (local application cap, not a wallet). */
    remainingNanoUsd: z.number().int(),
  })
  .strict();
export type JevSessionUsage = z.infer<typeof JevSessionUsageSchema>;

export const PlannerSessionUsageSchema = z
  .object({
    turns: nonNegInt,
    completedTurns: nonNegInt,
    failedTurns: nonNegInt,
    /** Completed turns that reported usage. */
    usageKnownTurns: nonNegInt,
    /** Turns whose usage is unknown (failed, cancelled, or no usage reported). */
    usageUnknownTurns: nonNegInt,
    inputTokens: nonNegInt,
    /** Breakdown of inputTokens (subset), when reported. */
    cachedInputTokens: nonNegInt,
    outputTokens: nonNegInt,
    /** Breakdown of outputTokens (subset), when reported. */
    reasoningOutputTokens: nonNegInt,
  })
  .strict();
export type PlannerSessionUsage = z.infer<typeof PlannerSessionUsageSchema>;

export const UsageSectionSchema = z
  .object({
    jev: Known_(JevSessionUsageSchema),
    planner: Known_(PlannerSessionUsageSchema),
  })
  .strict();

// ------------------------------------------------------------------ memory (MB-MEM-001 seam)

export const MemorySummarySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            label: shortText,
            kind: shortText,
            dimension: shortText.optional(),
            source: shortText,
            observedAtMs: ms,
          })
          .strict(),
      )
      .max(DASHBOARD_BOUNDS.memoryItems),
    totalItems: nonNegInt,
  })
  .strict();
export type DashboardMemorySummary = z.infer<typeof MemorySummarySchema>;

/** Which optional companion features are actually installed in this run. */
export const IntegrationsSchema = z
  .object({
    handoff: z.boolean(),
    memory: z.boolean(),
    survival: z.boolean(),
  })
  .strict();

// ------------------------------------------------------------------ snapshot

export const DashboardStatusSchema = z
  .object({
    schema: z.literal(DASHBOARD_STATUS_SCHEMA),
    version: z.literal(DASHBOARD_STATUS_VERSION),
    publisher: PublisherSchema,
    connection: ConnectionSectionSchema,
    vitals: VitalsSectionSchema,
    inventory: InventorySectionSchema,
    directive: DirectiveSectionSchema,
    readiness: ReadinessSectionSchema,
    usage: UsageSectionSchema,
    memory: Known_(MemorySummarySchema),
    integrations: IntegrationsSchema,
  })
  .strict();
export type DashboardStatus = z.infer<typeof DashboardStatusSchema>;

// ------------------------------------------------------------------ durable usage history

export const DayJevSchema = z
  .object({
    attempts: nonNegInt,
    validatedResponses: nonNegInt,
    chargedFailures: nonNegInt,
    retainedAttempts: nonNegInt,
    releasedAttempts: nonNegInt,
    inputTokens: nonNegInt,
    outputTokens: nonNegInt,
    tokensUnknownAttempts: nonNegInt,
    confirmedNanoUsd: nanoUsd,
    retainedNanoUsd: nanoUsd,
  })
  .strict();
export type DayJev = z.infer<typeof DayJevSchema>;

export const DayPlannerSchema = z
  .object({
    turns: nonNegInt,
    completedTurns: nonNegInt,
    failedTurns: nonNegInt,
    usageUnknownTurns: nonNegInt,
    inputTokens: nonNegInt,
    cachedInputTokens: nonNegInt,
    outputTokens: nonNegInt,
    reasoningOutputTokens: nonNegInt,
  })
  .strict();
export type DayPlanner = z.infer<typeof DayPlannerSchema>;

export const DayAggregateSchema = z.object({ jev: DayJevSchema, planner: DayPlannerSchema }).strict();
export type DayAggregate = z.infer<typeof DayAggregateSchema>;

/** Per-run cursor so re-applying the same cumulative state never double counts. */
export const RunCursorSchema = z
  .object({
    runId: z.string().regex(/^run-[a-z0-9]{4,32}$/),
    pid: z.number().int().positive(),
    startedAtMs: ms,
    lastFlushAtMs: ms,
    /** False after a graceful stop. An open run whose process is gone ended uncleanly. */
    open: z.boolean(),
    endedUncleanly: z.boolean(),
    jev: z.object({ attempts: nonNegInt, reconciledNanoUsd: nanoUsd, retainedNanoUsd: nanoUsd, reconciled: nonNegInt, retained: nonNegInt, released: nonNegInt }).strict(),
    /** Usage event identities already counted (bounded, most recent). */
    seen: z.array(z.string().max(120)).max(512),
  })
  .strict();
export type RunCursor = z.infer<typeof RunCursorSchema>;

export const UsageHistorySchema = z
  .object({
    schema: z.literal(DASHBOARD_HISTORY_SCHEMA),
    version: z.literal(DASHBOARD_HISTORY_VERSION),
    /** IANA zone used for day keys when each day was first written. */
    timeZone: shortText,
    recordedSinceMs: ms,
    updatedAtMs: ms,
    /** Day key YYYY-MM-DD (in `timeZone`) -> aggregate. */
    days: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), DayAggregateSchema),
    runs: z.array(RunCursorSchema).max(DASHBOARD_BOUNDS.historyRuns),
    /** Coverage gaps that the totals cannot include (corrupt reset, unclean end, zone change). */
    gaps: z.array(z.object({ atMs: ms, kind: z.enum(['corrupt_reset', 'unclean_end', 'time_zone_change', 'days_pruned', 'runs_pruned']), detail: text }).strict()).max(64),
  })
  .strict();
export type UsageHistory = z.infer<typeof UsageHistorySchema>;

// ------------------------------------------------------------------ optional remote metadata

export const RemoteMetadataStatusSchema = z.enum(['fresh', 'stale', 'unavailable', 'not_configured', 'pending']);

/** OpenRouter current-key overview (GET /api/v1/key). Key scope: may include other tools using the same key. */
export const OpenRouterKeyMetadataSchema = z
  .object({
    usageUsd: Known_(z.number().nonnegative()),
    dailyUsd: Known_(z.number().nonnegative()),
    weeklyUsd: Known_(z.number().nonnegative()),
    monthlyUsd: Known_(z.number().nonnegative()),
    /** null value: no key cap reported (not unlimited wallet credit). */
    limitUsd: Known_(z.number().nonnegative().nullable()),
    limitRemainingUsd: Known_(z.number().nullable()),
    limitReset: Known_(shortText.nullable()),
    isFreeTier: Known_(z.boolean()),
  })
  .strict();

/** One quota window actually returned by the Codex account read. */
export const CodexQuotaWindowSchema = z
  .object({
    bucket: shortText,
    usedPercent: z.number().min(0).max(100),
    windowDurationMins: z.number().int().positive().nullable(),
    resetsAtMs: ms.nullable(),
  })
  .strict();

export const RemoteMetadataSchema = z
  .object({
    openRouterKey: z
      .object({
        status: RemoteMetadataStatusSchema,
        scope: z.literal('openrouter_api_key'),
        checkedAtMs: ms.nullable(),
        lastSuccessAtMs: ms.nullable(),
        detail: shortText,
        value: OpenRouterKeyMetadataSchema.nullable(),
      })
      .strict(),
    openRouterWallet: z.object({ status: z.literal('unavailable'), detail: shortText }).strict(),
    codexQuota: z
      .object({
        status: RemoteMetadataStatusSchema,
        scope: z.literal('codex_account'),
        checkedAtMs: ms.nullable(),
        lastSuccessAtMs: ms.nullable(),
        detail: shortText,
        windows: z.array(CodexQuotaWindowSchema).max(8),
      })
      .strict(),
  })
  .strict();
export type RemoteMetadata = z.infer<typeof RemoteMetadataSchema>;
