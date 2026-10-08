// Per-connection SERVER packet tracker for immediate safety (listen-only).
//
// Why our own tracker:
//   - Installed Mineflayer 4.39.0 (entities.js, `metas.air_supply`) updates
//     `bot.oxygenLevel` from the air_supply metadata of ANY entity, not only
//     the bot's own, and its value starts at 20 before any server statement.
//     Own air is therefore read here ONLY from entity_metadata addressed to
//     the bot's own entity id (login packet), keyed by the exact version's
//     `player` metadata key `air_supply`. Never stated on this connection/life
//     = unknown (the server sends air only when it differs from the default).
//   - Weapon/armor durability needs the server slot component patch
//     (`damage`/`max_damage`), which the evidence journal does not keep.
//   - damage_event addressed to the bot names the responsible entity
//     (sourceCauseId - 1), which is the only provocation evidence used.
//
// The tracker never sends packets and never reads hidden entity positions.
import type { SafetyItemFact } from '../contracts/safety.ts';
import { AIR_MAX, type SafetyPacketSource } from '../contracts/safety.ts';

export interface SafetyItemRegistry {
  nameOf(itemId: number): string | undefined;
  maxDurability(key: string): number | undefined;
  /** Index of a named metadata key for an entity type (exact version), e.g. ('player','air_supply') -> 1. */
  metadataIndex(entity: string, key: string): number | undefined;
}

interface RawComponent {
  type?: unknown;
  data?: unknown;
}
interface RawSlot {
  itemCount?: number;
  itemId?: number;
  components?: RawComponent[];
  removeComponents?: Array<{ type?: unknown }>;
}

export interface TrackedSlot {
  key: string;
  count: number;
  maxDurability: number | null;
  damage: number | null;
}

/** Parses a 26.x server slot (count, id, component patch relative to the item's defaults). */
export function parseSafetySlot(raw: RawSlot | null | undefined, registry: SafetyItemRegistry): TrackedSlot | null {
  if (!raw || !raw.itemCount || raw.itemCount <= 0 || typeof raw.itemId !== 'number') return null;
  const name = registry.nameOf(raw.itemId) ?? `unknown_${raw.itemId}`;
  const key = name.includes(':') ? name : `minecraft:${name}`;
  let max: number | null = registry.maxDurability(key) ?? null;
  let damage: number | null = null;
  let unbreakable = false;
  for (const c of raw.components ?? []) {
    if (c.type === 'damage' && typeof c.data === 'number') damage = c.data;
    else if (c.type === 'max_damage' && typeof c.data === 'number') max = c.data;
    else if (c.type === 'unbreakable') unbreakable = true;
  }
  for (const r of raw.removeComponents ?? []) if (r.type === 'max_damage') max = null;
  if (unbreakable) max = null;
  // A damageable stack stated by the server without a `damage` patch has damage 0.
  return { key, count: raw.itemCount, maxDurability: max, damage: max !== null ? (damage ?? 0) : null };
}

/** Player inventory index (set_player_inventory) -> window-0 slot. */
export function inventoryIndexToSlot(index: number): number | undefined {
  if (index >= 0 && index <= 8) return 36 + index;
  if (index >= 9 && index <= 35) return index;
  if (index >= 36 && index <= 39) return 8 - (index - 36);
  if (index === 40) return 45;
  return undefined;
}

export interface DamageRecord {
  atMs: number;
  causeEntityId: number | null;
  directEntityId: number | null;
  damageTypeId: number;
}

