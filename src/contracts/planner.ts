// Versioned planner proposal and request contracts. The planner returns
// structured plans; it never edits code, launches workers, or controls Minecraft.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, textSchema } from './common.ts';
import { KnowledgeQueryBatchSchema, type KnowledgeResult } from './knowledge.ts';
import { GoalOutcomeContractSchema, type GoalOutcomeContract } from './predicate.ts';
import { TaskSpecSchema } from './task.ts';
import type { CapabilityCatalog } from './capability.ts';
import type { RequestId } from './ids.ts';
import type { LookaheadContext, PlanningSubject, PreparationContext } from './handoff.ts';
import type { MemoryView } from './memory.ts';
import type { AutonomyPlannerContext } from './autonomy.ts';
import type { LocatorHint, RouteProposalContext, RouteStatus } from './locator.ts';
import type { ObservationSnapshot } from './observation.ts';
import type { TaskFeedback } from './task.ts';

export const PLANNER_PROPOSAL_VERSION = 1 as const;

/**
 * MB-PLAN-006: the planner has NO owner-question disposition. Chunkbot never
 * asks the owner follow-up questions; a legacy/malformed `needs_clarification`
 * (or any owner-directed question in owner-facing text) is refused by code
 * with a counted, bounded repair turn and never reaches chat, terminal or the
 * dashboard (src/goals/declarative.ts). Internal knowledge queries stay.
 */
export const PlannerProposalSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      version: z.literal(PLANNER_PROPOSAL_VERSION),
      disposition: z.literal('plan'),
      interpretation: textSchema(BOUNDS.text),
      outcome: GoalOutcomeContractSchema,
      tasks: z.array(TaskSpecSchema).min(1).max(BOUNDS.planWindowSteps),
      morePlanningNeeded: z.boolean(),
    })
    .strict(),
  z
    .object({
      version: z.literal(PLANNER_PROPOSAL_VERSION),
      disposition: z.literal('needs_information'),
      interpretation: textSchema(BOUNDS.text),
      queries: KnowledgeQueryBatchSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(PLANNER_PROPOSAL_VERSION),
      disposition: z.literal('cannot_execute'),
      interpretation: textSchema(BOUNDS.text),
      /** The exact missing capability or prerequisite; never "not on the list". */
      missing: textSchema(BOUNDS.text),
      missingCapabilities: z.array(CapabilityIdSchema).max(BOUNDS.listSmall).default([]),
      verifiedProgress: z.string().max(BOUNDS.text).default(''),
    })
    .strict(),
]);
export type PlannerProposal = z.infer<typeof PlannerProposalSchema>;
export type PlannerDisposition = PlannerProposal['disposition'];

/** Code-owned counters for one goal. Every planner turn kind counts toward `plannerTurns`; none resets across windows. */
export interface GoalCounters {
  /** All planner turns: initial, knowledge continuations, schema/semantic/policy repairs, transport retries, replans, lookahead. */
  plannerTurns: number;
  knowledgeRounds: number;
  /** Turns that answered a rejected (malformed, code-bearing, unknown-reference, owner-question) proposal. */
  repairs: number;
  /** Turns retried after a bounded transport failure (timeout/process error). */
  retries: number;
  /** MB-PLAN-006: proposals refused because they asked the owner a question (each answered by a counted repair or ending the goal). */
  questionRefusals: number;
  /** Turns requested after an executed task window (window exhausted, task blocked/failed, outcome unmet). */
  replans: number;
  windows: number;
  tasksAdmitted: number;
  /** Turns spent while this instruction was prepared before admission (MB-FLOW-002; included in plannerTurns). */
  preparationTurns: number;
  /** Speculative next-window turns started while a window's last task ran (included in plannerTurns). */
  lookaheads: number;
}

/** Coordinates the OWNER typed (parsed by code from the instruction); the only admissible owner_destination values. */
export interface OwnerCoordinate {
  x: number;
  y: number;
  z: number;
  /** The exact owner text the numbers were parsed from (bounded). */
  text: string;
  source: 'instruction';
}

/** A verified prior skill result of this goal (e.g. a placed workstation), confirmed by the evidence ledger. */
export interface PriorResultRef {
  actionId: string;
  key: string;
  at: { x: number; y: number; z: number };
  dimension: string;
}

export const PLANNER_TURN_KINDS = ['initial', 'knowledge', 'repair', 'retry', 'replan', 'lookahead', 'continuation'] as const;
export type PlannerTurnKind = (typeof PLANNER_TURN_KINDS)[number];

/** Correlation id of a request's subject for evidence (goal id or intent id). */
export function subjectRef(subject: PlanningSubject): string {
  return subject.kind === 'goal' ? subject.goalId : subject.intentId;
}

