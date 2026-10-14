import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BridgeBindingSchema, BridgeIntentReceiptSchema, BridgeManagerStatusSchema, BridgeSampleSchema, REQUEST_TTL_TICKS, type BridgeBinding, type BridgeDisplay, type BridgeIntentRequest, type BridgeManagerPort, type BridgeManagerStatus, type BridgeSample, type BridgeTransport } from './types.ts';
import { wordsUuid } from './protocol.ts';

export interface BridgeOptions {
  binding: BridgeBinding;
  manager: BridgeManagerPort;
  transport: BridgeTransport;
  now?: () => number;
  monotonic?: () => number;
  sessionToken?: () => string;
  timeoutMs?: number;
  /** Time without a completed sample forces a new mailbox, discarding old flags. */
  maxGapMs?: number;
}
export interface BridgeHealth { state: 'stopped' | 'ready' | 'unavailable'; reason: 'none' | 'transport' | 'manager' | 'binding' | 'stale' | 'protocol'; display: BridgeDisplay; }

/** This service translates a mailbox into the shared manager. It owns no child,
 * auth, gameplay, budget, checkpoint, reconnect or deployment authority. */
export class VanillaControlBridge {
  readonly binding: BridgeBinding;
  private readonly opts: BridgeOptions;
  private readonly timeoutMs: number;
  private readonly maxGapMs: number;
  private session = '';
  private controller: AbortController | undefined;
  private inFlight: Promise<BridgeHealth> | undefined;
  private stopping: Promise<void> | undefined;
  private lastSampleAt: number | undefined;
  private lastClock = 0;
  private consumed = 0;
  private managerInstance = '';
  private expectedIntentGeneration = 0;
  private health: BridgeHealth = { state: 'stopped', reason: 'none', display: 'unavailable' };

