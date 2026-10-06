// Bounded journal of SERVER-SENT packets that can confirm world effects.
//
// Mineflayer's client model mixes server data with optimistic local updates
// (e.g. `dig` sets the block to air locally before the server answers, and
// window clicks are applied to the local model before any reply). Skills and
// predicates therefore confirm effects against this journal, which records only
// what the server actually sent: block changes, item pickups (`collect`), item
// entity spawns/metadata, entity status/damage/destroy, window contents/slots/
// properties, health, and server position corrections.
import type { EventEmitter } from 'node:events';

export interface ItemStackData {
  key: string;
  count: number;
}

export type ServerRecord =
  | { kind: 'block_change'; x: number; y: number; z: number; stateId: number }
  | { kind: 'collect'; collectedEntityId: number; collectorEntityId: number; count: number }
  | { kind: 'item_spawn'; entityId: number; x: number; y: number; z: number }
  | { kind: 'item_stack'; entityId: number; stack: ItemStackData }
  | { kind: 'entity_destroy'; entityIds: number[] }
  | { kind: 'entity_status'; entityId: number; status: number }
  | { kind: 'damage'; entityId: number; sourceEntityId: number | null }
  | { kind: 'entity_flags'; entityId: number; key: number; value: number | boolean }
  | { kind: 'window_items'; windowId: number; stateId: number; slots: Array<ItemStackData & { slot: number }>; cursor: ItemStackData | null }
  | { kind: 'set_slot'; windowId: number; slot: number; stack: ItemStackData | null }
  | { kind: 'player_slot'; inventoryIndex: number; stack: ItemStackData | null }
  | { kind: 'window_property'; windowId: number; property: number; value: number }
  | { kind: 'open_window'; windowId: number; windowType: string }
  | { kind: 'close_window'; windowId: number }
  | { kind: 'health'; health: number; food: number }
  | { kind: 'position_correction'; x: number; y: number; z: number }
  | { kind: 'held_slot'; slot: number }
  /** Server acknowledgement of block-interaction packets up to a client sequence number. */
  | { kind: 'ack'; sequence: number };

export type JournalEntry = ServerRecord & { seq: number; atMs: number };

export interface WaitOptions {
  /** Only entries with seq > afterSeq match. */
  afterSeq: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

type Registry = {
  items: Record<number, { name: string } | undefined>;
  entitiesByName: Record<string, { id: number } | undefined>;
};

interface RawStack {
  itemCount?: number;
  itemId?: number;
}

export const ITEM_STACK_METADATA_KEY = 8;

/** Records server packets for one connection. Bounded ring buffer. */
export class ServerEvidence {
  private readonly entries: JournalEntry[] = [];
  private seqValue = 0;
  private readonly waiters = new Set<{ test: (e: JournalEntry) => boolean; resolve: (e: JournalEntry | undefined) => void }>();
  private readonly listeners: Array<[string, (...args: unknown[]) => void]> = [];
  private readonly itemEntities = new Set<number>();
  /** Non-item entities whose small metadata flags are recorded (set by interaction skills). */
  private readonly watched = new Set<number>();
  private readonly client: EventEmitter;
  private readonly registry: Registry;
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(client: EventEmitter, registry: Registry, now: () => number = Date.now, capacity = 6_000) {
    this.client = client;
    this.registry = registry;
    this.now = now;
    this.capacity = capacity;
  }

  get seq(): number {
    return this.seqValue;
  }

  /**
   * Latest SERVER statement per block position (block_change / multi_block_change)
   * while its chunk stays loaded. Mineflayer's world also contains optimistic
   * client predictions (e.g. a finished dig sets air locally); positions with
   * such a pending prediction are tracked so evaluators never treat the client
   * model as server truth. Facts are dropped on chunk unload, respawn and login
   * (dimension change / reconnect), since the server stops reporting them then.
   */
  private readonly blockFacts = new Map<string, { stateId: number; seq: number; atMs: number }>();
  private readonly predictions = new Map<string, number>();
  private static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
  serverBlock(x: number, y: number, z: number): { stateId: number; seq: number; atMs: number } | undefined {
    return this.blockFacts.get(ServerEvidence.key(x, y, z));
  }
  /** Marks a client-side prediction at a position (cleared by the next server statement there). */
  /** Total client predictions marked on this connection (evidence metric). */
  predictionsNoted = 0;
  notePrediction(x: number, y: number, z: number): void {
    this.predictionsNoted += 1;
    this.predictions.set(ServerEvidence.key(x, y, z), this.seqValue);
    if (this.predictions.size > 256) this.predictions.delete(this.predictions.keys().next().value as string);
  }
  predictionPending(x: number, y: number, z: number): boolean {
    return this.predictions.has(ServerEvidence.key(x, y, z));
  }
  private forgetWorldFacts(filter?: (x: number, z: number) => boolean): void {
    for (const map of [this.blockFacts, this.predictions] as Array<Map<string, unknown>>) {
      for (const k of [...map.keys()]) {
        const [x, , z] = k.split(',').map(Number) as [number, number, number];
        if (!filter || filter(x, z)) map.delete(k);
      }
    }
  }

