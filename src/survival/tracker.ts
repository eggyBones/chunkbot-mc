// Per-connection SERVER packet tracker for survival: the bot's own inventory
// with component metadata, vitals, and own-death capture with a frozen
// last-alive snapshot.
//
// Why a separate tracker: the death-time inventory clearing reaches the client
// as ordinary slot updates, which (by the vanilla tick order this is gated on,
// R-G1) can arrive BEFORE the zero-health packet that makes the library emit
// `death`. Reading "the latest inventory" at the death event can therefore
// record an empty or stale inventory. The tracker freezes the last-alive copy
// at the earliest own-death signal the server sends:
//   1. the own combat-kill packet (`death_combat_event`, playerId = self),
//   2. else the first zero-health `update_health`,
//   3. else the application's death lifecycle event,
// and labels which signal froze it and how many inventory packets followed.
//
// After respawn, "fresh state" requires the respawn packet AND a following
// full window-0 sync AND a positive-health update on the same connection.
// The respawn packet's SpawnInfo carries the server's own last-death GlobalPos
// (both 26.1 and 26.2 codecs), which refines the client death estimate.
//
// The tracker only listens; it never sends packets, clicks or resyncs.
import type { DeathCause, DeathSite, DropStackFacts, InventoryFacts, LastAlive, TrackedStack, Vitals } from '../contracts/survival.ts';
import { classifyDeathMessage } from './death-cause.ts';
import { inventoryIndexToWindowSlot, parseSlot, sameDimension, sessionDimension, type RawSlot, type SurvivalItemRegistry } from './items.ts';

/** EventEmitter-like raw packet source (the protocol client). */
export interface PacketSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface TrackerAttachOptions {
  connectionEpoch: number;
  registry: SurvivalItemRegistry;
  now: () => number;
  /** Client physics position/dimension (approved session read) for the death estimate. */
  selfPosition: () => { dimension: string; at: { x: number; y: number; z: number } } | undefined;
  /** Own entity id when known before the login packet was seen (e.g. attached after login). */
  selfEntityId?: () => number | undefined;
  /** Library-model seed at ready (server-fed, labeled `ready_seed`) when attached after the initial sync. */
  seed?: { stacks: TrackedStack[]; heldHotbar?: number; vitals?: { health: number; food: number; saturation: number } };
  /** Open container window layout (static geometry), to map container slot packets onto the player region. */
  containerLayout?: () => { id: number; inventoryStart: number } | undefined;
}

export type LifeState = 'alive' | 'dying' | 'dead' | 'respawned_awaiting_sync';

export interface CapturedDeathRecord {
  captureId: string;
  connectionEpoch: number;
  occurredAtMs: number;
  site: DeathSite;
  cause: DeathCause;
  lastAlive: LastAlive;
}

export type TrackerEvent =
  | { type: 'death_captured'; death: CapturedDeathRecord }
  | { type: 'death_location_refined'; captureId: string; site: DeathSite }
  /**
   * Fresh respawn state. `inventory` is the FIRST full window-0 sync after the
   * respawn packet (the authoritative respawn inventory, C10); `current` is the
   * inventory when fresh state was reached and `packetsAfterSync` counts the
   * inventory packets in between (e.g. passive pickups at the respawn point,
   * which are never part of the respawn inventory).
   */
  | { type: 'respawn_ready'; connectionEpoch: number; inventory: InventoryFacts; current: InventoryFacts; packetsAfterSync: number; vitals: Vitals | null }
  /** First full respawn inventory, for read-only loss accounting before positive health permits any action. */
  | { type: 'respawn_inventory'; incidentId: string; inventory: InventoryFacts }
  | { type: 'inventory_changed' }
  /**
   * C12: the server says THIS bot collected an ITEM entity (other collectors and
   * non-item entities such as experience orbs are not reported). `facts` is the
   * entity's own server-stated stack (absent when never stated); `firstSeenAt`
   * is the position where the server first announced the entity to this client.
   */
  | { type: 'own_item_collect'; connectionEpoch: number; entityId: number; count: number; facts: DropStackFacts | undefined; firstSeenAt: { x: number; y: number; z: number } | undefined; atMs: number }
  /** Own collect of an entity never announced on this connection. Its kind, stack and position are unknown. */
  | { type: 'own_unknown_collect'; connectionEpoch: number; entityId: number; count: number; facts: undefined; firstSeenAt: undefined; atMs: number }
  | { type: 'vitals_changed'; vitals: Vitals };

