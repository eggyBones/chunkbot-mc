// Approved session read for immediate safety: plain-data, provenance-labeled
// facts built from the live session (client world model + client physics),
// the safety packet tracker (server statements) and the shared perception
// visibility rules. Read-only: never sends packets, never actuates.
//
// Entities are included only when VISIBLE now (line of sight from the eye
// within the scan radius, perception's isEntityVisible over sessionWorld);
// an entity out of sight is not read at all (its position is never consulted)
// and its approach history is dropped.
import blockLoader from 'prismarine-block';
import type { Vec3 } from '../contracts/common.ts';
import { AIR_MAX, type SafetyAirFact, type SafetyEntityFact, type SafetyEquipmentFact, type SafetyItemFact, type SafetySelfFacts } from '../contracts/safety.ts';
import type { GameSession } from '../game/connection.ts';
import { eyeOf, sessionWorld, type PerceptionService } from '../perception/perception.ts';
import { isBlockVisible, isEntityVisible } from '../perception/visibility.ts';
import { dispositionOf } from './dispositions.ts';
import { fluidState, type SafetyBlock, type SafetyBlockReader } from './geometry.ts';
import type { SafetyItemRegistry, SafetyTracker } from './tracker.ts';

type Bot = GameSession['bot'];

/** Supplied ONLY by the connection's completed protocol-checked status ping,
 * copied onto its current ready session. Not config or library labels. The
 * optional shape lets the shared writer deliver the seam independently;
 * absence cannot establish an omitted metadata default. */
export type SafetySession = GameSession & {
  readonly serverReported?: Readonly<{ version: string; protocol: number }>;
};

interface RawEntity {
  id: number;
  uuid?: string;
  name?: string;
  type?: string;
  position?: { x: number; y: number; z: number };
  height?: number;
  metadata?: Record<number, unknown>;
  heldItem?: { name?: string } | null;
  isValid?: boolean;
}

/** Exact-version registry facts the tracker/adapter need (installed minecraft-data via bot.registry). */
export function registryFacts(bot: Bot): SafetyRegistryFacts {
  return registryFactsOf(bot.registry);
}

/** Both createClient and Mineflayer normalize 26.1.2 to "26.1". Only the
 * current ready connection's status-ping report proves the exact release.
 * Require matching library labels/protocol/registry as corroboration; none
 * of those, alone or together, can replace a missing/ambiguous report. */
export function exactSafetyVersion(bot: Bot, reported: SafetySession['serverReported']): string | undefined {
  const version = reported?.version;
  const canonical = version === '26.1.2' ? '26.1' : version === '26.2' ? '26.2' : undefined;
  const protocol = version === '26.1.2' ? 775 : 776;
  const registry = bot.registry as unknown as { version?: { minecraftVersion?: string; version?: number } };
  // Installed loader assigns a number; its declaration incorrectly says string.
  const botProtocol = (bot as unknown as { protocolVersion?: unknown }).protocolVersion;
  if (!canonical || reported?.protocol !== protocol || botProtocol !== protocol) return undefined;
  if (bot.version !== version && bot.version !== canonical) return undefined;
  if (bot._client.version !== version && bot._client.version !== canonical) return undefined;
  if (registry.version?.minecraftVersion !== canonical || registry.version.version !== protocol) return undefined;
  return version;
}

export type SafetyRegistryFacts = SafetyItemRegistry & { category(entity: string): string | undefined };

/** Same facts from a raw minecraft-data registry object (as attached before login). */
export function registryFactsOf(raw: unknown): SafetyRegistryFacts {
  const reg = raw as {
    items: Record<number, { name: string; maxDurability?: number } | undefined>;
    itemsByName: Record<string, { maxDurability?: number } | undefined>;
    entitiesByName: Record<string, { metadataKeys?: string[]; category?: string } | undefined>;
    entities: Record<number, { name: string } | undefined>;
  };
  return {
    nameOf: (id) => reg.items[id]?.name,
    maxDurability: (key) => reg.itemsByName[key.replace(/^minecraft:/, '')]?.maxDurability,
    metadataIndex: (entity, key) => {
      const i = reg.entitiesByName[entity]?.metadataKeys?.indexOf(key);
      return i === undefined || i < 0 ? undefined : i;
    },
    category: (entity) => reg.entitiesByName[entity]?.category,
    entityNameOf: (type) => reg.entities[type]?.name,
  };
}

/** sessionWorld plus the `waterlogged` block state (prismarine-block properties by state id). */
export function safetyWorld(session: GameSession): SafetyBlockReader {
  const world = sessionWorld(session);
  const Block = blockLoader(session.bot.registry as never) as unknown as { fromStateId(id: number, biome: number): { getProperties(): Record<string, unknown> } };
  const cache = new Map<number, boolean>();
  return {
    blockAt(x, y, z): SafetyBlock | null {
      const b = world.blockAt(x, y, z);
      if (!b) return null;
      let wl = cache.get(b.stateId);
      if (wl === undefined) {
        try {
          wl = b.stateId > 0 ? Block.fromStateId(b.stateId, 0).getProperties()['waterlogged'] === true : false;
        } catch {
          wl = false;
        }
        cache.set(b.stateId, wl);
      }
      return { name: b.name, shapes: b.shapes, ...(b.level !== undefined ? { level: b.level } : {}), ...(wl ? { waterlogged: true } : {}) };
    },
  };
}

