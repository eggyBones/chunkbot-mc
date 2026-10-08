// MB-FLOW-003-C12 (S): server-attributed own-incident return lineage for the
// approved ContinuationSurvivalPort (src/contracts/continuation.ts, P 4409ba1).
//
// One ledger per own death CAPTURE on a connection (incidentId = captureId),
// kept in memory: it works with or without the durable survival store and
// with memory disabled. It answers "how much of what this death took came back
// to the bot", separately as
//   retained  kept through respawn (min(last-alive, FIRST full respawn sync))
//   regained  server collect packets of THIS incident's own drops, by any
//             collector path: the recovery skills (C3-planned, identity-checked)
//             and later ordinary/passive collectors.
// A later collect counts as a return only with SERVER evidence matching the
// accepted C3 rule: the item entity's own server-stated stack (key + component
// identity digest) equals a still-unreturned lost stack identity, its count
// fits that remainder, and the server first announced it within the recovery
// search radius of this incident's site in the current dimension. Anything that
// cannot be placed — a stack never stated, a pile larger than the remainder, a
// match for more than one incident, losses merged from a related death, a
// last-alive copy without server metadata — makes the incident's attribution
// `unknown`. Incidental gains (C10) never become returns because a key matches:
// only collect packets are considered, never inventory diffs.
import type { IncidentReturns } from '../contracts/continuation.ts';
import type { DropStackFacts, InventoryFacts, LastAlive, TrackedStack } from '../contracts/survival.ts';
import { counts, sameDimension } from './items.ts';

const MAX_LEDGERS = 8;

type Vec = { x: number; y: number; z: number };
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const identityOf = (s: { key: string; meta: { metadata: string; digest?: string | undefined } }): string | undefined => (s.meta.metadata === 'server_slot' && s.meta.digest ? `${s.key}#${s.meta.digest}` : undefined);

interface Ledger {
  incidentId: string;
  connectionEpoch: number;
  episodeId: string | undefined;
  related: boolean;
  /** A related death near the original site: its losses join the original episode's search. */
  merged: boolean;
  order: number;
  lastAlive: { source: LastAlive['source']; stacks: TrackedStack[] };
  site: { dimension: string; at: Vec } | undefined;
  state: 'awaiting_respawn' | 'assessed';
  lostByKey: Map<string, number>;
  /** Unreturned lost amount per server identity (`key#digest`). */
  unreturned: Map<string, number>;
  regained: Map<string, number>;
  retained: Map<string, number>;
  ambiguous: string | undefined;
}

export interface OwnCollect {
  connectionEpoch: number;
  count: number;
  facts: DropStackFacts | undefined;
  firstSeenAt: Vec | undefined;
}

export class IncidentLedgerBook {
  private readonly ledgers = new Map<string, Ledger>();
  private order = 0;

  /** A captured own death (call for every capture, scoped store or not). */
  capture(c: { incidentId: string; connectionEpoch: number; lastAlive: LastAlive; site: { dimension?: string | undefined; at?: Vec | undefined } | undefined; episodeId?: string; related: boolean; mergedIntoEpisode?: boolean }): void {
    this.order += 1;
    this.ledgers.set(c.incidentId, {
      incidentId: c.incidentId,
      connectionEpoch: c.connectionEpoch,
      episodeId: c.episodeId,
      related: c.related,
      merged: Boolean(c.mergedIntoEpisode),
      order: this.order,
      lastAlive: { source: c.lastAlive.source, stacks: c.lastAlive.stacks.map((s) => ({ ...s, meta: { ...s.meta } })) },
      site: c.site?.dimension && c.site.at ? { dimension: c.site.dimension, at: { ...c.site.at } } : undefined,
      state: 'awaiting_respawn',
      lostByKey: new Map(),
      unreturned: new Map(),
      regained: new Map(),
      retained: new Map(),
      ambiguous: undefined,
    });
    while (this.ledgers.size > MAX_LEDGERS) {
      const oldest = [...this.ledgers.values()].sort((a, b) => a.order - b.order)[0];
      if (!oldest) break;
      this.ledgers.delete(oldest.incidentId);
    }
  }

  refineSite(incidentId: string, site: { dimension?: string | undefined; at?: Vec | undefined }): void {
    const l = this.ledgers.get(incidentId);
    if (l && site.dimension && site.at) l.site = { dimension: site.dimension, at: { ...site.at } };
  }

