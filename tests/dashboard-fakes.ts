// Shared dashboard test doubles: a fake connection whose session uses the REAL
// ServerEvidence journal fed by raw packet events, so projections are tested
// through the same evidence path as the live bot.
import { EventEmitter } from 'node:events';
import type { GameLifecycleEvent, Unsubscribe } from '../src/contracts/index.ts';
import type { DashboardGame, DashboardSession } from '../src/dashboard/publisher.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';

export const ITEMS: Record<number, { name: string }> = { 1: { name: 'oak_log' }, 2: { name: 'cobblestone' }, 3: { name: 'iron_helmet' }, 4: { name: 'shield' }, 5: { name: 'bread' }, 6: { name: 'stone_pickaxe' } };
export const stack = (itemId: number, itemCount: number) => ({ itemId, itemCount });

export interface FakeBot {
  username?: string;
  health?: number;
  food?: number;
  foodSaturation?: number;
  quickBarSlot?: number;
  experience: { level: number | null; points: number | null; progress: number | null };
  game: { dimension?: string; gameMode?: string };
  entity: { attributes?: Record<string, { value: number; modifiers: Array<{ amount: number; operation: number }> }>; position?: { x: number; y: number; z: number } };
  listeners?: Map<string, Set<() => void>>;
  on?(event: string, fn: () => void): void;
  removeListener?(event: string, fn: () => void): void;
  emit?(event: string): void;
  currentWindow: { id: number; inventoryStart: number } | null;
}

export class FakeConnection implements DashboardGame {
  state: DashboardGame['state'] = 'disconnected';
  connectionEpoch = 0;
  private readonly events = new EventEmitter();
  client = new EventEmitter();
  evidence: ServerEvidence;
  bot: FakeBot;
  clock: { t: number };

  constructor(clock: { t: number }) {
    this.clock = clock;
    this.evidence = new ServerEvidence(this.client, { items: ITEMS, entitiesByName: {} }, () => this.clock.t);
    this.bot = FakeConnection.newBot();
  }

  static newBot(): FakeBot {
    const listeners = new Map<string, Set<() => void>>();
    return {
      experience: { level: null, points: null, progress: null },
      game: {},
      entity: {},
      currentWindow: null,
      listeners,
      on: (e, fn) => void (listeners.get(e) ?? listeners.set(e, new Set()).get(e)!).add(fn),
      removeListener: (e, fn) => void listeners.get(e)?.delete(fn),
      emit: (e) => listeners.get(e)?.forEach((fn) => fn()),
    };
  }

  /** The server set the position (Mineflayer applies the packet, then emits forcedMove). */
  serverTeleport(x: number, y: number, z: number): void {
    this.bot.entity.position = { x, y, z };
    this.bot.emit?.('forcedMove');
  }

  onLifecycle(listener: (event: GameLifecycleEvent) => void): Unsubscribe {
    this.events.on('lifecycle', listener);
    return () => this.events.off('lifecycle', listener);
  }

  emit(e: GameLifecycleEvent): void {
    this.events.emit('lifecycle', e);
  }

  session(): DashboardSession | undefined {
    if (this.state !== 'ready') return undefined;
    return { bot: this.bot, connectionEpoch: this.connectionEpoch, evidence: this.evidence };
  }

  /** New connection epoch with a fresh journal and bot (like a reconnect). */
  join(): void {
    this.connectionEpoch += 1;
    this.state = 'joining';
    this.evidence.detach();
    this.client = new EventEmitter();
    this.evidence = new ServerEvidence(this.client, { items: ITEMS, entitiesByName: {} }, () => this.clock.t);
    this.evidence.attach();
    this.bot = FakeConnection.newBot();
    this.emit({ type: 'joining', connectionEpoch: this.connectionEpoch });
  }

  ready(): void {
    this.state = 'ready';
    this.bot.username = 'Chunkbot';
    this.bot.game = { dimension: 'overworld', gameMode: 'survival' };
    this.emit({ type: 'ready', connectionEpoch: this.connectionEpoch, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, gameMode: 'survival', serverOnlineMode: false } });
  }

  end(reason: 'disconnected' | 'kicked' = 'disconnected'): void {
    this.state = 'ended';
    this.emit({ type: 'ended', connectionEpoch: this.connectionEpoch, reason, detail: 'socket closed by server' });
  }

  /** Raw server packets (as minecraft-protocol emits them). */
  health(health: number, food: number, saturation = 5): void {
    this.bot.health = health;
    this.bot.food = food;
    this.bot.foodSaturation = saturation;
    this.client.emit('update_health', { health, food, foodSaturation: saturation });
  }
  xp(level: number, progress: number, total: number): void {
    this.bot.experience = { level, progress, points: total };
  }
  windowItems(windowId: number, items: Array<{ itemId: number; itemCount: number } | null>): void {
    this.client.emit('window_items', { windowId, stateId: 1, items: items.map((i) => i ?? { itemCount: 0 }) });
  }
  setSlot(windowId: number, slot: number, item: { itemId: number; itemCount: number } | null): void {
    this.client.emit('set_slot', { windowId, stateId: 2, slot, item: item ?? { itemCount: 0 } });
  }
  playerSlot(slotId: number, contents: { itemId: number; itemCount: number } | null): void {
    this.client.emit('set_player_inventory', { slotId, contents: contents ?? { itemCount: 0 } });
  }
  openWindow(windowId: number, inventoryStart: number, type = 'minecraft:generic_9x3'): void {
    this.bot.currentWindow = { id: windowId, inventoryStart };
    this.client.emit('open_window', { windowId, inventoryType: type });
  }
}

/** A window-0 contents array (46 slots) with the given slot -> stack entries. */
export function window0(entries: Record<number, { itemId: number; itemCount: number }>): Array<{ itemId: number; itemCount: number } | null> {
  return Array.from({ length: 46 }, (_, i) => entries[i] ?? null);
}
