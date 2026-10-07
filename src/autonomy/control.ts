// AutonomyControl: the scoped, durable control state behind the supervisor
// (MB-FLOW-001 P2). It owns the ControlFileStore for ONE explicit scope and
// exposes the pause latch and the home construction project.
//
// Fail-closed rules:
// - No scope (neither autonomy.scope nor a memory scope): `missing_scope`.
// - Another writer, a newer schema or every revision unreadable: `read_only`.
// - A recovered load (newer revision unreadable): the latch is forced paused
//   (`store_recovery`) because the lost revision may have held a stop.
// - A different endpoint than the one first bound: `conflict`, unless the
//   operator sets rebindEndpoint once.
// - A failed write: `write_failed` until a later write succeeds.
// Any of these blocks AUTOMATIC work only (the supervisor reports it); owner
// goals never depend on this state.
import type { Clock, EvidenceEvent } from '../contracts/index.ts';
import type { AutonomyBody, AutonomyScope, DurableLatch, HomeProject, PersistenceState } from '../contracts/autonomy.ts';
import { ControlFileStore, autonomyScopeDirectory, type ControlLoad } from './store.ts';

export interface AutonomyControlOptions {
  scope: AutonomyScope | undefined;
  /** `<dataDir>/<autonomy.dir>`. */
  rootDir: string;
  /** host:port (connection metadata, never identity proof). */
  endpoint: string;
  rebindEndpoint: boolean;
  clock: Clock;
  record?: (event: EvidenceEvent) => void;
  /** Store test seams. */
  store?: Partial<Pick<ConstructorParameters<typeof ControlFileStore>[0], 'pid' | 'isAlive' | 'beforeRename'>>;
}

