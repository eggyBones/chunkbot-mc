// Recovery episode book (pure; the service persists it).
//
// One episode per ORIGINAL own-death incident. A later death while that
// episode is open never replaces it: it is appended as a related incident, its
// cause becomes a hazard record, and an attempt in progress ends with outcome
// `death`. Attempt counters, accumulated budgets and hazards live in the
// episode, so death, restart, routine switching or a new support admission
// never reset them.
import type { MemoryScope } from '../contracts/memory.ts';
import {
  SURVIVAL_BOUNDS,
  type Blocker,
  type DeathCause,
  type HazardRecord,
  type InterruptedDirective,
  type DropIdentity,
  type InventoryFacts,
  type ItemMetadata,
  type LossManifest,
  type ManifestItem,
  type PreparationSignature,
  type RecoveryAttempt,
  type RecoveryEpisode,
  type RecoveryStatus,
  type SurvivalConfig,
  type SurvivalStoreBody,
  type TrackedStack,
} from '../contracts/survival.ts';
import { destroysDrops } from './death-cause.ts';
import { armorPoints, counts, isValuable, mk, sameDimension, strip, type SurvivalItemRegistry, isSafeFood } from './items.ts';
import type { CapturedDeathRecord } from './tracker.ts';

export const OPEN_STATUSES: ReadonlySet<RecoveryStatus> = new Set(['pending', 'partially_recovered']);
export const CONCLUDED_STATUSES: ReadonlySet<RecoveryStatus> = new Set(['no_loss', 'recovered', 'known_destroyed', 'unknown', 'abandoned', 'blocked']);

const clip = (s: string, n = 200) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function isOpen(e: RecoveryEpisode): boolean {
  return e.status === 'pending' || (e.status === 'partially_recovered' && e.phase !== 'concluded');
}

export class EpisodeBook {
  private body: SurvivalStoreBody;
  /** Incremented on every change (the service persists when it differs). */
  version = 0;
  /** In-process only: a related death's last-alive stacks awaiting its fresh respawn comparison (never persisted). */
  private readonly relatedLoss = new Map<string, TrackedStack[]>();

  constructor(scope: MemoryScope, nowMs: number, body?: SurvivalStoreBody) {
    this.body = body ? structuredClone(body) : { scope, createdAtMs: nowMs, episodes: [], interrupted: [], nextEpisode: 1, evicted: 0 };
  }

  snapshot(): SurvivalStoreBody {
    return structuredClone(this.body);
  }

  episodes(): readonly RecoveryEpisode[] {
    return this.body.episodes;
  }

  get(id: string): RecoveryEpisode | undefined {
    return this.body.episodes.find((e) => e.episodeId === id);
  }

  /** Oldest open episode (the original valuables come first). */
  open(): RecoveryEpisode | undefined {
    return this.body.episodes.filter(isOpen).sort((a, b) => a.openedAtMs - b.openedAtMs)[0];
  }

  touch(e: RecoveryEpisode, nowMs: number): void {
    e.updatedAtMs = nowMs;
    this.version += 1;
  }

  private nextId(): string {
    const n = this.body.nextEpisode;
    this.body.nextEpisode += 1;
    return `rep-${n.toString(36).padStart(4, '0')}`;
  }

