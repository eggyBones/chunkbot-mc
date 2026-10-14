// MB-OPS-001 proposed shared seam. Data only; paths come from the local operator,
// never from Minecraft or the gameplay planner. Companion implementations must
// consume this contract after coordinator review of its exact commit.
import { z } from 'zod';
import type { ControlLatch, HandoffTotals } from './handoff.ts';
import type { ContinuationCheckpoint, RouteCarry } from './continuation.ts';
import type { Readiness } from './ports.ts';
import { MemoryScopeSchema } from './memory.ts';

export const RELEASE_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_FORMAT_VERSION = 1 as const;
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const ReleaseIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const ManagedScopeSchema = MemoryScopeSchema.extend({
  ownerUuid: z.string().uuid(),
}).strict();
export type ManagedScope = z.infer<typeof ManagedScopeSchema>;

// No traversal, absolute paths, platform separator, credentials or shell hooks.
export const ArtifactPathSchema = z.string().min(1).max(512).refine((s) =>
  !s.includes('\\') && !s.includes('\0') && !s.startsWith('/') &&
  s.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'relative artifact path required');
export const ReleaseManifestSchema = z.object({
  formatVersion: z.literal(RELEASE_FORMAT_VERSION),
  releaseId: ReleaseIdSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  entryPoint: ArtifactPathSchema,
  nodeMajor: z.literal(24),
  minecraftVersions: z.array(z.string().min(1).max(32)).min(1).max(16),
  checkpointVersion: z.literal(CHECKPOINT_FORMAT_VERSION),
  lockfileSha256: Sha256Schema,
  vendorLockSha256: Sha256Schema,
  // Complete regular-file inventory; verifier must reject symlinks and omissions.
  files: z.array(z.object({ path: ArtifactPathSchema, size: z.number().int().nonnegative(), sha256: Sha256Schema }).strict()).min(1).max(100_000),
  summary: z.string().min(1).max(240),
  // Acceptance identifies the frozen bytes, not a worker's success declaration.
  acceptance: z.object({ receiptId: z.string().min(1).max(96), evidenceSha256: Sha256Schema }).strict(),
}).strict().superRefine((m, ctx) => {
  const paths = new Set(m.files.map((f) => f.path));
  if (paths.size !== m.files.length) ctx.addIssue({ code: 'custom', path: ['files'], message: 'duplicate artifact path' });
  if (!paths.has(m.entryPoint)) ctx.addIssue({ code: 'custom', path: ['entryPoint'], message: 'entry point must be in the file inventory' });
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export interface VerifiedRelease {
  readonly directory: string;
  readonly manifest: Readonly<ReleaseManifest>;
  /** Digest of canonical manifest bytes, covering every inventoried file hash. */
  readonly manifestSha256: string;
}
export interface ReleaseArtifactPort {
  verify(directory: string): Promise<VerifiedRelease>;
}

/** Every child command/receipt belongs to exactly one session and deployment. */
export const DeploymentFenceSchema = z.object({
  sessionId: z.string().min(1).max(96),
  generation: z.number().int().nonnegative(),
  releaseId: ReleaseIdSchema,
  manifestSha256: Sha256Schema,
}).strict();
export type DeploymentFence = z.infer<typeof DeploymentFenceSchema>;

export interface ManagedSpendState {
  capUsd: number;
  reconciledUsd: number;
  retainedUsd: number;
  // Persist BEFORE provider dispatch; restore unresolved reservations as retained.
  outstanding: Array<{ id: number; amountUsd: number; label: string }>;
  nextId: number;
  counts: { attempts: number; reconciled: number; retained: number; released: number; refused: number };
}
export interface ManagedAccounting {
  spend: ManagedSpendState;
  decisionAttempts: Record<string, number>;
  decisionDisabled: string | null;
  plannerDisabled: string | null;
  preparation: Pick<HandoffTotals, 'discardedTurns' | 'discardedTurnAllowance'>;
  /** Companion supervisor's exact consumed session allowances (never defaults). */
  automatic: { progressionGoals: number; supportGoals: number; plannerTurns: number };
}
export interface AccountingJournalPort {
  /** Synchronous durable commit, including fsync; failure must prevent dispatch. */
  commit(accounting: ManagedAccounting): void;
}

/** Consumed route allowance history, with no connection/goal epoch grant. */
export type SemanticRouteAccounting = Omit<RouteCarry, 'originalGoalEpoch' | 'fromGoalEpoch' | 'connectionEpoch'>;
/** Semantic data only. Never execute this record directly or restore old epochs. */
export type SemanticDirectiveCheckpoint = Omit<ContinuationCheckpoint, 'sessionId' | 'connectionEpoch' | 'interruptions' | 'state' | 'route'> & {
  state: 'interrupted';
  intakeGeneration: number;
  interruption: 'update';
  route: SemanticRouteAccounting | null;
};
export interface ManagedSessionCheckpoint {
  formatVersion: typeof CHECKPOINT_FORMAT_VERSION;
  fence: DeploymentFence;
  scope: ManagedScope;
  revision: number;
  savedAtMs: number;
  /** Latest durable control generation overrides any earlier child's state. */
  controlGeneration: number;
  intent: 'online' | 'offline';
  latch: ControlLatch;
  accounting: ManagedAccounting;
  directive: SemanticDirectiveCheckpoint | null;
  memoryRevision: number | null;
}
export interface SessionCheckpointPort {
  load(sessionId: string): Promise<ManagedSessionCheckpoint | null>;
  /** Compare-and-swap; no overwritten late stop/logout or accounting. */
  save(checkpoint: ManagedSessionCheckpoint, expectedRevision: number | null): Promise<void>;
}

export interface ChildReadiness {
  fence: DeploymentFence;
  scope: ManagedScope;
  ready: boolean;
  detail: string;
  connectionEpoch: number;
  serverVersion: string;
  protocolVersion: number;
  botUuid: string | null;
  ownerVerified: boolean;
  spawned: boolean;
  inventoryFresh: boolean;
  observationFresh: boolean;
  catalogVersion: string;
  planner: Readiness;
  decision: Readiness;
}
export interface DrainReceipt {
  fence: DeploymentFence;
  drained: boolean;
  detail: string;
  /** True only after actual owned process/interface cleanup, never a timeout. */
  cleanupConfirmed: boolean;
  directive: SemanticDirectiveCheckpoint | null;
}
export interface ManagedChildAppPort {
  readiness(): Promise<ChildReadiness>;
  drain(): Promise<DrainReceipt>;
  stop(): Promise<void>;
  logout(): Promise<void>;
  /** Existing configured owner channel; manager calls once after verified ready. */
  announce(summary: string): Promise<{ sent: boolean; detail: string }>;
}

export interface ManagedChildLaunch {
  release: VerifiedRelease;
  fence: DeploymentFence;
  scope: ManagedScope;
  configPath: string;
  dataDir: string;
  authDir: string;
  checkpoint: ManagedSessionCheckpoint;
}
export interface ManagedChildPort {
  readonly fence: DeploymentFence;
  readiness(signal: AbortSignal): Promise<ChildReadiness>;
  drain(signal: AbortSignal): Promise<DrainReceipt>;
  stop(signal: AbortSignal): Promise<void>;
  /** Prove child, descendants AND socket gone before another launch. */
  terminate(signal: AbortSignal): Promise<{ gone: boolean; detail: string }>;
  announce(summary: string, signal: AbortSignal): Promise<{ sent: boolean; detail: string }>;
}
export interface ManagedChildLauncherPort {
  launch(input: ManagedChildLaunch, signal: AbortSignal): Promise<ManagedChildPort>;
}
export type ReleasePhase = 'offline' | 'joining' | 'online' | 'draining' | 'starting' | 'deferred' | 'rollback' | 'blocked';
export interface ReleaseManagerStatus {
  sessionId: string | null;
  generation: number;
  controlGeneration: number;
  intent: 'online' | 'offline';
  phase: ReleasePhase;
  currentRelease: string | null;
  stagedRelease: string | null;
  paused: boolean;
  detail: string;
}
export interface ReleaseManagerPort {
  status(): ReleaseManagerStatus;
  start(): Promise<ReleaseManagerStatus>;
  logout(): Promise<ReleaseManagerStatus>;
  stop(): Promise<ReleaseManagerStatus>;
  /** Local operator only. Verification precedes any child mutation. */
  offer(directory: string): Promise<ReleaseManagerStatus>;
  rollback(): Promise<ReleaseManagerStatus>;
}