  /** Last container state id the server sent (window_items / set_slot); used for window clicks. */
  stateId = -1;

  /**
   * Connection-unique sequence numbers for our block-interaction packets. They
   * start far above Mineflayer's own small counters so a server acknowledgement
   * >= our sequence can only mean our packet (or a later one of ours) was processed.
   */
  private nextSequenceValue = 1_000_000;
  nextSequence(): number {
    this.nextSequenceValue += 1;
    return this.nextSequenceValue;
  }

  private readonly recordListeners = new Set<(e: JournalEntry) => void>();
  /** Subscribes to every recorded entry (synchronously, in packet order). */
  onRecord(listener: (e: JournalEntry) => void): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  private stack(raw: RawStack | null | undefined): ItemStackData | null {
    if (!raw || !raw.itemCount || raw.itemId === undefined) return null;
    const name = this.registry.items[raw.itemId]?.name;
    return { key: `minecraft:${name ?? `unknown_${raw.itemId}`}`, count: raw.itemCount };
  }

  record(record: ServerRecord): JournalEntry {
    this.seqValue += 1;
    const entry = { ...record, seq: this.seqValue, atMs: this.now() } as JournalEntry;
    this.entries.push(entry);
    if (entry.kind === 'block_change') {
      const k = ServerEvidence.key(entry.x, entry.y, entry.z);
      this.blockFacts.delete(k);
      this.blockFacts.set(k, { stateId: entry.stateId, seq: entry.seq, atMs: entry.atMs });
      if (this.blockFacts.size > 8_192) this.blockFacts.delete(this.blockFacts.keys().next().value as string);
      this.predictions.delete(k);
    }
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    for (const listener of [...this.recordListeners]) {
      try {
        listener(entry);
      } catch {
        // a listener failure must not break evidence recording
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.test(entry)) {
        this.waiters.delete(waiter);
        waiter.resolve(entry);
      }
    }
    return entry;
  }

  private on<P>(name: string, handler: (packet: P) => void): void {
    const listener = handler as (...args: unknown[]) => void;
    this.client.on(name, listener);
    this.listeners.push([name, listener]);
  }

