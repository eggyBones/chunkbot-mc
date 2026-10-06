// Validated Chunkbot configuration. Configuration files never contain secrets:
// model keys are referenced by environment-variable NAME, and Microsoft auth
// caches live in ignored local storage.
import { isIP } from 'node:net';
import { z } from 'zod';
import { MemoryConfigSchema } from '../contracts/memory.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  // Any 127.0.0.0/8 address is loopback.
  return isIP(host) === 4 && host.startsWith('127.');
}

export const DEFAULT_DECISION_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

/** http(s) URL whose host is loopback (local fault fixtures only). */
export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Normalizes a Minecraft UUID to lowercase dashed form. */
export function normalizeUuid(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const PlayerNameSchema = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'must be a 3-16 character Minecraft player name');
const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'must be an environment variable NAME (the value stays in the environment)');

export const DEFAULT_LIMITS = {
  observationRadius: 32,
  travelRadius: 128,
  nearOwnerDistance: 3,
  planWindowSteps: 8,
  totalTaskCeiling: 64,
  decisionMaxOptions: 8,
  decisionConcurrentRequests: 1,
  decisionMinIntervalMs: 1_000,
  decisionTimeoutMs: 5_000,
  plannerTimeoutMs: 45_000,
  plannerTurnsPerGoal: 20,
  goalDeadlineMs: 20 * 60_000,
  decisionRequestsPerGoal: 1_200,
  noProgressMs: 30_000,
  ownerLossMs: 10_000,
  perTargetRetries: 2,
  replans: 8,
  lowHealth: 8,
  openRouterSpendCapUsd: 1,
  cleanupTimeoutMs: 2_000,
} as const;

const posInt = (max: number) => z.number().int().positive().max(max);

export const DEFAULT_FLOW = { handoff: 'smooth', lookahead: true, preparationTurnsPerRun: 40 } as const;

const FlowSchema = z
  .object({
    handoff: z.enum(['smooth', 'immediate']).default(DEFAULT_FLOW.handoff),
    lookahead: z.boolean().default(DEFAULT_FLOW.lookahead),
    preparationTurnsPerRun: z.number().int().min(0).max(1_000).default(DEFAULT_FLOW.preparationTurnsPerRun),
  })
  .strict();

const LimitsSchema = z
  .object({
    observationRadius: posInt(256).default(DEFAULT_LIMITS.observationRadius),
    travelRadius: posInt(4_096).default(DEFAULT_LIMITS.travelRadius),
    nearOwnerDistance: posInt(64).default(DEFAULT_LIMITS.nearOwnerDistance),
    planWindowSteps: posInt(8).default(DEFAULT_LIMITS.planWindowSteps),
    totalTaskCeiling: posInt(512).default(DEFAULT_LIMITS.totalTaskCeiling),
    decisionMaxOptions: posInt(32).default(DEFAULT_LIMITS.decisionMaxOptions),
    decisionConcurrentRequests: z.literal(1).default(DEFAULT_LIMITS.decisionConcurrentRequests),
    decisionMinIntervalMs: posInt(60_000).default(DEFAULT_LIMITS.decisionMinIntervalMs),
    decisionTimeoutMs: posInt(60_000).default(DEFAULT_LIMITS.decisionTimeoutMs),
    plannerTimeoutMs: posInt(600_000).default(DEFAULT_LIMITS.plannerTimeoutMs),
    plannerTurnsPerGoal: posInt(100).default(DEFAULT_LIMITS.plannerTurnsPerGoal),
    goalDeadlineMs: posInt(24 * 3_600_000).default(DEFAULT_LIMITS.goalDeadlineMs),
    decisionRequestsPerGoal: posInt(100_000).default(DEFAULT_LIMITS.decisionRequestsPerGoal),
    noProgressMs: posInt(3_600_000).default(DEFAULT_LIMITS.noProgressMs),
    ownerLossMs: posInt(3_600_000).default(DEFAULT_LIMITS.ownerLossMs),
    perTargetRetries: z.number().int().min(0).max(20).default(DEFAULT_LIMITS.perTargetRetries),
    replans: z.number().int().min(0).max(100).default(DEFAULT_LIMITS.replans),
    lowHealth: z.number().min(0).max(20).default(DEFAULT_LIMITS.lowHealth),
    openRouterSpendCapUsd: z.number().min(0).max(100).default(DEFAULT_LIMITS.openRouterSpendCapUsd),
    cleanupTimeoutMs: posInt(30_000).default(DEFAULT_LIMITS.cleanupTimeoutMs),
  })
  .strict();