  /** The FIRST full respawn sync after this capture: lost / retained per key and per identity. */
  assess(incidentId: string, sync: InventoryFacts, nearRadius = 8): void {
    const l = this.ledgers.get(incidentId);
    if (!l || l.state !== 'awaiting_respawn' || sync.source !== 'server_packets' || !sync.fullSync || sync.connectionEpoch !== l.connectionEpoch) return;
    const before = counts(l.lastAlive.stacks);
    const after = counts(sync.stacks);
    for (const [key, n] of before) {
      const kept = Math.min(n, after.get(key) ?? 0);
      if (kept > 0) l.retained.set(key, kept);
      if (n - kept > 0) l.lostByKey.set(key, n - kept);
    }
    // Per-identity remainder (bounded by the key-level loss).
    const afterId = new Map<string, number>();
    for (const s of sync.stacks) {
      const id = identityOf(s);
      if (id) afterId.set(id, (afterId.get(id) ?? 0) + s.count);
    }
    for (const s of l.lastAlive.stacks) {
      if (!l.lostByKey.has(s.key)) continue;
      const id = identityOf(s);
      if (!id) {
        l.ambiguous ??= 'lost_item_identity_unknown';
        continue;
      }
      const kept = Math.min(s.count, afterId.get(id) ?? 0);
      afterId.set(id, (afterId.get(id) ?? 0) - kept);
      if (s.count - kept > 0) l.unreturned.set(id, (l.unreturned.get(id) ?? 0) + s.count - kept);
    }
    if (l.lastAlive.source !== 'server_packets') l.ambiguous ??= 'last_alive_not_server_stated';
    if (l.related && l.lostByKey.size > 0) l.ambiguous ??= 'losses_merged_with_original_incident';
    l.state = 'assessed';
    // Merged related losses, or a related death whose SERVER-refined site lies within the search radius of the
    // original site (its drops are indistinguishable there): regains of that episode can no longer be split.
    if (l.related && l.lostByKey.size > 0 && l.episodeId) {
      const original = [...this.ledgers.values()].find((x) => x.episodeId === l.episodeId && !x.related);
      const near = Boolean(original?.site && l.site && sameDimension(original.site.dimension, l.site.dimension) && dist(original.site.at, l.site.at) <= nearRadius);
      if (l.merged || near) this.markEpisodeAmbiguous(l.episodeId, 'related_death_losses_near_original_site');
    }
  }

  /** A related death's losses were merged into this episode's search: earlier and later regains cannot be split per incident. */
  markEpisodeAmbiguous(episodeId: string, reason: string): void {
    for (const l of this.ledgers.values()) if (l.episodeId === episodeId) l.ambiguous ??= reason;
  }

  /** A C3-planned recovery pickup (already identity-checked and bounded by the episode). */
  recoveryRegain(episodeId: string, key: string, count: number, digest: string | undefined): void {
    const l = [...this.ledgers.values()].filter((x) => x.episodeId === episodeId && !x.related).sort((a, b) => b.order - a.order)[0];
    if (!l || count <= 0) return;
    this.credit(l, key, count, digest ? `${key}#${digest}` : undefined);
  }

