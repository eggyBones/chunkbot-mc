import { randomUUID } from 'node:crypto';
import {
  ManagerFault,
  type AcceptedRelease, type CheckpointRef, type ChildRegistration, type DrainEvidence,
  type FailureCode, type GoneEvidence, type ManagerControlRequest, type ManagerDeadlines, type ManagerIntent,
  type ManagerOptions, type OperationFence, type ReadinessEvidence, type ReleaseProfile,
} from './ports.ts';

export type ManagerPhase = 'offline' | 'staged' | 'validating' | 'draining' | 'starting'
  | 'verifying' | 'ready' | 'rollback' | 'deferred' | 'blocked';
export interface ManagerStatus {
  phase: ManagerPhase;
  intent: ManagerIntent;
  controlSessionId: string;
  deploymentGeneration: number;
  activeReleaseId: string;
  stagedReleaseId: string | null;
  child: ChildRegistration | null;
  failure: FailureCode | null;
  detail: string;
  notice: 'none' | 'sent' | 'unavailable';
  downtimeMs: number | null;
}

const defaults: ManagerDeadlines = {
  validationMs: 10_000, intentMs: 3_000, drainMs: 15_000, checkpointMs: 5_000,
  cleanupMs: 5_000, readinessMs: 30_000, commitMs: 3_000, noticeMs: 2_000, freshnessMs: 5_000,
};
export const sameFence = (a: OperationFence, b: OperationFence): boolean =>
  a.sessionId === b.sessionId && a.deploymentGeneration === b.deploymentGeneration
  && a.commandGeneration === b.commandGeneration;
export const sameProfile = (a: ReleaseProfile, b: ReleaseProfile): boolean =>
  a.worldProfile === b.worldProfile && a.botProfile === b.botProfile && a.ownerProfile === b.ownerProfile
  && a.serverVersion === b.serverVersion && a.protocol === b.protocol;