  /**
   * Records an own death. Returns the episode it belongs to and whether it is
   * a new original or a related death of an open episode.
   */
  recordDeath(death: CapturedDeathRecord, incidentFactId: string | undefined, cfg: SurvivalConfig, nowMs: number): { episode: RecoveryEpisode; related: boolean } {
    const open = this.open();
    if (open) {
      if (incidentFactId && !open.relatedIncidentFactIds.includes(incidentFactId) && open.relatedIncidentFactIds.length < SURVIVAL_BOUNDS.relatedIncidents) open.relatedIncidentFactIds.push(incidentFactId);
      this.addHazard(open, { hazard: death.cause.hazard, ...(death.cause.translationKey ? { translationKey: death.cause.translationKey } : {}), ...(death.site.dimension ? { dimension: death.site.dimension } : {}), ...(death.site.at ? { at: death.site.at } : {}), atMs: death.occurredAtMs, ...(incidentFactId ? { incidentFactId } : {}) });
      const running = open.attempts.find((a) => a.endedAtMs === undefined);
      if (running) {
        running.endedAtMs = death.occurredAtMs;
        running.outcome = 'death';
      }
      // A related death's losses near the original site lie in the same search area.
      const near = open.site.at && death.site.at && sameDimension(open.site.dimension, death.site.dimension) && dist(open.site.at, death.site.at) <= cfg.recovery.sameHazardRadius;
      open.detail = clip(`related death ${incidentFactId ?? '(unrecorded)'} (${death.cause.translationKey ?? 'cause unknown'})${near ? ' near the original site' : ' away from the original site (its losses are recorded on its own incident, not targeted)'}`);
      if (near) this.relatedLoss.set(open.episodeId, structuredClone(death.lastAlive.stacks));
      open.phase = 'awaiting_respawn';
      this.touch(open, nowMs);
      return { episode: open, related: true };
    }
    const episode: RecoveryEpisode = {
      episodeId: this.nextId(),
      ...(incidentFactId ? { incidentFactId, originalIncidentFactId: incidentFactId } : {}),
      relatedIncidentFactIds: [],
      openedAtMs: nowMs,
      updatedAtMs: nowMs,
      occurredAtMs: death.occurredAtMs,
      phase: 'awaiting_respawn',
      status: 'pending',
      site: { ...death.site },
      cause: { ...death.cause },
      lastAlive: structuredClone(death.lastAlive),
      regained: [],
      attempts: [],
      maxAttempts: Math.min(cfg.recovery.maxAttempts, SURVIVAL_BOUNDS.maxAttemptsCeiling),
      budget: { plannerTurns: 0, tasks: 0, replans: 0, admissions: 0, activeMs: 0 },
      hazards: [],
      detail: '',
    };
    this.addHazard(episode, { hazard: death.cause.hazard, ...(death.cause.translationKey ? { translationKey: death.cause.translationKey } : {}), ...(death.site.dimension ? { dimension: death.site.dimension } : {}), ...(death.site.at ? { at: death.site.at } : {}), atMs: death.occurredAtMs, ...(incidentFactId ? { incidentFactId } : {}) });
    this.body.episodes.push(episode);
    this.enforceBounds();
    this.version += 1;
    return { episode, related: false };
  }

  private addHazard(e: RecoveryEpisode, h: HazardRecord): void {
    e.hazards.push(h);
    if (e.hazards.length > SURVIVAL_BOUNDS.hazards) e.hazards.splice(0, e.hazards.length - SURVIVAL_BOUNDS.hazards);
  }

  /** The server refined the site of the latest death (respawn SpawnInfo). Only the ORIGINAL site is refined by its own death. */
  refineSite(e: RecoveryEpisode, captureOccurredAtMs: number, site: RecoveryEpisode['site'], nowMs: number): void {
    if (e.occurredAtMs !== captureOccurredAtMs) return;
    e.site = { ...site };
    this.touch(e, nowMs);
  }

