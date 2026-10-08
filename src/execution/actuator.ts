// Fenced, lower-level actuator over the live bot. Every command first checks
// the actuator lease (fence) and re-checks after every await.
//
// Installed Mineflayer macros are NOT used where they hide internal awaits that
// could issue commands after cancellation:
//   - bot.dig awaits lookAt before writing the start packet -> we look (fenced)
//     and then call dig with 'ignore' (start packet written synchronously);
//   - bot.activateBlock / _genericPlace await lookAt before writing -> we write
//     the block_place packet ourselves after a fenced look;
//   - bot.clickWindow sleeps up to 500 ms after a dig BEFORE writing, and
//     craft/equip/toss/transfer chain many clicks -> we write single
//     window_click packets ourselves (same optimistic model update and state id
//     as the plugin), with a fenced, abortable cooldown wait;
//   - bot.craft / openFurnace / openContainer are replaced by fenced sequences.
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import type { Clock } from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import type { JournalEntry } from '../game/server-evidence.ts';
import { faceNormal, type FaceName, type Vec } from '../perception/visibility.ts';
import { INTERFACE_DRAIN_MS, interfaceGate, type InterfaceGate, type InterfaceRequest } from './interface-gate.ts';
import { LeaseRevokedError, type Lease } from './lease.ts';

/** Another lease's interface reply is still unresolved; issuing a new interface request now could adopt it. */
export class InterfaceBusyError extends Error {
  readonly pending: number;
  constructor(pending: number) {
    super(`an earlier interface request (${pending} pending) has not been answered; a new interface action could adopt its reply`);
    this.name = 'InterfaceBusyError';
    this.pending = pending;
  }
}

type Bot = GameSession['bot'];

/** Private application observation of OWN motion; never server/effect evidence. */
export interface ActuatorMotionSample {
  atMs: number;
  self: { x: number; y: number; z: number };
  correctionSeq: number;
  commandsIssued: number;
}
export type Window = NonNullable<Bot['currentWindow']>;

const DIRECTION_CODE: Record<FaceName, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const DIG_CLICK_COOLDOWN_MS = 500;
/** Minimum spacing between window clicks: one 50 ms server tick plus margin. */
/** Horizontal offset of the out-of-range barrier position (far beyond any interaction range). */
export const BARRIER_OFFSET = 64;

type Writer = (name: string, data: Record<string, unknown>, detail?: string) => void;

/**
 * Writes the ordered no-op barrier: an ABORT_DESTROY_BLOCK player action for a
 * block far outside interaction range, with a fresh client sequence. The
 * installed 26.1.2 server handles player actions in packet order on its main
 * thread and, for an out-of-range position, only debug-logs ("too far") and
 * acknowledges the sequence; the acknowledgement therefore proves every
 * earlier packet from this connection was processed.
 */
export function writeBarrier(session: GameSession, write: Writer): number {
  const sequence = session.evidence.nextSequence();
  const p = session.bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  write('block_dig', { status: 1, location: { x: Math.floor(p.x) + BARRIER_OFFSET, y: Math.floor(p.y), z: Math.floor(p.z) }, face: 0, sequence }, `barrier seq=${sequence}`);
  return sequence;
}

/**
 * Correlated window resync. `window_items` carries no request id, so a late
 * reply to an EARLIER resync could arrive first; the barrier acknowledgement
 * is sent after the server processed this resync (whose full-state reply is
 * sent while processing it), so the LAST matching window_items before the ack
 * reflects at least this request. A window opened/closed in between, or no
 * acknowledgement, yields undefined (state unknown).
 */
export async function correlatedResync(session: GameSession, windowId: number, cursorNotch: unknown, write: Writer, timeoutMs: number, signal: AbortSignal): Promise<ConfirmedWindow | undefined> {
  const ev = session.evidence;
  const after = ev.seq;
  write('window_click', { windowId, stateId: -1, slot: -999, mouseButton: 2, mode: 5, changedSlots: [], cursorItem: cursorNotch });
  const sequence = writeBarrier(session, write);
  const ack = await ev.waitFor('ack', (e) => e.sequence >= sequence, { afterSeq: after, timeoutMs, signal });
  if (!ack) return undefined;
  const entry = ev.since(after, 'window_items', (e) => e.windowId === windowId && e.seq < ack.seq).at(-1);
  const changed = ev.since(after, 'open_window', (e) => e.seq < ack.seq).length + ev.since(after, 'close_window', (e) => e.seq < ack.seq).length;
  if (!entry || changed > 0) return undefined;
  return {
    windowId: entry.windowId,
    seq: entry.seq,
    atMs: entry.atMs,
    slots: new Map(entry.slots.map((x) => [x.slot, { key: x.key, count: x.count }])),
    cursor: entry.cursor,
  };
}

