import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SpendSnapshot } from '../../decision/spend.ts';
import { groundOutcome } from '../../goals/continuation.ts';
import { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, MAX_CHECKPOINT_BYTES, ManagedCheckpointSchema, SemanticGoalSchema, canonical, digest, type CheckpointAllowance, type ManagedCheckpoint, type SemanticGoal } from './schema.ts';
import type { CaptureManagedGoal, CheckpointLoad, CheckpointStoreOptions, CreateManagedSession, ResumeView } from './ports.ts';

const revisionFile = /^checkpoint-(\d{12})\.json$/;
const lockSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict();
const envelope = z.object({
  format: z.literal(CHECKPOINT_FORMAT), version: z.literal(CHECKPOINT_VERSION),
  previousDigest: z.string().nullable(), checksum: z.string(), body: ManagedCheckpointSchema,
}).strict();
const headSchema = z.object({ version: z.literal(CHECKPOINT_VERSION), revision: z.number().int().positive(), envelopeDigest: z.string() }).strict();
type Envelope = z.infer<typeof envelope>;

export class CheckpointHeldError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`managed checkpoint held: ${reason}`); this.reason = reason; }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    // Unknown ownership/PID reuse is held, never adopted or signalled.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readBounded(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_BYTES) throw new CheckpointHeldError('invalid_checkpoint_file');
  return readFileSync(path, 'utf8');
}
function notRefilled(previous: readonly CheckpointAllowance[], next: readonly CheckpointAllowance[]): boolean {
  return previous.every((p) => {
    const n = next.find((x) => x.key === p.key);
    return n && n.limit === p.limit && n.used >= p.used && n.deadlineAtMs === p.deadlineAtMs && (p.disabled === null || n.disabled === p.disabled);
  }) && next.length === previous.length;
}
function sameGoalLineage(p: SemanticGoal, n: SemanticGoal): boolean {
  const frozen = (g: SemanticGoal) => ({ goalId: g.goalId, instruction: g.instruction, origin: g.origin, admittedAtMs: g.admittedAtMs,
    deadlineAtMs: g.deadlineAtMs, outcomeDigest: g.outcomeDigest, admissionBaseline: g.admissionBaseline, anchor: g.anchor, caps: g.caps, maxContinuations: g.continuations.max });
  if (canonical(frozen(p)) !== canonical(frozen(n))) return false;
  if (Object.entries(p.counters).some(([key, value]) => (n.counters[key as keyof typeof n.counters] ?? -1) < (value ?? 0))) return false;
  if (n.admittedTasks < p.admittedTasks || n.continuations.used < p.continuations.used || !notRefilled(p.allowances, n.allowances)) return false;
  if (p.verifiedEffects.some((v, i) => canonical(n.verifiedEffects[i]) !== canonical(v))) return false;
  if (p.counts.some((c) => {
    const next = n.counts.find((x) => x.path === c.path);
    return !next || next.admissionCount !== c.admissionCount || next.segments < c.segments || (c.latched && !next.latched) || (c.basis === 'effect' && (next.credited ?? -1) < (c.credited ?? 0));
  })) return false;
  if (p.route === null) return n.route === null;
  if (!n.route || canonical(p.route.anchor) !== canonical(n.route.anchor) || canonical(p.route.limits) !== canonical(n.route.limits) || canonical(p.route.destinations) !== canonical(n.route.destinations) || p.route.source !== n.route.source || p.route.grantedAtMs !== n.route.grantedAtMs || p.route.deadlineAtMs !== n.route.deadlineAtMs) return false;
  if (Object.entries(p.route.used).some(([k, v]) => n.route!.used[k as keyof typeof p.route.used] < v)) return false;
  return p.route.state === 'authorized' || (n.route.state === p.route.state && n.route.blocker === p.route.blocker);
}

/**
 * Single manager-owned journal outside release directories. Synchronous commits
 * make provider-dispatch and terminal control acknowledgements durability gates.
 * We never fall back to older accounting, prune history or auto-create a budget.
 */