  /**
   * Fresh respawn state: compares the server-confirmed inventory with the
   * last-alive record. Retained inventory -> `no_loss` (no trip).
   */
  assess(e: RecoveryEpisode, fresh: InventoryFacts | null, registry: SurvivalItemRegistry, cfg: SurvivalConfig, nowMs: number, valuableExtra: readonly string[] = [], immediateRespawn = true): LossManifest {
    const related = this.relatedLoss.get(e.episodeId);
    const freshCounts = fresh && fresh.source === 'server_packets' && fresh.fullSync ? counts(fresh.stacks) : undefined;
    if (!e.manifest) {
      const before = counts(e.lastAlive.stacks);
      const metaByKey = new Map<string, TrackedStack>();
      for (const s of e.lastAlive.stacks) if (!metaByKey.has(s.key) || (s.meta.metadata === 'server_slot' && metaByKey.get(s.key)?.meta.metadata !== 'server_slot')) metaByKey.set(s.key, s);
      const missing: ManifestItem[] = [];
      const retained: Array<{ key: string; count: number }> = [];
      const destroy = destroysDrops(e.cause.hazard);
      for (const [key, n] of before) {
        const now = freshCounts?.get(key) ?? 0;
        const lost = freshCounts ? Math.max(0, n - now) : n;
        const kept = freshCounts ? Math.min(n, now) : 0;
        if (kept > 0) retained.push({ key, count: kept });
        if (lost <= 0) continue;
        const s = metaByKey.get(key);
        const fireproof = /^netherite_|^ancient_debris$/.test(strip(key));
        const state: ManifestItem['state'] = destroy === 'void' || (destroy === 'burn' && !fireproof) ? 'likely_destroyed' : 'missing';
        const valuable = e.lastAlive.stacks.some((x) => x.key === key && isValuable(key, x.meta, valuableExtra));
        const identities = valuable ? lostIdentities(e.lastAlive.stacks.filter((x) => x.key === key), freshCounts ? (fresh?.stacks ?? []).filter((x) => x.key === key) : []) : undefined;
        missing.push({ key, count: lost, valuable, metadata: s?.meta.metadata ?? 'unknown', state, ...(identities ? { identities } : {}) });
      }
      const partial = e.lastAlive.source !== 'server_packets' || !freshCounts || !immediateRespawn;
      e.manifest = {
        assessedAtMs: nowMs,
        freshInventorySource: freshCounts ? 'server_packets' : 'unavailable',
        lastAliveSource: e.lastAlive.source,
        missing: missing.slice(0, SURVIVAL_BOUNDS.manifestItems),
        retained: retained.slice(0, SURVIVAL_BOUNDS.manifestItems),
        partial,
        detail: clip(
          `${e.lastAlive.source === 'unavailable' ? 'no last-alive inventory was available: losses are UNKNOWN' : `last-alive inventory from ${e.lastAlive.source} frozen at ${e.lastAlive.frozenAt}`}; ${freshCounts ? immediateRespawn ? 'compared with the fresh server respawn inventory' : 'compared with a LATER server inventory (the respawn was not observed by this process): retained items are approximate' : 'no fresh server inventory: retained items unknown'}`,
        ),
      };
      if (e.lastAlive.source === 'unavailable') {
        e.status = 'blocked';
        e.phase = 'concluded';
        e.blocker = { reason: 'loss_manifest_unknown', detail: 'the last-alive inventory was not captured; recovery cannot be scoped to own items', atMs: nowMs, signature: `episode:${e.episodeId}:manifest_unknown` };
      } else if (missing.length === 0 && freshCounts) {
        e.status = 'no_loss';
        e.phase = 'concluded';
      } else if (missing.length > 0 && missing.every((m) => m.state === 'likely_destroyed')) {
        // C1: cause mechanics are not evidence; items stay `likely_destroyed`, never `known_destroyed`.
        e.status = 'blocked';
        e.phase = 'concluded';
        e.blocker =
          destroy === 'void'
            ? { reason: 'likely_destroyed_void', detail: `death by ${e.cause.translationKey ?? 'falling out of the world'}: dropped items fall out of the world by game mechanics (unverified here); no trip`, atMs: nowMs, signature: `episode:${e.episodeId}:void` }
            : { reason: 'site_fatal_hazard', detail: `death by ${e.cause.translationKey ?? 'lava'}: dropped items burn in lava by game mechanics (unverified here) and the site is a fatal hazard; no trip`, atMs: nowMs, signature: `episode:${e.episodeId}:lava` };
      } else {
        e.phase = 'ready';
      }
    } else if (related && freshCounts) {
      // Related death near the original site: its fresh losses join the same search.
      const before = counts(related);
      for (const [key, n] of before) {
        const lost = Math.max(0, n - (freshCounts.get(key) ?? 0));
        if (lost <= 0) continue;
        const m = e.manifest.missing.find((x) => x.key === key && x.state !== 'likely_destroyed');
        if (m) {
          m.count += lost;
          m.state = 'missing';
          // Related losses carry their own identities; any unproven stack makes the whole key unproven.
          const rel = lostIdentities(related.filter((x) => x.key === key), (fresh?.stacks ?? []).filter((x) => x.key === key));
          if (m.valuable || related.some((x) => x.key === key && isValuable(key, x.meta, valuableExtra))) {
            m.valuable = true;
            if (m.identities && rel) m.identities = mergeIdentities(m.identities, rel);
            else delete m.identities;
          }
        } else if (e.manifest.missing.length < SURVIVAL_BOUNDS.manifestItems) {
          const valuable = related.some((x) => x.key === key && isValuable(key, x.meta, valuableExtra));
          const identities = valuable ? lostIdentities(related.filter((x) => x.key === key), (fresh?.stacks ?? []).filter((x) => x.key === key)) : undefined;
          e.manifest.missing.push({ key, count: lost, valuable, metadata: related.find((x) => x.key === key)?.meta.metadata ?? 'unknown', state: 'missing', ...(identities ? { identities } : {}) });
        }
      }
      if (e.phase !== 'concluded') e.phase = 'ready';
    } else if (e.phase === 'awaiting_respawn' || e.phase === 'assessing') {
      e.phase = 'ready';
    }
    if (freshCounts) this.relatedLoss.delete(e.episodeId);
    void registry;
    void cfg;
    this.touch(e, nowMs);
    return e.manifest;
  }