  /** Installs raw packet listeners. Called once per created bot, before login. */
  attach(): void {
    const itemType = this.registry.entitiesByName['item']?.id;
    this.on('unload_chunk', (p: { chunkX: number; chunkZ: number }) => {
      this.forgetWorldFacts((x, z) => Math.floor(x / 16) === p.chunkX && Math.floor(z / 16) === p.chunkZ);
    });
    this.on('map_chunk', (p: { x: number; z: number }) => {
      // A fresh chunk replaces everything known about its blocks.
      this.forgetWorldFacts((x, z) => Math.floor(x / 16) === p.x && Math.floor(z / 16) === p.z);
    });
    this.on('respawn', () => this.forgetWorldFacts());
    this.on('login', () => this.forgetWorldFacts());
    this.on('block_change', (p: { location: { x: number; y: number; z: number }; type: number }) => {
      this.record({ kind: 'block_change', x: p.location.x, y: p.location.y, z: p.location.z, stateId: p.type });
    });
    this.on('multi_block_change', (p: { chunkCoordinates?: { x: number; y: number; z: number }; records?: Array<number | bigint> }) => {
      const c = p.chunkCoordinates;
      if (!c || !Array.isArray(p.records)) return;
      for (const raw of p.records) {
        const r = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
        const local = Number(r & 0xfffn);
        const stateId = Number(r >> 12n);
        this.record({
          kind: 'block_change',
          x: c.x * 16 + ((local >> 8) & 0x0f),
          y: c.y * 16 + (local & 0x0f),
          z: c.z * 16 + ((local >> 4) & 0x0f),
          stateId,
        });
      }
    });
    this.on('collect', (p: { collectedEntityId: number; collectorEntityId: number; pickupItemCount: number }) => {
      this.record({ kind: 'collect', collectedEntityId: p.collectedEntityId, collectorEntityId: p.collectorEntityId, count: p.pickupItemCount });
    });
    this.on('spawn_entity', (p: { entityId: number; type: number; x: number; y: number; z: number }) => {
      if (itemType === undefined || p.type !== itemType) return;
      this.itemEntities.add(p.entityId);
      if (this.itemEntities.size > 2_000) this.itemEntities.delete(this.itemEntities.values().next().value as number);
      this.record({ kind: 'item_spawn', entityId: p.entityId, x: p.x, y: p.y, z: p.z });
    });
    this.on('entity_metadata', (p: { entityId: number; metadata?: Array<{ key: number; type: string; value: unknown }> }) => {
      for (const m of p.metadata ?? []) {
        if (this.itemEntities.has(p.entityId) && m.key === ITEM_STACK_METADATA_KEY && m.type === 'item_stack') {
          const stack = this.stack(m.value as RawStack);
          if (stack) this.record({ kind: 'item_stack', entityId: p.entityId, stack });
        } else if (this.watched.has(p.entityId) && (m.type === 'byte' || m.type === 'boolean' || m.type === 'varint')) {
          // Small flag values (e.g. sheep sheared/colour byte, baby flags) for entity interaction evidence.
          const value = m.value as number | boolean;
          if (typeof value === 'number' || typeof value === 'boolean') this.record({ kind: 'entity_flags', entityId: p.entityId, key: m.key, value });
        }
      }
    });
    this.on('entity_destroy', (p: { entityIds: number[] }) => {
      for (const id of p.entityIds) this.itemEntities.delete(id);
      this.record({ kind: 'entity_destroy', entityIds: [...p.entityIds] });
    });
    this.on('entity_status', (p: { entityId: number; entityStatus: number }) => {
      this.record({ kind: 'entity_status', entityId: p.entityId, status: p.entityStatus });
    });
    this.on('damage_event', (p: { entityId: number; sourceCauseId: number }) => {
      this.record({ kind: 'damage', entityId: p.entityId, sourceEntityId: p.sourceCauseId > 0 ? p.sourceCauseId - 1 : null });
    });
    this.on('window_items', (p: { windowId: number; stateId: number; items: RawStack[]; carriedItem?: RawStack }) => {
      this.stateId = p.stateId;
      const slots: Array<ItemStackData & { slot: number }> = [];
      p.items.forEach((raw, slot) => {
        const s = this.stack(raw);
        if (s) slots.push({ ...s, slot });
      });
      this.record({ kind: 'window_items', windowId: p.windowId, stateId: p.stateId, slots, cursor: this.stack(p.carriedItem) });
    });
    this.on('set_slot', (p: { windowId: number; stateId?: number; slot: number; item: RawStack }) => {
      if (typeof p.stateId === 'number') this.stateId = p.stateId;
      this.record({ kind: 'set_slot', windowId: p.windowId, slot: p.slot, stack: this.stack(p.item) });
    });
    this.on('set_player_inventory', (p: { slotId: number; contents: RawStack }) => {
      this.record({ kind: 'player_slot', inventoryIndex: p.slotId, stack: this.stack(p.contents) });
    });
    this.on('craft_progress_bar', (p: { windowId: number; property: number; value: number }) => {
      this.record({ kind: 'window_property', windowId: p.windowId, property: p.property, value: p.value });
    });
    this.on('open_window', (p: { windowId: number; inventoryType: number | string }) => {
      this.record({ kind: 'open_window', windowId: p.windowId, windowType: String(p.inventoryType) });
    });
    this.on('close_window', (p: { windowId: number }) => {
      this.record({ kind: 'close_window', windowId: p.windowId });
    });
    this.on('update_health', (p: { health: number; food: number }) => {
      this.record({ kind: 'health', health: p.health, food: p.food });
    });
    this.on('position', (p: { x: number; y: number; z: number }) => {
      this.record({ kind: 'position_correction', x: p.x, y: p.y, z: p.z });
    });
    this.on('acknowledge_player_digging', (p: { sequenceId: number }) => {
      this.record({ kind: 'ack', sequence: p.sequenceId });
    });
    this.on('held_item_slot', (p: { slot: number }) => {
      this.record({ kind: 'held_slot', slot: p.slot });
    });
  }

