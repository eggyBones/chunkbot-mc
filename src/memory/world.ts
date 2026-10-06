// Read-only live-world port used by the memory recorder, plus the adapter
// over the installed perception/ledger/session. Memory never issues game
// commands; it only reads bounded, already-filtered evidence:
//   - the latest filtered observation snapshot (line of sight only),
//   - a voxel's CURRENT content only when it is directly observable now
//     (inside the observation radius, loaded, server-stated (no pending client
//     prediction), and either a visible block face or a clear line of sight to an
//     empty voxel),
//   - server-confirmed ledger entries attributed to one action id,
//   - a synchronous death context captured BEFORE lifecycle invalidation.
import type { ObservationSnapshot } from '../contracts/index.ts';
import type { DeathPayload } from '../contracts/memory.ts';
import type { EvidenceLedger, LedgerEntry } from '../execution/ledger.ts';
import type { GameSession } from '../game/connection.ts';
import { eyeOf, sessionWorld, type PerceptionService } from '../perception/perception.ts';
import { UNCONFIRMED_BLOCK, isBlockVisible, lineOfSight } from '../perception/visibility.ts';

export interface ActionEvidence {
  /** Server-confirmed block changes the action caused (ledger `block_changed`). */
  blockChanges: Array<{ x: number; y: number; z: number; from: string; to: string; atMs: number }>;
  /** Server-synchronized container reads/transfers by the action (ledger `container`). */
  containers: Array<{ dimension: string; x: number; y: number; z: number; contents: Record<string, number>; atMs: number; via?: string }>;
  /** Ledger-verified prior result (placed block) of this action, if any. */
  result?: { dimension: string; x: number; y: number; z: number; key: string };
}

export interface DeathContext {
  dimension?: string;
  position?: { x: number; y: number; z: number };
  accuracy: DeathPayload['accuracy'];
  positionAgeMs?: number;
  inventory: { source: 'server_sync' | 'client_model' | 'unavailable'; capturedAtMs?: number; items: Array<{ key: string; count: number }> };
}

export interface MemoryWorld {
  /** Current ready connection facts; undefined when not connected. */
  connection(): { connectionEpoch: number; dimension: string } | undefined;
  latestSnapshot(): ObservationSnapshot | undefined;
  /** `minecraft:<name>` when the voxel is directly observable now; undefined otherwise. */
  observeVoxel(x: number, y: number, z: number): string | undefined;
  observationRadius(): number;
  actionEvidence(actionId: string): ActionEvidence;
  /** Synchronous; must be called before the ledger/perception lifecycle invalidation. */
  deathContext(): DeathContext;
}

const AIR = /^(air|cave_air|void_air)$/;

export interface InstalledWorldDeps {
  session: () => GameSession | undefined;
  perception: PerceptionService;
  ledger: EvidenceLedger;
  clock: { now(): number };
}

/** MemoryWorld over the installed MB-V1-02 adapters (read-only). */
export function installedMemoryWorld(deps: InstalledWorldDeps): MemoryWorld {
  return {
    connection() {
      const s = deps.session();
      return s ? { connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) } : undefined;
    },
    latestSnapshot() {
      return deps.perception.latest();
    },
    observationRadius() {
      return deps.perception.radius;
    },
    observeVoxel(x, y, z) {
      const s = deps.session();
      if (!s) return undefined;
      const world = sessionWorld(s);
      const b = world.blockAt(x, y, z);
      if (!b || b.name === UNCONFIRMED_BLOCK) return undefined;
      const eye = eyeOf(s.bot);
      if (Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z) > deps.perception.radius) return undefined;
      if (AIR.test(b.name)) {
        // An empty voxel is "observed empty" only with a clear sight line to its centre.
        return lineOfSight(world, eye, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, { x, y, z }) ? `minecraft:${b.name}` : undefined;
      }
      return isBlockVisible(world, eye, x, y, z) ? `minecraft:${b.name}` : undefined;
    },
    actionEvidence(actionId) {
      const entries = deps.ledger.since(0).filter((e) => (e as { actionId?: string }).actionId === actionId);
      const blockChanges = entries.filter((e): e is Extract<LedgerEntry, { kind: 'block_changed' }> => e.kind === 'block_changed').map(({ x, y, z, from, to, atMs }) => ({ x, y, z, from, to, atMs }));
      const containers = entries
        .filter((e): e is Extract<LedgerEntry, { kind: 'container' }> => e.kind === 'container')
        .map(({ dimension, x, y, z, contents, atMs, via }) => ({ dimension, x, y, z, contents, atMs, ...(via ? { via } : {}) }));
      const result = deps.ledger.result(actionId);
      return { blockChanges, containers, ...(result ? { result } : {}) };
    },
    deathContext() {
      const s = deps.session();
      const now = deps.clock.now();
      const snap = deps.perception.latest();
      const inv = deps.ledger.inventory();
      const inventory: DeathContext['inventory'] = inv
        ? { source: 'server_sync', capturedAtMs: inv.atMs, items: [...inv.counts.entries()].filter(([, n]) => n > 0).slice(0, 41).map(([key, count]) => ({ key, count })) }
        : snap
          ? { source: 'client_model', capturedAtMs: snap.takenAtMs, items: snap.inventory.filter((i) => i.count > 0).slice(0, 41) }
          : { source: 'unavailable', items: [] };
      const p = s?.bot.entity?.position;
      if (s && p) {
        return { dimension: String(s.bot.game.dimension), position: { x: p.x, y: p.y, z: p.z }, accuracy: 'client_position_at_death_event', inventory };
      }
      if (snap) return { dimension: snap.dimension, position: snap.self.at, accuracy: 'last_observation', positionAgeMs: Math.max(0, now - snap.takenAtMs), inventory };
      return { accuracy: 'unknown', inventory };
    },
  };
}