export const ConfigSchema = z
  .object({
    minecraft: z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65_535).default(25_565),
        /** Exact Java Edition version; must be supported by the installed protocol stack. */
        version: z.string().regex(/^\d+\.\d+(\.\d+)?$/, 'must be an exact release version such as 26.1.2'),
        joinTimeoutMs: posInt(300_000).default(30_000),
      })
      .strict(),
    bot: z
      .object({
        auth: z.enum(['microsoft', 'offline']),
        /**
         * offline: the bot's in-game name.
         * microsoft: a local label for the bot account's token cache (the in-game
         * name comes from the signed-in Minecraft profile).
         */
        username: z.string().min(1).max(64),
        /** Must be true for offline auth; only honored for loopback hosts. */
        trustedOfflineFixture: z.boolean().default(false),
      })
      .strict(),
    owner: z
      .object({
        /** Required for Microsoft/online play: owner admission compares packet sender UUIDs. */
        uuid: z.string().regex(UUID_RE, 'must be a Minecraft UUID').transform(normalizeUuid).optional(),
        /** Exact player name; admission by name is only allowed in the trusted offline fixture. */
        name: PlayerNameSchema.optional(),
      })
      .strict(),
    chat: z
      .object({
        prefix: z.string().regex(/^[!#.$%&*+?~][a-z]{2,15}$/, 'must be a symbol followed by 2-15 lowercase letters').default('!chunkbot'),
        maxInstructionChars: posInt(2_000).default(500),
        replyMode: z.enum(['whisper', 'public']).default('whisper'),
        /** When true, owner chat must also carry a library-verified message signature. */
        requireSignedChat: z.boolean().default(false),
      })
      .strict()
      .default({ prefix: '!chunkbot', maxInstructionChars: 500, replyMode: 'whisper', requireSignedChat: false }),
    storage: z
      .object({
        /** Root for run evidence and auth caches; relative to the config file's project root. */
        dataDir: z.string().min(1).max(512).default('var'),
        keepRuns: posInt(1_000).default(20),
        maxEventsPerRun: posInt(1_000_000).default(5_000),
        maxEventChars: posInt(100_000).default(2_000),
      })
      .strict()
      .default({ dataDir: 'var', keepRuns: 20, maxEventsPerRun: 5_000, maxEventChars: 2_000 }),
    models: z
      .object({
        planner: z
          .object({
            provider: z.literal('codex-subscription'),
            /** Codex CLI binary (managed ChatGPT sign-in); verified against the pinned isolation profile at startup. */
            command: z.string().min(1).max(512).default('codex'),
            /**
             * `codex`: the real subscription planner on normal goal intake.
             * `disabled`: an explicit INFERENCE-FREE profile for foundation/mechanic
             * checks; admitted goals then end planner_not_ready (never a fallback).
             */
            mode: z.enum(['codex', 'disabled']).default('codex'),
            /** The only planner model verified for the isolation profile (no other model is authorized). */
            model: z.literal('gpt-6.1-sol').default('gpt-6.1-sol'),
            /** Coordinator default: low. Higher efforts are supported by the CLI but need documented evidence. */
            reasoningEffort: z.enum(['low', 'medium', 'high']).default('low'),
          })
          .strict()
          .default({ provider: 'codex-subscription', command: 'codex', mode: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' }),
        decision: z
          .object({
            provider: z.literal('openrouter'),
            model: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/).default('typesafe/jev-1.13'),
            apiKeyEnv: EnvVarNameSchema.default('OPENROUTER_API_KEY'),
            /**
             * The OpenRouter Decisions route. Only a LOOPBACK http(s) URL may replace it,
             * for local provider fault fixtures; there is no other provider fallback.
             */
            endpoint: z
              .string()
              .max(300)
              .refine((u) => u === DEFAULT_DECISION_ENDPOINT || isLoopbackUrl(u), 'must be the OpenRouter Decisions route or a loopback fault-fixture URL')
              .default(DEFAULT_DECISION_ENDPOINT),
            /** Responses from any other serving provider fail closed (route change). */
            expectedProvider: z.string().min(1).max(100).default('TypeSafe'),
          })
          .strict()
          .default({ provider: 'openrouter', model: 'typesafe/jev-1.13', apiKeyEnv: 'OPENROUTER_API_KEY', endpoint: DEFAULT_DECISION_ENDPOINT, expectedProvider: 'TypeSafe' }),
      })
      .strict()
      .default({
        planner: { provider: 'codex-subscription', command: 'codex', mode: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' },
        decision: { provider: 'openrouter', model: 'typesafe/jev-1.13', apiKeyEnv: 'OPENROUTER_API_KEY', endpoint: DEFAULT_DECISION_ENDPOINT, expectedProvider: 'TypeSafe' },
      }),
    limits: LimitsSchema.default(DEFAULT_LIMITS),
    /**
     * MB-FLOW-002 directive flow. `handoff: smooth` keeps the current task running while a
     * new owner instruction is prepared (switching after a validated plan); `immediate`
     * replaces at once. `lookahead` plans the next window while a window's last task runs
     * (counted planner turns, revalidated before use). `preparationTurnsPerRun` bounds the
     * planner turns spent on preparations that are discarded (superseded/stopped/failed).
     */
    flow: FlowSchema.default(DEFAULT_FLOW),
    /**
     * MB-MEM-001 persistent gameplay memory. Absent (the default) or
     * `enabled: false`: memory is off, no memory capability is registered and no
     * view is built. Requires an operator-named worldProfile/worldRevision/botProfile.
     */
    memory: MemoryConfigSchema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.bot.auth === 'offline') {
      if (!cfg.bot.trustedOfflineFixture) {
        ctx.addIssue({
          code: 'custom',
          path: ['bot', 'trustedOfflineFixture'],
          message: 'offline auth requires trustedOfflineFixture: true (trusted loopback test fixtures only)',
        });
      }
      if (!isLoopbackHost(cfg.minecraft.host)) {
        ctx.addIssue({
          code: 'custom',
          path: ['minecraft', 'host'],
          message: 'offline auth is only allowed for a loopback host (127.0.0.1, ::1, localhost); use microsoft auth for other servers',
        });
      }
      if (!PlayerNameSchema.safeParse(cfg.bot.username).success) {
        ctx.addIssue({ code: 'custom', path: ['bot', 'username'], message: 'offline bot username must be a 3-16 character player name' });
      }
      if (!cfg.owner.name) {
        ctx.addIssue({ code: 'custom', path: ['owner', 'name'], message: 'offline fixture owner admission requires the exact owner player name' });
      } else if (cfg.owner.name.toLowerCase() === cfg.bot.username.toLowerCase()) {
        ctx.addIssue({ code: 'custom', path: ['bot', 'username'], message: "bot identity must differ from the owner's player identity" });
      }
    } else {
      if (cfg.bot.trustedOfflineFixture) {
        ctx.addIssue({
          code: 'custom',
          path: ['bot', 'trustedOfflineFixture'],
          message: 'trustedOfflineFixture only applies to offline auth; remove it for microsoft auth',
        });
      }
      if (!cfg.owner.uuid) {
        ctx.addIssue({
          code: 'custom',
          path: ['owner', 'uuid'],
          message: 'microsoft auth requires the owner UUID; chat admission compares verified sender UUIDs, not names',
        });
      }
    }
  });

export type ChunkbotConfigInput = z.input<typeof ConfigSchema>;
export type ChunkbotConfig = z.output<typeof ConfigSchema>;
export type Limits = ChunkbotConfig['limits'];