  /** Outstanding items still sought (missing state only), after verified regains. */
  sought(e: RecoveryEpisode): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of e.manifest?.missing ?? []) if (m.state === 'missing' && m.count > 0) out.set(m.key, m.count);
    return out;
  }

  /** A server-confirmed pickup of a scoped drop (key must still be sought). Returns the counted amount. */
  /** C3: may a drop with these server facts count as this incident's item? */
  identityStatus(e: RecoveryEpisode, key: string, meta: ItemMetadata | undefined): DropIdentity {
    const m = e.manifest?.missing.find((x) => x.key === mk(key) && x.state === 'missing' && x.count > 0);
    if (!m) return 'mismatch';
    if (!m.valuable) return 'not_required';
    if (!m.identities || !meta || meta.metadata !== 'server_slot' || !meta.digest) return 'unproven';
    return m.identities.some((i) => i.digest === meta.digest && i.count > 0) ? 'match' : 'mismatch';
  }

  regain(e: RecoveryEpisode, key: string, count: number, nowMs: number, meta?: ItemMetadata): number {
    const m = e.manifest?.missing.find((x) => x.key === mk(key) && x.state === 'missing');
    if (!m || count <= 0) return 0;
    const identity = this.identityStatus(e, key, meta);
    if (identity === 'mismatch' || identity === 'unproven') return 0;
    let counted = Math.min(m.count, count);
    if (identity === 'match' && m.identities) {
      const i = m.identities.find((x) => x.digest === meta?.digest && x.count > 0) as { digest: string; count: number };
      counted = Math.min(counted, i.count);
      i.count -= counted;
      m.identities = m.identities.filter((x) => x.count > 0);
    }
    m.count -= counted;
    if (m.count === 0) m.state = 'regained';
    e.regained.push({ key: m.key, count: counted, atMs: nowMs, provenance: 'scoped_visible_drop' });
    if (e.regained.length > SURVIVAL_BOUNDS.regained) e.regained.splice(0, e.regained.length - SURVIVAL_BOUNDS.regained);
    const running = e.attempts.find((a) => a.endedAtMs === undefined);
    if (running) running.regained += counted;
    if (this.sought(e).size === 0) {
      e.status = e.manifest?.missing.some((x) => x.state === 'likely_destroyed') ? 'partially_recovered' : 'recovered';
      e.phase = 'concluded';
    } else {
      e.status = 'partially_recovered';
    }
    this.touch(e, nowMs);
    return counted;
  }

  /** The bounded visible search at the site ended with nothing scoped visible. */
  markSearched(e: RecoveryEpisode, nowMs: number): void {
    const running = e.attempts.find((a) => a.endedAtMs === undefined);
    if (running) running.searchedSite = true;
    this.touch(e, nowMs);
  }

  beginAttempt(e: RecoveryEpisode, goalId: string, preparation: PreparationSignature, nowMs: number): RecoveryAttempt | undefined {
    if (e.attempts.some((a) => a.endedAtMs === undefined)) return undefined;
    const used = countedAttempts(e);
    if (used >= e.maxAttempts) return undefined;
    const attempt: RecoveryAttempt = { attempt: used + 1, goalId, startedAtMs: nowMs, preparation, regained: 0, searchedSite: false };
    e.attempts.push(attempt);
    if (e.attempts.length > SURVIVAL_BOUNDS.attemptHistory) e.attempts.splice(0, e.attempts.length - SURVIVAL_BOUNDS.attemptHistory);
    e.phase = 'traveling';
    e.budget.admissions += 1;
    this.touch(e, nowMs);
    return attempt;
  }

  /**
   * Ends the running attempt of `goalId`. Owner stop/replacement/shutdown and
   * provider-not-ready do not consume the attempt (not the route's fault) but
   * still accumulate budget. Returns false for a stale/unknown goal.
   */
  endAttempt(e: RecoveryEpisode, goalId: string, outcome: string, used: { plannerTurns: number; tasks: number; replans: number; activeMs: number }, nowMs: number): boolean {
    const a = e.attempts.find((x) => x.goalId === goalId);
    e.budget.plannerTurns += Math.max(0, used.plannerTurns);
    e.budget.tasks += Math.max(0, used.tasks);
    e.budget.replans += Math.max(0, used.replans);
    e.budget.activeMs += Math.max(0, used.activeMs);
    if (!a) {
      this.touch(e, nowMs);
      return false;
    }
    if (a.endedAtMs === undefined) {
      a.endedAtMs = nowMs;
      a.outcome = /^[a-z_]{1,48}$/.test(outcome) ? outcome : 'other';
    }
    if (UNCOUNTED_OUTCOMES.has(a.outcome ?? '')) e.attempts.splice(e.attempts.indexOf(a), 1);
    if (e.phase !== 'concluded') e.phase = 'ready';
    this.touch(e, nowMs);
    return true;
  }

  conclude(e: RecoveryEpisode, status: RecoveryStatus, blocker: Blocker | undefined, nowMs: number): void {
    e.status = status;
    e.phase = 'concluded';
    if (blocker) e.blocker = blocker;
    else delete e.blocker;
    this.touch(e, nowMs);
  }

  setInterrupted(e: RecoveryEpisode, d: InterruptedDirective, nowMs: number): void {
    e.interrupted = d;
    this.touch(e, nowMs);
  }

  interrupted(): InterruptedDirective[] {
    return this.body.interrupted;
  }

  addInterrupted(d: InterruptedDirective): void {
    this.body.interrupted = [d, ...this.body.interrupted.filter((x) => x.goalId !== d.goalId)].slice(0, 4);
    this.version += 1;
  }

  /** Restart: an attempt that was running when the process ended is closed honestly (counted). */
  closeInterruptedAttempts(nowMs: number): number {
    let n = 0;
    for (const e of this.body.episodes) {
      for (const a of e.attempts) {
        if (a.endedAtMs !== undefined) continue;
        a.endedAtMs = nowMs;
        a.outcome = 'restart_interrupted';
        n += 1;
      }
      if (n > 0 && isOpen(e) && e.phase !== 'awaiting_respawn') e.phase = 'ready';
    }
    if (n > 0) this.version += 1;
    return n;
  }

  private enforceBounds(): void {
    const open = this.body.episodes.filter(isOpen);
    const closed = this.body.episodes.filter((e) => !isOpen(e)).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const keepClosed = Math.max(0, SURVIVAL_BOUNDS.episodes - open.length);
    const dropped = closed.length - Math.min(closed.length, keepClosed);
    this.body.episodes = [...open, ...closed.slice(0, keepClosed)].sort((a, b) => a.openedAtMs - b.openedAtMs);
    this.body.evicted += Math.max(0, dropped);
  }
}

