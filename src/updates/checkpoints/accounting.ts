import type { SpendReservation, SpendSnapshot } from '../../decision/spend.ts';
import type { CheckpointDecisionOwner, CheckpointSpendPort, RestoreCheckpointSpend } from './ports.ts';
import { canonical, SpendCheckpointSchema } from './schema.ts';
import { CheckpointHeldError, ManagedCheckpointStore } from './store.ts';

/**
 * Durability adapter around the existing SpendLedger, not a replacement ledger.
 * Integration restores that ledger from the recovered snapshot. Its reservations
 * are returned only AFTER the manager's journal is fsynced. Old child callbacks
 * cannot settle, release or dispatch a newer child's reservation.
 */
export class CheckpointAccounting implements CheckpointSpendPort {
  private readonly store: ManagedCheckpointStore;
  private readonly ledger: CheckpointSpendPort;
  private readonly checkChild: () => void;
  private readonly issued = new Map<number, SpendReservation>();
  private readonly reservationGenerations = new Map<number, number>();

  constructor(store: ManagedCheckpointStore, restore: RestoreCheckpointSpend) {
    this.store = store;
    const checkpoint = store.snapshot();
    if (!checkpoint) throw new CheckpointHeldError('accounting_checkpoint_missing');
    this.ledger = restore(structuredClone(checkpoint.spend));
    if (canonical(SpendCheckpointSchema.parse(this.ledger.snapshot())) !== canonical(checkpoint.spend)) throw new CheckpointHeldError('restored_accounting_mismatch');
    this.checkChild = store.bindChild({ fenceGeneration: false });
  }

  private current(): void {
    this.checkChild();
    const s = this.store.snapshot()!;
    if (canonical(s.spend) !== canonical(this.ledger.snapshot())) throw new CheckpointHeldError('accounting_changed_outside_adapter');
  }
  private record(owner?: CheckpointDecisionOwner): void { this.store.checkpointSpend(this.ledger.snapshot(), undefined, owner); }

  reserve(amountUsd: number, label: string, owner?: CheckpointDecisionOwner): SpendReservation | undefined {
    this.current();
    const s = this.store.snapshot()!;
    if (!s.control.onlineIntent || s.providerDisabled.decision) throw new CheckpointHeldError('provider_dispatch_not_authorized');
    if (s.goal && s.directiveGeneration === s.generation && !owner) throw new CheckpointHeldError('goal_decision_context_required');
    if (owner) this.store.checkDecisionOwner(owner);
    const reservation = this.ledger.reserve(amountUsd, label);
    // Even a refused attempt count is durable. Labels/keys never enter the file.
    // Jev increments its per-goal attempts only after a funded reservation.
    // Both debits commit together, so a crash cannot refill that attempt.
    this.record(reservation ? owner : undefined);
    if (reservation) {
      this.issued.set(reservation.id, Object.freeze({ ...reservation }));
      this.reservationGenerations.set(reservation.id, s.generation);
      return { ...reservation };
    }
    return undefined;
  }

  private owned(reservation: SpendReservation): SpendReservation {
    this.current();
    const actual = this.issued.get(reservation.id);
    if (!actual || canonical(actual) !== canonical(reservation)) throw new CheckpointHeldError('unknown_or_forged_reservation');
    return actual;
  }

  /** Invoke immediately before HTTP dispatch; no await may split this fence. */
  beforeDispatch(reservation: SpendReservation): void {
    this.owned(reservation);
    const s = this.store.snapshot()!;
    if (this.reservationGenerations.get(reservation.id) !== s.generation) throw new CheckpointHeldError('replaced_or_revoked_reservation');
    if (!s.control.onlineIntent || s.providerDisabled.decision) throw new CheckpointHeldError('provider_dispatch_not_authorized');
  }

  reconcile(reservation: SpendReservation, costUsd: number): void {
    const actual = this.owned(reservation);
    if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > actual.amountUsd + 1e-12) {
      this.ledger.retain(actual);
      this.store.checkpointSpend(this.ledger.snapshot(), 'untrustworthy_reported_cost');
      this.issued.delete(actual.id);
      this.reservationGenerations.delete(actual.id);
      throw new CheckpointHeldError('untrustworthy_reported_cost');
    }
    this.ledger.reconcile(actual, costUsd);
    this.record();
    this.issued.delete(actual.id);
    this.reservationGenerations.delete(actual.id);
  }

  retain(reservation: SpendReservation): void {
    const actual = this.owned(reservation);
    this.ledger.retain(actual);
    this.record();
    this.issued.delete(actual.id);
    this.reservationGenerations.delete(actual.id);
  }

  /** Caller must have an explicit provider rejection proving no inference. */
  release(reservation: SpendReservation): void {
    const actual = this.owned(reservation);
    if (this.reservationGenerations.get(actual.id) !== this.store.snapshot()!.generation) throw new CheckpointHeldError('replaced_or_revoked_reservation');
    this.ledger.release(actual);
    this.record();
    this.issued.delete(actual.id);
    this.reservationGenerations.delete(actual.id);
  }

  snapshot(): SpendSnapshot { this.current(); return structuredClone(this.ledger.snapshot()); }
  get capUsd(): number { return this.snapshot().capUsd; }
  remainingUsd(): number { return this.snapshot().remainingUsd; }
}