export class SafetyTracker {
  private source: SafetyPacketSource | undefined;
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];
  private registry: () => SafetyItemRegistry | undefined = () => undefined;
  private now: () => number = Date.now;
  connectionEpoch = -1;
  selfId: number | undefined;
  air: { value: number; atMs: number; previous: number | null } | null = null;
  vitals: { health: number; food: number; atMs: number } | null = null;
  heldHotbarServer: number | null = null;
  /** Window-0 slots stated by the server since the last full sync of this life. */
  readonly slots = new Map<number, TrackedSlot>();
  slotsAtMs: number | null = null;
  fullSync = false;
  readonly damage: DamageRecord[] = [];
  /** Entities the server declared dead (entity_status 3) and not yet destroyed: dying bodies are never threats or targets. */
  readonly dying = new Map<number, number>();
  /** Counts for evidence/status. */
  readonly counts = { airStatements: 0, otherEntityAirIgnored: 0, damageEvents: 0, slotPackets: 0 };

  attach(source: SafetyPacketSource, opts: { connectionEpoch: number; registry: () => SafetyItemRegistry | undefined; now: () => number; selfId?: () => number | undefined }): void {
    this.detach();
    this.source = source;
    this.registry = opts.registry;
    this.now = opts.now;
    this.connectionEpoch = opts.connectionEpoch;
    this.selfId = opts.selfId?.();
    this.resetLife();
    const on = (name: string, fn: (p: any) => void) => {
      const listener = (p: unknown) => {
        try {
          fn(p);
        } catch {
          // a malformed packet never breaks the connection or the tracker
        }
      };
      source.on(name, listener);
      this.listeners.push([name, listener]);
    };
    on('login', (p: { entityId?: number }) => {
      if (typeof p.entityId === 'number') this.selfId = p.entityId;
      this.resetLife();
    });
    on('respawn', () => this.resetLife());
    on('entity_metadata', (p: { entityId?: number; metadata?: Array<{ key: number; value: unknown }> }) => {
      const reg = this.registry();
      const airKey = reg?.metadataIndex('player', 'air_supply');
      if (airKey === undefined) return;
      for (const m of p.metadata ?? []) {
        if (m.key !== airKey || typeof m.value !== 'number') continue;
        if (this.selfId === undefined || p.entityId !== this.selfId) {
          this.counts.otherEntityAirIgnored += 1;
          continue;
        }
        this.counts.airStatements += 1;
        this.air = { value: Math.max(-20, Math.min(AIR_MAX, Math.round(m.value))), atMs: this.now(), previous: this.air?.value ?? null };
      }
    });
    on('update_health', (p: { health?: number; food?: number }) => {
      if (typeof p.health === 'number' && typeof p.food === 'number') this.vitals = { health: p.health, food: p.food, atMs: this.now() };
    });
    on('damage_event', (p: { entityId?: number; sourceTypeId?: number; sourceCauseId?: number; sourceDirectId?: number }) => {
      if (this.selfId === undefined || p.entityId !== this.selfId) return;
      this.counts.damageEvents += 1;
      this.damage.unshift({
        atMs: this.now(),
        causeEntityId: typeof p.sourceCauseId === 'number' && p.sourceCauseId > 0 ? p.sourceCauseId - 1 : null,
        directEntityId: typeof p.sourceDirectId === 'number' && p.sourceDirectId > 0 ? p.sourceDirectId - 1 : null,
        damageTypeId: typeof p.sourceTypeId === 'number' ? p.sourceTypeId : 0,
      });
      if (this.damage.length > 8) this.damage.length = 8;
    });
    on('entity_status', (p: { entityId?: number; entityStatus?: number }) => {
      if (typeof p.entityId !== 'number' || p.entityStatus !== 3 || p.entityId === this.selfId) return;
      this.dying.set(p.entityId, this.now());
      if (this.dying.size > 64) this.dying.delete(this.dying.keys().next().value as number);
    });
    on('entity_destroy', (p: { entityIds?: number[] }) => {
      for (const id of p.entityIds ?? []) this.dying.delete(id);
    });
    on('window_items', (p: { windowId?: number; items?: RawSlot[] }) => {
      if (p.windowId !== 0 || !Array.isArray(p.items)) return;
      const reg = this.registry();
      if (!reg) return;
      this.counts.slotPackets += 1;
      this.slots.clear();
      p.items.forEach((raw, slot) => {
        const s = parseSafetySlot(raw, reg);
        if (s) this.slots.set(slot, s);
      });
      this.fullSync = true;
      this.slotsAtMs = this.now();
    });
    on('set_slot', (p: { windowId?: number; slot?: number; item?: RawSlot }) => {
      if (p.windowId !== 0 || typeof p.slot !== 'number') return;
      this.applySlot(p.slot, p.item);
    });
    on('set_player_inventory', (p: { slotId?: number; contents?: RawSlot }) => {
      if (typeof p.slotId !== 'number') return;
      const slot = inventoryIndexToSlot(p.slotId);
      if (slot !== undefined) this.applySlot(slot, p.contents);
    });
    on('held_item_slot', (p: { slot?: number }) => {
      if (typeof p.slot === 'number' && p.slot >= 0 && p.slot <= 8) this.heldHotbarServer = p.slot;
    });
  }

  private applySlot(slot: number, raw: RawSlot | undefined): void {
    const reg = this.registry();
    if (!reg) return;
    this.counts.slotPackets += 1;
    const s = parseSafetySlot(raw, reg);
    if (s) this.slots.set(slot, s);
    else this.slots.delete(slot);
    this.slotsAtMs = this.now();
  }

  /** New life (login/respawn): air/equipment/damage facts of the previous life are void. */
  resetLife(): void {
    this.air = null;
    this.slots.clear();
    this.slotsAtMs = null;
    this.fullSync = false;
    this.damage.length = 0;
    this.dying.clear();
    this.heldHotbarServer = null;
  }

  detach(): void {
    const s = this.source;
    if (s) {
      for (const [name, fn] of this.listeners.splice(0)) {
        if (typeof s.off === 'function') s.off(name, fn);
        else s.removeListener?.(name, fn);
      }
    }
    this.source = undefined;
  }

  /** Server-stated item fact for a window-0 slot (only after a full sync of this life). */
  item(slot: number): SafetyItemFact | null {
    if (!this.fullSync) return null;
    const s = this.slots.get(slot);
    if (!s) return null;
    return { key: s.key, slot, maxDurability: s.maxDurability, remainingUses: s.maxDurability !== null ? Math.max(0, s.maxDurability - (s.damage ?? 0)) : null, metadata: 'server_slot' };
  }
}