export class ManagedCheckpointStore {
  private readonly options: CheckpointStoreOptions;
  readonly dir: string;
  private state: ManagedCheckpoint | null = null;
  private held: string | null = 'not_open';
  private previousDigest: string | null = null;
  private readonly token = randomUUID();
  private lockHeld = false;
  private opened = false;
  private childEpoch = 0;
  private uncleanRecovery = false;

  constructor(options: CheckpointStoreOptions) {
    this.options = options;
    this.dir = resolve(options.dir);
  }

  private hold(reason: string): CheckpointLoad {
    this.held = reason;
    this.childEpoch += 1;
    return { status: 'held', reason, checkpoint: this.snapshot() };
  }

  private acquireLock(): void {
    const path = join(this.dir, 'writer.lock');
    const guard = join(this.dir, 'lock-recovery.guard');
    if (exists(guard)) throw new CheckpointHeldError('writer_or_recovery_busy');
    const claim = () => {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); fsyncSync(fd); } finally { closeSync(fd); }
      this.lockHeld = true;
      syncDirectory(this.dir);
    };
    try { claim(); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    // Serialize abandoned-lock recovery. An abandoned recovery guard itself
    // remains held; guessing its state would violate crash/ownership fencing.
    let fd: number;
    try { fd = openSync(guard, 'wx', 0o600); } catch { throw new CheckpointHeldError('writer_or_recovery_busy'); }
    try {
      const owner = lockSchema.parse(JSON.parse(readBounded(path)));
      if (alive(owner.pid)) throw new CheckpointHeldError('writer_busy');
      this.uncleanRecovery = true;
      unlinkSync(path);
      claim();
    } finally { closeSync(fd); unlinkSync(guard); }
  }

  open(): CheckpointLoad {
    if (this.opened) return this.held ? this.hold(this.held) : { status: 'ready', checkpoint: this.snapshot()! };
    this.opened = true;
    try {
      if (exists(this.dir) && (!lstatSync(this.dir).isDirectory() || lstatSync(this.dir).isSymbolicLink())) return this.hold('invalid_checkpoint_directory');
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.acquireLock();
      const names = readdirSync(this.dir);
      if (names.some((n) => (n.startsWith('checkpoint-') && !revisionFile.test(n)) || n.startsWith('head.json.tmp-'))) return this.hold('ambiguous_partial_checkpoint');
      const files = names.filter((n) => revisionFile.test(n)).sort();
      if (!files.length) return this.hold(exists(join(this.dir, 'head.json')) ? 'missing_checkpoint_with_existing_head' : 'missing_checkpoint');
      let previous: Envelope | null = null;
      for (const name of files) {
        const next = envelope.parse(JSON.parse(readBounded(join(this.dir, name))));
        const expectedRevision: number = previous ? previous.body.revision + 1 : 1;
        if (next.body.revision !== expectedRevision || Number(revisionFile.exec(name)![1]) !== expectedRevision || next.previousDigest !== (previous ? digest(previous) : null) || next.checksum !== digest(next.body)) return this.hold('checkpoint_integrity_or_revision_gap');
        if (canonical(next.body.scope) !== canonical(this.options.scope) || next.body.sessionId !== this.options.sessionId) return this.hold('checkpoint_scope_or_session_mismatch');
        if (previous && !this.validTransition(previous.body, next.body)) return this.hold('checkpoint_lineage_mismatch');
        previous = next;
      }
      // An independently durable head detects a missing TAIL revision, not only
      // a gap inside the chain. An extra unpublished revision is also held.
      const head = headSchema.parse(JSON.parse(readBounded(join(this.dir, 'head.json'))));
      if (head.revision !== previous!.body.revision || head.envelopeDigest !== digest(previous)) return this.hold('checkpoint_head_mismatch');
      this.state = previous!.body;
      this.previousDigest = digest(previous);
      this.held = null;
      // Recovery never grants release/refund authority for unresolved dispatches.
      if (this.state.spend.outstandingUsd > 0 || this.uncleanRecovery) {
        const s = this.state.spend;
        const pending = s.attempts - s.reconciled - s.retained - s.released;
        this.persist({ ...this.state, managerRecovery: this.uncleanRecovery ? 'held_unclean' : this.state.managerRecovery,
          spend: { ...s, retainedUsd: s.retainedUsd + s.outstandingUsd, outstandingUsd: 0, retained: s.retained + pending } });
      }
      return { status: 'ready', checkpoint: this.snapshot()! };
    } catch (error) {
      return this.hold(error instanceof CheckpointHeldError ? error.reason : 'checkpoint_unreadable_or_incompatible');
    }
  }

  /** This is the ONLY path that may allocate fresh accounting. */
  createSession(input: CreateManagedSession): ManagedCheckpoint {
    if (!this.opened || !this.lockHeld || this.held !== 'missing_checkpoint' || this.state || input.authorization !== 'explicit_operator_new_session') throw new CheckpointHeldError('new_session_not_authorized_or_not_empty');
    if (readdirSync(this.dir).some((n) => n.startsWith('checkpoint-'))) throw new CheckpointHeldError('checkpoint_state_not_empty');
    this.held = null;
    this.persist({
      version: CHECKPOINT_VERSION, scope: this.options.scope, sessionId: this.options.sessionId,
      revision: 1, generation: 0, savedAtMs: this.now(),
      managerRecovery: 'clean',
      control: { onlineIntent: input.onlineIntent, paused: input.paused, reason: 'explicit_operator_new_session' },
      directiveGeneration: null, goal: null,
      spend: { capUsd: input.capUsd, reconciledUsd: 0, retainedUsd: 0, outstandingUsd: 0, remainingUsd: input.capUsd, attempts: 0, reconciled: 0, retained: 0, released: 0, refused: 0 },
      allowances: input.allowances, providerDisabled: { planner: null, decision: null },
    });
    return this.snapshot()!;
  }

  snapshot(): ManagedCheckpoint | null { return this.state ? structuredClone(this.state) : null; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private requireReady(): ManagedCheckpoint {
    if (this.held || !this.lockHeld || !this.state) throw new CheckpointHeldError(this.held ?? 'checkpoint_not_ready');
    try {
      if (readBounded(join(this.dir, 'writer.lock')) !== JSON.stringify({ pid: process.pid, token: this.token })) throw new CheckpointHeldError('writer_ownership_changed');
    } catch {
      this.hold('writer_ownership_changed'); throw new CheckpointHeldError('writer_ownership_changed');
    }
    return this.state;
  }
  private validTransition(p: ManagedCheckpoint, n: ManagedCheckpoint): boolean {
    if (n.sessionId !== p.sessionId || canonical(n.scope) !== canonical(p.scope) || n.generation < p.generation || n.generation > p.generation + 1 || n.savedAtMs < p.savedAtMs) return false;
    if (p.managerRecovery === 'held_unclean' && n.managerRecovery === 'clean' && !(n.generation === p.generation + 1 && n.control.reason === 'operator_start')) return false;
    if (n.generation === p.generation && (canonical(n.control) !== canonical(p.control) || n.directiveGeneration !== p.directiveGeneration)) return false;
    if (n.spend.capUsd !== p.spend.capUsd || n.spend.reconciledUsd < p.spend.reconciledUsd || n.spend.retainedUsd < p.spend.retainedUsd) return false;
    for (const k of ['attempts', 'reconciled', 'retained', 'released', 'refused'] as const) if (n.spend[k] < p.spend[k]) return false;
    if (!notRefilled(p.allowances, n.allowances)) return false;
    if ((p.providerDisabled.planner !== null && n.providerDisabled.planner !== p.providerDisabled.planner) || (p.providerDisabled.decision !== null && n.providerDisabled.decision !== p.providerDisabled.decision)) return false;
    if (p.goal && p.directiveGeneration === n.directiveGeneration && (!n.goal || !sameGoalLineage(p.goal, n.goal))) return false;
    return true;
  }
  private persist(input: ManagedCheckpoint): void {
    try {
      const next = ManagedCheckpointSchema.parse({ ...input, revision: (this.state?.revision ?? 0) + 1, savedAtMs: this.now() });
      if (this.state && !this.validTransition(this.state, next)) throw new CheckpointHeldError('checkpoint_lineage_mismatch');
      const doc: Envelope = { format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, previousDigest: this.previousDigest, checksum: digest(next), body: next };
      const raw = JSON.stringify(doc);
      if (Buffer.byteLength(raw) > MAX_CHECKPOINT_BYTES) throw new CheckpointHeldError('checkpoint_too_large');
      const final = join(this.dir, `checkpoint-${String(next.revision).padStart(12, '0')}.json`);
      if (exists(final)) throw new CheckpointHeldError('checkpoint_revision_already_exists');
      const tmp = `${final}.tmp-${this.token}`;
      this.options.fault?.('before_write');
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      this.options.fault?.('after_file_sync');
      renameSync(tmp, final);
      this.options.fault?.('after_rename');
      syncDirectory(this.dir);
      const headTmp = join(this.dir, `head.json.tmp-${this.token}`);
      const headFd = openSync(headTmp, 'wx', 0o600);
      try { writeFileSync(headFd, JSON.stringify({ version: CHECKPOINT_VERSION, revision: next.revision, envelopeDigest: digest(doc) })); fsyncSync(headFd); } finally { closeSync(headFd); }
      renameSync(headTmp, join(this.dir, 'head.json'));
      syncDirectory(this.dir);
      this.options.fault?.('after_directory_sync');
      this.state = next;
      this.previousDigest = digest(doc);
    } catch (error) {
      this.hold(error instanceof CheckpointHeldError ? error.reason : 'checkpoint_write_failed');
      throw error;
    }
  }

  control(command: 'stop' | 'logout' | 'resume' | 'start' | 'directive'): number {
    const s = this.requireReady();
    const generation = s.generation + 1;
    const control = { ...s.control, reason: `operator_${command}` };
    if (command === 'logout') { control.onlineIntent = false; control.paused = true; }
    if (command === 'stop') control.paused = true;
    if (command === 'resume') control.paused = false;
    if (command === 'start') control.onlineIntent = true;
    this.persist({ ...s, generation, control, managerRecovery: command === 'start' ? 'clean' : s.managerRecovery,
      ...(command === 'directive' ? { goal: null, directiveGeneration: generation } : {}),
    });
    if (command === 'start') this.uncleanRecovery = false;
    return generation;
  }

  captureGoal(input: CaptureManagedGoal): void {
    const s = this.requireReady();
    if (input.expectedGeneration !== s.generation) throw new CheckpointHeldError('stale_directive_generation');
    if (s.directiveGeneration !== s.generation) throw new CheckpointHeldError('directive_not_admitted');
    const goal = SemanticGoalSchema.parse(input.goal);
    if (s.goal && s.directiveGeneration === s.generation && (s.goal.goalId !== goal.goalId || !sameGoalLineage(s.goal, goal))) throw new CheckpointHeldError('goal_semantics_or_allowance_changed');
    this.persist({ ...s, goal, directiveGeneration: s.generation });
  }

  /** Manager calls after its bounded owned-child drain, before a new child. */
  prepareReplacement(input: { expectedGeneration: number; cleanup: 'owned_child_settled' }): ManagedCheckpoint {
    const s = this.requireReady();
    if (s.generation !== input.expectedGeneration || input.cleanup !== 'owned_child_settled') throw new CheckpointHeldError('replacement_generation_or_cleanup_mismatch');
    this.childEpoch += 1;
    const spend = s.spend;
    const pending = spend.attempts - spend.reconciled - spend.retained - spend.released;
    this.persist({ ...s, spend: { ...spend, retainedUsd: spend.retainedUsd + spend.outstandingUsd, outstandingUsd: 0, retained: spend.retained + pending } });
    return this.snapshot()!;
  }

  /** Manager invokes once per child; former child callbacks lose authority. */
  bindChild(options: { fenceGeneration?: boolean } = {}): () => void {
    const generation = this.requireReady().generation;
    if (this.requireReady().managerRecovery === 'held_unclean') throw new CheckpointHeldError('unclean_manager_restart_requires_explicit_start');
    const epoch = ++this.childEpoch;
    return () => {
      this.requireReady();
      if (epoch !== this.childEpoch || (options.fenceGeneration !== false && generation !== this.state!.generation)) throw new CheckpointHeldError('replaced_or_revoked_child');
    };
  }

  /** Accounting wrapper only; persist before the provider is allowed to run. */
  checkpointSpend(snapshot: SpendSnapshot, disableDecisionReason?: string): void {
    const s = this.requireReady();
    this.persist({ ...s, spend: snapshot,
      providerDisabled: { ...s.providerDisabled, decision: s.providerDisabled.decision ?? disableDecisionReason ?? null },
    });
  }

  consumeAllowance(key: string, amount: number, expectedGeneration: number): void {
    const s = this.requireReady();
    const allowance = s.allowances.find((a) => a.key === key);
    if (s.generation !== expectedGeneration || !allowance || !Number.isFinite(amount) || amount <= 0 || allowance.disabled || (allowance.deadlineAtMs !== null && this.now() >= allowance.deadlineAtMs) || allowance.used + amount > allowance.limit) throw new CheckpointHeldError('allowance_not_available');
    this.persist({ ...s, allowances: s.allowances.map((a) => a.key === key ? { ...a, used: a.used + amount } : a) });
  }

  disableProvider(provider: 'planner' | 'decision', reason: string): void {
    const s = this.requireReady();
    this.persist({ ...s, providerDisabled: { ...s.providerDisabled, [provider]: s.providerDisabled[provider] ?? reason } });
  }

  resumeView(): ResumeView {
    const s = this.state;
    if (this.held || !s) return { kind: 'held', generation: s?.generation ?? null, reason: this.held ?? 'missing_checkpoint' };
    try { this.requireReady(); } catch { return { kind: 'held', generation: s.generation, reason: this.held ?? 'writer_ownership_changed' }; }
    if (!s.control.onlineIntent) return { kind: 'offline', generation: s.generation };
    if (s.control.paused) return { kind: 'paused', generation: s.generation };
    const held = (reason: string): ResumeView => ({ kind: 'held', generation: s.generation, reason });
    if (s.managerRecovery === 'held_unclean') return held('unclean_manager_restart_requires_explicit_start');
    if (s.directiveGeneration === null) return { kind: 'idle', generation: s.generation };
    if (s.directiveGeneration !== s.generation) return held('superseded_directive_generation');
    const g = s.goal;
    if (!g) return held('semantic_capture_missing');
    if (g.heldReason || !g.acceptedOutcome) return held(g.heldReason ?? 'outcome_missing');
    if (this.now() >= g.deadlineAtMs) return held('original_deadline_expired');
    if (g.counters.plannerTurns >= g.caps.plannerTurns || g.admittedTasks >= g.caps.tasks || g.counters.replans >= g.caps.replans) return held('original_limits_exhausted');
    if (s.providerDisabled.planner || s.providerDisabled.decision) return held('provider_disabled');
    const decision = g.allowances.find((a) => a.key === 'decision_attempts');
    if (!decision) return held('decision_allowance_unknown');
    if (decision.disabled || decision.used >= decision.limit || (decision.deadlineAtMs !== null && this.now() >= decision.deadlineAtMs)) return held('decision_allowance_exhausted_or_disabled');
    if (s.spend.remainingUsd <= 0) return held('spend_exhausted');
    const grounding = groundOutcome(g.acceptedOutcome, g.admissionBaseline.counts !== null);
    const bad = grounding.find((a) => a.status !== 'groundable');
    if (bad) return held(`not_groundable:${bad.reason ?? 'unknown'}`);
    if (g.counts.some((a) => a.credited === null || a.evidence === 'pending' || a.evidence === 'unavailable' || (a.basis === 'possession' && (a.admissionCount === null || a.heldAtInterruption === null || a.incidentId !== null)))) return held('count_provenance_requires_core_rebind');
    // A route needs a new connection admission seam, not this historical copy.
    if (g.route) return held('route_requires_compatible_rebind');
    return { kind: 'replan', generation: s.generation, goal: structuredClone(g), historical: true };
  }

  close(): void {
    this.childEpoch += 1;
    if (this.lockHeld) {
      const path = join(this.dir, 'writer.lock');
      if (exists(path) && readBounded(path) === JSON.stringify({ pid: process.pid, token: this.token })) { unlinkSync(path); syncDirectory(this.dir); }
      this.lockHeld = false;
    }
    this.held = 'closed';
  }
}