export const CLICK_PACING_MS = 60;

type ItemCtor = { toNotch(item: unknown): unknown };
// prismarine-item is CommonJS (module.exports = loader); its typings declare an ES default.
const itemLoader = createRequire(import.meta.url)('prismarine-item') as (registry: unknown) => ItemCtor;
const itemCtors = new WeakMap<object, ItemCtor>();

function itemCtor(bot: Bot): ItemCtor {
  const registry = bot.registry as unknown as object;
  let ctor = itemCtors.get(registry);
  if (!ctor) {
    ctor = itemLoader(bot.registry);
    itemCtors.set(registry, ctor);
  }
  return ctor;
}

/** Abortable sleep (resolves early on abort). */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One server-confirmed container snapshot from a forced resync. */
export interface ConfirmedWindow {
  windowId: number;
  seq: number;
  atMs: number;
  slots: Map<number, { key: string; count: number }>;
  cursor: { key: string; count: number } | null;
}

// Only real actuator construction can install sampling. Minimal diagnostic/test
// doubles have no sampler; their outcome claims cannot become motion evidence.
const motionSamplers = new WeakMap<Actuator, () => void>();
export function observeActuatorMotion(act: Actuator): void {
  act.fence();
  motionSamplers.get(act)?.();
}

export class Actuator {
  readonly session: GameSession;
  readonly lease: Lease;
  private readonly clock: Clock;
  /** Window ids this lease opened and must close on revocation. */
  private readonly owned = new Set<number>();
  /** Log of commands written (bounded) for cancellation evidence. */
  readonly commands: Array<{ atMs: number; command: string }> = [];

  /** Per-connection attribution of interfaces opened by use packets. */
  readonly gate: InterfaceGate;

  private readonly onMotion: ((sample: ActuatorMotionSample) => void) | undefined;

  constructor(session: GameSession, lease: Lease, clock: Clock, onMotion?: (sample: ActuatorMotionSample) => void) {
    this.session = session;
    this.lease = lease;
    this.clock = clock;
    this.onMotion = onMotion;
    if (onMotion) motionSamplers.set(this, () => this.observeMotion());
    this.gate = interfaceGate(session, clock);
    lease.onRevoke('close_owned_windows', () => this.closeOwnedWindowsUnfenced());
  }

  /** Waits (bounded) until no interface request is unresolved; throws InterfaceBusyError otherwise. */
  private async drainInterfaces(): Promise<void> {
    this.fence();
    const ok = await this.gate.drain(INTERFACE_DRAIN_MS, this.lease.signal);
    this.fence();
    if (!ok) throw new InterfaceBusyError(this.gate.pending().length);
  }

  get bot(): Bot {
    return this.session.bot;
  }

  get signal(): AbortSignal {
    return this.lease.signal;
  }

  fence(): void {
    this.lease.fence();
  }

  /** Called only inside fenced navigation, using current self position and correction journal. */
  private observeMotion(): void {
    this.fence();
    if (!this.onMotion) return;
    const p = this.bot.entity.position;
    this.onMotion({ atMs: this.clock.now(), self: { x: p.x, y: p.y, z: p.z }, correctionSeq: this.session.evidence.latest('position_correction')?.seq ?? 0, commandsIssued: this.issued });
  }

  /** Total commands issued by this actuator (monotonic; `commands` keeps only the latest 200). */
  issued = 0;

  private log(command: string): void {
    this.issued += 1;
    this.commands.push({ atMs: this.clock.now(), command });
    if (this.commands.length > 200) this.commands.splice(0, this.commands.length - 200);
  }

  private write(name: string, data: Record<string, unknown>, detail = ''): void {
    this.fence();
    (this.bot._client as unknown as { write(n: string, d: unknown): void }).write(name, data);
    this.log(detail ? `${name} ${detail}` : name);
  }

  async sleep(ms: number): Promise<void> {
    this.fence();
    await sleepAbortable(ms, this.lease.signal);
    this.fence();
  }

