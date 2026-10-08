// Code-owned predicate evaluation against server-confirmed evidence.
//
// Baselines are bound at goal/task admission from a SERVER-confirmed inventory.
// Distinctions:
//   - inventory_amount/possess: currently holds N (final outputs must still hold);
//   - inventory_amount/collect_additional: N more than at admission, now;
//   - inventory_delta: acquisition milestone; with mayBeConsumedLater, items
//     consumed by verified crafting/processing since admission still count, and
//     once reached the milestone stays latched;
//   - crafting/smelting results come only from skill-confirmed ledger entries;
//   - entity defeat only from a server death status; presence only from
//     current line of sight; remembered anchors are labeled as remembered.
// Evidence that cannot decide a predicate yields `unknown` with the limitation.
import { createRequire } from 'node:module';
import type {
  BoundPredicate,
  InventoryBaseline,
  MemoryPredicatePort,
  MemoryRefResolver,
  SurvivalPredicatePort,
  OutcomePredicate,
  PredicateOwner,
  PredicateEvaluation,
  PredicateEvaluator,
  TargetSelector,
} from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import type { SkillServices } from '../skills/definition.ts';
import { countMatching } from '../skills/common.ts';
import { UNCONFIRMED_BLOCK } from '../perception/visibility.ts';
import { correlatedResync } from './actuator.ts';
import { inventoryFromConfirmed, type InventoryView } from './ledger.ts';
import type { ActuatorLeases } from './lease.ts';

type ItemCtor = { toNotch(item: unknown): unknown };
const itemLoader = createRequire(import.meta.url)('prismarine-item') as (registry: unknown) => ItemCtor;

interface Bound extends BoundPredicate {
  latched: Set<string>;
  /**
   * MB-PLAN-006 blocks_removed: member positions bound per predicate path
   * ("x,y,z" -> key at binding), the bound area (for bounded growth) and why a
   * binding failed. Never exposed to models.
   */
  removal?: Map<string, { members: Map<string, string>; group?: { class: string; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }; issue?: string }>;
  /** Lifecycle interruptions recorded by the ledger when the baselines were bound. */
  lifecycleMark?: number;
  connectionEpoch?: number;
}

type Ev = PredicateEvaluation['evidence'];

/** Maximum age of server-synchronized container contents accepted as CURRENT evidence. */
export const CONTAINER_EVIDENCE_MAX_AGE_MS = 60_000;
const SLOT = { head: 5, torso: 6, legs: 7, feet: 8, off_hand: 45 } as const;

export interface PredicateDeps {
  services: SkillServices;
  session: () => GameSession | undefined;
  leases: ActuatorLeases;
  /** MB-MEM-001 (optional): memory_ref targets and memory_state evaluation; absent => unknown. */
  memory?: MemoryRefResolver & MemoryPredicatePort;
  /** MB-FLOW-001 (optional): home shelter verification; absent => unknown. */
  structures?: { evaluateStructure(expect: 'site_approved' | 'enclosed' | 'complete'): PredicateEvaluation };
  /** MB-FLOW-003 (optional): survival routine conditions; absent => unknown. */
  survival?: SurvivalPredicatePort;
}

/** Baseline key of the memory write sequence captured when a memory_state predicate is bound. */
export const MEMORY_SEQ_BASELINE = 'memory:seq';

export class PredicateEngine implements PredicateEvaluator {
  private readonly deps: PredicateDeps;

  constructor(deps: PredicateDeps) {
    this.deps = deps;
  }

