// A skill definition is ONE registered object that supplies (a) the
// model-visible catalog descriptor, (b) the parameter schema the executor
// validates, (c) the candidate resolver used for task-driven candidate
// generation, and (d) the executor. Planner catalog, candidate generation and
// execution therefore cannot drift apart.
//
// A skill is a bounded player mechanism, never a whole user goal and never a
// hidden prerequisite chain: a missing tool, ingredient, workstation, fuel,
// target or path is returned as structured evidence for the planner.
import type { z } from 'zod';
import type {
  ActionCandidate,
  CapabilityDescriptor,
  Clock,
  ExecutionOwner,
  JsonValue,
  ObservationSnapshot,
  Parameters,
  SkillOutcome,
  TaskSpec,
} from '../contracts/index.ts';
import type { Actuator } from '../execution/actuator.ts';
import type { EvidenceLedger } from '../execution/ledger.ts';
import type { GameSession } from '../game/connection.ts';
import type { VersionKnowledge } from '../knowledge/knowledge.ts';
import type { PerceptionService } from '../perception/perception.ts';

export interface SkillLimits {
  observationRadius: number;
  travelRadius: number;
  ownerLossMs: number;
}

export interface SkillServices {
  perception: PerceptionService;
  knowledge: VersionKnowledge;
  ledger: EvidenceLedger;
  clock: Clock;
  limits: SkillLimits;
}

/** Generic hints derived from a TaskSpec (selectors, completion predicate, parameters); never a goal type. */
export interface TaskHints {
  /** Registry keys/tags named by target selectors or the completion predicate. */
  keys: string[];
  /** Observed handles named by target selectors. */
  handles: Array<{ snapshotId: string; handle: string }>;
  /** Explicit task selectors/parameters, separate from completion discovery hints. */
  primaryHandles?: Array<{ snapshotId: string; handle: string }>;
  /** Explicit registry targets remain binding even when completion offers broader resource hints. */
  targetKeys?: string[];
  /** Removal completion targets form a work set, intersected with explicit targets. */
  removalHandles?: Array<{ snapshotId: string; handle: string }>;
  wantsOwner: boolean;
  anchors: string[];
  destinations: Array<{ dimension: string; at: { x: number; y: number; z: number } }>;
  priorResults: string[];
  /** Desired items and quantities from the completion predicate (crafting/smelting/inventory); `possess` = held amount counts. */
  outputs: Array<{ key: string; count: number; possess?: boolean }>;
  parameters: Parameters;
  /** MB-MEM-001: memory refs named by target selectors (resolved only under the goal's ownership fence). */
  memoryRefs: string[];
}

export interface ResolveContext {
  task: TaskSpec;
  hints: TaskHints;
  snapshot: ObservationSnapshot;
  /** Read-only access for preconditions; resolvers never issue commands. */
  session: GameSession;
  services: SkillServices;
}

export interface CandidateDraft {
  parameters: Parameters;
  description: string;
  criteria?: string[];
  preconditions?: string[];
  timeoutMs?: number;
  /** Higher sorts first within this capability. */
  score?: number;
}

export interface Unavailable {
  reason: string;
  detail: string;
  evidence?: Record<string, JsonValue>;
}

export interface ResolveResult {
  drafts: CandidateDraft[];
  unavailable?: Unavailable[];
}

export type SkillStatus = 'succeeded' | 'partial' | 'failed' | 'precondition_failed';

export interface SkillResult {
  status: SkillStatus;
  effect: string;
  reason?: string;
  confirmation: 'server_packet' | 'server_sync' | 'client_only' | 'none';
  evidence?: Record<string, JsonValue>;
}

export type ProgressProvenance = 'server_packet' | 'server_sync' | 'local';

export interface ExecuteContext {
  act: Actuator;
  session: GameSession;
  services: SkillServices;
  candidate: ActionCandidate;
  owner: ExecutionOwner;
  /**
   * Records partial effects (reported if the action is cancelled) with their
   * provenance: 'server_packet' / 'server_sync' only for effects the server
   * stated; 'local' (default) for client-model or locally sampled progress,
   * which never makes a cancelled result server-confirmed.
   */
  progress(evidence: Record<string, JsonValue>, provenance?: ProgressProvenance): void;
}

export interface SkillDefinition<P = unknown> {
  descriptor: CapabilityDescriptor;
  params: z.ZodType<P>;
  /**
   * Sustained (intentional-wait) skills such as following or furnace processing:
   * `windowElapsed` recognizes an outcome that only means the healthy wait window
   * ended. The task runtime then continues an equivalent grounded option locally,
   * without inference and without counting a stall. Not part of the catalog
   * descriptor (the catalog version is unchanged).
   */
  sustained?: { windowElapsed(outcome: SkillOutcome): boolean };
  resolve(ctx: ResolveContext): ResolveResult;
  execute(ctx: ExecuteContext, params: P): Promise<SkillResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySkill = SkillDefinition<any>;

export function precondition(reason: string, effect: string, evidence: Record<string, JsonValue> = {}): SkillResult {
  return { status: 'precondition_failed', reason, effect, confirmation: 'none', evidence };
}

export function failed(reason: string, effect: string, evidence: Record<string, JsonValue> = {}, confirmation: SkillResult['confirmation'] = 'none'): SkillResult {
  return { status: 'failed', reason, effect, confirmation, evidence };
}