  constructor(opts: BridgeOptions) {
    this.binding = BridgeBindingSchema.parse(opts.binding);
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.maxGapMs = opts.maxGapMs ?? 2500;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 1000 || !Number.isInteger(this.maxGapMs) || this.maxGapMs < 2 * this.timeoutMs || this.maxGapMs > 2500) throw new Error('invalid bridge deadlines');
  }
  status(): BridgeHealth { return { ...this.health }; }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private mono(): number { return (this.opts.monotonic ?? (() => performance.now()))(); }

  private async bounded<T>(fn: (signal: AbortSignal) => Promise<T>, parent = this.controller?.signal): Promise<T> {
    const timeout = new AbortController();
    const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
    let timer: NodeJS.Timeout | undefined;
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { signal.throwIfAborted(); return fn(signal); }),
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(new Error('bridge operation cancelled'));
          signal.addEventListener('abort', listener, { once: true });
          timer = setTimeout(() => timeout.abort(), this.timeoutMs);
          if (signal.aborted) listener();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) signal.removeEventListener('abort', listener);
    }
  }
  private match(sample: BridgeSample): void {
    const b = this.binding;
    if (sample.installation !== b.installation || sample.world !== b.world || sample.bot !== b.bot || sample.version !== b.version || wordsUuid(sample.owner) !== b.ownerUuid) throw new Error('binding');
  }
  private async managerStatus(): Promise<BridgeManagerStatus> {
    try {
      const status = BridgeManagerStatusSchema.parse(await this.bounded((s) => this.opts.manager.readStatus(s)));
      if (status.world !== this.binding.world || status.bot !== this.binding.bot || status.observedAtMs > this.now() || this.now() - status.observedAtMs > this.maxGapMs) throw new Error('manager');
      if (this.managerInstance && (status.managerInstance !== this.managerInstance || status.intentGeneration < this.expectedIntentGeneration)) throw new Error('manager');
      return status;
    } catch { throw new Error('manager'); }
  }
  private display(status: BridgeManagerStatus): BridgeDisplay {
    if (status.observedAtMs > this.now() || this.now() - status.observedAtMs > this.maxGapMs) return 'unavailable';
    if (status.state === 'online') return status.desired === 'on' && status.child === 'owned' && status.connection === 'spawn_verified' && status.connectionEpoch !== null && status.botUuid === this.binding.botUuid ? 'online' : 'unavailable';
    if (status.state === 'offline') return status.desired === 'off' && status.child === 'absent' && status.connection === 'absent' ? 'offline' : 'unavailable';
    if (status.state === 'joining') return status.desired === 'on' && status.child === 'owned' && status.connection === 'joining' ? 'joining' : 'unavailable';
    return status.state;
  }

  /** Explicit service start; installation must already exist. Discards persisted
   * requests before heartbeat enables owner on/off, including after a restart. */
  start(): Promise<BridgeHealth> {
    if (this.stopping) return Promise.resolve(this.status());
    if (this.controller) return this.inFlight ?? Promise.resolve(this.status());
    this.controller = new AbortController();
    const work = this.startOnce();
    this.inFlight = work;
    void work.finally(() => { if (this.inFlight === work) this.inFlight = undefined; });
    return work;
  }
  private async startOnce(): Promise<BridgeHealth> {
    try {
      const before = BridgeSampleSchema.parse(await this.bounded((s) => this.opts.transport.sample(s)));
      this.match(before);
      if (before.session !== 'closed' && before.heartbeat > 0) throw new Error('binding'); // active bridge is never adopted
      const manager = await this.managerStatus();
      this.managerInstance = manager.managerInstance;
      this.expectedIntentGeneration = manager.intentGeneration;
      const session = (this.opts.sessionToken ?? (() => randomBytes(16).toString('hex')))();
      if (!/^[a-f0-9]{32}$/.test(session)) throw new Error('protocol');
      this.session = session;
      await this.bounded((s) => this.opts.transport.open(this.binding, session, s));
      const sample = BridgeSampleSchema.parse(await this.bounded((s) => this.opts.transport.sample(s)));
      this.match(sample);
      if (sample.session !== session || sample.generation !== 0 || sample.acknowledged !== 0 || sample.request.action !== 0) throw new Error('protocol');
      this.lastClock = sample.clock;
      this.lastSampleAt = this.mono();
      this.consumed = 0;
      const display = this.display(manager);
      if (display === 'unavailable') throw new Error('manager');
      await this.bounded((s) => this.opts.transport.heartbeat(session, display, manager.blocker, manager.intentGeneration, s));
      this.health = { state: 'ready', reason: 'none', display };
    } catch (error) { this.fail(error); }
    return this.status();
  }

  /** At most one poll. Receipt waits are admission-only and deadline bounded,
   * so an off is never held behind an entire join or provider turn. */
  poll(): Promise<BridgeHealth> {
    if (this.inFlight) return this.inFlight;
    const work = this.pollOnce();
    this.inFlight = work;
    void work.finally(() => { if (this.inFlight === work) this.inFlight = undefined; });
    return work;
  }
  private async pollOnce(): Promise<BridgeHealth> {
    if (!this.controller || this.controller.signal.aborted || this.health.state !== 'ready') return this.status();
    try {
      if (this.lastSampleAt === undefined || this.mono() - this.lastSampleAt > this.maxGapMs) throw new Error('stale');
      let sample = BridgeSampleSchema.parse(await this.bounded((s) => this.opts.transport.sample(s)));
      this.match(sample);
      if (sample.session !== this.session || sample.heartbeat <= 0 || sample.clock < this.lastClock || sample.acknowledged > sample.generation || sample.generation < this.consumed) throw new Error('stale');
      // Catch wake/transport gaps during the await as well as before it.
      if (this.mono() - this.lastSampleAt > this.maxGapMs) throw new Error('stale');
      let manager = await this.managerStatus();
      // Manager I/O can yield while the owner leaves or off supersedes on.
      // Re-read the current mailbox rather than dispatching the frozen old flag.
      sample = BridgeSampleSchema.parse(await this.bounded((s) => this.opts.transport.sample(s)));
      this.match(sample);
      if (sample.session !== this.session || sample.heartbeat <= 0 || sample.clock < this.lastClock || sample.acknowledged > sample.generation || sample.generation < this.consumed || this.mono() - this.lastSampleAt > this.maxGapMs) throw new Error('stale');
      this.lastSampleAt = this.mono(); this.lastClock = sample.clock;
      const r = sample.request;
      if (r.action !== 0 && r.generation > this.consumed) {
        if (r.generation !== sample.generation || r.generation <= sample.acknowledged || r.tick > sample.clock || sample.clock - r.tick >= REQUEST_TTL_TICKS || sample.ownerPresent !== 1 || r.ownerSession < 1 || r.ownerSession !== sample.ownerSession || r.managerGeneration > manager.intentGeneration || wordsUuid(r.owner) !== this.binding.ownerUuid) throw new Error('stale');
        // A local logout/update intent after our previous pulse fences a queued on.
        // Off is still sent to that SAME current authority and never starts a run.
        const staleOn = r.action === 1 && (r.managerGeneration !== manager.intentGeneration || manager.intentGeneration !== this.expectedIntentGeneration || manager.state === 'logging_out' || manager.child === 'unknown' || manager.connection === 'unknown');
        this.consumed = r.generation; // before dispatch: ambiguous failure is never replayed
        if (staleOn) {
          await this.bounded((s) => this.opts.transport.acknowledge(this.session, r.generation, 'rejected', s));
        } else {
          const request: BridgeIntentRequest = {
            source: 'vanilla-trigger', action: r.action === 1 ? 'on' : 'off', binding: this.binding,
            bridgeSession: this.session, generation: r.generation, ownerSession: r.ownerSession,
            expiresAtMs: this.now() + Math.min(this.timeoutMs, (REQUEST_TTL_TICKS - (sample.clock - r.tick)) * 50),
            expectedManagerInstance: manager.managerInstance, expectedIntentGeneration: manager.intentGeneration,
          };
          let receipt;
          try { receipt = BridgeIntentReceiptSchema.parse(await this.bounded((s) => this.opts.manager.submitIntent(request, s))); }
          catch { throw new Error('manager'); }
          if (receipt.bridgeSession !== this.session || receipt.generation !== r.generation || receipt.managerInstance !== this.managerInstance || receipt.intentGeneration < manager.intentGeneration || (receipt.disposition === 'rejected' ? receipt.reason === 'none' : receipt.reason !== 'none')) throw new Error('manager');
          this.expectedIntentGeneration = receipt.intentGeneration;
          await this.bounded((s) => this.opts.transport.acknowledge(this.session, r.generation, receipt.disposition, s));
          manager = await this.managerStatus();
        }
      }
      // Even a status-only cycle re-reads manager evidence. A dead manager cannot
      // extend the last online heartbeat indefinitely.
      this.expectedIntentGeneration = manager.intentGeneration;
      const display = this.display(manager);
      if (display === 'unavailable') throw new Error('manager');
      if (this.mono() - (this.lastSampleAt ?? 0) > this.maxGapMs) throw new Error('stale');
      await this.bounded((s) => this.opts.transport.heartbeat(this.session, display, manager.blocker, manager.intentGeneration, s));
      this.health = { state: 'ready', reason: 'none', display };
    } catch (error) { this.fail(error); }
    return this.status();
  }
  private fail(error: unknown): void {
    if (this.health.state === 'stopped' && this.controller?.signal.aborted) return;
    const message = error instanceof Error ? error.message : '';
    const reason = message === 'binding' || message === 'stale' || message === 'protocol' || message === 'manager' ? message : 'transport';
    this.health = { state: 'unavailable', reason, display: 'unavailable' };
    // No retry/rejoin. Datapack heartbeat expires independently, including on kill.
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const work = this.stopOnce();
    this.stopping = work;
    void work.finally(() => { if (this.stopping === work) this.stopping = undefined; });
    return work;
  }
  private async stopOnce(): Promise<void> {
    this.controller?.abort();
    this.health = { state: 'stopped', reason: 'none', display: 'unavailable' };
    await this.inFlight;
    if (this.session) {
      try { await this.bounded((s) => this.opts.transport.close(this.session, s), new AbortController().signal); } catch { /* heartbeat expiry remains the independent fallback */ }
    }
    this.controller = undefined; this.session = ''; this.managerInstance = ''; this.lastSampleAt = undefined;
  }
}