/** Server-confirmed inventory captured at goal ADMISSION (before the first planner turn). */
export interface AdmissionInventory {
  capturedAtMs: number;
  /** All item counts; null when no server-confirmed inventory could be obtained (detail says why). */
  counts: Array<{ key: string; count: number }> | null;
  detail: string;
}

/** Everything a planner turn receives. Contains no Minecraft library objects. */
export interface PlannerRequest {
  requestId: RequestId;
  /** What this turn plans for: an admitted goal, or a non-admitted pending instruction (H-G1). */
  subject: PlanningSubject;
  /** The owner's instruction verbatim (bounded). Open-ended natural language. */
  instruction: string;
  turn: number;
  maxTurns: number;
  catalog: CapabilityCatalog;
  observation: ObservationSnapshot | null;
  knowledge: readonly KnowledgeResult[];
  /** Verified results and structured recovery evidence from earlier task windows of this goal (bounded). */
  feedback?: readonly TaskFeedback[];
  /** Why this turn happens (first turn, knowledge continuation, repair, retry, replan, lookahead). */
  turnKind?: PlannerTurnKind;
  /** Preparation subject only: the old task continues; the draft is revalidated at admission. */
  preparation?: PreparationContext;
  /** `lookahead` turns only: the current window's last task is still running. */
  lookahead?: LookaheadContext;
  /**
   * MB-MEM-001: bounded memory view for THIS subject (goal: executable mref-
   * refs; preparation: non-executable mprep- refs). Absent when memory is not installed.
   */
  memory?: MemoryView;
  /** Admission-bound inventory baseline (all items), kept for the goal's lifetime. */
  admission?: AdmissionInventory;
  /** The accepted, immutable goal outcome once a first plan was admitted. */
  acceptedOutcome?: GoalOutcomeContract;
  /** The accepted interpretation (shown to the owner). */
  acceptedInterpretation?: string;
  /** Latest code evaluation of the accepted outcome (never a model claim). */
  outcomeStatus?: { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string };
  counters?: GoalCounters;
  remaining?: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number; windowSteps: number };
  ownerCoordinates?: readonly OwnerCoordinate[];
  priorResults?: readonly PriorResultRef[];
  /** Problems of the previous rejected proposal (for a bounded repair turn). */
  rejection?: { problems: string[] };
  mechanicsVersion?: string;
  /** Limits the planner must respect (read-only facts; the planner cannot change them). */
  limits?: { travelRadius: number; observationRadius: number; planWindowSteps: number };
  /**
   * MB-FLOW-001: present only for an AUTOMATIC goal (progression/support). The
   * instruction is then code-generated, not owner words; this bounded context
   * says why the goal exists, what was recently verified/blocked, the session
   * allowance left and the home project. Data, not instructions.
   */
  autonomy?: AutonomyPlannerContext;
  /**
   * MB-LOC-001: the goal epoch's code-owned route authorization (no
   * coordinates), its progress and the ORIGINAL admission anchor/radius. A
   * proposal naming an unauthorized/unavailable route destination is rejected.
   */
  route?: RouteProposalContext & { status: RouteStatus | null; admission: { anchor: { x: number; y: number; z: number }; radius: number } | null };
  /** MB-LOC-001: coarse owner locator hint (direction/band/elevation only; never coordinates). */
  locator?: LocatorHint;
  /**
   * MB-FLOW-003-C12: present on every turn of a CONTINUATION of a held owner job
   * (same goal id): app-written facts (never planner prose), the continuation
   * number and what interrupted it. Data, not instructions.
   */
  continuation?: { number: number; max: number; after: string; facts: string[] };
}

/**
 * Typed planner failures. There is no planner model, provider or billing
 * fallback. `aborted` means the owning goal was revoked.
 */
export const PLANNER_FAILURE_KINDS = [
  'not_ready', // adapter not installed, isolation gate failed, or disabled for the run
  'auth', // subscription sign-in missing/expired
  'quota', // subscription usage limit reached
  'model_unavailable', // selected model not available for the account
  'model_mismatch', // the CLI reported a reroute/fallback to another model
  'prohibited_event', // a tool/agent event appeared in the turn stream (isolation breach)
  'invalid_output', // no parseable final JSON / forbidden fields / code-bearing text
  'timeout',
  'process_error', // the planner process failed without a classified reason
  'aborted',
] as const;
export type PlannerFailureKind = (typeof PLANNER_FAILURE_KINDS)[number];

export interface PlannerFailure {
  kind: PlannerFailureKind;
  detail: string;
  /** Problems for an invalid-output repair turn. */
  problems?: string[];
}