export interface ReadOptions {
  scanRadius: number;
  approachWindowMs: number;
  provokedWindowMs: number;
}

/** Stateful (per connection) reader: approach history for visible entities only. */
export class SessionSafetyReader {
  private readonly history = new Map<number, Array<{ atMs: number; d: number }>>();
  private epoch = -1;

  private readonly deps: { session: () => SafetySession | undefined; perception: Pick<PerceptionService, 'isOwnerEntity'>; tracker: SafetyTracker; now: () => number };

  constructor(deps: { session: () => SafetySession | undefined; perception: Pick<PerceptionService, 'isOwnerEntity'>; tracker: SafetyTracker; now: () => number }) {
    this.deps = deps;
  }

  reset(): void {
    this.history.clear();
  }

  world(): SafetyBlockReader | undefined {
    const s = this.deps.session();
    return s ? safetyWorld(s) : undefined;
  }

  /** Floor-face visibility from the eye (observed geometry for exit/retreat targets). */
  visible(): ((x: number, y: number, z: number) => boolean) | undefined {
    const s = this.deps.session();
    if (!s) return undefined;
    const world = sessionWorld(s);
    const eye = eyeOf(s.bot);
    return (x, y, z) => isBlockVisible(world, eye, x, y, z);
  }

  self(): SafetySelfFacts | undefined {
    const s = this.deps.session();
    if (!s || !s.bot.entity?.position) return undefined;
    if (s.connectionEpoch !== this.epoch) {
      this.epoch = s.connectionEpoch;
      this.reset();
    }
    const bot = s.bot;
    const now = this.deps.now();
    const t = this.deps.tracker;
    const p = bot.entity.position;
    const world = safetyWorld(s);
    const eyeHeight = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
    const fs = fluidState(world, { x: p.x, y: p.y, z: p.z }, eyeHeight);
    const air: SafetyAirFact =
      t.air && t.connectionEpoch === s.connectionEpoch
        ? { value: t.air.value, max: AIR_MAX, source: 'server_metadata', observedAtMs: t.air.atMs, trend: t.air.previous === null ? 'unknown' : t.air.value < t.air.previous ? 'falling' : t.air.value > t.air.previous ? 'rising' : 'steady' }
        : { value: null, max: AIR_MAX, source: 'unknown', observedAtMs: null, trend: 'unknown' };
    const vitals = t.vitals && t.connectionEpoch === s.connectionEpoch ? t.vitals : null;
    return {
      connectionEpoch: s.connectionEpoch,
      dimension: String(bot.game.dimension),
      observedAtMs: now,
      position: { x: p.x, y: p.y, z: p.z },
      health: vitals?.health ?? bot.health ?? 0,
      food: vitals?.food ?? bot.food ?? 0,
      vitalsSource: vitals ? 'server_update_health' : 'client_model',
      air,
      fluid: { feetIn: fs.feetIn, eyeIn: fs.eyeIn, columnFluid: fs.columnFluid, support: fs.support, depth: fs.depth, wadeable: fs.wadeable, headroom: fs.headroom, surfaceDy: fs.surfaceDy, onGround: Boolean(bot.entity.onGround), source: 'local_estimate' },
      equipment: this.equipment(bot),
      recentDamage: t.damage.slice(0, 8).map((d) => ({ ...d })),
    };
  }

  private equipment(bot: Bot): SafetyEquipmentFact {
    const t = this.deps.tracker;
    if (!t.fullSync) return { mainHand: null, heldHotbar: null, hotbar: [], armor: [], source: 'unavailable', observedAtMs: null };
    const held = typeof (bot as { quickBarSlot?: number }).quickBarSlot === 'number' ? (bot as { quickBarSlot: number }).quickBarSlot : t.heldHotbarServer;
    const hotbar: SafetyItemFact[] = [];
    for (let i = 0; i < 9; i += 1) {
      const it = t.item(36 + i);
      if (it) hotbar.push(it);
    }
    const armor: SafetyItemFact[] = [];
    for (const slot of [5, 6, 7, 8]) {
      const it = t.item(slot);
      if (it) armor.push(it);
    }
    // The main hand counts as verified only when the client's selected stack matches the server-stated slot.
    let mainHand = held !== null && held !== undefined ? t.item(36 + held) : null;
    const clientHeld = (bot as { heldItem?: { name?: string } | null }).heldItem;
    if (mainHand && clientHeld?.name && `minecraft:${clientHeld.name}` !== mainHand.key) mainHand = null;
    return { mainHand, heldHotbar: held ?? null, hotbar, armor, source: 'server_slots', observedAtMs: t.slotsAtMs };
  }