/** One bounded supervisor. All explicit intent changes fence awaits immediately. */
export class ReleaseManager {
  private readonly options: ManagerOptions;
  private readonly limits: ManagerDeadlines;
  private readonly now: () => number;
  private intent: ManagerIntent;
  private checkpoint: CheckpointRef;
  private activeId: string;
  private stagedId: string | null = null;
  private child: ChildRegistration | null = null;
  private generation = 0;
  private phase: ManagerPhase = 'offline';
  private failure: FailureCode | null = null;
  private detail = 'offline; explicit on required';
  private notice: ManagerStatus['notice'] = 'none';
  private downtimeMs: number | null = null;
  private running: Promise<ManagerStatus> | null = null;
  private transition: AbortController | null = null;
  private readonly tails = new Set<Promise<unknown>>();
  private persistence: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private checkpointUnproven = false;
  private latestRequestGeneration: number;
  private readonly activated = new Set<string>();
  private readonly controlSessionId = randomUUID();
  private readonly retiring = new Set<string>();
  private childReady = false;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.limits = { ...defaults, ...options.deadlines };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error('invalid manager deadline');
    }
    if (!options.intent.sessionId || options.intent.sessionId !== options.checkpoint.sessionId
      || !Number.isSafeInteger(options.intent.generation) || options.intent.generation < 0) throw new Error('invalid managed session');
    // Restart does not resurrect saved reconnect intent or adopt a PID.
    this.intent = { ...options.intent, online: false };
    this.checkpoint = { ...options.checkpoint };
    this.activeId = options.activeReleaseId;
    this.latestRequestGeneration = options.intent.generation;
    this.now = options.now ?? Date.now;
    options.lease.assertHeld();
    options.children.onLoss((child, reason) => {
      if (this.child?.id !== child.id || this.retiring.has(child.id)) return;
      this.failure = reason;
      this.childReady = false;
      this.detail = `registered child lost readiness (${reason}); no automatic reconnect`;
      this.phase = 'blocked';
      // Root exit rejects pending IPC itself. Candidate startup failure may roll back once.
      if (reason !== 'startup_failed' || !this.running) this.transition?.abort(new ManagerFault(reason, this.detail));
    });
  }

  status(): ManagerStatus {
    return structuredClone({ phase: this.phase, intent: this.intent, controlSessionId: this.controlSessionId, deploymentGeneration: this.generation,
      activeReleaseId: this.activeId, stagedReleaseId: this.stagedId, child: this.child,
      failure: this.failure, detail: this.detail, notice: this.notice, downtimeMs: this.downtimeMs });
  }

  /** Shared server-control/local seam, with bounded freshness and no deployment input. */
  control(request: ManagerControlRequest): Promise<ManagerStatus> {
    const now = this.now();
    if (!request || !request.profile || !sameProfile(request.profile, this.options.profile) || request.sessionId !== this.intent.sessionId
      || request.controlSessionId !== this.controlSessionId
      || !Number.isSafeInteger(request.generation) || !Number.isFinite(request.issuedAtMs) || !Number.isFinite(request.expiresAtMs)
      || request.issuedAtMs > now || request.expiresAtMs <= now || request.expiresAtMs <= request.issuedAtMs
      || request.expiresAtMs - request.issuedAtMs > 30_000 || !['on', 'off', 'stop', 'resume'].includes(request.action)) {
      return Promise.resolve({ ...this.status(), failure: 'request_invalid', detail: 'control request scope, generation or freshness invalid' });
    }
    return request.action === 'on' ? this.on(request.generation, request.expiresAtMs) : this[request.action](request.generation);
  }

  /** Already authenticated local/bridge requests must supply a monotonic generation. */
  on(commandGeneration: number, expiresAtMs?: number): Promise<ManagerStatus> {
    // Repeated on is an acknowledgement, not a cancellation/reconnect request.
    if (this.intent.online && (this.child || this.running)) {
      if (Number.isSafeInteger(commandGeneration)) this.latestRequestGeneration = Math.max(this.latestRequestGeneration, commandGeneration);
      return Promise.resolve(this.status());
    }
    if (!this.admitIntent(commandGeneration, true, this.intent.paused)) return Promise.resolve(this.status());
    const saved = this.saveIntent();
    const start = async () => {
      await saved;
      if (this.running) await this.running;
      if (commandGeneration !== this.intent.generation || !this.intent.online || this.child) return this.status();
      if (this.tails.size || this.persistenceFailed || this.checkpointUnproven) return this.busy();
      return this.exclusive(async (fence, signal) => {
        this.current(fence, signal);
        const release = await this.validate(this.stagedId ?? this.activeId, signal);
        this.current(fence, signal);
        if (expiresAtMs !== undefined && this.now() >= expiresAtMs) throw new ManagerFault('request_invalid', 'explicit on expired before startup; no delayed join');
        await this.start(release, fence, signal, false, expiresAtMs);
        this.stagedId = null;
      });
    };
    return start().catch((error: unknown) => this.block(error));
  }

  stop(commandGeneration: number): Promise<ManagerStatus> {
    if (!this.admitIntent(commandGeneration, this.intent.online, true)) return Promise.resolve(this.status());
    return this.applyControl(false);
  }

  off(commandGeneration: number): Promise<ManagerStatus> {
    if (!this.admitIntent(commandGeneration, false, this.intent.paused)) return Promise.resolve(this.status());
    return this.applyControl(true);
  }

  /** Bare resume clears pause only; never joins or replays a saved action. */
  resume(commandGeneration: number): Promise<ManagerStatus> {
    if (!this.admitIntent(commandGeneration, this.intent.online, false)) return Promise.resolve(this.status());
    return this.applyControl(false);
  }

  promote(releaseId: string): Promise<ManagerStatus> {
    if (releaseId === this.activeId && !this.stagedId) return Promise.resolve(this.status());
    if (this.running || this.tails.size || this.persistenceFailed || this.checkpointUnproven) return Promise.resolve(this.busy());
    return this.exclusive(async (fence, signal) => {
      this.notice = 'none';
      this.downtimeMs = null;
      this.phase = 'validating';
      const release = await this.validate(releaseId, signal);
      this.current(fence, signal);
      this.stagedId = release.id;
      if (!this.intent.online || !this.child || !this.childReady) {
        this.phase = 'staged';
        this.detail = this.child ? 'accepted update staged; current child readiness/cleanup requires recovery' : 'accepted update staged; explicit on required';
        return;
      }
      const priorId = this.activeId;
      // Validate fallback before touching the current child, never trust a mutable path.
      await this.validate(priorId, signal);
      this.current(fence, signal);
      this.phase = 'draining';
      const disconnectedAt = await this.retire(this.child, fence, true);
      this.current(fence, signal);
      try {
        const ready = await this.start(release, fence, signal, true);
        this.stagedId = null;
        this.downtimeMs = Math.max(0, ready.spawnedAtMs - disconnectedAt);
        await this.sendNotice(fence, `Updated: ${release.summary}`);
      } catch (error) {
        if (this.child) await this.retire(this.child, fence, this.activated.has(this.child.id));
        this.current(fence, signal); // stop/off never trigger rollback/reconnect
        const fault = asFault(error, 'startup_failed');
        if (!rollbackEligible(fault.code)) throw fault;
        this.phase = 'rollback';
        const prior = await this.validate(priorId, signal);
        this.current(fence, signal);
        let ready: ReadinessEvidence;
        try {
          ready = await this.start(prior, fence, signal, true);
        } catch (rollbackError) {
          if (this.child) await this.retire(this.child, fence, this.activated.has(this.child.id));
          throw asFault(rollbackError, 'startup_failed');
        }
        this.phase = 'rollback';
        this.failure = fault.code;
        this.detail = `candidate failed (${fault.code}); previous release restored once`;
        this.downtimeMs = Math.max(0, ready.spawnedAtMs - disconnectedAt);
        await this.sendNotice(fence, 'Update failed; the previous release is back.');
      }
    });
  }

  private admitIntent(generation: number, online: boolean, paused: boolean): boolean {
    if (!Number.isSafeInteger(generation) || generation <= this.latestRequestGeneration) return false;
    this.latestRequestGeneration = generation;
    this.intent = { sessionId: this.intent.sessionId, generation, online, paused };
    this.transition?.abort(new ManagerFault('superseded', 'newer explicit intent won'));
    return true;
  }

  private saveIntent(): Promise<void> {
    const snapshot = { ...this.intent };
    const work = this.persistence.then(() => this.bounded(this.limits.intentMs, undefined,
      (signal) => this.options.checkpoints.persistIntent(snapshot, signal)));
    this.persistence = work.catch(() => { this.persistenceFailed = true; });
    return work.catch((error: unknown) => { throw asFault(error, 'intent_failed'); });
  }

  private async applyControl(disconnect: boolean): Promise<ManagerStatus> {
    const generation = this.intent.generation;
    try {
      await this.saveIntent();
      // Registered child transitions are bounded; late transport tails remain launch barriers.
      if (this.running) await this.running;
      if (generation !== this.intent.generation) return this.status();
      const child = this.child;
      if (disconnect && child) {
        await this.retire(child, this.fence(), this.activated.has(child.id));
      } else if (child) {
        await this.bounded(this.limits.drainMs, undefined,
          (signal) => this.options.children.pause(child, { ...this.intent }, signal));
      }
      if (generation !== this.intent.generation) return this.status();
      if (disconnect && !this.child && !this.tails.size) {
        this.phase = 'offline';
        this.detail = 'offline; registered child, descendants and socket proved gone';
      } else if (child) {
        this.detail = this.intent.paused ? 'gameplay paused' : 'pause cleared; no action replay';
      }
      return this.status();
    } catch (error) { return this.block(error); }
  }

  private exclusive(work: (fence: OperationFence, signal: AbortSignal) => Promise<void>): Promise<ManagerStatus> {
    this.options.lease.assertHeld();
    if (this.running || this.tails.size || this.persistenceFailed || this.checkpointUnproven) return Promise.resolve(this.busy());
    this.generation += 1;
    const fence = this.fence();
    const controller = new AbortController();
    this.transition = controller;
    this.failure = null;
    // Defer execution until the lock is installed, including synchronous launch exceptions.
    const running = Promise.resolve().then(() => work(fence, controller.signal)).then(() => this.status(), async (error: unknown) => {
      if (this.child && (this.phase === 'starting' || this.phase === 'verifying'
        || (this.child.fence.deploymentGeneration === fence.deploymentGeneration && !this.activated.has(this.child.id)))) {
        try { await this.retire(this.child, fence, this.activated.has(this.child.id)); }
        catch (cleanupError) { return this.block(cleanupError); }
      }
      const fault = asFault(error, 'startup_failed');
      this.failure = fault.code;
      this.detail = fault.message;
      this.phase = fault.code === 'superseded' ? 'deferred'
        : ['cleanup_unproven', 'checkpoint_failed', 'intent_failed', 'ownership_unproven'].includes(fault.code) ? 'blocked'
        : this.child ? 'deferred' : 'blocked';
      return this.status();
    }).finally(() => {
      if (this.running === running) this.running = null;
      if (this.transition === controller) this.transition = null;
    });
    this.running = running;
    return running;
  }

  private async validate(id: string, signal: AbortSignal): Promise<AcceptedRelease> {
    const release = await this.bounded(this.limits.validationMs, signal,
      (boundedSignal) => this.options.artifacts.validate(id, boundedSignal)).catch((error: unknown) => { throw asFault(error, 'artifact_invalid'); });
    if (release.id !== id || !/^[a-f0-9]{64}$/.test(release.digest)
      || !sameProfile(release.profile, this.options.profile)) throw new ManagerFault('artifact_invalid', 'accepted artifact identity/profile mismatch');
    if (release.checkpointSchema !== this.checkpoint.schema) throw new ManagerFault('incompatible', 'checkpoint/data compatibility not proven');
    return structuredClone(release);
  }

  private async retire(child: ChildRegistration, fence: OperationFence, capture: boolean): Promise<number> {
    this.retiring.add(child.id);
    this.childReady = false;
    try { return await this.retireOwned(child, fence, capture); }
    finally { this.retiring.delete(child.id); }
  }

  private async retireOwned(child: ChildRegistration, fence: OperationFence, capture: boolean): Promise<number> {
    let drain: DrainEvidence | undefined;
    let drainError: unknown;
    try {
      drain = await this.bounded(this.limits.drainMs, undefined,
        (signal) => this.options.children.drain(child, fence, signal));
      if (drain.childId !== child.id || !sameFence(drain.fence, fence)
        || !drain.admissionClosed || !drain.preparationsSettled || !drain.providersSettled
        || !drain.actuatorsReleased || !drain.interfacesSettled || !drain.socketClosed
        || !Number.isFinite(drain.socketClosedAtMs) || drain.socketClosedAtMs < 0 || drain.socketClosedAtMs > this.now()) {
        throw new ManagerFault('cleanup_unproven', 'owned work/interface/socket drain not proven');
      }
      if (capture) {
        const checkpoint = await this.bounded(this.limits.checkpointMs, undefined,
          (signal) => this.options.checkpoints.capture(child, drain!, signal));
        if (checkpoint.sessionId !== this.intent.sessionId || checkpoint.schema !== this.checkpoint.schema
          || checkpoint.id !== drain.checkpoint.id) throw new ManagerFault('checkpoint_failed', 'checkpoint/session changed at drain');
        this.checkpoint = structuredClone(checkpoint);
      }
    } catch (error) { drainError = error; if (capture) this.checkpointUnproven = true; }
    const terminated = await this.bounded(this.limits.cleanupMs, undefined,
      (signal) => this.options.children.terminate(child, signal));
    this.assertGone(child, terminated);
    const gone = await this.bounded(this.limits.cleanupMs, undefined,
      (signal) => this.options.children.proveGone(child, signal));
    this.assertGone(child, gone);
    if (this.child?.id === child.id) this.child = null;
    this.activated.delete(child.id);
    if (capture && drainError) throw asFault(drainError, 'checkpoint_failed');
    return drain?.socketClosedAtMs ?? this.now();
  }

  private assertGone(child: ChildRegistration, proof: GoneEvidence): void {
    if (proof.childId !== child.id || !proof.inspectionSucceeded || !proof.rootGone
      || !proof.descendantsGone || !proof.socketClosed) throw new ManagerFault('cleanup_unproven', 'process birth/descendant/socket closure unproven; no new child permitted');
  }

  private async start(release: AcceptedRelease, fence: OperationFence, signal: AbortSignal, commit: boolean, expiresAtMs?: number): Promise<ReadinessEvidence> {
    this.current(fence, signal);
    this.options.lease.assertHeld();
    if (this.child || this.tails.size || this.checkpointUnproven) throw new ManagerFault('ownership_unproven', 'registered child, unsettled work or unproven checkpoint remains');
    if (!this.intent.online) throw new ManagerFault('superseded', 'offline intent forbids startup');
    // Rehash immediately before launch, not only before draining the prior child.
    const fresh = await this.validate(release.id, signal);
    if (fresh.digest !== release.digest) throw new ManagerFault('artifact_invalid', 'artifact changed since acceptance');
    this.current(fence, signal);
    if (expiresAtMs !== undefined && this.now() >= expiresAtMs) throw new ManagerFault('request_invalid', 'explicit on expired before launch');
    this.phase = 'starting';
    const launchedAt = this.now();
    this.child = this.options.children.launch(fresh, this.checkpoint, { ...this.intent }, fence);
    const child = this.child;
    if (child.releaseId !== fresh.id || child.digest !== fresh.digest || !sameFence(child.fence, fence)
      || !Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.id) throw new ManagerFault('ownership_unproven', 'launcher returned an invalid registration');
    this.phase = 'verifying';
    const ready = await this.bounded(this.limits.readinessMs, signal,
      (boundedSignal) => this.options.children.readiness(child, fence, boundedSignal));
    this.current(fence, signal);
    this.assertReady(child, fresh, fence, ready, launchedAt);
    if (commit || this.activeId !== fresh.id) {
      await this.bounded(this.limits.commitMs, signal,
        (boundedSignal) => this.options.artifacts.commitActive(fresh, fence, boundedSignal)).catch((error: unknown) => { throw asFault(error, 'commit_failed'); });
      this.current(fence, signal);
      this.activeId = fresh.id;
    }
    this.activated.add(child.id); // a lost activation ACK can already have dispatched work
    await this.bounded(this.limits.commitMs, signal,
      (boundedSignal) => this.options.children.activate(child, { ...this.intent }, fence, boundedSignal));
    this.current(fence, signal);
    this.phase = 'ready';
    this.childReady = true;
    this.detail = this.intent.paused ? 'verified release ready; gameplay paused' : 'verified release ready';
    return ready;
  }

  private assertReady(child: ChildRegistration, release: AcceptedRelease, fence: OperationFence, r: ReadinessEvidence, launchedAt: number): void {
    if (!r || typeof r !== 'object' || !r.profile) throw new ManagerFault('readiness_failed', 'readiness envelope absent');
    if (!r.authReady) throw new ManagerFault('auth_required', 'child authentication is not ready; code rollback cannot repair authentication');
    if (r.profile.serverVersion !== this.options.profile.serverVersion || r.profile.protocol !== this.options.profile.protocol) {
      throw new ManagerFault('protocol_mismatch', 'child server/protocol differs from the accepted profile');
    }
    if (!sameProfile(r.profile, this.options.profile)) throw new ManagerFault('identity_conflict', 'child world/bot/owner profile differs from the accepted profile');
    const age = this.now() - r.observedAtMs;
    if (r.childId !== child.id || !sameFence(r.fence, fence) || r.releaseId !== release.id
      || r.digest !== release.digest
      || r.checkpointId !== this.checkpoint.id || !Number.isSafeInteger(r.connectionEpoch) || r.connectionEpoch < 1
      || !r.spawnValid || !Number.isFinite(r.spawnedAtMs) || r.spawnedAtMs < launchedAt || r.spawnedAtMs > r.observedAtMs
      || !r.dimension || !Number.isFinite(age) || age < 0 || age > this.limits.freshnessMs
      || !r.inventoryServerConfirmed || !r.observationServerConfirmed || !r.capabilitiesRegistered
      || !r.authReady || !r.providersReady || !r.admissionClosed || r.paused !== this.intent.paused) {
      throw new ManagerFault('readiness_failed', 'loaded version, profile, fresh spawn/inventory/readiness proof failed');
    }
  }

  private async sendNotice(fence: OperationFence, text: string): Promise<void> {
    this.current(fence, this.transition!.signal);
    const child = this.child;
    if (!child) return;
    try {
      this.notice = await this.bounded(this.limits.noticeMs, this.transition?.signal,
        (signal) => this.options.children.announce(child, fence, text.replace(/[\r\n]/g, ' ').slice(0, 240), signal));
    } catch { this.notice = 'unavailable'; }
  }

  private current(fence: OperationFence, signal: AbortSignal): void {
    this.options.lease.assertHeld();
    if (signal.aborted && signal.reason instanceof ManagerFault) throw signal.reason;
    if (signal.aborted || !sameFence(fence, this.fence())) throw new ManagerFault('superseded', 'newer explicit intent won; no reconnect or promotion');
    if (this.persistenceFailed) throw new ManagerFault('intent_failed', 'durable intent is unproven');
  }

  private fence(): OperationFence {
    return { sessionId: this.intent.sessionId, deploymentGeneration: this.generation, commandGeneration: this.intent.generation };
  }

  private busy(): ManagerStatus {
    return { ...this.status(), failure: 'busy', detail: 'one transition or unsettled operation already owns the slot' };
  }
  private block(error: unknown): ManagerStatus {
    const fault = asFault(error, 'intent_failed');
    this.phase = 'blocked'; this.failure = fault.code; this.detail = fault.message;
    return this.status();
  }

  /** Timeout is bounded to callers, but the real settlement tail fences launches. */
  private async bounded<T>(ms: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) abort();
    parent?.addEventListener('abort', abort, { once: true });
    const work = Promise.resolve().then(() => run(controller.signal));
    this.tails.add(work);
    work.then(() => this.tails.delete(work), () => this.tails.delete(work));
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(parent?.aborted && parent.reason instanceof ManagerFault ? parent.reason
        : new ManagerFault(parent?.aborted ? 'superseded' : 'timeout', 'bounded manager operation cancelled/timed out'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      timer = setTimeout(() => controller.abort(), ms);
      if (controller.signal.aborted) rejectAbort();
    });
    try { return await Promise.race([work, cancelled]); }
    finally {
      if (timer) clearTimeout(timer);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      parent?.removeEventListener('abort', abort);
    }
  }
}

function asFault(error: unknown, fallback: FailureCode): ManagerFault {
  return error instanceof ManagerFault ? error : new ManagerFault(fallback, `manager operation failed (${fallback})`);
}
function rollbackEligible(code: FailureCode): boolean {
  return code === 'startup_failed' || code === 'readiness_failed' || code === 'timeout';
}