  /**
   * CURRENT server-confirmed inventory, or undefined (=> `unknown`). A fresh
   * correlated resync is requested only when no actuator lease is active and no
   * interface is open (it must not interleave with an action's clicks). There
   * is deliberately no fallback to a cached inventory: an old view does not
   * prove the current state.
   */
  async inventory(signal: AbortSignal): Promise<InventoryView | undefined> {
    this.lastInventoryIssue = undefined;
    const s = this.deps.session();
    if (!s) {
      this.lastInventoryIssue = 'not connected';
      return undefined;
    }
    if (this.deps.leases.current) {
      this.lastInventoryIssue = 'an action holds the actuator; no current inventory resync is possible now';
      return undefined;
    }
    if (s.bot.currentWindow) {
      this.lastInventoryIssue = 'an interface is open; no current inventory resync is possible now';
      return undefined;
    }
    if (signal.aborted) return undefined;
    const Item = itemLoader(s.bot.registry);
    const write = (name: string, data: Record<string, unknown>) => (s.bot._client as unknown as { write(n: string, d: unknown): void }).write(name, data);
    let confirmed;
    try {
      confirmed = await correlatedResync(s, 0, Item.toNotch(null), write, 2_000, signal);
    } catch {
      confirmed = undefined;
    }
    if (!confirmed) {
      this.lastInventoryIssue = 'the current inventory resync was not answered (no correlated server reply)';
      return undefined;
    }
    const view = inventoryFromConfirmed(confirmed, 9, this.deps.services.clock.now());
    this.deps.services.ledger.setInventory(view);
    return view;
  }

  private lastInventoryIssue: string | undefined;

  /**
   * Goal ADMISSION baseline: the full server-confirmed inventory (every item),
   * captured before the first planner turn when no outcome selector is known
   * yet. Retries a correlated resync briefly; never falls back to a cached or
   * client-model inventory (counts stay null with the reason instead).
   */
  async captureBaseline(signal: AbortSignal): Promise<InventoryBaseline> {
    const s = this.deps.session();
    const lifecycleMark = this.deps.services.ledger.invalidations.length;
    let inv: InventoryView | undefined;
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
      inv = await this.inventory(signal);
      if (inv) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const capturedAtMs = this.deps.services.clock.now();
    const base = { capturedAtMs, lifecycleMark, ...(s ? { connectionEpoch: s.connectionEpoch } : {}) };
    if (!inv) return { ...base, counts: null, detail: `no server-confirmed inventory at admission: ${this.lastInventoryIssue ?? 'unavailable'}` };
    const counts: Record<string, number> = {};
    for (const [key, n] of inv.counts) if (n > 0) counts[key] = n;
    return { ...base, counts, detail: `server-synced player inventory at admission (${Object.keys(counts).length} item types)` };
  }

  async bind(predicate: OutcomePredicate, signal: AbortSignal, admission?: InventoryBaseline, owner?: PredicateOwner): Promise<BoundPredicate> {
    const baselines: Record<string, number> = {};
    // A goal outcome bound later measures acquisition from the ADMISSION counts.
    const inv = admission ? undefined : await this.inventory(signal);
    const fromAdmission = admission?.counts ? new Map(Object.entries(admission.counts)) : undefined;
    const removal: NonNullable<Bound['removal']> = new Map();
    const visit = (p: OutcomePredicate, path = 'root') => {
      if (p.predicate === 'all' || p.predicate === 'any') p.of.forEach((c, i) => visit(c, `${path}.${i}`));
      else if (p.predicate === 'not') visit(p.of, `${path}.0`);
      else if (p.predicate === 'blocks_removed') removal.set(path, this.bindRemoval(p));
      else if (p.predicate === 'inventory_delta' || (p.predicate === 'inventory_amount' && p.mode === 'collect_additional')) {
        const counts = admission ? fromAdmission : inv?.counts;
        baselines[`inv:${p.selector}`] = counts ? countMatching(counts, p.selector, this.deps.services) : Number.NaN;
      } else if (p.predicate === 'memory_state' && this.deps.memory && !(MEMORY_SEQ_BASELINE in baselines)) {
        // Monotonic write sequence (never a timestamp): older or same-millisecond writes cannot satisfy it.
        baselines[MEMORY_SEQ_BASELINE] = this.deps.memory.memoryBaseline();
      }
    };
    visit(predicate);
    const s = this.deps.session();
    const bound: Bound = {
      predicate,
      boundAtMs: admission ? admission.capturedAtMs : this.deps.services.clock.now(),
      baselines,
      latched: new Set(),
      ...(removal.size > 0 ? { removal } : {}),
      lifecycleMark: admission?.lifecycleMark ?? this.deps.services.ledger.invalidations.length,
      ...(admission ? (admission.connectionEpoch !== undefined ? { connectionEpoch: admission.connectionEpoch } : {}) : s ? { connectionEpoch: s.connectionEpoch } : {}),
      ...(owner ? { owner: { goalId: owner.goalId, goalEpoch: owner.goalEpoch } } : {}),
    };
    return bound;
  }