interface RawGlobalPos {
  dimensionName?: string;
  location?: { x: number; y: number; z: number };
}

const clone = (stacks: Map<number, TrackedStack>): TrackedStack[] => [...stacks.values()].sort((a, b) => a.slot - b.slot).map((s) => ({ ...s, meta: { ...s.meta } }));

let captureCounter = 0;

/** Item entity metadata index of the item stack (same constant as server-evidence ITEM_STACK_METADATA_KEY). */
const ITEM_STACK_KEY = 8;

export class SurvivalTracker {
  private source: PacketSource | undefined;
  private opts: TrackerAttachOptions | undefined;
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];
  private readonly subscribers = new Set<(e: TrackerEvent) => void>();
  private slots = new Map<number, TrackedStack>();
  private invSource: InventoryFacts['source'] = 'unavailable';
  private invAtMs = 0;
  private fullSync = false;
  private heldHotbar: number | undefined;
  private vitalsValue: Vitals | null = null;
  private serverHealthSeen = false;
  private selfId: number | undefined;
  private state: LifeState = 'alive';
  /** Frozen last-alive copy while dying (before the death record is finalized). */
  private frozen: { stacks: TrackedStack[]; source: InventoryFacts['source']; atMs: number; invAtMs: number; frozenAt: LastAlive['frozenAt']; cause: DeathCause; clearing: number } | undefined;
  private latestDeath: CapturedDeathRecord | undefined;
  private readonly unconsumed: CapturedDeathRecord[] = [];
  private loginDeath: RawGlobalPos | undefined;
  private respawnSeen = false;
  /** C10: the first full window-0 sync after the respawn packet, and inventory packets applied after it. */
  private respawnSync: { inv: InventoryFacts; packetsAfter: number } | undefined;
  private openWindowId: number | undefined;
  /** Item entities announced by the server (spawn_entity of the item type) on this connection/life. */
  private readonly itemEntities = new Set<number>();
  /** Server-stated stack of each item entity (its own metadata packet; C3 authority, never a label). */
  private readonly drops = new Map<number, DropStackFacts>();
  /** First-announced position of each item entity (spawn_entity) on this connection/life. */
  private readonly firstSeen = new Map<number, { x: number; y: number; z: number }>();
  /** Entities the server announced as something other than an item (e.g. experience orbs). */
  private readonly nonItemEntities = new Set<number>();
  /** Kind of entities this bot collected recently (outlives entity_destroy; bounded). */
  private readonly collectedKinds = new Map<number, 'item' | 'non_item' | 'unknown'>();
  /** Packet-time stacks for recent own collects. Settlement history, never live drop authority. */
  private readonly collectedStacks = new Map<number, DropStackFacts>();

  /** Subscribes to tracker events (synchronous, in packet order). */
  subscribe(listener: (e: TrackerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(e: TrackerEvent): void {
    for (const l of [...this.subscribers]) {
      try {
        l(e);
      } catch {
        // a subscriber failure never breaks packet tracking
      }
    }
  }

  get connectionEpoch(): number | undefined {
    return this.source ? this.opts?.connectionEpoch : undefined;
  }

  get life(): LifeState {
    return this.state;
  }

  /** Attaches to one connection's packet source (call before login when possible). Detaches any previous one. */
  attach(source: PacketSource, opts: TrackerAttachOptions): void {
    this.detach();
    this.source = source;
    this.opts = opts;
    this.slots = new Map();
    this.invSource = 'unavailable';
    this.fullSync = false;
    this.vitalsValue = null;
    this.serverHealthSeen = false;
    this.selfId = undefined;
    this.state = 'alive';
    this.frozen = undefined;
    this.respawnSeen = false;
    this.respawnSync = undefined;
    this.loginDeath = undefined;
    this.openWindowId = undefined;
    this.itemEntities.clear();
    this.drops.clear();
    this.firstSeen.clear();
    this.nonItemEntities.clear();
    this.collectedKinds.clear();
    this.collectedStacks.clear();
    if (opts.seed) {
      for (const s of opts.seed.stacks) this.slots.set(s.slot, { ...s, meta: { ...s.meta } });
      this.invSource = 'ready_seed';
      this.invAtMs = opts.now();
      this.fullSync = true;
      if (opts.seed.heldHotbar !== undefined) this.heldHotbar = opts.seed.heldHotbar;
      if (opts.seed.vitals) this.vitalsValue = { health: opts.seed.vitals.health, food: Math.round(opts.seed.vitals.food), saturation: opts.seed.vitals.saturation, atMs: opts.now(), connectionEpoch: opts.connectionEpoch };
    }
    const on = <P>(name: string, handler: (p: P) => void) => {
      const fn = handler as (...args: any[]) => void;
      source.on(name, fn);
      this.listeners.push([name, fn]);
    };
    on('spawn_entity', (p: { entityId: number; type: number; x?: number; y?: number; z?: number }) => {
      // Entity ids may be reused. Neither the old live stack nor its collect history belongs to a new entity.
      this.itemEntities.delete(p.entityId);
      this.nonItemEntities.delete(p.entityId);
      this.drops.delete(p.entityId);
      this.firstSeen.delete(p.entityId);
      this.collectedKinds.delete(p.entityId);
      this.collectedStacks.delete(p.entityId);
      const itemType = this.opts?.registry.itemEntityTypeId;
      if (itemType !== undefined && p.type !== itemType) {
        this.nonItemEntities.add(p.entityId);
        if (this.nonItemEntities.size > 4_000) this.nonItemEntities.delete(this.nonItemEntities.values().next().value as number);
      }
      if (itemType === undefined || p.type !== itemType) return;
      this.itemEntities.add(p.entityId);
      if (this.itemEntities.size > 4_000) this.itemEntities.delete(this.itemEntities.values().next().value as number);
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        this.firstSeen.set(p.entityId, { x: p.x as number, y: p.y as number, z: p.z as number });
        if (this.firstSeen.size > 4_000) this.firstSeen.delete(this.firstSeen.keys().next().value as number);
      }
    });
    on('collect', (p: { collectedEntityId: number; collectorEntityId: number; pickupItemCount?: number }) => {
      const self = this.self();
      if (!this.opts || self === undefined || p.collectorEntityId !== self) return;
      const kind = this.itemEntities.has(p.collectedEntityId) ? 'item' : this.nonItemEntities.has(p.collectedEntityId) ? 'non_item' : 'unknown';
      const facts = kind === 'item' ? this.drops.get(p.collectedEntityId) : undefined;
      if (facts) this.collectedStacks.set(p.collectedEntityId, { ...facts, meta: { ...facts.meta } });
      else this.collectedStacks.delete(p.collectedEntityId);
      this.collectedKinds.delete(p.collectedEntityId);
      this.collectedKinds.set(p.collectedEntityId, kind);
      if (this.collectedKinds.size > 256) {
        const oldest = this.collectedKinds.keys().next().value as number;
        this.collectedKinds.delete(oldest);
        this.collectedStacks.delete(oldest);
      }
      if (kind === 'non_item') return;
      const count = Number(p.pickupItemCount);
      if (!Number.isInteger(count) || count <= 0) return;
      if (kind === 'unknown') {
        this.emit({ type: 'own_unknown_collect', connectionEpoch: this.opts.connectionEpoch, entityId: p.collectedEntityId, count, facts: undefined, firstSeenAt: undefined, atMs: this.now() });
        return;
      }
      const at = this.firstSeen.get(p.collectedEntityId);
      this.emit({ type: 'own_item_collect', connectionEpoch: this.opts.connectionEpoch, entityId: p.collectedEntityId, count, facts: facts ? { ...facts, meta: { ...facts.meta } } : undefined, firstSeenAt: at ? { ...at } : undefined, atMs: this.now() });
    });
    on('entity_metadata', (p: { entityId: number; metadata?: Array<{ key: number; type: string; value: unknown }> }) => {
      if (!this.itemEntities.has(p.entityId) || !this.opts) return;
      for (const m of p.metadata ?? []) {
        if (m.key !== ITEM_STACK_KEY || m.type !== 'item_stack') continue;
        const parsed = parseSlot(m.value as RawSlot, this.opts.registry);
        if (parsed) this.drops.set(p.entityId, { entityId: p.entityId, key: parsed.key, count: parsed.count, meta: parsed.meta, atMs: this.now() });
        else this.drops.delete(p.entityId);
        if (this.drops.size > 2_000) this.drops.delete(this.drops.keys().next().value as number);
      }
    });
    on('entity_destroy', (p: { entityIds?: number[] }) => {
      for (const id of p.entityIds ?? []) {
        this.itemEntities.delete(id);
        this.drops.delete(id);
        this.firstSeen.delete(id);
        this.nonItemEntities.delete(id);
      }
    });
    on('login', (p: { entityId?: number; worldState?: { death?: RawGlobalPos } }) => {
      this.itemEntities.clear();
      this.drops.clear();
      this.firstSeen.clear();
      this.nonItemEntities.clear();
      this.collectedKinds.clear();
      this.collectedStacks.clear();
      if (typeof p.entityId === 'number') this.selfId = p.entityId;
      if (p.worldState?.death) this.loginDeath = p.worldState.death;
    });
    on('window_items', (p: { windowId: number; items?: RawSlot[] }) => this.onWindowItems(p));
    on('set_slot', (p: { windowId: number; slot: number; item?: RawSlot }) => this.onSetSlot(p));
    on('set_player_inventory', (p: { slotId: number; contents?: RawSlot }) => {
      const w = inventoryIndexToWindowSlot(p.slotId);
      if (w !== undefined) this.setSlot(w, p.contents);
    });
    on('held_item_slot', (p: { slot: number }) => {
      if (Number.isInteger(p.slot) && p.slot >= 0 && p.slot <= 8) this.heldHotbar = p.slot;
    });
    on('open_window', (p: { windowId: number }) => {
      this.openWindowId = p.windowId;
    });
    on('close_window', (p: { windowId: number }) => {
      if (this.openWindowId === p.windowId) this.openWindowId = undefined;
    });
    on('update_health', (p: { health: number; food: number; foodSaturation: number }) => this.onHealth(p));
    on('death_combat_event', (p: { playerId: number; message?: unknown }) => this.onCombatKill(p));
    on('respawn', (p: { worldState?: { death?: RawGlobalPos; name?: string } }) => this.onRespawn(p));
  }

  detach(): void {
    const src = this.source;
    if (src) {
      for (const [name, fn] of this.listeners.splice(0)) {
        if (src.off) src.off(name, fn);
        else src.removeListener?.(name, fn);
      }
    }
    this.source = undefined;
  }

  private now(): number {
    return this.opts?.now() ?? Date.now();
  }

  private self(): number | undefined {
    return this.selfId ?? this.opts?.selfEntityId?.();
  }

  // ------------------------------------------------------------ inventory

  private setSlot(slot: number, raw: RawSlot | null | undefined): void {
    if (!this.opts || slot < 0 || slot > 45) return;
    const parsed = parseSlot(raw, this.opts.registry);
    if (parsed) this.slots.set(slot, { slot, ...parsed });
    else this.slots.delete(slot);
    this.touchInventory();
  }

  private touchInventory(): void {
    if (this.invSource === 'unavailable') this.invSource = 'server_packets';
    this.invAtMs = this.now();
    if (this.frozen) this.frozen.clearing += 1;
    if (this.respawnSync) this.respawnSync.packetsAfter += 1;
    this.emit({ type: 'inventory_changed' });
  }

  private onWindowItems(p: { windowId: number; items?: RawSlot[] }): void {
    if (!this.opts) return;
    const items = Array.isArray(p.items) ? p.items : [];
    if (p.windowId === 0) {
      const next = new Map<number, TrackedStack>();
      items.forEach((raw, slot) => {
        const parsed = parseSlot(raw, this.opts!.registry);
        if (parsed && slot <= 45) next.set(slot, { slot, ...parsed });
      });
      this.slots = next;
      this.invSource = 'server_packets';
      this.fullSync = true;
      this.invAtMs = this.now();
      if (this.frozen) this.frozen.clearing += 1;
      if (this.state === 'respawned_awaiting_sync' && this.respawnSeen && !this.respawnSync && this.opts) {
        // The authoritative respawn inventory: frozen at the first full sync after the respawn packet.
        this.respawnSync = { inv: { source: 'server_packets', connectionEpoch: this.opts.connectionEpoch, atMs: this.invAtMs, stacks: clone(this.slots), fullSync: true, ...(this.heldHotbar !== undefined ? { heldHotbar: this.heldHotbar } : {}) }, packetsAfter: 0 };
        if (this.latestDeath) this.emit({ type: 'respawn_inventory', incidentId: this.latestDeath.captureId, inventory: this.respawnSync.inv });
      } else if (this.respawnSync) this.respawnSync.packetsAfter += 1;
      this.emit({ type: 'inventory_changed' });
      this.maybeRespawnReady();
      return;
    }
    const layout = this.opts.containerLayout?.();
    if (!layout || layout.id !== p.windowId) return;
    for (let s = 9; s <= 44; s += 1) this.slots.delete(s);
    items.forEach((raw, i) => {
      if (i < layout.inventoryStart || i >= layout.inventoryStart + 36) return;
      const parsed = parseSlot(raw, this.opts!.registry);
      const slot = 9 + (i - layout.inventoryStart);
      if (parsed) this.slots.set(slot, { slot, ...parsed });
    });
    this.touchInventory();
  }

  private onSetSlot(p: { windowId: number; slot: number; item?: RawSlot }): void {
    if (!this.opts) return;
    if (p.windowId === 0) return this.setSlot(p.slot, p.item);
    if (p.windowId === -2) {
      const w = inventoryIndexToWindowSlot(p.slot);
      if (w !== undefined) this.setSlot(w, p.item);
      return;
    }
    const layout = this.opts.containerLayout?.();
    if (!layout || layout.id !== p.windowId) return;
    if (p.slot >= layout.inventoryStart && p.slot < layout.inventoryStart + 36) this.setSlot(9 + (p.slot - layout.inventoryStart), p.item);
  }

  /** Current server-backed inventory of this connection (null before any data). */
  inventory(): InventoryFacts | null {
    if (!this.opts || this.invSource === 'unavailable') return null;
    return {
      source: this.invSource,
      connectionEpoch: this.opts.connectionEpoch,
      atMs: this.invAtMs,
      stacks: clone(this.slots),
      fullSync: this.fullSync && this.state === 'alive',
      ...(this.heldHotbar !== undefined ? { heldHotbar: this.heldHotbar } : {}),
    };
  }

  vitals(): Vitals | null {
    return this.vitalsValue ? { ...this.vitalsValue } : null;
  }

  /** Current attached connection's server health packet (a ready-time library seed is insufficient). */
  serverVitals(): Vitals | null {
    return this.source && this.serverHealthSeen ? this.vitals() : null;
  }

  // ------------------------------------------------------------ vitals / death

  private onHealth(p: { health: number; food: number; foodSaturation: number }): void {
    if (!this.opts) return;
    this.serverHealthSeen = true;
    this.vitalsValue = {
      health: Math.max(0, Math.min(1_024, Number(p.health) || 0)),
      food: Math.max(0, Math.min(20, Math.round(Number(p.food) || 0))),
      saturation: Math.max(0, Math.min(20, Number(p.foodSaturation) || 0)),
      atMs: this.now(),
      connectionEpoch: this.opts.connectionEpoch,
    };
    this.emit({ type: 'vitals_changed', vitals: { ...this.vitalsValue } });
    if (this.vitalsValue.health <= 0) {
      if (this.state === 'alive') this.freeze('zero_health_packet', { kind: 'unknown', hazard: 'unknown' });
      if (this.state === 'dying') this.finalizeDeath();
      return;
    }
    this.maybeRespawnReady();
  }

  private onCombatKill(p: { playerId: number; message?: unknown }): void {
    const self = this.self();
    if (self === undefined || p.playerId !== self) return;
    const cause = classifyDeathMessage(p.message);
    if (this.state === 'alive') this.freeze('combat_kill_packet', cause);
    else if (this.frozen && this.frozen.cause.kind === 'unknown') this.frozen.cause = cause;
    else if (this.latestDeath && this.latestDeath.cause.kind === 'unknown' && this.state === 'dead') this.latestDeath.cause = cause;
  }

  private freeze(frozenAt: LastAlive['frozenAt'], cause: DeathCause): void {
    this.state = 'dying';
    this.frozen = { stacks: clone(this.slots), source: this.invSource, atMs: this.now(), invAtMs: this.invAtMs, frozenAt, cause, clearing: 0 };
  }

  private finalizeDeath(): void {
    const f = this.frozen;
    if (!f || !this.opts) return;
    this.frozen = undefined;
    this.state = 'dead';
    this.respawnSeen = false;
    const now = this.now();
    const pos = this.opts.selfPosition();
    captureCounter += 1;
    const death: CapturedDeathRecord = {
      captureId: `dcap-${this.opts.connectionEpoch}-${captureCounter}`,
      connectionEpoch: this.opts.connectionEpoch,
      occurredAtMs: f.atMs,
      site: pos ? { source: 'client_position_at_death_event', dimension: sessionDimension(pos.dimension), at: { ...pos.at }, observedAtMs: now } : { source: 'unknown' },
      cause: f.cause,
      lastAlive: {
        source: f.source,
        frozenAt: f.frozenAt,
        ...(f.source !== 'unavailable' ? { capturedAtMs: f.invAtMs, ageMsAtDeath: Math.max(0, f.atMs - f.invAtMs) } : {}),
        stacks: f.stacks,
        clearingPacketsAfterFreeze: f.clearing,
      },
    };
    this.latestDeath = death;
    this.unconsumed.push(death);
    if (this.unconsumed.length > 4) this.unconsumed.shift();
    this.emit({ type: 'death_captured', death });
  }

  /**
   * Application death lifecycle event: guarantees a capture even when the
   * library emitted `death` before this tracker saw the zero-health packet
   * (listener order). Idempotent per death.
   */
  ensureDeathCaptured(): CapturedDeathRecord | undefined {
    if (this.state === 'alive') this.freeze('death_event', { kind: 'unknown', hazard: 'unknown' });
    if (this.state === 'dying') this.finalizeDeath();
    return this.latestDeath;
  }

  /** Server-stated stack of one dropped item entity, or undefined when the server stated none (unknown). */
  dropStack(entityId: number): DropStackFacts | undefined {
    const d = this.drops.get(entityId);
    return d ? { ...d, meta: { ...d.meta } } : undefined;
  }

  /** Stack stated at an own collect packet; survives entity_destroy for bounded action settlement only. */
  collectedStack(entityId: number): DropStackFacts | undefined {
    const d = this.collectedStacks.get(entityId);
    return d ? { ...d, meta: { ...d.meta } } : undefined;
  }

  /** What a collect by this bot took: a server-announced item, a server-announced non-item (orb), or never announced. */
  collectedKind(entityId: number): 'item' | 'non_item' | 'unknown' {
    return this.collectedKinds.get(entityId) ?? (this.itemEntities.has(entityId) ? 'item' : this.nonItemEntities.has(entityId) ? 'non_item' : 'unknown');
  }

  /** Own entity id on this connection (from login). */
  selfEntityId(): number | undefined {
    return this.self();
  }

  /** Most recent captured own death of this connection (not consumed). */
  latest(): CapturedDeathRecord | undefined {
    return this.latestDeath;
  }

  /** Takes captured deaths not yet consumed by the service (oldest first). */
  takeDeaths(): CapturedDeathRecord[] {
    return this.unconsumed.splice(0);
  }

  private onRespawn(p: { worldState?: { death?: RawGlobalPos; name?: string } }): void {
    // A respawn (death or dimension travel) restarts the client's entity space.
    this.itemEntities.clear();
    this.drops.clear();
    this.firstSeen.clear();
    this.nonItemEntities.clear();
    this.collectedKinds.clear();
    this.collectedStacks.clear();
    if (this.state === 'alive' && !this.latestDeath) {
      // A respawn without a death (dimension travel) is not a death; inventory continues.
      return;
    }
    if (this.state === 'dying') this.finalizeDeath();
    if (this.state !== 'dead') return;
    const d = p.worldState?.death;
    const death = this.latestDeath;
    if (death && d && typeof d.dimensionName === 'string' && d.location && Number.isFinite(d.location.x + d.location.y + d.location.z)) {
      const at = { x: d.location.x + 0.5, y: d.location.y, z: d.location.z + 0.5 };
      const prev = death.site;
      const off = prev.at && sameDimension(prev.dimension, d.dimensionName) ? Math.round(Math.hypot(prev.at.x - at.x, prev.at.y - at.y, prev.at.z - at.z) * 10) / 10 : undefined;
      death.site = { source: 'server_death_location', dimension: sessionDimension(d.dimensionName), at, observedAtMs: this.now(), ...(off !== undefined ? { clientEstimateOffBy: off } : {}) };
      this.emit({ type: 'death_location_refined', captureId: death.captureId, site: { ...death.site } });
    }
    this.state = 'respawned_awaiting_sync';
    this.serverHealthSeen = false;
    this.respawnSeen = true;
    this.respawnSync = undefined;
    this.fullSync = false;
  }

  private maybeRespawnReady(): void {
    if (this.state !== 'respawned_awaiting_sync' || !this.respawnSeen || !this.fullSync || !this.opts) return;
    if (!this.serverHealthSeen || !this.vitalsValue || this.vitalsValue.health <= 0) return;
    this.state = 'alive';
    const inv = this.inventory();
    const sync = this.respawnSync;
    this.respawnSync = undefined;
    if (inv) this.emit({ type: 'respawn_ready', connectionEpoch: this.opts.connectionEpoch, inventory: sync ? sync.inv : inv, current: inv, packetsAfterSync: sync ? sync.packetsAfter : 0, vitals: this.vitals() });
  }

  /** C10 diagnostics: every server-stated dropped item stack currently known on this connection (bounded copy). */
  dropStacks(limit = 64): DropStackFacts[] {
    return [...this.drops.values()].slice(-limit).map((d) => ({ ...d, meta: { ...d.meta } }));
  }

  /** The login packet's last-death GlobalPos (historical; may predate this run). */
  loginDeathLocation(): { dimension: string; at: { x: number; y: number; z: number } } | undefined {
    const d = this.loginDeath;
    if (!d || typeof d.dimensionName !== 'string' || !d.location) return undefined;
    return { dimension: sessionDimension(d.dimensionName), at: { x: d.location.x + 0.5, y: d.location.y, z: d.location.z + 0.5 } };
  }

  /**
   * MB-MEM-001 DeathContext shape (memory/world.ts) from the frozen
   * last-alive record. Call synchronously at the death lifecycle event.
   */
  deathContext(): { dimension?: string; position?: { x: number; y: number; z: number }; accuracy: 'client_position_at_death_event' | 'last_observation' | 'unknown'; positionAgeMs?: number; inventory: { source: 'server_sync' | 'client_model' | 'unavailable'; capturedAtMs?: number; items: Array<{ key: string; count: number }> } } {
    const d = this.ensureDeathCaptured();
    if (!d) return { accuracy: 'unknown', inventory: { source: 'unavailable', items: [] } };
    const totals = new Map<string, number>();
    for (const s of d.lastAlive.stacks) totals.set(s.key, (totals.get(s.key) ?? 0) + s.count);
    const items = [...totals.entries()].slice(0, 41).map(([key, count]) => ({ key, count }));
    // Memory's vocabulary: `server_sync` = server-stated contents; a ready seed is the library model.
    const source = d.lastAlive.source === 'server_packets' ? 'server_sync' : d.lastAlive.source === 'ready_seed' ? 'client_model' : 'unavailable';
    return {
      ...(d.site.dimension && d.site.at ? { dimension: d.site.dimension, position: { ...d.site.at } } : {}),
      accuracy: d.site.at ? 'client_position_at_death_event' : 'unknown',
      inventory: { source, ...(d.lastAlive.capturedAtMs !== undefined ? { capturedAtMs: d.lastAlive.capturedAtMs } : {}), items },
    };
  }
}