  /**
   * An item entity collected by the bot OUTSIDE the recovery plan (ordinary or
   * passive collectors). Counts as a return only with exact server evidence;
   * otherwise it either is clearly foreign (another identity, outside every
   * site radius) or makes the matching incident's attribution unknown.
   */
  ownCollect(c: OwnCollect, currentDimension: string | undefined, radius: number): { attributed?: { incidentId: string; key: string; count: number }; ambiguous?: string[] } {
    const open = [...this.ledgers.values()].filter((l) => l.connectionEpoch === c.connectionEpoch && l.state === 'assessed' && [...l.unreturned.values()].some((n) => n > 0));
    const near = (l: Ledger) => Boolean(l.site && c.firstSeenAt && currentDimension && sameDimension(l.site.dimension, currentDimension) && dist(l.site.at, c.firstSeenAt) <= radius);
    if (!c.facts) {
      // Stack never stated: it cannot be placed; any incident it could belong to becomes unknown.
      const hit = open.filter((l) => !c.firstSeenAt || near(l));
      for (const l of hit) l.ambiguous ??= 'unstated_stack_collected_near_site';
      return hit.length ? { ambiguous: hit.map((l) => l.incidentId) } : {};
    }
    const id = identityOf(c.facts);
    const sameKeyNear = open.filter((l) => (l.lostByKey.get(c.facts?.key ?? '') ?? 0) > 0 && (!c.firstSeenAt || near(l)));
    if (!id) {
      for (const l of sameKeyNear) l.ambiguous ??= 'collected_stack_identity_unknown';
      return sameKeyNear.length ? { ambiguous: sameKeyNear.map((l) => l.incidentId) } : {};
    }
    if (!c.firstSeenAt) {
      const hit = open.filter((l) => (l.unreturned.get(id) ?? 0) > 0);
      for (const l of hit) l.ambiguous ??= 'collected_entity_position_unknown';
      return hit.length ? { ambiguous: hit.map((l) => l.incidentId) } : {};
    }
    const candidates = open.filter((l) => near(l) && (l.unreturned.get(id) ?? 0) > 0);
    if (candidates.length === 0) return {}; // another identity or outside every incident's site: not a return
    if (candidates.length > 1) {
      for (const l of candidates) l.ambiguous ??= 'collect_matches_several_incidents';
      return { ambiguous: candidates.map((l) => l.incidentId) };
    }
    const l = candidates[0] as Ledger;
    if (!Number.isInteger(c.count) || c.count <= 0 || c.count > c.facts.count || c.facts.count > (l.unreturned.get(id) ?? 0)) {
      l.ambiguous ??= 'collected_pile_exceeds_unreturned_loss';
      return { ambiguous: [l.incidentId] };
    }
    this.credit(l, c.facts.key, c.count, id);
    return { attributed: { incidentId: l.incidentId, key: c.facts.key, count: c.count } };
  }

  private credit(l: Ledger, key: string, count: number, id: string | undefined): void {
    const room = Math.max(0, (l.lostByKey.get(key) ?? 0) - (l.regained.get(key) ?? 0));
    const n = Math.min(room, count);
    if (n <= 0) return;
    l.regained.set(key, (l.regained.get(key) ?? 0) + n);
    if (id && l.unreturned.has(id)) l.unreturned.set(id, Math.max(0, (l.unreturned.get(id) ?? 0) - n));
    else {
      // Identity not given (recovery regain without digest): reduce this key's identities in order.
      let left = n;
      for (const [k, v] of l.unreturned) {
        if (left <= 0) break;
        if (!k.startsWith(`${key}#`) || v <= 0) continue;
        const d = Math.min(v, left);
        l.unreturned.set(k, v - d);
        left -= d;
      }
    }
  }

  /** Packet-frozen last-alive counts of the latest own death on this connection (server packets only). */
  frozen(connectionEpoch: number): { incidentId: string; counts: Record<string, number>; evidence: 'last_alive_server_packets' } | null {
    const l = [...this.ledgers.values()].filter((x) => x.connectionEpoch === connectionEpoch).sort((a, b) => b.order - a.order)[0];
    if (!l || l.lastAlive.source !== 'server_packets') return null;
    return { incidentId: l.incidentId, counts: Object.fromEntries(counts(l.lastAlive.stacks)), evidence: 'last_alive_server_packets' };
  }

  returns(incidentId: string): IncidentReturns | null {
    const l = this.ledgers.get(incidentId);
    if (!l) return null;
    return {
      incidentId: l.incidentId,
      connectionEpoch: l.connectionEpoch,
      regained: Object.fromEntries(l.regained),
      retained: Object.fromEntries(l.retained),
      attribution: l.state === 'assessed' && !l.ambiguous ? 'server_attributed' : 'unknown',
    };
  }

  /** Why an incident's attribution is unknown (diagnostics/status; never model-visible text). */
  unknownReason(incidentId: string): string | undefined {
    const l = this.ledgers.get(incidentId);
    if (!l) return undefined;
    return l.state !== 'assessed' ? 'awaiting_fresh_respawn_sync' : l.ambiguous;
  }

  episodeOf(incidentId: string): string | undefined {
    return this.ledgers.get(incidentId)?.episodeId;
  }
}