  async evaluate(boundIn: BoundPredicate, signal: AbortSignal): Promise<PredicateEvaluation> {
    const bound = boundIn as Bound;
    bound.latched ??= new Set();
    const inv = await this.inventory(signal);
    return this.eval(bound.predicate, bound, inv, 'root');
  }

  private eval(p: OutcomePredicate, bound: Bound, inv: InventoryView | undefined, path: string): PredicateEvaluation {
    const { services } = this.deps;
    const s = this.deps.session();
    const result = (status: PredicateEvaluation['status'], detail: string, evidence: Ev = {}): PredicateEvaluation => ({ status, predicate: p.predicate, detail, evidence });
    switch (p.predicate) {
      case 'all':
      case 'any': {
        const children = p.of.map((c, i) => this.eval(c, bound, inv, `${path}.${i}`));
        const sat = children.filter((c) => c.status === 'satisfied').length;
        const unsat = children.filter((c) => c.status === 'unsatisfied').length;
        let status: PredicateEvaluation['status'];
        if (p.predicate === 'all') status = unsat > 0 ? 'unsatisfied' : sat === children.length ? 'satisfied' : 'unknown';
        else status = sat > 0 ? 'satisfied' : unsat === children.length ? 'unsatisfied' : 'unknown';
        return { status, predicate: p.predicate, detail: `${sat}/${children.length} satisfied`, evidence: { satisfied: sat, unsatisfied: unsat }, children };
      }
      case 'not': {
        const child = this.eval(p.of, bound, inv, `${path}.0`);
        const status = child.status === 'unknown' ? 'unknown' : child.status === 'satisfied' ? 'unsatisfied' : 'satisfied';
        return { status, predicate: 'not', detail: `not(${child.detail})`, evidence: {}, children: [child] };
      }
      case 'inventory_amount':
      case 'inventory_delta': {
        if (!inv) return result('unknown', `no current server-confirmed inventory: ${this.lastInventoryIssue ?? 'unavailable'}`);
        const now = countMatching(inv.counts, p.selector, services);
        const ev: Ev = { selector: p.selector, current: now, source: inv.source, confirmedAtMs: inv.atMs };
        if (p.predicate === 'inventory_amount' && p.mode === 'possess') {
          return result(now >= p.atLeast ? 'satisfied' : 'unsatisfied', `holds ${now}/${p.atLeast} ${p.selector}`, ev);
        }
        const baseline = bound.baselines[`inv:${p.selector}`];
        if (baseline === undefined || Number.isNaN(baseline)) return result('unknown', 'baseline was not bound from a server-confirmed inventory', ev);
        const interrupted = (bound.lifecycleMark !== undefined && services.ledger.invalidations.length !== bound.lifecycleMark) || (bound.connectionEpoch !== undefined && s?.connectionEpoch !== bound.connectionEpoch);
        if (interrupted) return result('unknown', 'a lifecycle interruption (death, dimension change or reconnect) happened since admission; the admission baseline is no longer comparable', { ...ev, lifecycleInterrupted: true });
        let acquired = now - baseline;
        ev['baseline'] = baseline;
        if (p.predicate === 'inventory_delta' && p.mayBeConsumedLater) {
          const consumed = services.ledger
            .since(bound.boundAtMs)
            .filter((e) => e.kind === 'consumed' && (p.selector.startsWith('#') ? services.knowledge.recipes?.matches(p.selector, e.item) : e.item === p.selector))
            .reduce((n, e) => n + (e as { count: number }).count, 0);
          ev['consumedSinceAdmission'] = consumed;
          acquired += consumed;
          if (bound.latched.has(path)) return result('satisfied', `milestone already reached (${p.atLeast} ${p.selector} acquired); later consumption allowed`, { ...ev, latched: true });
        }
        ev['acquired'] = acquired;
        const ok = acquired >= p.atLeast;
        if (ok && p.predicate === 'inventory_delta' && p.mayBeConsumedLater) bound.latched.add(path);
        return result(ok ? 'satisfied' : 'unsatisfied', `acquired ${acquired}/${p.atLeast} ${p.selector} since admission`, ev);
      }
      case 'equipped': {
        if (!inv?.includesEquipment) return result('unknown', `no current server-confirmed player inventory with equipment slots${this.lastInventoryIssue ? `: ${this.lastInventoryIssue}` : ''}`);
        const slot = p.slot === 'hand' ? 36 + (s?.bot.quickBarSlot ?? 0) : SLOT[p.slot];
        const key = inv.slots.get(slot)?.key ?? null;
        const ok = key !== null && (p.selector.startsWith('#') ? Boolean(services.knowledge.recipes?.matches(p.selector, key)) : key === p.selector);
        return result(ok ? 'satisfied' : 'unsatisfied', `${p.slot} holds ${key ?? 'nothing'}`, { slot: p.slot, item: key });
      }
      case 'crafting_result':
      case 'smelting_result': {
        const kind = p.predicate === 'crafting_result' ? 'crafted' : 'smelted_collected';
        const n = services.ledger
          .since(bound.boundAtMs)
          .filter((e) => e.kind === kind && (e as { output: string }).output === p.output)
          .reduce((sum, e) => sum + (e as { count: number }).count, 0);
        return result(n >= p.atLeast ? 'satisfied' : 'unsatisfied', `${n}/${p.atLeast} ${p.output} ${kind === 'crafted' ? 'crafted' : 'collected from a furnace'} (skill-confirmed) since admission`, { confirmed: n });
      }
      case 'near_target':
      case 'visited_location': {
        if (!s) return result('unknown', 'not connected');
        const target = this.position(p.target, s, bound);
        if ('unknown' in target) return result('unknown', target.unknown);
        if (p.predicate === 'near_target') {
          const e = s.bot.entity.position;
          const d = Math.hypot(e.x - target.at.x, e.y - target.at.y, e.z - target.at.z);
          return result(d <= p.within ? 'satisfied' : 'unsatisfied', `${d.toFixed(1)} blocks from ${target.label}${target.remembered ? ' (remembered position; presence not verified)' : ''}`, { distance: Math.round(d * 10) / 10, remembered: Boolean(target.remembered) });
        }
        const visited = services.perception.visitedLocations().filter((v) => v.dimension === String(s.bot.game.dimension));
        const hit = visited.find((v) => Math.hypot(v.at.x - target.at.x, v.at.y - target.at.y, v.at.z - target.at.z) <= p.within && v.atMs >= bound.boundAtMs);
        return result(hit ? 'satisfied' : 'unsatisfied', hit ? `visited within ${p.within} of ${target.label}` : `no visit within ${p.within} of ${target.label} since admission`, { visitedPoints: visited.length });
      }
      case 'block_state': {
        if (!s) return result('unknown', 'not connected');
        const target = this.position(p.target, s, bound);
        if ('unknown' in target) return result('unknown', target.unknown);
        const x = Math.floor(target.at.x);
        const y = Math.floor(target.at.y);
        const z = Math.floor(target.at.z);
        const where = `${x},${y},${z}`;
        const ev = s.evidence as Partial<Pick<GameSession['evidence'], 'serverBlock' | 'predictionPending'>>;
        // 1. The latest SERVER statement for this position while its chunk is loaded,
        //    used only when the position is in line of sight now or the change is this
        //    goal's own skill-confirmed effect (server updates also arrive for hidden blocks).
        const fact = typeof ev.serverBlock === 'function' ? ev.serverBlock(x, y, z) : undefined;
        const visibleNow = typeof services.perception.blockVisibleNow === 'function' ? services.perception.blockVisibleNow(x, y, z) : false;
        const own = typeof services.ledger.ownBlockChange === 'function' ? services.ledger.ownBlockChange(x, y, z, bound.boundAtMs) : false;
        if (fact && (visibleNow || own)) {
          const name = (s.bot.registry as unknown as { blocksByStateId?: Record<number, { name: string } | undefined> }).blocksByStateId?.[fact.stateId]?.name;
          if (!name) return result('unknown', `server block state ${fact.stateId} at ${where} is not in the installed registry`);
          const key = `minecraft:${name}`;
          return result(key === p.expect ? 'satisfied' : 'unsatisfied', `server block update at ${where}: ${key}${own && !visibleNow ? ' (this goal\'s own confirmed change; not in sight now)' : ''}`, { block: key, source: 'server_block_update', atMs: fact.atMs, visibleNow, ownChange: own });
        }
        // 2. Server chunk data, only for a position in line of sight now with no
        //    pending client-side prediction (Mineflayer's optimistic dig result).
        const pending = typeof ev.predictionPending === 'function' ? ev.predictionPending(x, y, z) : true;
        if (pending) return result('unknown', `no server statement for ${where} after a local prediction (or no prediction tracking); not treating the client model as server truth`);
        if (!visibleNow) return result('unknown', `${where} is not in line of sight now; its contents are not reported`);
        const b = services.perception.world()?.blockAt(x, y, z);
        if (!b) return result('unknown', `block at ${where} is not loaded`);
        const key = `minecraft:${b.name}`;
        return result(key === p.expect ? 'satisfied' : 'unsatisfied', `visible block at ${where} is ${key} (server chunk data, no pending prediction)`, { block: key, source: 'visible_chunk_data' });
      }
      case 'container_state': {
        if (!s) return result('unknown', 'not connected');
        const target = this.position(p.target, s, bound);
        if ('unknown' in target) return result('unknown', target.unknown);
        const rec = services.ledger.latestContainer(String(s.bot.game.dimension), Math.floor(target.at.x), Math.floor(target.at.y), Math.floor(target.at.z));
        if (!rec) return result('unknown', `contents of ${target.label} have not been observed on this connection since the last lifecycle interruption; inspect it first`);
        const ageMs = services.clock.now() - rec.atMs;
        const count = Object.entries(rec.contents)
          .filter(([k]) => {
            const item = k.includes(':minecraft:') ? k.slice(k.indexOf(':') + 1) : k;
            return p.selector.startsWith('#') ? services.knowledge.recipes?.matches(p.selector, item) : item === p.selector;
          })
          .reduce((sum, [, v]) => sum + v, 0);
        // Freshness/ownership boundary for CURRENT contents: a server-synchronized
        // read through the bot's own open interface (inspect/transfer/furnace skill),
        // on this connection and lifecycle generation, made AFTER this predicate was
        // bound (i.e. within the admitted goal/task), and at most
        // CONTAINER_EVIDENCE_MAX_AGE_MS old. Closed containers are not observable, so
        // anything else is historical and yields unknown (re-inspect to validate).
        const afterBinding = rec.atMs >= bound.boundAtMs;
        const recent = ageMs <= CONTAINER_EVIDENCE_MAX_AGE_MS;
        const ev: Ev = { observedAtMs: rec.atMs, boundAtMs: bound.boundAtMs, ageMs, maxAgeMs: CONTAINER_EVIDENCE_MAX_AGE_MS, observedBy: rec.actionId ?? null, via: rec.via ?? null };
        if (!afterBinding || !recent) {
          return result(
            'unknown',
            `contents of ${target.label} were last server-synced ${Math.round(ageMs / 1000)}s ago${afterBinding ? ` (older than ${CONTAINER_EVIDENCE_MAX_AGE_MS / 1000}s)` : ', before this outcome was bound'}; historical only (then ${count} ${p.selector}) — inspect it to validate current contents`,
            { ...ev, historical: true, historicalCount: count },
          );
        }
        return result(count >= p.atLeast ? 'satisfied' : 'unsatisfied', `${count}/${p.atLeast} ${p.selector} in ${target.label} (server-synced by ${rec.via ?? 'a skill'} ${Math.round(ageMs / 1000)}s ago, after binding)`, { ...ev, count, fresh: true });
      }
      case 'entity_outcome': {
        if (!s) return result('unknown', 'not connected');
        if (p.target.kind === 'owner') {
          if (p.outcome === 'observed_defeated') return result('unknown', 'owner defeat is not an evaluated outcome');
          const owner = Object.values(s.bot.entities).find((e) => e && services.perception.isOwnerEntity(s.bot, e));
          const visible = owner ? services.perception.entityVisibleNow(owner.id) : false;
          return result(visible ? 'satisfied' : 'unsatisfied', visible ? 'owner visible now' : 'owner not visible now', { visible });
        }
        if (p.target.kind !== 'observed') return result('unknown', `entity outcomes need an observed entity handle, not ${p.target.kind}`);
        // Identity survives snapshot eviction (same connection/dimension; cleared on lifecycle).
        const rec = services.perception.identity(p.target.snapshotId, p.target.handle);
        if ('error' in rec || rec.target.kind !== 'entity') return result('unknown', `entity handle cannot be resolved (${'error' in rec ? rec.error : rec.target.kind})`);
        const id = rec.target.entityId;
        if (p.outcome === 'observed_present') {
          const v = services.perception.entityVisibleNow(id);
          return result(v ? 'satisfied' : 'unsatisfied', v ? 'entity visible now' : 'entity not visible now (absence is not defeat)', { visible: v });
        }
        const died = services.ledger.since(bound.boundAtMs).some((e) => e.kind === 'entity_defeated' && e.entityId === id) || s.evidence.latest('entity_status', (e) => e.entityId === id && e.status === 3 && e.atMs >= bound.boundAtMs) !== undefined;
        if (died) return result('satisfied', 'server reported the entity death status', { entityId: id });
        const gone = !s.bot.entities[id];
        return result(gone ? 'unknown' : 'unsatisfied', gone ? 'entity is gone but no death status was observed; not counted as defeated' : 'entity still present', { entityId: id, gone });
      }
      case 'blocks_removed':
        return this.evalRemoval(p, bound, path, s);
      case 'structure_state': {
        const structures = this.deps.structures;
        if (!structures) return result('unknown', 'home construction is not installed in this run (autonomy home disabled or no durable scope)');
        return structures.evaluateStructure(p.expect);
      }
      case 'survival_state': {
        const survival = this.deps.survival;
        if (!survival) return result('unknown', 'the survival policy is not installed in this run');
        const e = survival.evaluateSurvivalState(p, bound.owner);
        return { status: e.status, predicate: 'survival_state', detail: e.detail, evidence: e.evidence };
      }
      case 'memory_state': {
        const memory = this.deps.memory;
        if (!memory) return result('unknown', 'memory is not installed in this run');
        if (!bound.owner) return result('unknown', 'memory_state needs an owning goal; operator diagnostics do not evaluate it');
        const baseline = bound.baselines[MEMORY_SEQ_BASELINE];
        if (baseline === undefined || !Number.isFinite(baseline)) return result('unknown', 'no memory write-sequence baseline was bound');
        const m = memory.evaluateMemoryState(p, { memoryBaseline: baseline });
        return { status: m.status, predicate: 'memory_state', detail: m.detail, evidence: { ...m.evidence, memoryBaseline: baseline, confirmation: 'local_memory_store' } };
      }
    }
  }