/** Attempt outcomes that do not consume one of the bounded attempts. */
export const UNCOUNTED_OUTCOMES: ReadonlySet<string> = new Set(['owner_stop', 'replaced', 'shutdown', 'planner_not_ready', 'decision_not_ready']);

export function countedAttempts(e: RecoveryEpisode): number {
  return e.attempts.filter((a) => a.endedAtMs !== undefined && !UNCOUNTED_OUTCOMES.has(a.outcome ?? '')).length;
}

/** Preparation signature from fresh server inventory/vitals (armor, food, health, position). */
export function preparationSignature(inv: InventoryFacts | null, health: number, registry: SurvivalItemRegistry, at: { dimension: string; at: { x: number; y: number; z: number } } | undefined, routePolicy: string, avoid: readonly string[] = []): PreparationSignature {
  const stacks = inv?.stacks ?? [];
  const armor = stacks.filter((s) => s.slot >= 5 && s.slot <= 8).reduce((n, s) => n + armorPoints(s.key), 0);
  const food = stacks.filter((s) => isSafeFood(s.key, registry, avoid)).reduce((n, s) => n + s.count, 0);
  const fire = stacks.some((s) => s.slot >= 5 && s.slot <= 8 && /^netherite_/.test(strip(s.key)));
  return { armorPoints: Math.min(40, armor), foodItems: Math.min(4_096, food), health: Math.max(0, Math.min(1_024, health)), fireProtection: fire, ...(at ? { startAt: { x: Math.round(at.at.x), y: Math.round(at.at.y), z: Math.round(at.at.z) }, startDimension: at.dimension } : {}), routePolicy };
}

