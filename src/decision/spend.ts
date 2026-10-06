// Per-APPLICATION-RUN OpenRouter spend accounting (not per goal). Before each
// attempt a conservative maximum is reserved; the call is refused if the cap
// could be exceeded. Afterwards the reservation is either reconciled with a
// trustworthy reported cost, released when the provider certainly did not run
// (an explicit routing/validation rejection), or RETAINED in full when the
// charge is ambiguous (timeout, abort after dispatch, network error, 5xx,
// unparseable or untrustworthy response). Credits are never purchased.

export interface SpendReservation {
  readonly id: number;
  readonly amountUsd: number;
  readonly label: string;
}

export interface SpendSnapshot {
  capUsd: number;
  /** Reported costs reconciled from valid responses. */
  reconciledUsd: number;
  /** Reservations kept because the charge is ambiguous. */
  retainedUsd: number;
  /** Reservations for attempts still in flight. */
  outstandingUsd: number;
  /** cap - reconciled - retained - outstanding. */
  remainingUsd: number;
  attempts: number;
  reconciled: number;
  retained: number;
  released: number;
  refused: number;
}

export class SpendLedger {
  readonly capUsd: number;
  private reconciledUsd = 0;
  private retainedUsd = 0;
  private readonly outstanding = new Map<number, SpendReservation>();
  private nextId = 1;
  private counts = { attempts: 0, reconciled: 0, retained: 0, released: 0, refused: 0 };

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error('spend cap must be a finite non-negative number');
    this.capUsd = capUsd;
  }

  private outstandingUsd(): number {
    let n = 0;
    for (const r of this.outstanding.values()) n += r.amountUsd;
    return n;
  }

  remainingUsd(): number {
    return this.capUsd - this.reconciledUsd - this.retainedUsd - this.outstandingUsd();
  }

  /** Reserves `amountUsd` or returns undefined when the cap cannot be guaranteed. */
  reserve(amountUsd: number, label: string): SpendReservation | undefined {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      this.counts.refused += 1;
      return undefined;
    }
    if (amountUsd > this.remainingUsd() + 1e-12) {
      this.counts.refused += 1;
      return undefined;
    }
    const r: SpendReservation = { id: this.nextId++, amountUsd, label };
    this.outstanding.set(r.id, r);
    this.counts.attempts += 1;
    return r;
  }

  /** A valid response reported its cost: replace the reservation with it. */
  reconcile(r: SpendReservation, costUsd: number): void {
    if (!this.outstanding.delete(r.id)) return;
    this.reconciledUsd += costUsd;
    this.counts.reconciled += 1;
  }

  /** Charge ambiguous: keep the full reservation as spent. */
  retain(r: SpendReservation): void {
    if (!this.outstanding.delete(r.id)) return;
    this.retainedUsd += r.amountUsd;
    this.counts.retained += 1;
  }

  /** Provider certainly did not run inference (explicit 4xx routing/validation rejection). */
  release(r: SpendReservation): void {
    if (!this.outstanding.delete(r.id)) return;
    this.counts.released += 1;
  }

  snapshot(): SpendSnapshot {
    const outstandingUsd = this.outstandingUsd();
    return {
      capUsd: this.capUsd,
      reconciledUsd: this.reconciledUsd,
      retainedUsd: this.retainedUsd,
      outstandingUsd,
      remainingUsd: this.capUsd - this.reconciledUsd - this.retainedUsd - outstandingUsd,
      ...this.counts,
    };
  }
}