  /** MB-PLAN-006: bind the observed target's member positions matching the selector (code-only; no model data). */
  private bindRemoval(p: Extract<OutcomePredicate, { predicate: 'blocks_removed' }>): NonNullable<Bound['removal']> extends Map<string, infer V> ? V : never {
    const { services } = this.deps;
    const members = new Map<string, string>();
    if (p.target.kind !== 'observed') return { members, issue: `blocks_removed needs an observed group or block handle, not ${p.target.kind}` };
    const rec = services.perception.identity(p.target.snapshotId, p.target.handle);
    if ('error' in rec) return { members, issue: `target ${p.target.handle} cannot be resolved at binding (${rec.error})` };
    const matches = (name: string) => this.keyMatches(p.selector, `minecraft:${name}`);
    const t = rec.target;
    if (t.kind === 'block') {
      if (matches(t.name)) members.set(`${t.x},${t.y},${t.z}`, `minecraft:${t.name}`);
      return members.size ? { members } : { members, issue: `${p.target.handle} is ${t.name}, not ${p.selector}` };
    }
    if (t.kind !== 'group') return { members, issue: `${p.target.handle} is a ${t.kind}, not a block group or block` };
    for (const m of t.members) if (matches(m.name)) members.set(`${m.x},${m.y},${m.z}`, `minecraft:${m.name}`);
    const xs = t.members.map((m) => m.x);
    const ys = t.members.map((m) => m.y);
    const zs = t.members.map((m) => m.z);
    const group = { class: t.class, min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }, max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) } };
    return members.size ? { members, group } : { members, group, issue: `group ${p.target.handle} has no visible ${p.selector} member` };
  }

  private keyMatches(selector: string, key: string): boolean {
    return selector.startsWith('#') ? Boolean(this.deps.services.knowledge.recipes?.matches(selector, key)) : key === selector;
  }

  /** Bound removal evaluation: every bound position must be server-stated free of a matching block. */
  private evalRemoval(p: Extract<OutcomePredicate, { predicate: 'blocks_removed' }>, bound: Bound, path: string, s: GameSession | undefined): PredicateEvaluation {
    const result = (status: PredicateEvaluation['status'], detail: string, evidence: Ev = {}): PredicateEvaluation => ({ status, predicate: 'blocks_removed', detail, evidence });
    const b = bound.removal?.get(path);
    if (!b) return result('unknown', 'no removal binding for this predicate');
    if (b.issue) return result('unknown', b.issue);
    if (!s) return result('unknown', 'not connected');
    const { services } = this.deps;
    const interrupted = (bound.lifecycleMark !== undefined && services.ledger.invalidations.length !== bound.lifecycleMark) || (bound.connectionEpoch !== undefined && s.connectionEpoch !== bound.connectionEpoch);
    if (interrupted) return result('unknown', 'a lifecycle interruption happened since binding; the bound positions must be re-observed', { lifecycleInterrupted: true });
    // Bounded growth: newly SEEN members of the same group (connected, of the bound class, near the bound area).
    if (b.group && b.members.size < 256) {
      const snap = services.perception.latest();
      for (const g of snap?.groups ?? []) {
        if (g.class !== b.group.class) continue;
        const members = services.perception.groupMembers(snap!.id, g.handle) ?? [];
        if (!members.some((m) => b.members.has(`${m.x},${m.y},${m.z}`))) continue;
        for (const m of members) {
          const k = `${m.x},${m.y},${m.z}`;
          const near = m.x >= b.group.min.x - 2 && m.x <= b.group.max.x + 2 && m.y >= b.group.min.y - 2 && m.y <= b.group.max.y + 2 && m.z >= b.group.min.z - 2 && m.z <= b.group.max.z + 2;
          if (near && !b.members.has(k) && this.keyMatches(p.selector, `minecraft:${m.name}`) && b.members.size < 256) b.members.set(k, `minecraft:${m.name}`);
        }
      }
    }
    const ev = s.evidence as Partial<Pick<GameSession['evidence'], 'predictionPending'>>;
    const world = services.perception.world();
    let remaining = 0;
    let removed = 0;
    let unknown = 0;
    for (const k of b.members.keys()) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const pending = typeof ev.predictionPending === 'function' ? ev.predictionPending(x, y, z) : true;
      const cur = pending ? undefined : world?.blockAt(x, y, z);
      if (!cur || cur.name === UNCONFIRMED_BLOCK) unknown += 1;
      else if (this.keyMatches(p.selector, `minecraft:${cur.name}`)) remaining += 1;
      else removed += 1;
    }
    const evidence: Ev = { bound: b.members.size, removed, remaining, unknown, selector: p.selector, source: 'server_world_state_no_pending_prediction' };
    if (remaining > 0) return result('unsatisfied', `${removed}/${b.members.size} bound ${p.selector} positions removed; ${remaining} remain${unknown ? `, ${unknown} unknown` : ''}`, evidence);
    if (unknown > 0) return result('unknown', `${removed}/${b.members.size} bound positions removed; ${unknown} cannot be confirmed now (unloaded or awaiting a server statement)`, evidence);
    return result('satisfied', `all ${b.members.size} bound ${p.selector} positions of the target are removed (server world state)`, evidence);
  }

  private position(sel: TargetSelector, s: GameSession, bound?: Bound): { at: { x: number; y: number; z: number }; label: string; remembered?: boolean } | { unknown: string } {
    const { services } = this.deps;
    switch (sel.kind) {
      case 'memory_ref': {
        const memory = this.deps.memory;
        if (!memory) return { unknown: 'memory is not installed in this run' };
        if (!bound?.owner) return { unknown: 'memory refs resolve only for their owning goal; this predicate has no goal owner' };
        const r = memory.resolveRef(sel.refId, { goalEpoch: bound.owner.goalEpoch, goalId: bound.owner.goalId, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) });
        if ('error' in r) return { unknown: `memory ref ${sel.refId} does not resolve (${r.error}): ${r.detail}` };
        return { at: r.at, label: `remembered ${r.category} "${r.label}"`, remembered: true };
      }
      case 'owner': {
        const owner = Object.values(s.bot.entities).find((e) => e && services.perception.isOwnerEntity(s.bot, e));
        if (!owner || !services.perception.entityVisibleNow(owner.id)) return { unknown: 'owner not currently visible; a remembered position does not prove presence' };
        return { at: owner.position, label: 'owner' };
      }
      case 'observed': {
        const rec = services.perception.identity(sel.snapshotId, sel.handle);
        if ('error' in rec) return { unknown: `handle ${sel.handle} cannot be resolved (${rec.error})` };
        const t = rec.target;
        if (t.kind === 'block') return { at: { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }, label: `${t.name} ${sel.handle}` };
        if (t.kind === 'frontier') return { at: t.at, label: `frontier ${sel.handle}` };
        if (t.kind === 'group') {
          const me = s.bot.entity.position;
          const m = [...t.members].sort((a, b) => Math.hypot(a.x + 0.5 - me.x, a.y - me.y, a.z + 0.5 - me.z) - Math.hypot(b.x + 0.5 - me.x, b.y - me.y, b.z + 0.5 - me.z))[0];
          if (!m) return { unknown: `group ${sel.handle} has no members` };
          return { at: { x: m.x + 0.5, y: m.y, z: m.z + 0.5 }, label: `${t.class} group ${sel.handle} (nearest observed member)` };
        }
        // Entity positions only from current line of sight (never hidden protocol positions).
        if (!services.perception.entityVisibleNow(t.entityId)) return { unknown: `${sel.handle} is not visible now; its position is not reported` };
        const e = s.bot.entities[t.entityId];
        if (!e) return { unknown: `${sel.handle} is no longer present` };
        return { at: e.position, label: sel.handle };
      }
      case 'remembered_anchor': {
        const a = services.perception.anchor(sel.anchorId);
        if (!a) return { unknown: `anchor ${sel.anchorId} not remembered` };
        return { at: a.at, label: a.label, remembered: true };
      }
      case 'owner_destination':
        return sel.dimension === String(s.bot.game.dimension) ? { at: sel.at, label: 'owner-supplied destination' } : { unknown: `destination is in ${sel.dimension}` };
      case 'prior_result': {
        const r = services.ledger.result(sel.actionId);
        if (!r) return { unknown: `no verified result for action ${sel.actionId} on this connection since the last lifecycle interruption` };
        if (r.dimension !== String(s.bot.game.dimension)) return { unknown: `the result of ${sel.actionId} is in ${r.dimension}, not the current dimension` };
        return { at: { x: r.x + 0.5, y: r.y, z: r.z + 0.5 }, label: `${r.key} placed by ${sel.actionId}` };
      }
      case 'registry': {
        const snap = services.perception.latest();
        const match = [...(snap?.blocks ?? []), ...(snap?.entities ?? []), ...(snap?.drops ?? [])]
          .filter((t) => (sel.key.startsWith('#') ? services.knowledge.recipes?.matches(sel.key, t.key) : t.key === sel.key))
          .sort((a, b) => a.distance - b.distance)[0];
        if (!match) return { unknown: `no visible ${sel.key} in the latest observation` };
        const rec = snap ? services.perception.resolve(snap.id, match.handle) : undefined;
        if (rec && !('error' in rec) && (rec.target.kind === 'entity' || rec.target.kind === 'drop')) {
          if (!services.perception.entityVisibleNow(rec.target.entityId)) return { unknown: `${match.key} ${match.handle} is not visible now` };
          const e = s.bot.entities[rec.target.entityId];
          if (e) return { at: e.position, label: `${match.key} ${match.handle}` };
        }
        return { at: match.at, label: `${match.key} ${match.handle} (latest observation ${snap?.id ?? ''})` };
      }
    }
  }
}