  /** Waits for a server journal entry while fenced; undefined on timeout. Throws if revoked. */
  async waitServer<K extends JournalEntry['kind']>(
    kind: K,
    test: (e: Extract<JournalEntry, { kind: K }>) => boolean,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<Extract<JournalEntry, { kind: K }> | undefined> {
    this.fence();
    const entry = await this.session.evidence.waitFor(kind, test, { afterSeq, timeoutMs, signal: this.lease.signal });
    this.fence();
    return entry;
  }

  // ------------------------------------------------------------ looking and movement

  async lookAt(point: Vec): Promise<void> {
    this.fence();
    await this.bot.lookAt(new Vec3(point.x, point.y, point.z), true);
    this.fence();
  }

  async look(yaw: number, pitch: number): Promise<void> {
    this.fence();
    await this.bot.look(yaw, pitch, true);
    this.fence();
  }

  setPathGoal(goal: unknown, dynamic = false): void {
    this.fence();
    (this.bot as unknown as { pathfinder: { setGoal(g: unknown, d?: boolean): void } }).pathfinder.setGoal(goal, dynamic);
    this.log('path_goal');
  }

  /** Clears the path goal if this lease is still active (never touches a replacement's goal). */
  clearPathGoal(): void {
    if (!this.lease.active) return;
    (this.bot as unknown as { pathfinder: { setGoal(g: unknown): void } }).pathfinder.setGoal(null);
    this.bot.clearControlStates();
  }

  /**
   * Shift (sneak) input. Mineflayer's setControlState skips the packet when its
   * cached state already matches, so the 26.1 player_input packet is also
   * written explicitly to make the server-side state certain.
   */
  /**
   * Sneak (26.1.x: the `player_input` shift flag). Mineflayer's setControlState
   * writes that packet on a state change; if its model already holds the state,
   * the packet is written explicitly so the server input is never assumed.
   */
  setSneak(on: boolean): void {
    this.fence();
    const before = (this.bot as unknown as { getControlState?(c: string): boolean }).getControlState?.('sneak');
    this.bot.setControlState('sneak', on);
    if (before === on) (this.bot._client as unknown as { write(n: string, d: unknown): void }).write('player_input', { inputs: { shift: on } });
    this.log(`player_input shift=${on}`);
  }

  setControl(control: Parameters<Bot['setControlState']>[0], on: boolean): void {
    this.fence();
    this.bot.setControlState(control, on);
  }

  // ------------------------------------------------------------ digging

  /** Starts digging synchronously (no internal look); resolves when the CLIENT model updates. */
  startDig(block: NonNullable<ReturnType<Bot['blockAt']>>): Promise<void> {
    this.fence();
    // Mineflayer sets the block to air locally when its dig timer ends; that
    // local prediction is marked by the connection's prediction tap
    // (tapClientPredictions) at the moment the client model changes.
    const p = this.bot.dig(block, 'ignore');
    this.log('dig_start');
    return p;
  }

  // ------------------------------------------------------------ hotbar, clicks, windows

  selectHotbar(index: number): void {
    this.fence();
    this.bot.setQuickBarSlot(index);
    this.log(`hotbar ${index}`);
  }

  /** Current window (open container or the player inventory). */
  window(): Window {
    return (this.bot.currentWindow ?? this.bot.inventory) as Window;
  }

  /**
   * One window click, written directly (no internal sleep). Applies the same
   * optimistic local model update the plugin applies; the server remains the
   * authority and is checked with `confirmWindow`.
   */
  async click(slot: number, mouseButton: number, mode: 0 | 1 | 4, expectWindowId?: number, afterWrite?: () => void): Promise<void> {
    this.fence();
    const window = this.window() as unknown as {
      id: number;
      slots: unknown[];
      selectedItem: unknown;
      acceptClick(click: Record<string, unknown>): number[] | undefined;
    };
    if (expectWindowId !== undefined && window.id !== expectWindowId) throw new Error(`window changed (expected ${expectWindowId}, have ${window.id})`);
    const lastDig = (this.bot as unknown as { lastDigTime?: number | null }).lastDigTime;
    if (slot >= 36 && typeof lastDig === 'number') {
      const wait = DIG_CLICK_COOLDOWN_MS - (performance.now() - lastDig);
      if (wait > 0) await this.sleep(wait);
    }
    this.fence();
    const Item = itemCtor(this.bot);
    const click = { slot, mouseButton, mode, id: 0, windowId: window.id, item: slot === -999 ? null : (window.slots[slot] ?? null) };
    let changed: number[];
    if (mode === 0 || mode === 4) {
      changed = window.acceptClick(click) ?? [];
    } else {
      const before = JSON.stringify(window.slots);
      window.acceptClick(click);
      const old = JSON.parse(before) as unknown[];
      changed = window.slots.map((_, i) => i).filter((i) => JSON.stringify(window.slots[i] ?? null) !== JSON.stringify(old[i] ?? null));
    }
    const cursor = window.selectedItem as { name?: string; count?: number } | null;
    this.write(
      'window_click',
      {
        windowId: window.id,
        stateId: this.session.evidence.stateId,
        slot,
        mouseButton,
        mode,
        changedSlots: changed.map((s) => ({ location: s, item: Item.toNotch(window.slots[s] ?? null) })),
        cursorItem: Item.toNotch(window.selectedItem ?? null),
      },
      `w${window.id} s${slot} b${mouseButton} m${mode} cursor=${cursor ? `${cursor.name}x${cursor.count}` : '-'}`,
    );
    (this.bot as unknown as { updateHeldItem?: () => void }).updateHeldItem?.();
    afterWrite?.(); // progress is recorded once the packet is written, even if a stop lands during pacing
    // One server tick between clicks (verified live on 26.1.2): a burst of clicks
    // carrying the same state id makes the vanilla server full-resync after each,
    // record our optimistic slot claims as the client's view, and emit
    // corrections that overwrite the local model mid-sequence (lost/duplicated
    // crafts). The pacing wait is fenced and abortable.
    await this.sleep(CLICK_PACING_MS);
  }

  /**
   * Forces the server to resend the current window (no-op click with an
   * impossible state id) and returns the authoritative contents.
   */
  async confirmWindow(timeoutMs = 2_500): Promise<ConfirmedWindow | undefined> {
    this.fence();
    const window = this.window() as unknown as { id: number; selectedItem: unknown };
    const Item = itemCtor(this.bot);
    const confirmed = await correlatedResync(this.session, window.id, Item.toNotch(window.selectedItem ?? null), (name, data, detail) => this.write(name, data, detail), timeoutMs, this.lease.signal);
    this.fence();
    return confirmed;
  }

  private writeBarrier(): number {
    return writeBarrier(this.session, (name, data, detail) => this.write(name, data, detail));
  }

  // ------------------------------------------------------------ world interaction packets

  /**
   * Right-click a block face (place against it, or use/activate it). Fenced
   * look first. Registers an interface request (any use can open an interface)
   * that the server's sequence acknowledgement or reply resolves.
   */
  async useOnBlock(pos: Vec, face: FaceName, look = true): Promise<InterfaceRequest> {
    this.fence();
    const n = faceNormal(face);
    const cursor = { x: 0.5 + n.x * 0.5, y: 0.5 + n.y * 0.5, z: 0.5 + n.z * 0.5 };
    if (look) await this.lookAt({ x: pos.x + cursor.x, y: pos.y + cursor.y, z: pos.z + cursor.z });
    await this.drainInterfaces();
    const sequence = this.session.evidence.nextSequence();
    const request = this.gate.register(this.lease.id, sequence, this.session.evidence.seq, () => this.lease.active);
    this.write(
      'block_place',
      {
        hand: 0,
        location: new Vec3(pos.x, pos.y, pos.z),
        direction: DIRECTION_CODE[face],
        cursorX: cursor.x,
        cursorY: cursor.y,
        cursorZ: cursor.z,
        insideBlock: false,
        worldBorderHit: false,
        sequence,
      },
      `seq=${sequence}`,
    );
    this.swing();
    return request;
  }

  swing(): void {
    this.write('arm_animation', { hand: 0 });
  }

  /**
   * Right-clicks an entity. `use_entity` carries no sequence, so it is followed
   * by an ordered, correlated barrier: an ABORT_DESTROY_BLOCK player action for
   * a block far outside interaction range with a fresh client sequence. The
   * server handles both on its main thread in order; for an out-of-range
   * position it only debug-logs ("too far") and acknowledges the sequence, so
   * the acknowledgement proves the interaction was processed and any interface
   * it opened was sent before it. (Verified against the installed 26.1.2 server
   * classes and live in the fixture.)
   */
  async useOnEntity(entityId: number, lookAt?: Vec): Promise<InterfaceRequest> {
    if (lookAt) await this.lookAt(lookAt);
    await this.drainInterfaces();
    this.fence();
    const afterSeq = this.session.evidence.seq;
    this.write('use_entity', { target: entityId, hand: 0, location: { x: 0, y: 0, z: 0 }, sneaking: false });
    this.swing();
    const sequence = this.writeBarrier();
    return this.gate.register(this.lease.id, sequence, afterSeq, () => this.lease.active);
  }

  async attackEntity(entityId: number, lookAt?: Vec): Promise<void> {
    if (lookAt) await this.lookAt(lookAt);
    this.write('attack', { entityId });
    this.swing();
  }

  /** Uses the held item (eat/drink/throw...). */
  useHeldItem(): void {
    this.fence();
    (this.bot as unknown as { activateItem(off?: boolean): void }).activateItem(false);
    this.log('use_item');
  }

  releaseHeldItem(): void {
    if (!this.lease.active) return;
    (this.bot as unknown as { deactivateItem(): void }).deactivateItem();
  }

  /** Opens the interface of a block by right-clicking it; resolves with the window attributed to THIS request. */
  async openBlockWindow(pos: Vec, face: FaceName, timeoutMs = 3_000): Promise<Window> {
    this.fence();
    const request = await this.useOnBlock(pos, face);
    const state = await this.gate.waitResolved(request, timeoutMs, this.lease.signal);
    this.fence();
    if (state !== 'opened' || request.windowId === undefined) {
      // A late reply stays attributed to this request and is closed by the gate or our cleanup.
      throw new Error(state === 'none' ? 'no window opened (server acknowledged the use without an interface)' : 'no window opened within the timeout');
    }
    const windowId = request.windowId;
    this.owned.add(windowId);
    const opened = this.session.evidence.latest('open_window', (e) => e.windowId === windowId && e.seq > request.afterSeq);
    // Mineflayer emits windowOpen only after the slot contents arrive.
    const deadline = this.clock.now() + timeoutMs;
    while (this.clock.now() < deadline) {
      const w = this.bot.currentWindow as unknown as { id: number } | null;
      if (w && w.id === windowId && this.session.evidence.latest('window_items', (e) => e.windowId === windowId && e.seq > (opened?.seq ?? request.afterSeq))) {
        return this.bot.currentWindow as Window;
      }
      await this.sleep(25);
    }
    throw new Error('window contents not received');
  }

  /** Closes an owned window (fenced). */
  closeWindow(window: Window): void {
    this.fence();
    this.closeUnfenced(window);
  }

  private closeUnfenced(window: Window, label = ''): void {
    const id = (window as unknown as { id: number }).id;
    try {
      (this.bot as unknown as { closeWindow(w: Window): unknown }).closeWindow(window);
    } catch {
      (this.bot._client as unknown as { write(n: string, d: unknown): void }).write('close_window', { windowId: id });
    }
    this.owned.delete(id);
    this.log(`close_window ${id}${label}`);
  }

  /** Closes the player inventory "screen": returns the 2x2 grid and cursor items to the inventory. */
  closeInventory(): void {
    this.fence();
    (this.bot._client as unknown as { write(n: string, d: unknown): void }).write('close_window', { windowId: 0 });
    this.log('close_window 0');
  }

  /** Whether a window was opened by this lease (explicitly, or as the attributed reply to one of its use packets). */
  ownsWindow(windowId: number): boolean {
    return this.owned.has(windowId) || this.gate.windowsOf(this.lease.id).includes(windowId);
  }

  /**
   * Revocation cleanup: close the current window if it is ours, and the
   * inventory grid we may have used. Replies to our still-pending requests are
   * closed by the gate when they arrive (they stay attributed to us).
   */
  private closeOwnedWindowsUnfenced(): void {
    const current = this.bot.currentWindow as unknown as { id: number } | null;
    if (current && this.ownsWindow(current.id)) this.closeUnfenced(current as unknown as Window, ' (revoked)');
    if (this.usedInventoryGrid) {
      (this.bot._client as unknown as { write(n: string, d: unknown): void }).write('close_window', { windowId: 0 });
      this.log('close_window 0 (revoked)');
    }
    this.owned.clear();
  }

  /** Set by skills that place items into the 2x2 inventory crafting grid or cursor. */
  usedInventoryGrid = false;

  isOwned(windowId: number): boolean {
    return this.owned.has(windowId);
  }
}

export { LeaseRevokedError };
