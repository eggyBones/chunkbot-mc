// Private durable format. This is semantic history, never an executable plan.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DimensionSchema, RegistryKeySchema, Vec3Schema } from '../../contracts/common.ts';
import { GoalRecordSchema } from '../../contracts/goal.ts';
import { GoalOutcomeContractSchema, isPredicateWithinDepth, type GoalOutcomeContract } from '../../contracts/predicate.ts';
import { groundOutcome, outcomeAtoms } from '../../goals/continuation.ts';

export const CHECKPOINT_FORMAT = 'chunkbot-managed-checkpoint' as const;
export const CHECKPOINT_VERSION = 1 as const;
export const CHECKPOINT_SEMANTICS = 'admission-bound-outcome-v1' as const;
export const MAX_CHECKPOINT_BYTES = 1_048_576;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const number = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const code = z.string().regex(/^[a-z][a-z0-9_:-]{0,95}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
const text = z.string().max(2_000);
const counts = z.record(RegistryKeySchema, integer).refine((x) => Object.keys(x).length <= 2_048);

export const CheckpointScopeSchema = z.object({
  worldProfile: id, worldRevision: integer, botProfile: id,
  semantics: z.literal(CHECKPOINT_SEMANTICS),
}).strict();
export type CheckpointScope = z.infer<typeof CheckpointScopeSchema>;

export const AllowanceSchema = z.object({
  key: code, limit: number, used: number, deadlineAtMs: integer.nullable(),
  disabled: code.nullable(),
}).strict().refine((x) => x.used <= x.limit, 'consumed allowance exceeds original cap');
export type CheckpointAllowance = z.infer<typeof AllowanceSchema>;

const countLineage = z.object({
  path: z.string().regex(/^root(?:\.\d+){0,4}$/),
  basis: z.enum(['possession', 'effect']),
  predicate: z.enum(['inventory_delta', 'inventory_amount', 'crafting_result', 'smelting_result']),
  selector: RegistryKeySchema, atLeast: integer, admissionCount: integer.nullable(),
  credited: integer.nullable(), heldAtInterruption: integer.nullable(),
  evidence: z.enum(['current_server_inventory', 'last_alive_server_packets', 'skill_confirmed_outputs', 'pending', 'unavailable']),
  latched: z.boolean(), incidentId: id.nullable(), segments: integer,
}).strict();

// Route usage only: no route id, old epoch, leg target, handle or actuator grant.
export const RouteCheckpointSchema = z.object({
  grantedAtMs: integer, deadlineAtMs: integer,
  anchor: z.object({ dimension: DimensionSchema, at: Vec3Schema, radius: number }).strict(),
  limits: z.object({ legs: integer, distance: number, stalledLegs: integer }).strict(),
  used: z.object({ legs: integer, distance: number, stalledLegs: integer, continuations: integer,
    clientPhysics: number, serverCorrections: number, correctionSamples: integer }).strict(),
  state: z.enum(['authorized', 'exhausted', 'blocked']), blocker: code.nullable(),
}).strict().refine((x) => x.deadlineAtMs >= x.grantedAtMs, 'route deadline precedes grant');

export const SemanticGoalSchema = z.object({
  goalId: id, instruction: z.string().min(1).max(8_000),
  origin: GoalRecordSchema.shape.origin,
  admittedAtMs: integer, deadlineAtMs: integer,
  // Unsupported reference-bearing outcomes are held with their digest only.
  acceptedOutcome: GoalOutcomeContractSchema.nullable(),
  outcomeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  admissionBaseline: z.object({ capturedAtMs: integer, counts: counts.nullable(), detail: text }).strict(),
  anchor: z.object({ dimension: DimensionSchema, at: Vec3Schema, radius: number }).strict().nullable(),
  counters: GoalRecordSchema.shape.counters.unwrap(),
  caps: z.object({ plannerTurns: integer, tasks: integer, replans: integer }).strict(),
  admittedTasks: integer,
  counts: z.array(countLineage).max(256),
  // Already verified historical effects; these never become current evidence.
  verifiedEffects: z.array(z.object({
    key: RegistryKeySchema, count: integer, kind: z.enum(['crafted', 'smelted', 'consumed', 'acquired']),
    verifiedAtMs: integer, provenance: z.literal('code_verified_server_evidence'),
  }).strict()).max(256),
  continuations: z.object({ used: integer, max: integer }).strict(),
  allowances: z.array(AllowanceSchema).max(128),
  route: RouteCheckpointSchema.nullable(),
  heldReason: code.nullable(),
}).strict().superRefine((g, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (g.deadlineAtMs < g.admittedAtMs || g.admissionBaseline.capturedAtMs < g.admittedAtMs) invalid('invalid original admission timing');
  if (g.counters.plannerTurns > g.caps.plannerTurns || g.admittedTasks > g.caps.tasks || g.counters.replans > g.caps.replans) invalid('goal counters exceed original caps');
  if (g.counters.tasksAdmitted !== g.admittedTasks || g.continuations.used > g.continuations.max) invalid('inconsistent cumulative counters');
  if (g.acceptedOutcome === null && g.heldReason === null) invalid('missing outcome must remain held');
  if (g.acceptedOutcome) {
    if (digest(g.acceptedOutcome) !== g.outcomeDigest) invalid('immutable outcome digest mismatch');
    const p = g.acceptedOutcome.kind === 'finite' ? g.acceptedOutcome.outcome : g.acceptedOutcome.maintain;
    if (!isPredicateWithinDepth(p)) invalid('outcome depth exceeded');
    for (const { atom } of outcomeAtoms(g.acceptedOutcome)) {
      if ('target' in atom && !['registry', 'owner', 'owner_destination'].includes(atom.target.kind)) invalid('ephemeral outcome reference forbidden');
    }
    const atoms = outcomeAtoms(g.acceptedOutcome);
    const expected = atoms.filter(({ atom }) => atom.predicate === 'inventory_delta' || atom.predicate === 'crafting_result' || atom.predicate === 'smelting_result' || (atom.predicate === 'inventory_amount' && atom.mode === 'collect_additional'));
    if (expected.length !== g.counts.length) invalid('count lineage incomplete');
    for (const line of g.counts) {
      const atom = atoms.find((x) => x.path === line.path)?.atom;
      if (!atom || !('atLeast' in atom) || line.predicate !== atom.predicate || line.atLeast !== atom.atLeast || line.selector !== ('output' in atom ? atom.output : 'selector' in atom ? atom.selector : null)) invalid('count lineage does not match outcome');
      const effect = line.predicate === 'crafting_result' || line.predicate === 'smelting_result';
      if (line.basis !== (effect ? 'effect' : 'possession')) invalid('count basis mismatch');
      if (!effect && !line.selector.startsWith('#') && g.admissionBaseline.counts && line.admissionCount !== (g.admissionBaseline.counts[line.selector] ?? 0)) invalid('acquisition admission count changed');
    }
  }
  if (new Set(g.counts.map((x) => x.path)).size !== g.counts.length) invalid('duplicate count lineage');
  if (new Set(g.allowances.map((x) => x.key)).size !== g.allowances.length) invalid('duplicate allowance');
});
export type SemanticGoal = z.infer<typeof SemanticGoalSchema>;

export const SpendCheckpointSchema = z.object({
  capUsd: number, reconciledUsd: number, retainedUsd: number, outstandingUsd: number,
  remainingUsd: z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  attempts: integer, reconciled: integer, retained: integer, released: integer, refused: integer,
}).strict().superRefine((s, ctx) => {
  const remaining = s.capUsd - s.reconciledUsd - s.retainedUsd - s.outstandingUsd;
  if (Math.abs(remaining - s.remainingUsd) > 1e-12 || remaining < -1e-12) ctx.addIssue({ code: 'custom', message: 'invalid spend accounting' });
  if (s.reconciled + s.retained + s.released > s.attempts) ctx.addIssue({ code: 'custom', message: 'invalid attempt accounting' });
  const pending = s.attempts - s.reconciled - s.retained - s.released;
  if ((pending === 0) !== (s.outstandingUsd === 0)) ctx.addIssue({ code: 'custom', message: 'outstanding spend/attempt mismatch' });
});

export const ManagedCheckpointSchema = z.object({
  version: z.literal(CHECKPOINT_VERSION), scope: CheckpointScopeSchema, sessionId: id,
  revision: integer.min(1), generation: integer, savedAtMs: integer,
  control: z.object({ onlineIntent: z.boolean(), paused: z.boolean(), reason: code }).strict(),
  directiveGeneration: integer.nullable(), goal: SemanticGoalSchema.nullable(),
  spend: SpendCheckpointSchema,
  // Session-scoped preparation, decision, support/recovery allowances and flags.
  allowances: z.array(AllowanceSchema).max(128),
  providerDisabled: z.object({ planner: code.nullable(), decision: code.nullable() }).strict(),
}).strict().superRefine((x, ctx) => {
  if ((x.goal !== null && x.directiveGeneration === null) || (x.directiveGeneration !== null && x.directiveGeneration > x.generation)) ctx.addIssue({ code: 'custom', message: 'directive generation mismatch' });
  if (new Set(x.allowances.map((a) => a.key)).size !== x.allowances.length) ctx.addIssue({ code: 'custom', message: 'duplicate session allowance' });
});
export type ManagedCheckpoint = z.infer<typeof ManagedCheckpointSchema>;

export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(walk(value));
}
export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

/** Strip all reference-bearing outcomes as a unit; no saved handle is reusable. */
export function portableOutcome(outcome: GoalOutcomeContract, baselineKnown: boolean): {
  acceptedOutcome: GoalOutcomeContract | null; outcomeDigest: string; heldReason: string | null;
} {
  const parsed = GoalOutcomeContractSchema.parse(outcome);
  const reference = outcomeAtoms(parsed).some(({ atom }) => 'target' in atom && !['registry', 'owner', 'owner_destination'].includes(atom.target.kind));
  const reason = groundOutcome(parsed, baselineKnown).find((x) => x.status === 'not_groundable')?.reason;
  return { acceptedOutcome: reference ? null : parsed, outcomeDigest: digest(parsed), heldReason: reference ? 'outcome_reference_not_portable' : reason ?? null };
}