export type LatchDurability = 'loaded' | 'written' | 'pending' | 'failed' | 'none';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class AutonomyControl {
  readonly scope: AutonomyScope | undefined;
  private readonly options: AutonomyControlOptions;
  private store: ControlFileStore | undefined;
  private load: ControlLoad | undefined;
  private body: AutonomyBody | undefined;
  private conflict: string | undefined;
  private writeFailed: string | undefined;
  private durability: LatchDurability = 'none';
  private closed = false;
  /** Persist operations whose durability bookkeeping has not settled yet. */
  private readonly inflight = new Set<Promise<boolean>>();

  constructor(options: AutonomyControlOptions) {
    this.options = options;
    this.scope = options.scope;
  }

  /** Synchronous startup load (one writer per scope). Safe to call once. */
  open(): void {
    if (!this.scope || this.store) return;
    const now = this.options.clock.now();
    this.store = new ControlFileStore({ dir: autonomyScopeDirectory(this.options.rootDir, this.scope), scope: this.scope, clock: this.options.clock, ...(this.options.store ?? {}) });
    try {
      this.load = this.store.open();
    } catch (error) {
      this.load = { body: undefined, state: 'read_only', detail: `autonomy store could not be opened: ${error instanceof Error ? error.message : String(error)}`, revision: 0, corruptRevisions: [], writable: false };
    }
    if (this.load.body) {
      this.body = structuredClone(this.load.body);
      this.durability = 'loaded';
      if (this.load.state === 'recovered' && !this.body.latch.paused) {
        this.body.latch = { paused: true, sinceMs: now, source: 'store_recovery' };
        this.durability = 'pending';
        void this.persist('recovered_fail_closed');
      }
    } else if (this.load.state === 'empty') {
      this.body = { scope: this.scope, latch: { paused: false }, createdAtMs: now, updatedAtMs: now };
    }
    this.options.record?.({ type: 'autonomy_control_opened', state: this.load.state, detail: this.load.detail, revision: this.load.revision, paused: this.body?.latch.paused ?? null, home: this.body?.home ? this.body.home.state : null });
  }

  /** Persistence state that gates automatic work. */
  persistence(): { state: PersistenceState; detail: string; revision: number; lastWriteAtMs?: number } {
    const revision = this.store?.revision ?? 0;
    const at = this.store?.lastWriteAtMs !== undefined ? { lastWriteAtMs: this.store.lastWriteAtMs } : {};
    if (!this.scope) return { state: 'missing_scope', detail: 'no durable scope: configure memory (worldProfile, worldRevision, botProfile) or autonomy.scope; automatic work stays off, manual goals work', revision, ...at };
    if (!this.load) return { state: 'read_only', detail: 'autonomy state not opened', revision, ...at };
    if (this.conflict) return { state: 'conflict', detail: this.conflict, revision, ...at };
    if (!this.body || !this.store?.canWrite || this.closed) return { state: 'read_only', detail: this.closed ? 'closed' : this.load.detail, revision, ...at };
    if (this.writeFailed) return { state: 'write_failed', detail: `last durable write failed (${this.writeFailed}); automatic work waits until a write succeeds`, revision, ...at };
    return { state: 'ready', detail: this.load.state === 'recovered' ? this.load.detail : `${this.load.detail}${revision !== this.load.revision ? `; now at revision ${revision}` : ''}`, revision, ...at };
  }

  /** Automatic work may rely on durable state. */
  usable(): boolean {
    return this.persistence().state === 'ready';
  }

  latch(): DurableLatch {
    return this.body ? { ...this.body.latch } : { paused: false };
  }

  latchDurability(): LatchDurability {
    return this.durability;
  }

  home(): HomeProject | undefined {
    return this.body?.home ? structuredClone(this.body.home) : undefined;
  }

  /** First ready connection binds the endpoint; another endpoint is a scope conflict (unless rebound by config). */
  onConnectionReady(): void {
    if (!this.body || !this.store?.canWrite) return;
    const endpoint = this.options.endpoint;
    const bound = this.body.endpoint;
    if (!bound || bound === endpoint) {
      this.conflict = undefined;
      if (!bound) {
        this.body.endpoint = endpoint;
        void this.persist('endpoint_bound');
      }
      return;
    }
    if (this.options.rebindEndpoint) {
      this.options.record?.({ type: 'autonomy_endpoint_rebound', from: bound, to: endpoint });
      this.body.endpoint = endpoint;
      this.conflict = undefined;
      void this.persist('endpoint_rebound');
      return;
    }
    this.conflict = `scope conflict: autonomy scope ${this.scope?.worldProfile}@r${this.scope?.worldRevision}/${this.scope?.botProfile} is bound to ${bound}, but this connection is ${endpoint}; automatic work is off (use a new world profile/revision, or autonomy.rebindEndpoint once if it is the same world)`;
    this.options.record?.({ type: 'autonomy_scope_conflict', bound, endpoint });
  }

  /**
   * Updates the latch in memory synchronously (the caller already applied it
   * to the engine) and persists it. Resolves true when durable.
   */
  setLatch(latch: DurableLatch): Promise<boolean> {
    if (!this.body) {
      this.durability = 'failed';
      return Promise.resolve(false);
    }
    this.body.latch = { ...latch };
    this.durability = 'pending';
    return this.persist(latch.paused ? 'paused' : 'resumed');
  }

  /** Replaces the home project (or clears it) and persists. */
  setHome(home: HomeProject | undefined, reason: string): Promise<boolean> {
    if (!this.body) return Promise.resolve(false);
    if (home) this.body.home = structuredClone(home);
    else delete this.body.home;
    return this.persist(reason);
  }

  private persist(reason: string): Promise<boolean> {
    const store = this.store;
    const body = this.body;
    if (!store || !body || !store.canWrite || this.closed) {
      this.durability = this.durability === 'pending' ? 'failed' : this.durability;
      return Promise.resolve(false);
    }
    body.updatedAtMs = this.options.clock.now();
    const snapshot = structuredClone(body);
    const op = store.write(snapshot).then(
      (revision) => {
        this.writeFailed = undefined;
        if (this.body && this.body.latch.paused === snapshot.latch.paused) this.durability = 'written';
        this.options.record?.({ type: 'autonomy_control_written', reason, revision, paused: snapshot.latch.paused, home: snapshot.home?.state ?? null });
        return true;
      },
      (error: unknown) => {
        this.writeFailed = clip(error instanceof Error ? error.message : String(error), 200);
        this.durability = 'failed';
        this.options.record?.({ type: 'autonomy_control_write_failed', reason, error: this.writeFailed });
        return false;
      },
    );
    this.inflight.add(op);
    void op.finally(() => this.inflight.delete(op));
    return op;
  }

  /** Waits for every queued write AND its durability bookkeeping. */
  async flush(): Promise<void> {
    await this.store?.flush();
    await Promise.all([...this.inflight]);
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.closed = true;
  }
}