  /** Visible entities within the scan radius (never global; never an out-of-sight position). */
  entities(opts: ReadOptions): SafetyEntityFact[] {
    const s = this.deps.session();
    if (!s || !s.bot.entity?.position) return [];
    const bot = s.bot;
    const now = this.deps.now();
    const world = sessionWorld(s);
    const eye = eyeOf(bot);
    const self = bot.entity.position;
    const reg = registryFacts(bot);
    const recentCause = new Map<number, number>();
    for (const d of this.deps.tracker.damage) {
      if (now - d.atMs > opts.provokedWindowMs) continue;
      for (const id of [d.causeEntityId, d.directEntityId]) if (id !== null && !recentCause.has(id)) recentCause.set(id, d.atMs);
    }
    const out: SafetyEntityFact[] = [];
    const seen = new Set<number>();
    for (const raw of Object.values(bot.entities) as unknown as RawEntity[]) {
      if (!raw || raw === (bot.entity as unknown as RawEntity) || !raw.position || raw.isValid === false) continue;
      const name = raw.name ?? 'unknown';
      if (name === 'item' || name === 'experience_orb') continue;
      if (this.deps.tracker.dying.has(raw.id)) continue; // server death status: dying body, not a threat
      const distance = Math.hypot(raw.position.x - self.x, raw.position.y - self.y, raw.position.z - self.z);
      if (distance > opts.scanRadius) continue;
      const height = raw.height ?? 1;
      if (!isEntityVisible(world, eye, raw.position, height)) continue;
      const isOwner = this.deps.perception.isOwnerEntity(bot, raw as never);
      const heldItem = raw.heldItem?.name ? `minecraft:${raw.heldItem.name}` : null;
      const disp = isOwner ? { disposition: 'owner' as const } : raw.type === 'player' ? { disposition: 'player' as const } : dispositionOf(name, reg.category(name), heldItem);
      if (disp.disposition === 'passive') continue;
      seen.add(raw.id);
      const meta = raw.metadata ?? {};
      const flag = (key: string): unknown => {
        const i = reg.metadataIndex(name, key);
        return i === undefined ? undefined : meta[i];
      };
      const mobFlags = flag('mob_flags');
      const baby = flag('baby');
      const version = exactSafetyVersion(bot, s.serverReported);
      const adultDefault = baby === undefined && version !== undefined && this.deps.tracker.adultDefault(raw.id, name, version, { connectionEpoch: s.connectionEpoch, uuid: raw.uuid });
      const swell = flag('swell_dir');
      const ignited = flag('is_ignited');
      const hist = this.history.get(raw.id) ?? [];
      hist.push({ atMs: now, d: distance });
      while (hist.length > 0 && now - (hist[0] as { atMs: number }).atMs > opts.approachWindowMs * 2) hist.shift();
      this.history.set(raw.id, hist);
      const old = hist.find((h) => now - h.atMs >= opts.approachWindowMs * 0.5);
      out.push({
        entityId: raw.id,
        key: `minecraft:${name}`,
        disposition: disp.disposition,
        at: { x: raw.position.x, y: raw.position.y, z: raw.position.z },
        distance: Math.round(distance * 100) / 100,
        height,
        approaching: old ? old.d - distance >= 0.75 : null,
        aggressive: typeof mobFlags === 'number' ? (mobFlags & 0x04) !== 0 : null,
        baby: typeof baby === 'boolean' ? baby : adultDefault ? false : null,
        ageEvidence: typeof baby === 'boolean' ? 'server_metadata' : adultDefault ? 'vanilla_spawn_default' : reg.metadataIndex(name, 'baby') === undefined ? 'not_applicable' : 'unknown',
        fuse: name === 'creeper' ? { swelling: typeof swell === 'number' && swell > 0, ignited: ignited === true } : null,
        heldItem,
        damagedSelfAtMs: recentCause.get(raw.id) ?? null,
        observedAtMs: now,
      });
      if (out.length >= 24) break;
    }
    // Out-of-sight entities: drop their history (no hidden tracking).
    for (const id of [...this.history.keys()]) if (!seen.has(id)) this.history.delete(id);
    return out.sort((a, b) => a.distance - b.distance);
  }

  /** Position of the bot (client physics) for displacement checks. */
  position(): Vec3 | undefined {
    const p = this.deps.session()?.bot.entity?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : undefined;
  }
}

/** Whether an entity id is visible now (fresh LOS within radius); never reads a hidden position. */
export function entityVisibleNow(session: GameSession, entityId: number, radius: number): boolean {
  const e = session.bot.entities[entityId] as unknown as RawEntity | undefined;
  if (!e?.position) return false;
  if (Math.hypot(e.position.x - session.bot.entity.position.x, e.position.y - session.bot.entity.position.y, e.position.z - session.bot.entity.position.z) > radius) return false;
  return isEntityVisible(sessionWorld(session), eyeOf(session.bot), e.position, e.height ?? 1);
}
