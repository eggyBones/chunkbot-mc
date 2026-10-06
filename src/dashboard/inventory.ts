// Passive, server-backed player inventory projection for the dashboard.
//
// Built only from SERVER-SENT window contents/slot packets already recorded in
// the connection's evidence journal (window_items / set_slot / player_slot).
// It never requests a resync, clicks, or opens an interface: viewing the
// dashboard cannot cause game traffic. Mineflayer's local model (which mixes in
// optimistic window-click predictions) is not used for slot contents.
import type { JournalEntry } from '../game/server-evidence.ts';
import { DASHBOARD_BOUNDS, known, unknown, type DashboardSlot, type Known } from '../contracts/dashboard.ts';
import { playerRegion } from '../execution/ledger.ts';

/** Minimal evidence surface (ServerEvidence satisfies it). */
export interface EvidenceSource {
  latest<K extends JournalEntry['kind']>(kind: K, test?: (e: Extract<JournalEntry, { kind: K }>) => boolean): Extract<JournalEntry, { kind: K }> | undefined;
  since<K extends JournalEntry['kind']>(afterSeq: number, kind: K, test?: (e: Extract<JournalEntry, { kind: K }>) => boolean): Array<Extract<JournalEntry, { kind: K }>>;
  onRecord(listener: (e: JournalEntry) => void): () => void;
}

/** Window describing where the player-inventory region of an open container starts. */
export interface OpenWindowLayout {
  id: number;
  inventoryStart: number;
}

/**
 * Player inventory index (set_player_inventory) -> window-0 slot number.
 * 0..8 hotbar, 9..35 main, 36..39 feet/legs/chest/head, 40 off hand.
 */
export function inventoryIndexToWindowSlot(index: number): number | undefined {
  if (index >= 0 && index <= 8) return 36 + index;
  if (index >= 9 && index <= 35) return index;
  if (index >= 36 && index <= 39) return 8 - (index - 36);
  if (index === 40) return 45;
  return undefined;
}

const MAX_COUNT = 127;

export interface InventoryState {
  slots: DashboardSlot[];
  complete: boolean;
}

/** One connection epoch's server-backed inventory. */
export class InventoryTracker {
  private readonly slots = new Map<number, { item: string; count: number }>();
  private complete = false;
  private syncedAtMs: number | undefined;
  private openWindow: { windowId: number; windowType: string; sinceMs: number } | null = null;
  private off: (() => void) | undefined;
  private reason = 'awaiting the first server inventory sync';
  /** Client's open-window layout (static slot geometry only; never slot contents). */
  private readonly layout: (() => OpenWindowLayout | undefined) | undefined;

  constructor(layout?: () => OpenWindowLayout | undefined) {
    this.layout = layout;
  }

  /** Seeds from the journal (latest full window-0 contents and later updates), then follows new records. */
  attach(evidence: EvidenceSource): void {
    this.detach();
    const seed = evidence.latest('window_items', (e) => e.windowId === 0);
    const after = seed?.seq ?? 0;
    if (seed) this.apply(seed);
    const later: JournalEntry[] = [
      ...evidence.since(after, 'window_items', (e) => e.windowId !== 0),
      ...evidence.since(after, 'set_slot'),
      ...evidence.since(after, 'player_slot'),
      ...evidence.since(after, 'open_window'),
      ...evidence.since(after, 'close_window'),
    ];
    later.sort((a, b) => a.seq - b.seq);
    for (const e of later) this.apply(e);
    this.off = evidence.onRecord((e) => this.apply(e));
  }

  detach(): void {
    this.off?.();
    this.off = undefined;
  }

  /** Death or respawn: the previous contents are no longer the current stock. */
  invalidate(reason: string): void {
    this.slots.clear();
    this.complete = false;
    this.syncedAtMs = undefined;
    this.openWindow = null;
    this.reason = reason;
  }

  private set(slot: number, stack: { key: string; count: number } | null, atMs: number): void {
    if (slot < 5 || slot > 45) return;
    if (!stack || stack.count <= 0) this.slots.delete(slot);
    else this.slots.set(slot, { item: stack.key, count: Math.min(stack.count, MAX_COUNT) });
    this.syncedAtMs = atMs;
  }

  apply(e: JournalEntry): void {
    switch (e.kind) {
      case 'window_items': {
        if (e.windowId === 0) {
          this.slots.clear();
          for (const s of e.slots) this.set(s.slot, s, e.atMs);
          this.complete = true;
          this.syncedAtMs = e.atMs;
          return;
        }
        const map = this.containerMap(e.windowId);
        if (!map) return;
        // A container's full contents restate the player's main+hotbar region (not armor/off hand).
        for (let s = 9; s <= 44; s += 1) this.slots.delete(s);
        for (const s of e.slots) {
          const p = map(s.slot);
          if (p !== undefined) this.set(p, s, e.atMs);
        }
        this.syncedAtMs = e.atMs;
        return;
      }
      case 'set_slot': {
        if (e.windowId === 0) return this.set(e.slot, e.stack, e.atMs);
        const map = this.containerMap(e.windowId);
        const p = map?.(e.slot);
        if (p !== undefined) this.set(p, e.stack, e.atMs);
        return;
      }
      case 'player_slot': {
        const p = inventoryIndexToWindowSlot(e.inventoryIndex);
        if (p !== undefined) this.set(p, e.stack, e.atMs);
        return;
      }
      case 'open_window':
        this.openWindow = { windowId: e.windowId, windowType: e.windowType.slice(0, DASHBOARD_BOUNDS.shortText), sinceMs: e.atMs };
        return;
      case 'close_window':
        if (this.openWindow?.windowId === e.windowId) this.openWindow = null;
        return;
      default:
        return;
    }
  }

  private containerMap(windowId: number): ((slot: number) => number | undefined) | undefined {
    const w = this.layout?.();
    if (!w || w.id !== windowId || windowId === 0) return undefined;
    return playerRegion(windowId, w.inventoryStart);
  }

  contents(): Known<InventoryState> {
    if (this.syncedAtMs === undefined) return unknown(this.reason);
    const slots = [...this.slots.entries()].sort((a, b) => a[0] - b[0]).map(([slot, s]) => ({ slot, item: s.item, count: s.count }));
    return known({ slots: slots.slice(0, DASHBOARD_BOUNDS.maxSlots), complete: this.complete }, 'server_sync', this.syncedAtMs);
  }

  container(): { windowId: number; windowType: string; sinceMs: number } | null {
    if (!this.openWindow) return null;
    // The client closes windows without a server packet: trust the layout when it says none is open.
    if (this.layout && this.layout()?.id !== this.openWindow.windowId) return null;
    return { ...this.openWindow };
  }
}
