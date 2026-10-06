// Ownership of interfaces (windows) opened by our own use packets.
//
// The vanilla server sends `open_window` without any request id, so a late
// reply cannot be told apart from the next request's reply by itself. Two
// facts make attribution sound:
//   1. every block-use packet carries a client sequence that the server
//      acknowledges (`acknowledge_player_digging`) AFTER processing it, and an
//      interface opened by that use is sent before the acknowledgement; entity
//      use has no sequence, so the actuator follows it with a sequenced no-op
//      (out-of-range abort-destroy) that the server processes in order;
//   2. this gate allows only ONE request in flight: a new request (from any
//      lease) first drains older ones (bounded), so a reply always belongs to the
//      single pending request.
// A reply attributed to a request whose lease is no longer active (stopped,
// replaced, completed or timed out) is closed as soon as Mineflayer has
// registered it; it never becomes a newer lease's interface. Requests that stay
// unresolved past a horizon make the executor report not-ready with the exact
// reason instead of pretending the connection's interface state is known.
import type { Clock } from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import type { JournalEntry } from '../game/server-evidence.ts';

export type InterfaceRequestState = 'pending' | 'opened' | 'none' | 'closing' | 'closed_late';

export interface InterfaceRequest {
  readonly id: number;
  readonly leaseId: number;
  readonly sequence: number;
  readonly afterSeq: number;
  readonly sentAtMs: number;
  state: InterfaceRequestState;
  windowId?: number;
  /** Whether the requesting lease may still use a reply. */
  readonly ownerActive: () => boolean;
}

/** Horizon after which an unanswered request makes interface state unknown. */
export const INTERFACE_UNRESOLVED_MS = 5_000;
/** Bounded wait for an older lease's requests before a new lease may issue its own. */
export const INTERFACE_DRAIN_MS = 2_500;

export class InterfaceGate {
  private readonly session: GameSession;
  private readonly clock: Clock;
  private readonly requests: InterfaceRequest[] = [];
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  /** Bounded log of resolutions for evidence. */
  readonly log: Array<{ atMs: number; event: string }> = [];

  constructor(session: GameSession, clock: Clock) {
    this.session = session;
    this.clock = clock;
    session.evidence.onRecord((e) => this.onEntry(e));
  }

  private note(event: string): void {
    this.log.push({ atMs: this.clock.now(), event });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Requests still in flight: awaiting a reply/acknowledgement, or a late reply not yet closed. */
  pending(): InterfaceRequest[] {
    return this.requests.filter((r) => r.state === 'pending' || r.state === 'closing');
  }

  private awaiting(): InterfaceRequest[] {
    return this.requests.filter((r) => r.state === 'pending');
  }

  /** Pending requests that belong to a different lease than `leaseId`. */
  pendingFromOthers(leaseId: number): InterfaceRequest[] {
    return this.pending().filter((r) => r.leaseId !== leaseId);
  }

  /** Requests older than the horizon that never resolved (interface state unknown). */
  unresolved(): InterfaceRequest[] {
    const now = this.clock.now();
    return this.pending().filter((r) => now - r.sentAtMs > INTERFACE_UNRESOLVED_MS);
  }

  register(leaseId: number, sequence: number, afterSeq: number, ownerActive: () => boolean): InterfaceRequest {
    const request: InterfaceRequest = { id: this.nextId++, leaseId, sequence, afterSeq, sentAtMs: this.clock.now(), state: 'pending', ownerActive };
    this.requests.push(request);
    if (this.requests.length > 64) this.requests.splice(0, this.requests.length - 64);
    this.note(`request ${request.id} lease ${leaseId} seq ${sequence}`);
    return request;
  }

  /** Window ids attributed to a lease's requests (for adoption and cleanup). */
  windowsOf(leaseId: number): number[] {
    return this.requests.filter((r) => r.leaseId === leaseId && r.state === 'opened' && r.windowId !== undefined).map((r) => r.windowId as number);
  }

  /** Waits (bounded, abortable) until no request is pending, so the next reply is unambiguous. */
  async drain(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = this.clock.now() + timeoutMs;
    while (this.pending().length > 0) {
      // Past the horizon the interface state is unknown: report it instead of waiting.
      if (this.unresolved().length > 0) return false;
      if (signal.aborted || this.clock.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(1, Math.min(100, deadline - this.clock.now())));
        this.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return true;
  }

  /** Waits (bounded, abortable) for a request's resolution. */
  async waitResolved(request: InterfaceRequest, timeoutMs: number, signal: AbortSignal): Promise<InterfaceRequestState> {
    const deadline = this.clock.now() + timeoutMs;
    while (request.state === 'pending') {
      if (signal.aborted || this.clock.now() >= deadline) return request.state;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(1, Math.min(100, deadline - this.clock.now())));
        this.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return request.state;
  }

  /** Lifecycle reset (death/respawn/dimension change restart window ids). */
  clear(reason: string): void {
    for (const r of this.pending()) r.state = r.state === 'closing' ? 'closed_late' : 'none';
    this.note(`cleared (${reason})`);
    this.wake();
  }

  private onEntry(e: JournalEntry): void {
    if (e.kind === 'open_window') {
      const request = this.awaiting().find((r) => r.afterSeq < e.seq);
      if (!request) return; // not caused by our use packets (e.g. server-forced)
      request.windowId = e.windowId;
      this.note(`request ${request.id} -> window ${e.windowId}`);
      if (request.ownerActive()) request.state = 'opened';
      else {
        request.state = 'closing';
        this.closeLate(request, e.windowId);
      }
      this.wake();
    } else if (e.kind === 'ack') {
      for (const r of this.awaiting()) {
        if (r.afterSeq < e.seq && e.sequence >= r.sequence) {
          r.state = 'none';
          this.note(`request ${r.id} acknowledged without an interface`);
        }
      }
      this.wake();
    }
  }

  /** Closes a reply whose owner is gone, after Mineflayer has registered the window. */
  private closeLate(request: InterfaceRequest, windowId: number): void {
    setImmediate(() => {
      // A lifecycle reset in between voids this request: window ids restart, so the
      // id may now belong to a new scene's interface. Never close it then.
      if (request.state !== 'closing') return;
      const bot = this.session.bot as unknown as { currentWindow: { id: number } | null; closeWindow(w: unknown): void; _client: { write(n: string, d: unknown): void } };
      if (bot.currentWindow && bot.currentWindow.id === windowId) bot.closeWindow(bot.currentWindow);
      else bot._client.write('close_window', { windowId });
      request.state = 'closed_late';
      this.note(`request ${request.id} late window ${windowId} closed (owner inactive)`);
      this.wake();
    });
  }
}

const gates = new WeakMap<object, InterfaceGate>();

/** The interface gate of a connection (one per evidence journal). */
export function interfaceGate(session: GameSession, clock: Clock): InterfaceGate {
  let gate = gates.get(session.evidence);
  if (!gate) {
    gate = new InterfaceGate(session, clock);
    gates.set(session.evidence, gate);
  }
  return gate;
}
