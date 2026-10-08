// Thin, survival-owned helpers for the designated shared writer, so the
// existing app/task/predicate files only need small, mechanical hooks:
//
//   createSurvivalService   composition (explicit scope reuse from memory config)
//   librarySeed             ready-time inventory seed when onBotCreated is not wired
//   allowedUnderAllowance   TaskRuntime candidate filter at the low-health guard
//   supportGoalSource       canonical autonomy GoalSource `support` shape
//   supportTaskSpec         TaskSpec for a code_task proposal (same admission seam)
//
// None of these actuate, call a model or bypass the single admission path.
import type { ActionCandidate } from '../contracts/action.ts';
import type { MemoryScope } from '../contracts/memory.ts';
import type { ObservationSnapshot } from '../contracts/observation.ts';
import type { EvidenceEvent } from '../contracts/ports.ts';
import { SurvivalConfigSchema, type LowHealthCheck, type SurvivalConfigInput, type SurvivalProposal, type TrackedStack } from '../contracts/survival.ts';
import type { TaskSpec } from '../contracts/task.ts';
import { mk } from './items.ts';
import { minecraftDataRegistry } from './registry.ts';
import { SurvivalService, survivalRoot, type SurvivalMemoryPort } from './service.ts';

export interface CreateSurvivalOptions {
  /** `config.survival` block (undefined: survival disabled). */
  survival: SurvivalConfigInput | undefined;
  /** Explicit operator scope: the enabled memory config's world profile/revision/bot profile (never derived from the endpoint). */
  scope: MemoryScope | undefined;
  /** LoadedConfig.dataDir (ignored var/); undefined: no durable store (recovery blocked honestly). */
  dataDir: string | undefined;
  minecraftVersion: string;
  limits: { lowHealth: number; travelRadius: number };
  now: () => number;
  record?: (event: EvidenceEvent) => void;
  memory?: SurvivalMemoryPort;
  latestSnapshot?: () => ObservationSnapshot | undefined;
  farRoute?: () => string | undefined;
  /** C12: this application session's id (stored checkpoint records from other sessions display as `restart_held`). */
  sessionId?: string;
}

/** Builds and opens the service (synchronous load). Returns undefined when disabled or the version has no item data. */
export function createSurvivalService(o: CreateSurvivalOptions): SurvivalService | undefined {
  if (!o.survival) return undefined;
  const config = SurvivalConfigSchema.parse(o.survival);
  if (!config.enabled) return undefined;
  const registry = minecraftDataRegistry(o.minecraftVersion);
  if (!registry) return undefined;
  const service = new SurvivalService({
    config,
    scope: o.scope,
    rootDir: o.dataDir && o.scope ? survivalRoot(o.dataDir, config) : undefined,
    registry,
    now: o.now,
    limits: o.limits,
    ...(o.record ? { record: o.record } : {}),
    ...(o.memory ? { memory: o.memory } : {}),
    ...(o.latestSnapshot ? { latestSnapshot: o.latestSnapshot } : {}),
    ...(o.farRoute ? { farRoute: o.farRoute } : {}),
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
  });
  service.open();
  return service;
}

interface LibraryItem {
  name?: string;
  count?: number;
  durabilityUsed?: number;
  maxDurability?: number;
}

/**
 * Ready-time seed from the library's inventory model (fed by the server's
 * initial window sync before any click). Labeled `ready_seed`; metadata is
 * `unknown` (component patches were not observed by survival).
 */
export function librarySeed(bot: { inventory?: { slots?: Array<LibraryItem | null | undefined> }; quickBarSlot?: number; health?: number; food?: number; foodSaturation?: number }): { stacks: TrackedStack[]; heldHotbar?: number; vitals?: { health: number; food: number; saturation: number } } {
  const stacks: TrackedStack[] = [];
  (bot.inventory?.slots ?? []).forEach((it, slot) => {
    if (!it || !it.name || !it.count || slot > 45) return;
    stacks.push({ slot, key: mk(it.name), count: it.count, meta: { metadata: 'unknown' } });
  });
  return {
    stacks,
    ...(typeof bot.quickBarSlot === 'number' ? { heldHotbar: bot.quickBarSlot } : {}),
    ...(typeof bot.health === 'number' && typeof bot.food === 'number' ? { vitals: { health: bot.health, food: bot.food, saturation: bot.foodSaturation ?? 0 } } : {}),
  };
}

/** TaskRuntime filter at the low-health guard: only allowed capabilities and (when present) allowed items. */
export function allowedUnderAllowance(candidates: readonly ActionCandidate[], check: LowHealthCheck): ActionCandidate[] {
  if (!check.allowed) return [];
  return candidates.filter((c) => {
    if (!check.capabilities.includes(c.capability)) return false;
    const item = (c.parameters as Record<string, unknown>)['item'];
    if (item === undefined) return true;
    return typeof item === 'string' && check.items.includes(mk(item));
  });
}

/** Canonical autonomy GoalSource (ce214b0) `support` variant for an admitted proposal. */
export function supportGoalSource(p: SurvivalProposal, sessionAttempt: number): { kind: 'support'; routine: string; priority: 'safety' | 'support'; serves: 'owner_intent' | 'progression' | 'none'; reason: string; episodeId?: string; sessionAttempt: number } {
  return { kind: 'support', routine: p.routine, priority: p.priority, serves: p.serves, reason: p.reason.slice(0, 200), ...(p.episodeId ? { episodeId: p.episodeId } : {}), sessionAttempt };
}

/** TaskSpec of a code_task proposal (the writer adds `survival_state` to the predicate union). */
export function supportTaskSpec(p: SurvivalProposal): { spec: TaskSpec; mode: 'complete' | 'maintain' } | undefined {
  if (p.execution.kind !== 'code_task') return undefined;
  return { spec: { ...p.execution.spec, completion: p.execution.completion as TaskSpec['completion'] }, mode: p.execution.mode };
}