  /** Starts recording metadata flags for an entity a skill is about to interact with (bounded). */
  watch(entityId: number): void {
    this.watched.add(entityId);
    if (this.watched.size > 64) this.watched.delete(this.watched.values().next().value as number);
  }

  detach(): void {
    this.recordListeners.clear();
    for (const [name, handler] of this.listeners.splice(0)) this.client.off(name, handler);
    for (const waiter of [...this.waiters]) waiter.resolve(undefined);
    this.waiters.clear();
  }

  /** Entries recorded after `afterSeq` that match `test` (oldest first). */
  since<K extends ServerRecord['kind']>(afterSeq: number, kind: K, test: (e: Extract<JournalEntry, { kind: K }>) => boolean = () => true): Array<Extract<JournalEntry, { kind: K }>> {
    const out: Array<Extract<JournalEntry, { kind: K }>> = [];
    for (const e of this.entries) {
      if (e.seq > afterSeq && e.kind === kind && test(e as Extract<JournalEntry, { kind: K }>)) out.push(e as Extract<JournalEntry, { kind: K }>);
    }
    return out;
  }

  /** Most recent matching entry, if any. */
  latest<K extends ServerRecord['kind']>(kind: K, test: (e: Extract<JournalEntry, { kind: K }>) => boolean = () => true): Extract<JournalEntry, { kind: K }> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i] as JournalEntry;
      if (e.kind === kind && test(e as Extract<JournalEntry, { kind: K }>)) return e as Extract<JournalEntry, { kind: K }>;
    }
    return undefined;
  }

  /**
   * Resolves with the first entry after `afterSeq` that matches, or undefined on
   * timeout/abort. Already-recorded entries are checked first.
   */
  waitFor<K extends ServerRecord['kind']>(kind: K, test: (e: Extract<JournalEntry, { kind: K }>) => boolean, options: WaitOptions): Promise<Extract<JournalEntry, { kind: K }> | undefined> {
    const existing = this.since(options.afterSeq, kind, test)[0];
    if (existing) return Promise.resolve(existing);
    if (options.signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = {
        test: (e: JournalEntry) => e.seq > options.afterSeq && e.kind === kind && test(e as Extract<JournalEntry, { kind: K }>),
        resolve: (e: JournalEntry | undefined) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(e as Extract<JournalEntry, { kind: K }> | undefined);
        },
      };
      const onAbort = () => {
        this.waiters.delete(waiter);
        waiter.resolve(undefined);
      };
      const timer = setTimeout(onAbort, options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }
}

const TAPPED = Symbol('chunkbot.predictionTap');

/**
 * Marks Mineflayer's LOCAL world predictions in the evidence journal.
 * Mineflayer applies server block updates through its internal
 * updateBlockState, but local optimistic changes (e.g. a finished dig set to
 * air before the server answers) go through the public `bot._updateBlockState`.
 * Wrapping that property marks exactly those voxels as pending predictions
 * until the server states them (block_change / multi_block_change / chunk).
 * Idempotent; safe to call before the blocks plugin is injected (retries on
 * inject_allowed and login).
 */
export function tapClientPredictions(bot: unknown, evidence: () => ServerEvidence | undefined): void {
  const b = bot as { _updateBlockState?: (point: { x: number; y: number; z: number }, stateId: number) => unknown; [TAPPED]?: boolean; once?: (event: string, fn: () => void) => void };
  const tryTap = (): boolean => {
    if (b[TAPPED]) return true;
    const original = b._updateBlockState;
    if (typeof original !== 'function') return false;
    b._updateBlockState = (point, stateId) => {
      evidence()?.notePrediction(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
      return original(point, stateId);
    };
    b[TAPPED] = true;
    return true;
  };
  if (tryTap()) return;
  b.once?.('inject_allowed', () => void tryTap());
  b.once?.('login', () => void tryTap());
}
