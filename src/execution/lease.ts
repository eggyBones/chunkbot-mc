// One actuator lease owns ALL game control (movement, look, dig, clicks,
// interfaces, item use, attacks) at a time.
//
// Revocation order (stop, replacement, lifecycle end, completion):
//   1. invalidate: the lease is marked revoked FIRST, so every later fence()
//      throws and no continuation of the old action can issue a command;
//   2. abort the lease signal (wakes pending waits);
//   3. run the lease's own synchronous cleanups (close owned interfaces);
//   4. clear shared controls (path goal, movement keys, dig, item use) — only
//      if this lease is still the current one, so an old cleanup can never
//      clear a replacement lease.
// Revocation is synchronous; its timing is reported as control-clear evidence.
import type { Clock, ExecutionOwner } from '../contracts/index.ts';

export class LeaseRevokedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`actuator lease revoked (${reason})`);
    this.name = 'LeaseRevokedError';
    this.reason = reason;
  }
}

export class LeaseBusyError extends Error {
  readonly holder: ExecutionOwner;
  constructor(holder: ExecutionOwner) {
    super(`actuator lease is held by ${holder.kind === 'goal' ? `goal epoch ${holder.goalEpoch}` : `diagnostic ${holder.diagnosticId}`}`);
    this.name = 'LeaseBusyError';
    this.holder = holder;
  }
}

export interface ControlClearReport {
  leaseId: number;
  reason: string;
  /** Milliseconds from revoke() entry until shared controls were cleared. */
  clearMs: number;
  steps: string[];
  errors: string[];
  clearedShared: boolean;
}

export interface LeaseHooks {
  clock: Clock;
  /** Whether the owner still holds authority (e.g. goal epoch unchanged). Checked by fence(). */
  ownerCurrent(owner: ExecutionOwner): boolean;
  /** Current connection epoch; a lease never survives a connection change. */
  connectionEpoch(): number;
  /** Synchronously stops shared actuation on the live bot; returns step names. */
  clearShared(reason: string): { steps: string[]; errors: string[] };
  /** Evidence sink (bounded, redacted elsewhere). */
  record?(event: Record<string, unknown>): void;
}

export class Lease {
  readonly id: number;
  readonly owner: ExecutionOwner;
  readonly connectionEpoch: number;
  readonly acquiredAtMs: number;
  private readonly controller = new AbortController();
  private revokedReason: string | undefined;
  private readonly cleanups: Array<{ name: string; fn: () => void }> = [];
  private readonly hooks: LeaseHooks;

  constructor(id: number, owner: ExecutionOwner, connectionEpoch: number, hooks: LeaseHooks) {
    this.id = id;
    this.owner = owner;
    this.connectionEpoch = connectionEpoch;
    this.hooks = hooks;
    this.acquiredAtMs = hooks.clock.now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get revocation(): string | undefined {
    return this.revokedReason;
  }

  /** True while this lease may still issue commands. */
  get active(): boolean {
    return this.revokedReason === undefined && this.hooks.connectionEpoch() === this.connectionEpoch && this.hooks.ownerCurrent(this.owner);
  }

  /** Throws unless this lease may still act. Call before EVERY command and after every await. */
  fence(): void {
    if (this.revokedReason !== undefined) throw new LeaseRevokedError(this.revokedReason);
    if (this.hooks.connectionEpoch() !== this.connectionEpoch) throw new LeaseRevokedError('connection_changed');
    if (!this.hooks.ownerCurrent(this.owner)) throw new LeaseRevokedError('owner_revoked');
  }

  /** Registers a synchronous cleanup (e.g. close an owned window) run at revocation. Ignored once revoked. */
  onRevoke(name: string, fn: () => void): () => void {
    if (this.revokedReason !== undefined) return () => undefined;
    const entry = { name, fn };
    this.cleanups.push(entry);
    return () => {
      const i = this.cleanups.indexOf(entry);
      if (i >= 0) this.cleanups.splice(i, 1);
    };
  }

  /** @internal Called only by ActuatorLeases. */
  markRevoked(reason: string): Array<{ name: string; fn: () => void }> {
    this.revokedReason ??= reason;
    this.controller.abort(new LeaseRevokedError(reason));
    return this.cleanups.splice(0).reverse();
  }
}

export class ActuatorLeases {
  private currentLease: Lease | undefined;
  private nextId = 1;
  private readonly hooks: LeaseHooks;
  private lastReport: ControlClearReport | undefined;

  constructor(hooks: LeaseHooks) {
    this.hooks = hooks;
  }

  get current(): Lease | undefined {
    return this.currentLease?.revocation === undefined ? this.currentLease : undefined;
  }

  get lastClear(): ControlClearReport | undefined {
    return this.lastReport;
  }

  /** Acquires the single lease. Throws LeaseBusyError while another active lease exists. */
  acquire(owner: ExecutionOwner): Lease {
    const held = this.currentLease;
    if (held && held.revocation === undefined) {
      if (held.active) throw new LeaseBusyError(held.owner);
      // The holder lost authority (epoch/connection changed) without revoking yet: revoke it now.
      this.revoke(held, 'stale_owner');
    }
    const lease = new Lease(this.nextId++, owner, this.hooks.connectionEpoch(), this.hooks);
    this.currentLease = lease;
    this.hooks.record?.({ type: 'lease_acquired', leaseId: lease.id, owner: owner.kind === 'goal' ? `goal:${owner.goalEpoch}` : `diag:${owner.diagnosticId}` });
    return lease;
  }

  /**
   * Revokes `lease` (idempotent). Invalidates first, then aborts, closes owned
   * interfaces, and clears shared controls only if it is still the current lease.
   */
  revoke(lease: Lease, reason: string): ControlClearReport | undefined {
    if (lease.revocation !== undefined) return undefined;
    const started = this.hooks.clock.now();
    const cleanups = lease.markRevoked(reason); // 1+2: invalidate, abort
    const steps: string[] = [];
    const errors: string[] = [];
    for (const c of cleanups) {
      // 3: lease-scoped cleanups (e.g. close an owned window)
      try {
        c.fn();
        steps.push(c.name);
      } catch (error) {
        errors.push(`${c.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let clearedShared = false;
    if (this.currentLease === lease) {
      // 4: shared controls, only for the current lease
      const r = this.hooks.clearShared(reason);
      steps.push(...r.steps);
      errors.push(...r.errors);
      clearedShared = true;
      this.currentLease = undefined;
    }
    const report: ControlClearReport = { leaseId: lease.id, reason, clearMs: this.hooks.clock.now() - started, steps, errors, clearedShared };
    this.lastReport = report;
    this.hooks.record?.({ type: 'lease_revoked', ...report });
    return report;
  }

  /** Revokes whatever lease is current. */
  revokeCurrent(reason: string): ControlClearReport | undefined {
    return this.currentLease ? this.revoke(this.currentLease, reason) : undefined;
  }
}
