// Reads the bot's own vitals from the live session WITHOUT sending anything.
//
// Health/food/saturation come from the server's update_health packet (the
// evidence journal timestamps it); XP from the server's experience packet;
// max health from the server-sent max_health attribute with its modifiers.
// Mineflayer initializes XP fields to null and health to undefined, so a value
// that the server has not sent yet stays unknown (never 0).
import { DASHBOARD_BOUNDS, known, unknown, type Known } from '../contracts/dashboard.ts';
import type { JournalEntry } from '../game/server-evidence.ts';

interface AttributeModifier {
  amount?: unknown;
  operation?: unknown;
}
interface AttributeValue {
  value?: unknown;
  modifiers?: unknown;
}

/** The structural slice of a Mineflayer bot the dashboard reads. Read-only. */
export interface BotView {
  username?: string;
  health?: number;
  food?: number;
  foodSaturation?: number;
  isAlive?: boolean;
  quickBarSlot?: number;
  experience?: { level: number | null; points: number | null; progress: number | null };
  game?: { dimension?: unknown; gameMode?: unknown };
  entity?: { attributes?: Record<string, AttributeValue | undefined> };
  currentWindow?: { id?: number; inventoryStart?: number } | null;
}

export interface VitalsEvidence {
  latest<K extends JournalEntry['kind']>(kind: K, test?: (e: Extract<JournalEntry, { kind: K }>) => boolean): Extract<JournalEntry, { kind: K }> | undefined;
}

const MAX_HEALTH_KEYS = ['minecraft:max_health', 'generic.max_health', 'max_health', 'minecraft:generic.max_health'];

/** Vanilla attribute modifier math: add value, add multiplied base, multiply total. */
export function attributeValue(attr: AttributeValue | undefined): number | undefined {
  if (!attr || typeof attr.value !== 'number' || !Number.isFinite(attr.value)) return undefined;
  const mods = Array.isArray(attr.modifiers) ? (attr.modifiers as AttributeModifier[]) : [];
  const amount = (m: AttributeModifier) => (typeof m.amount === 'number' && Number.isFinite(m.amount) ? m.amount : 0);
  let x = attr.value;
  for (const m of mods) if (m.operation === 0) x += amount(m);
  let y = x;
  for (const m of mods) if (m.operation === 1) y += x * amount(m);
  for (const m of mods) if (m.operation === 2) y += y * amount(m);
  return Number.isFinite(y) ? y : undefined;
}

export function readMaxHealth(bot: BotView, observedAtMs: number): Known<number> {
  const attrs = bot.entity?.attributes;
  if (!attrs) return unknown('the server has not sent player attributes yet');
  for (const key of MAX_HEALTH_KEYS) {
    const v = attributeValue(attrs[key]);
    // Vanilla clamps max_health to 1..1024.
    if (v !== undefined) return known(Math.min(1024, Math.max(1, v)), 'server_packet', observedAtMs);
  }
  return unknown('no max_health attribute received');
}

/** Tracks first-seen times so unchanged readings keep their original observation time. */
export class ChangeClock {
  private readonly seen = new Map<string, { sig: string; atMs: number }>();
  at(key: string, value: unknown, now: number): number {
    const sig = JSON.stringify(value);
    const prev = this.seen.get(key);
    if (prev && prev.sig === sig) return prev.atMs;
    this.seen.set(key, { sig, atMs: now });
    return now;
  }
  reset(): void {
    this.seen.clear();
  }
}

export interface VitalsReading {
  health: Known<number>;
  maxHealth: Known<number>;
  food: Known<number>;
  saturation: Known<number>;
  xp: Known<{ level: number; progress: number; totalPoints: number }>;
  alive: Known<boolean>;
  dimension: Known<string>;
  gameMode: Known<string>;
  botName: Known<string>;
  selectedHotbar: Known<number>;
}

const clipName = (s: string) => s.slice(0, DASHBOARD_BOUNDS.shortText);

export function readVitals(bot: BotView, evidence: VitalsEvidence, now: number, changes: ChangeClock): VitalsReading {
  // The journal timestamps the packet; if it was evicted from the bounded journal, Mineflayer's copy of
  // the same server packet is used (it only ever sets these from update_health).
  const j = evidence.latest('health');
  const h =
    j ??
    (typeof bot.health === 'number' && Number.isFinite(bot.health) && typeof bot.food === 'number' && Number.isFinite(bot.food)
      ? { health: bot.health, food: bot.food, atMs: changes.at('healthPacket', [bot.health, bot.food], now) }
      : undefined);
  const NO_HEALTH = 'no health packet received on this connection yet';
  const health: Known<number> = h ? known(Math.max(0, h.health), 'server_packet', h.atMs) : unknown(NO_HEALTH);
  const food: Known<number> = h ? known(Math.min(20, Math.max(0, h.food)), 'server_packet', h.atMs) : unknown(NO_HEALTH);
  const saturation: Known<number> =
    h && typeof bot.foodSaturation === 'number' && Number.isFinite(bot.foodSaturation) ? known(Math.min(20, Math.max(0, bot.foodSaturation)), 'server_packet', h.atMs) : unknown('saturation not received');
  const e = bot.experience;
  let xp: VitalsReading['xp'];
  if (e && typeof e.level === 'number' && typeof e.progress === 'number' && typeof e.points === 'number') {
    const value = { level: Math.max(0, Math.trunc(e.level)), progress: Math.min(1, Math.max(0, e.progress)), totalPoints: Math.max(0, Math.trunc(e.points)) };
    xp = known(value, 'server_packet', changes.at('xp', value, now));
  } else xp = unknown('no experience packet received on this connection yet');
  const maxRaw = readMaxHealth(bot, now);
  const maxHealth: Known<number> = maxRaw.known ? { ...maxRaw, observedAtMs: changes.at('maxHealth', maxRaw.value, now) } : maxRaw;
  const alive: Known<boolean> = h ? known(h.health > 0, 'server_packet', h.atMs) : unknown(NO_HEALTH);
  const dimRaw = bot.game?.dimension;
  const dimension: Known<string> = typeof dimRaw === 'string' && dimRaw ? known(clipName(dimRaw), 'server_packet', changes.at('dimension', dimRaw, now)) : unknown('dimension not received');
  const gmRaw = bot.game?.gameMode;
  const gameMode: Known<string> = typeof gmRaw === 'string' && gmRaw ? known(clipName(gmRaw), 'server_packet', changes.at('gameMode', gmRaw, now)) : unknown('game mode not received');
  const botName: Known<string> = typeof bot.username === 'string' && bot.username ? known(clipName(bot.username), 'server_packet', changes.at('botName', bot.username, now)) : unknown('bot name not known yet');
  // The selected hotbar slot is the client's choice; the server does not echo it back.
  const held = evidence.latest('held_slot');
  const qb = bot.quickBarSlot;
  const selectedHotbar: Known<number> =
    typeof qb === 'number' && qb >= 0 && qb <= 8
      ? known(qb, held && held.slot === qb ? 'server_packet' : 'client_selected', changes.at('hotbar', qb, now))
      : unknown('selected hotbar slot not known');
  return { health, maxHealth, food, saturation, xp, alive, dimension, gameMode, botName, selectedHotbar };
}
