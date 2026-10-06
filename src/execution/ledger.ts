// Server-confirmed inventory accounting and the evidence ledger.
//
// The ledger records only effects a skill CONFIRMED with server data (window
// resync diffs, collect packets, block changes, entity status). Predicates read
// it for crafting/smelting results, ingredient consumption milestones, pickups,
// entity outcomes and container contents. Optimistic client-model changes and
// resolved library promises are never recorded as effects.
import type { Clock } from '../contracts/index.ts';
import type { ConfirmedWindow } from './actuator.ts';

export type Counts = Map<string, number>;

export interface InventoryView {
  counts: Counts;
  /** Player-inventory slot index (window-0 numbering 5..45) -> stack. */
  slots: Map<number, { key: string; count: number }>;
  cursor: { key: string; count: number } | null;
  source: 'server_sync' | 'client_model';
  atMs: number;
  /** Armor/off-hand slots are not part of container windows. */
  includesEquipment: boolean;
}

/** Player inventory region of a window: window-0 slot numbers by window slot. */
export function playerRegion(windowId: number, inventoryStart: number): (windowSlot: number) => number | undefined {
  if (windowId === 0) return (s) => (s >= 5 && s <= 45 ? s : undefined);
  // container windows: inventoryStart..+26 main (9..35), +27..+35 hotbar (36..44)
  return (s) => (s >= inventoryStart && s < inventoryStart + 36 ? 9 + (s - inventoryStart) : undefined);
}

export function inventoryFromConfirmed(confirmed: ConfirmedWindow, inventoryStart: number, atMs: number): InventoryView {
  const map = playerRegion(confirmed.windowId, inventoryStart);
  const counts: Counts = new Map();
  const slots = new Map<number, { key: string; count: number }>();
  for (const [slot, stack] of confirmed.slots) {
    const p = map(slot);
    if (p === undefined) continue;
    slots.set(p, stack);
    counts.set(stack.key, (counts.get(stack.key) ?? 0) + stack.count);
  }
  return { counts, slots, cursor: confirmed.cursor, source: 'server_sync', atMs, includesEquipment: confirmed.windowId === 0 };
}

export function countsDiff(before: Counts, after: Counts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (d !== 0) out[key] = d;
  }
  return out;
}

export type LedgerEntry =
  | { kind: 'crafted'; output: string; count: number; consumed: Record<string, number>; atMs: number }
  | { kind: 'smelted_collected'; output: string; count: number; atMs: number }
  | { kind: 'picked_up'; item: string; count: number; atMs: number }
  | { kind: 'dropped'; item: string; count: number; atMs: number }
  | { kind: 'consumed'; item: string; count: number; atMs: number; via: string }
  | { kind: 'entity_defeated'; entityId: number; entity: string; atMs: number }
  | { kind: 'block_changed'; x: number; y: number; z: number; from: string; to: string; atMs: number; actionId: string }
  /** Server-synchronized contents read through the bot's own open interface by a skill action. */
  | { kind: 'container'; dimension: string; x: number; y: number; z: number; contents: Record<string, number>; atMs: number; actionId?: string; via?: string };

/**
 * Skill-confirmed evidence history. Entries are stamped with the connection
 * epoch; container observations are HISTORICAL (labeled by age) and scoped to
 * the connection that observed them. The cached inventory is a convenience for
 * skills inside one action and is dropped on lifecycle interruptions; the
 * predicate engine never uses it as current state.
 */
export class EvidenceLedger {
  private readonly entries: Array<LedgerEntry & { connectionEpoch?: number; generation?: number }> = [];
  /** Incremented by every lifecycle invalidation; current-state history is scoped to it. */
  private generation = 0;
  private readonly clock: Clock;
  private readonly epoch: () => number;
  private lastInventory: (InventoryView & { connectionEpoch: number }) | undefined;
  readonly invalidations: Array<{ atMs: number; reason: string }> = [];
  /** Verified prior-result positions by action id (placed blocks, etc.). */
  private readonly results = new Map<string, { dimension: string; x: number; y: number; z: number; key: string; connectionEpoch: number; generation: number }>();

  constructor(clock: Clock, connectionEpoch: () => number = () => 0) {
    this.clock = clock;
    this.epoch = connectionEpoch;
  }

  add(entry: LedgerEntry): void {
    this.entries.push({ ...entry, connectionEpoch: this.epoch(), generation: this.generation });
    if (this.entries.length > 2_000) this.entries.splice(0, this.entries.length - 2_000);
  }

  since(atMs: number): LedgerEntry[] {
    return this.entries.filter((e) => e.atMs >= atMs);
  }

  setInventory(view: InventoryView): void {
    if (view.source === 'server_sync' && view.includesEquipment) this.lastInventory = { ...view, connectionEpoch: this.epoch() };
  }

  /** Last server-confirmed full inventory of THIS connection (historical; age in atMs), if any. */
  inventory(): InventoryView | undefined {
    return this.lastInventory && this.lastInventory.connectionEpoch === this.epoch() ? this.lastInventory : undefined;
  }

  /** Lifecycle interruption (death, dimension change, disconnect): cached state no longer describes the player. */
  invalidate(reason: string): void {
    this.lastInventory = undefined;
    this.generation += 1;
    this.invalidations.push({ atMs: this.clock.now(), reason });
    if (this.invalidations.length > 32) this.invalidations.shift();
  }

  setResult(actionId: string, result: { dimension: string; x: number; y: number; z: number; key: string }): void {
    this.results.set(actionId, { ...result, connectionEpoch: this.epoch(), generation: this.generation });
    if (this.results.size > 128) this.results.delete(this.results.keys().next().value as string);
  }

  /** A verified prior result of THIS connection and lifecycle generation (callers still check the dimension). */
  result(actionId: string): { dimension: string; x: number; y: number; z: number; key: string } | undefined {
    const r = this.results.get(actionId);
    return r && r.connectionEpoch === this.epoch() && r.generation === this.generation ? r : undefined;
  }

  /** Whether a skill confirmed a block change at this position on this connection/generation since `atMs`. */
  ownBlockChange(x: number, y: number, z: number, sinceMs: number): boolean {
    return this.entries.some((e) => e.kind === 'block_changed' && e.x === x && e.y === y && e.z === z && e.atMs >= sinceMs && e.connectionEpoch === this.epoch() && e.generation === this.generation);
  }

  latestContainer(dimension: string, x: number, y: number, z: number): Extract<LedgerEntry, { kind: 'container' }> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i] as LedgerEntry & { connectionEpoch?: number; generation?: number };
      if (e.connectionEpoch !== this.epoch() || e.generation !== this.generation) continue;
      if (e.kind === 'container' && e.dimension === dimension && e.x === x && e.y === y && e.z === z) return e;
    }
    return undefined;
  }

  now(): number {
    return this.clock.now();
  }
}