/**
 * Whether another attempt is MATERIALLY improved over the previous one:
 * more armor, fire protection gained against a fire/lava hazard, a different
 * route policy, or (for a non-fatal previous end) a substantially different
 * start (> 16 blocks or another dimension). Same preparation and route after a
 * fatal end is never improved.
 */
export function materiallyImproved(prev: PreparationSignature, now: PreparationSignature, prevOutcome: string | undefined, hazard: DeathCause['hazard'] | undefined): { improved: boolean; why: string } {
  if (now.routePolicy !== prev.routePolicy) return { improved: true, why: `route policy changed (${prev.routePolicy} -> ${now.routePolicy})` };
  if (now.armorPoints >= prev.armorPoints + 2) return { improved: true, why: `armor ${prev.armorPoints} -> ${now.armorPoints} points` };
  if ((hazard === 'fire' || hazard === 'lava') && now.fireProtection && !prev.fireProtection) return { improved: true, why: 'fire protection gained' };
  const fatal = prevOutcome === 'death';
  if (!fatal) {
    const moved = prev.startAt && now.startAt ? Math.hypot(prev.startAt.x - now.startAt.x, prev.startAt.z - now.startAt.z) : 0;
    const otherDimension = (prev.startDimension !== undefined || now.startDimension !== undefined) && !sameDimension(prev.startDimension, now.startDimension);
    if (otherDimension || moved > 16) return { improved: true, why: `different start (${Math.round(moved)} blocks away)` };
    if (prevOutcome === 'restart_interrupted' || prevOutcome === 'limit_exhausted' || prevOutcome === 'planner_error' || prevOutcome === 'decision_error' || prevOutcome === 'runtime_error') {
      if (now.health >= prev.health) return { improved: true, why: `previous attempt ended by ${prevOutcome}, not by the route` };
    }
  }
  return { improved: false, why: fatal ? 'previous attempt ended in death with unchanged preparation and route' : `previous attempt ended (${prevOutcome ?? 'unknown'}) and nothing material changed` };
}

/** The same unresolved fatal hazard killed the bot again near the site (blocks recovery early). */
export function repeatedFatalHazard(e: RecoveryEpisode, radius: number): HazardRecord | undefined {
  if (!e.site.at || e.hazards.length < 2) return undefined;
  const first = e.hazards[0] as HazardRecord;
  for (const h of e.hazards.slice(1)) {
    if (!h.at || !sameDimension(h.dimension, e.site.dimension)) continue;
    if (dist(h.at, e.site.at) > radius) continue;
    if (h.hazard === first.hazard || h.hazard === 'unknown') return h;
  }
  return undefined;
}

/** Identity digests of the stacks lost (last-alive minus fresh, by digest); undefined when any stack's identity is unknown. */
export function lostIdentities(before: readonly TrackedStack[], after: readonly TrackedStack[]): Array<{ digest: string; count: number }> | undefined {
  if (before.some((s) => s.meta.metadata !== 'server_slot' || !s.meta.digest)) return undefined;
  const left = new Map<string, number>();
  for (const s of before) left.set(s.meta.digest as string, (left.get(s.meta.digest as string) ?? 0) + s.count);
  for (const s of after) if (s.meta.digest && left.has(s.meta.digest)) left.set(s.meta.digest, Math.max(0, (left.get(s.meta.digest) ?? 0) - s.count));
  const out = [...left.entries()].filter(([, n]) => n > 0).map(([digest, count]) => ({ digest, count }));
  return out.length <= 8 ? out : undefined;
}

function mergeIdentities(a: Array<{ digest: string; count: number }>, b: Array<{ digest: string; count: number }>): Array<{ digest: string; count: number }> | undefined {
  const m = new Map(a.map((x) => [x.digest, x.count]));
  for (const x of b) m.set(x.digest, (m.get(x.digest) ?? 0) + x.count);
  const out = [...m.entries()].map(([digest, count]) => ({ digest, count }));
  return out.length <= 8 ? out : undefined;
}

export function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return dist(a, b);
}

export function safeFoodCount(inv: InventoryFacts | null, registry: SurvivalItemRegistry, avoid: readonly string[]): number {
  return (inv?.stacks ?? []).filter((s) => isSafeFood(s.key, registry, avoid) && !s.meta.customName && !s.meta.enchanted).reduce((n, s) => n + s.count, 0);
}
