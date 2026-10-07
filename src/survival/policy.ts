// Routine evaluation (pure): each routine looks at FRESH server-backed facts
// and returns not-needed, needed-but-blocked (honest wait, with a condition
// signature) or a bounded proposal body. No inference, no actuation. The
// service applies hysteresis memory, cooldowns, admission caps and ordering.
import type { ObservationSnapshot } from '../contracts/observation.ts';
import type { OutcomePredicate } from '../contracts/predicate.ts';
import {
  SURVIVAL_CAPABILITIES,
  type Blocker,
  type InventoryFacts,
  type RecoveryEpisode,
  type RecoveryStatus,
  type SurvivalConfig,
  type SurvivalExecution,
  type SurvivalPriority,
  type SurvivalProposal,
  type SurvivalRoutine,
  type SurvivalStatePredicate,
  type TrackedStack,
  type Vitals,
} from '../contracts/survival.ts';
import { visibleThreat } from './allowance.ts';
import { siteIsHazard } from './death-cause.ts';
import { countedAttempts, distance, materiallyImproved, preparationSignature, repeatedFatalHazard, safeFoodCount } from './episodes.ts';
import { isArmor, isTool, isValuable, nearlyWorn, remainingUses, safeFoods, STORAGE_SLOTS, strip, toolKind, toolTier, type SurvivalItemRegistry } from './items.ts';

export interface DesignatedStorage {
  factId: string;
  label: string;
  dimension: string;
  at: { x: number; y: number; z: number };
}

export interface PolicyContext {
  now: number;
  cfg: SurvivalConfig;
  registry: SurvivalItemRegistry;
  /** Task-runtime low-health guard threshold (config limits.lowHealth). */
  lowHealth: number;
  travelRadius: number;
  vitals: Vitals | null;
  inv: InventoryFacts | null;
  snapshot: ObservationSnapshot | null;
  connection: { connectionEpoch: number; dimension: string };
  /** Oldest open episode (original incident first). */
  episode: RecoveryEpisode | undefined;
  /** The episode's capture is EXACTLY linked to a durable memory death fact (captureId -> factId). */
  episodeLinked: boolean;
  /** The survival store is scoped and writable (attempt bounds can persist). */
  storeWritable: boolean;
  /** C5: durability of the current episode/attempt bookkeeping. */
  durability: 'durable' | 'pending' | 'failed' | 'unavailable';
  durabilityError?: string;
  /** C5: durability of the exact memory death fact. */
  incidentDurability: 'durable' | 'pending' | 'failed' | 'unknown' | 'unlinked' | 'seam_missing';
  storeDetail: string;
  storage: readonly DesignatedStorage[];
  /** Route policy id for a FAR own-death site when code-owned routing is integrated (else undefined). */
  farRoute: (() => string | undefined) | undefined;
  goalLimits: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number };
  serves: SurvivalProposal['serves'];
}

export type ProposalBody = Omit<SurvivalProposal, 'proposalId' | 'expiresAtMs'>;

export type RoutineEval =
  | { routine: SurvivalRoutine; need: false; reason: string }
  | { routine: SurvivalRoutine; need: true; signature: string; blocked: { reason: string; detail: string; transient: boolean }; conclude?: { status: RecoveryStatus; blocker: Blocker } }
  | { routine: SurvivalRoutine; need: true; signature: string; proposal: ProposalBody };

const notNeeded = (routine: SurvivalRoutine, reason: string): RoutineEval => ({ routine, need: false, reason });
const blocked = (routine: SurvivalRoutine, signature: string, reason: string, detail: string, transient = false): RoutineEval => ({ routine, need: true, signature, blocked: { reason, detail, transient } });

const bare = (k: string) => strip(k).replace(/_/g, ' ');
const listItems = (m: ReadonlyMap<string, number> | Array<{ key: string; count: number }>, max = 8): string => {
  const arr = Array.isArray(m) ? m.map((x) => [x.key, x.count] as const) : [...m.entries()];
  const shown = arr.slice(0, max).map(([k, n]) => `${n} ${strip(k)}`);
  return `${shown.join(', ')}${arr.length > max ? ` and ${arr.length - max} more kind(s)` : ''}`;
};

function codeTask(objective: string, decisionInstruction: string, capability: string, completion: SurvivalStatePredicate | OutcomePredicate, selectors: Array<{ kind: 'registry'; key: string }> = []): SurvivalExecution {
  return {
    kind: 'code_task',
    objective,
    mode: 'complete',
    spec: { objective, decisionInstruction, allowedCapabilities: [capability], targetSelectors: selectors, parameters: {} },
    completion,
  };
}

function ceilings(ctx: PolicyContext, want: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number }) {
  return {
    plannerTurns: Math.max(0, Math.min(want.plannerTurns, ctx.goalLimits.plannerTurns)),
    tasks: Math.max(1, Math.min(want.tasks, ctx.goalLimits.tasks)),
    replans: Math.max(0, Math.min(want.replans, ctx.goalLimits.replans)),
    deadlineMs: Math.max(1_000, Math.min(want.deadlineMs, ctx.goalLimits.deadlineMs)),
  };
}

// ---------------------------------------------------------------- eat

export function evalEat(ctx: PolicyContext): RoutineEval {
  const v = ctx.vitals;
  if (!v) return notNeeded('eat', 'no fresh server vitals');
  const { food: f } = ctx.cfg;
  const healthNeedsFood = v.health <= ctx.cfg.health.restAtOrBelow && v.food < 18;
  if (v.food >= 20) return notNeeded('eat', 'food is full');
  if (v.food > f.eatAtOrBelow && !healthNeedsFood) return notNeeded('eat', `food ${v.food} above ${f.eatAtOrBelow}`);
  const foods = safeFoods(ctx.inv?.stacks ?? [], ctx.registry, v.food, f.avoid);
  const signature = `eat:${v.food}:${foods.map((x) => x.key).join(',')}`;
  if (!ctx.inv || !ctx.inv.fullSync) return blocked('eat', 'eat:inventory_unknown', 'inventory_unknown', 'no full server inventory sync yet', true);
  if (foods.length === 0) return blocked('eat', `eat:none:${v.food}`, 'no_safe_food', `food ${v.food}/20 and no suitable owned food (risky and precious foods are never eaten automatically)`);
  if (ctx.snapshot) {
    const threat = visibleThreat(ctx.snapshot, ctx.cfg.lowHealthAllowance.threatRadius);
    if (threat && v.health <= ctx.lowHealth) return blocked('eat', `eat:threat:${threat.key}:${Math.round(threat.distance)}`, 'threat_nearby', `visible ${threat.key} ${threat.distance} blocks away at low health; eating here is unsafe and no escape capability is supported`, true);
  }
  const low = v.health <= ctx.lowHealth;
  const priority: SurvivalPriority = low || v.food <= 6 ? 'safety' : 'support';
  return {
    routine: 'eat',
    need: true,
    signature,
    proposal: {
      routine: 'eat',
      priority,
      reason: `food ${v.food}/20${healthNeedsFood ? `, health ${v.health} needs food to regenerate` : ''}`,
      signature,
      serves: ctx.serves,
      execution: codeTask(
        'Eat suitable owned food until hunger is restored',
        'Choose one offered safe food to eat; prefer the option that wastes the least hunger.',
        SURVIVAL_CAPABILITIES.eatSafeFood,
        { predicate: 'survival_state', routine: 'eat', expect: 'satisfied' },
      ),
      ceilings: ceilings(ctx, { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 90_000 }),
      ...(low
        ? {
            lowHealthAllowance: {
              routine: 'eat',
              capabilities: [SURVIVAL_CAPABILITIES.eatSafeFood],
              items: foods.map((x) => x.key).slice(0, 8),
              maxActions: ctx.cfg.lowHealthAllowance.maxActions,
              ttlMs: ctx.cfg.lowHealthAllowance.ttlMs,
            },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------- rest

export function evalRest(ctx: PolicyContext): RoutineEval {
  const v = ctx.vitals;
  if (!v) return notNeeded('rest', 'no fresh server vitals');
  const h = ctx.cfg.health;
  if (v.health > h.restAtOrBelow) return notNeeded('rest', `health ${v.health} above ${h.restAtOrBelow}`);
  const band = Math.floor(v.health / 2);
  const fed = v.food >= 18;
  const signature = `rest:${fed ? 'fed' : 'hungry'}:${band}`;
  if (!fed) return blocked('rest', signature, 'regeneration_needs_food', `health ${v.health}; food ${v.food} is below 18 so natural regeneration is not expected; eat first`);
  if (ctx.snapshot) {
    const threat = visibleThreat(ctx.snapshot, ctx.cfg.lowHealthAllowance.threatRadius);
    if (threat) return blocked('rest', `${signature}:threat:${threat.key}`, 'threat_nearby', `visible ${threat.key} ${threat.distance} blocks away; resting here is unsafe and no escape/combat capability is supported`, true);
  }
  const low = v.health <= ctx.lowHealth;
  return {
    routine: 'rest',
    need: true,
    signature,
    proposal: {
      routine: 'rest',
      priority: low ? 'safety' : 'support',
      reason: `health ${v.health}/20 with food ${v.food}`,
      signature,
      serves: ctx.serves,
      execution: codeTask(
        'Rest in place until health regenerates',
        'Rest in place; stop if health does not regenerate.',
        SURVIVAL_CAPABILITIES.restInPlace,
        { predicate: 'survival_state', routine: 'rest', expect: 'satisfied' },
      ),
      ceilings: ceilings(ctx, { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: h.maxRestMs + 15_000 }),
      ...(low ? { lowHealthAllowance: { routine: 'rest', capabilities: [SURVIVAL_CAPABILITIES.restInPlace], items: [], maxActions: Math.min(8, Math.ceil(h.maxRestMs / 10_000)), ttlMs: Math.min(300_000, h.maxRestMs + 10_000) } } : {}),
    },
  };
}

// ---------------------------------------------------------------- death recovery

export function recoveryRemaining(ctx: Pick<PolicyContext, 'cfg'>, e: RecoveryEpisode) {
  const r = ctx.cfg.recovery;
  return { plannerTurns: r.episodePlannerTurns - e.budget.plannerTurns, tasks: r.episodeTasks - e.budget.tasks, replans: r.episodeReplans - e.budget.replans, deadlineMs: e.openedAtMs + r.episodeDeadlineMs };
}

export function evalRecovery(ctx: PolicyContext): RoutineEval {
  const e = ctx.episode;
  if (!e) return notNeeded('death_recovery', 'no open death incident');
  if (e.phase === 'awaiting_respawn' || e.phase === 'assessing') return notNeeded('death_recovery', 'awaiting fresh respawn state');
  if (e.phase !== 'ready') return notNeeded('death_recovery', `episode ${e.phase}`);
  const sig = (s: string) => `recovery:${e.episodeId}:${s}`;
  const conclude = (status: RecoveryStatus, reason: string, detail: string): RoutineEval => ({ routine: 'death_recovery', need: true, signature: sig(reason), blocked: { reason, detail, transient: false }, conclude: { status, blocker: { reason, detail, atMs: ctx.now, signature: sig(reason) } } });
  if (!ctx.storeWritable) return blocked('death_recovery', sig(`store:${ctx.storeDetail.slice(0, 40)}`), 'durable_scope_unavailable', `recovery attempts must persist under the operator scope: ${ctx.storeDetail}`);
  if (!ctx.episodeLinked) return blocked('death_recovery', sig('unlinked'), 'incident_not_linked', 'the death capture is not exactly linked to a durable memory death fact; recovery is not authorized without it');
  // C5: durable authority before any recovery admission.
  if (ctx.durability === 'pending') return blocked('death_recovery', sig('store_pending'), 'durable_write_pending', 'the survival episode is not yet saved durably; waiting before recovery', true);
  if (ctx.durability === 'failed') return blocked('death_recovery', sig('store_failed'), 'durable_write_failed', `the survival episode could not be saved durably (${ctx.durabilityError ?? 'write failed'}); recovery waits for a successful save`, true);
  if (ctx.incidentDurability === 'pending') return blocked('death_recovery', sig('mem_pending'), 'incident_write_pending', 'the memory death fact is not yet durable; waiting', true);
  if (ctx.incidentDurability === 'failed') return blocked('death_recovery', sig('mem_failed'), 'incident_write_failed', 'the memory death fact could not be saved durably');
  if (ctx.incidentDurability === 'seam_missing') return blocked('death_recovery', sig('mem_seam'), 'incident_durability_unknown', 'memory durability of the death fact cannot be confirmed (durability seam not installed); recovery is not authorized');
  if (ctx.incidentDurability !== 'durable') return blocked('death_recovery', sig(`mem_${ctx.incidentDurability}`), 'incident_not_durable', `the memory death fact is not confirmed durable (${ctx.incidentDurability})`);
  if (!ctx.inv || ctx.inv.source !== 'server_packets' || !ctx.inv.fullSync) return blocked('death_recovery', sig('inv'), 'inventory_unknown', 'no full server inventory on this connection yet', true);
  const rem = recoveryRemaining(ctx, e);
  if (ctx.now >= rem.deadlineMs) return conclude(e.regained.length ? 'partially_recovered' : 'unknown', 'recovery_window_ended', 'the bounded recovery window ended; the items may or may not still exist (no despawn time is claimed)');
  if (rem.plannerTurns <= 0 || rem.tasks <= 0) return conclude(e.regained.length ? 'partially_recovered' : 'blocked', 'episode_budget_exhausted', `episode used ${e.budget.plannerTurns} planner turns and ${e.budget.tasks} tasks of its ceilings`);
  const used = countedAttempts(e);
  if (used >= e.maxAttempts) return conclude(e.regained.length ? 'partially_recovered' : 'unknown', 'attempts_exhausted', `all ${e.maxAttempts} recovery attempts were used`);
  const repeat = repeatedFatalHazard(e, ctx.cfg.recovery.sameHazardRadius);
  if (repeat) return conclude(e.regained.length ? 'partially_recovered' : 'blocked', 'repeated_fatal_hazard', `died again near the site (${repeat.translationKey ?? repeat.hazard}); the same unresolved hazard blocks further recovery`);
  const site = e.site;
  if (!site.at || !site.dimension) return conclude('blocked', 'site_unknown', 'the death location is unknown');
  if (siteIsHazard(e.cause.hazard) && used > 0) return conclude(e.regained.length ? 'partially_recovered' : 'blocked', 'site_fatal_hazard', `the site is a ${e.cause.hazard} hazard and an attempt already ran`);
  const self = ctx.snapshot?.self.at;
  if (site.dimension !== ctx.connection.dimension) return blocked('death_recovery', sig(`dim:${ctx.connection.dimension}`), 'cross_dimension', `the death site is in ${site.dimension}; cross-dimension recovery is not supported`);
  if (!self) return blocked('death_recovery', sig('noself'), 'observation_unavailable', 'no fresh observation', true);
  const d = Math.round(distance(self, site.at));
  let routePolicy = 'local';
  if (d > ctx.travelRadius - ctx.cfg.recovery.arrivalWithin) {
    const far = ctx.farRoute?.();
    if (!far) return blocked('death_recovery', sig(`far:${Math.floor(self.x / 32)},${Math.floor(self.z / 32)}`), 'outside_travel_bounds', `the death site is ${d} blocks away, beyond the ${ctx.travelRadius}-block goal travel bound; long-distance own-death routing is not integrated (the bound is not relaxed)`);
    routePolicy = far;
  }
  const v = ctx.vitals;
  if (v && v.health < Math.min(ctx.cfg.health.restUntil, 14)) return blocked('death_recovery', sig(`health:${Math.floor(v.health / 2)}`), 'health_too_low', `health ${v.health}; recover health before travelling`, true);
  const prep = preparationSignature(ctx.inv, v?.health ?? 0, ctx.registry, { dimension: ctx.connection.dimension, at: self }, routePolicy, ctx.cfg.food.avoid);
  const prev = [...e.attempts].reverse().find((a) => a.endedAtMs !== undefined && !['owner_stop', 'replaced', 'shutdown', 'planner_not_ready', 'decision_not_ready'].includes(a.outcome ?? ''));
  if (prev) {
    const imp = materiallyImproved(prev.preparation, prep, prev.outcome, e.cause.hazard);
    if (!imp.improved) return blocked('death_recovery', sig(`prep:${prep.armorPoints}:${prep.routePolicy}:${Math.floor(self.x / 16)},${Math.floor(self.z / 16)}`), 'no_material_improvement', `attempt ${used + 1} needs a materially better preparation or route: ${imp.why}`);
  }
  const sought = new Map<string, number>();
  for (const m of e.manifest?.missing ?? []) if (m.state === 'missing' && m.count > 0) sought.set(m.key, m.count);
  if (sought.size === 0) return conclude(e.regained.length ? 'recovered' : 'no_loss', 'nothing_sought', 'nothing remains to recover');
  const valuables = (e.manifest?.missing ?? []).filter((m) => m.state === 'missing' && m.valuable).map((m) => strip(m.key));
  const dir = compass(self, site.at);
  const signature = sig(`attempt:${used + 1}:${prep.armorPoints}:${prep.routePolicy}`);
  const facts = [
    `incident ${e.originalIncidentFactId ?? e.episodeId}: died ${Math.round((ctx.now - e.occurredAtMs) / 1000)}s ago (${e.cause.translationKey ?? 'cause unknown'}), site source ${site.source}`,
    `site about ${d} blocks ${dir} in ${site.dimension}`,
    `still sought (from the last-alive record minus server-confirmed regains): ${listItems(sought)}`,
    ...(valuables.length ? [`valuable: ${valuables.slice(0, 6).join(', ')}`] : []),
    `attempt ${used + 1} of ${e.maxAttempts}; episode budget left: ${rem.plannerTurns} planner turns, ${rem.tasks} tasks`,
    ...(e.manifest?.partial ? ['the loss manifest is partial (some pre-death or fresh inventory evidence was unavailable)'] : []),
  ];
  const instruction = `Automatic support routine (not an owner request): recover my own belongings lost at death incident ${e.originalIncidentFactId ?? e.episodeId}, about ${d} blocks ${dir}. Use go_to_death_site, then recover_lost_items to pick up only the matching visible drops near the site; finish when survival_state death_recovery is concluded.`;
  return {
    routine: 'death_recovery',
    need: true,
    signature,
    proposal: {
      routine: 'death_recovery',
      priority: 'support',
      reason: `recover ${listItems(sought, 3)} from own death site (attempt ${used + 1}/${e.maxAttempts})`,
      signature,
      serves: ctx.serves,
      episodeId: e.episodeId,
      execution: {
        kind: 'planner_goal',
        instruction,
        context: {
          routine: 'death_recovery',
          facts,
          suggestedCapabilities: [SURVIVAL_CAPABILITIES.goToDeathSite, SURVIVAL_CAPABILITIES.recoverLostItems],
          rules: [
            'pick up only drops offered by recover_lost_items (scoped to the death site and the missing items); never sweep other loot',
            'items may have despawned, burned or been taken: never promise their return, an exact despawn time or experience restoration',
            'stop and report if the site is unsafe; never dig, tower or build a shortcut to reach it',
            'recovered items are prior possessions, not newly acquired work',
          ],
        },
      },
      ceilings: ceilings(ctx, { plannerTurns: rem.plannerTurns, tasks: rem.tasks, replans: rem.replans, deadlineMs: rem.deadlineMs - ctx.now }),
    },
  };
}

function compass(from: { x: number; z: number }, to: { x: number; z: number }): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 2) return 'here';
  const a = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const names = ['north', 'north_east', 'east', 'south_east', 'south', 'south_west', 'west', 'north_west'];
  return names[(Math.round(((a + 360) % 360) / 45) % 8) as number] as string;
}

// ---------------------------------------------------------------- tool upkeep

/** Tool kinds whose best owned stack is nearly worn with no capable spare (unknown metadata is never "worn"). */
export function wornTools(inv: InventoryFacts | null, cfg: SurvivalConfig): Array<{ kind: string; key: string; left: number }> {
  if (!inv) return [];
  const byKind = new Map<string, TrackedStack[]>();
  for (const s of inv.stacks) {
    const kind = toolKind(s.key);
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), s]);
  }
  const out: Array<{ kind: string; key: string; left: number }> = [];
  for (const [kind, stacks] of byKind) {
    const states = stacks.map((s) => ({ s, worn: nearlyWorn(s, cfg.tools.wornFraction, cfg.tools.wornUses) }));
    if (states.some((x) => x.worn !== true)) continue; // a healthy or unknown-metadata spare exists
    const best = states.sort((a, b) => toolTier(b.s.key) - toolTier(a.s.key))[0];
    if (best) out.push({ kind, key: best.s.key, left: remainingUses(best.s) ?? 0 });
  }
  return out;
}

export function evalToolUpkeep(ctx: PolicyContext): RoutineEval {
  if (!ctx.inv || !ctx.inv.fullSync) return notNeeded('tool_upkeep', 'no full server inventory');
  const worn = wornTools(ctx.inv, ctx.cfg);
  if (worn.length === 0) {
    // Owned, better armor not worn: a code task through the existing equip capability.
    const better = betterArmor(ctx.inv);
    if (!better) return notNeeded('tool_upkeep', 'no nearly worn tool without a spare');
    const signature = `armor:${better.key}:${better.slot}`;
    return {
      routine: 'tool_upkeep',
      need: true,
      signature,
      proposal: {
        routine: 'tool_upkeep',
        priority: 'support',
        reason: `wear owned ${bare(better.key)}`,
        signature,
        serves: ctx.serves,
        execution: codeTask(`Wear the owned ${bare(better.key)}`, `Equip ${better.key} in the ${better.slot} slot.`, 'equip_item', { predicate: 'equipped', selector: better.key, slot: better.slot }, [{ kind: 'registry', key: better.key }]),
        ceilings: ceilings(ctx, { plannerTurns: 0, tasks: 1, replans: 0, deadlineMs: 30_000 }),
      },
    };
  }
  const w = worn[0] as { kind: string; key: string; left: number };
  const signature = `tool:${w.key}:${w.left}`;
  const valuable = isValuable(w.key);
  return {
    routine: 'tool_upkeep',
    need: true,
    signature,
    proposal: {
      routine: 'tool_upkeep',
      priority: 'support',
      reason: `${bare(w.key)} has ${w.left} uses left and no spare ${w.kind}`,
      signature,
      serves: ctx.serves,
      execution: {
        kind: 'planner_goal',
        instruction: `Automatic support routine (not an owner request): my ${bare(w.key)} is nearly worn (${w.left} uses left) and I have no spare ${w.kind}. Make or obtain one replacement ${w.kind} with owned or nearby obtainable materials, preferring the cheapest tier that does the job; finish when survival_state tool_upkeep is satisfied.`,
        context: {
          routine: 'tool_upkeep',
          facts: [`worn: ${w.key} with ${w.left} uses left (server slot durability)`, ...worn.slice(1, 4).map((x) => `also worn: ${x.key} (${x.left} left)`)],
          suggestedCapabilities: ['craft_item', 'mine_block', 'pickup_item', 'move_near'],
          rules: ['no repair or enchanting capability exists; do not claim one', valuable ? 'do not spend valuable materials unless a cheaper tier cannot work' : 'a cheaper tier is acceptable', 'keep the worn tool unless it breaks'],
        },
      },
      ceilings: ceilings(ctx, { plannerTurns: 6, tasks: 12, replans: 2, deadlineMs: 10 * 60_000 }),
    },
  };
}

const SLOT_OF: Record<string, { slot: 'head' | 'torso' | 'legs' | 'feet'; index: number }> = { helmet: { slot: 'head', index: 5 }, chestplate: { slot: 'torso', index: 6 }, leggings: { slot: 'legs', index: 7 }, boots: { slot: 'feet', index: 8 } };

function betterArmor(inv: InventoryFacts): { key: string; slot: 'head' | 'torso' | 'legs' | 'feet' } | undefined {
  for (const s of inv.stacks) {
    if (s.slot <= 8 || !isArmor(s.key)) continue;
    const piece = /_(helmet|chestplate|leggings|boots)$/.exec(strip(s.key))?.[1];
    const target = piece ? SLOT_OF[piece] : undefined;
    if (!target) continue;
    const worn = inv.stacks.find((x) => x.slot === target.index);
    if (!worn) return { key: s.key, slot: target.slot };
  }
  return undefined;
}

// ---------------------------------------------------------------- inventory room

export function freeSlots(inv: InventoryFacts): number {
  const used = new Set(inv.stacks.filter((s) => STORAGE_SLOTS.includes(s.slot)).map((s) => s.slot));
  return STORAGE_SLOTS.length - used.size;
}

/** Surplus stacks safe to deposit: no tools/armor/valuables/safe food reserve/configured reserves. */
export function surplus(inv: InventoryFacts, ctx: Pick<PolicyContext, 'cfg' | 'registry'>): Array<{ key: string; count: number }> {
  const reserveKeys = new Set(ctx.cfg.resupply.reserves.map((r) => r.key));
  const m = new Map<string, number>();
  for (const s of inv.stacks) {
    if (!STORAGE_SLOTS.includes(s.slot)) continue;
    if (isTool(s.key) || isArmor(s.key) || isValuable(s.key, s.meta) || reserveKeys.has(s.key)) continue;
    if (safeFoods([s], ctx.registry, 0).length > 0) continue;
    m.set(s.key, (m.get(s.key) ?? 0) + s.count);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

export function evalInventoryRoom(ctx: PolicyContext): RoutineEval {
  if (!ctx.inv || !ctx.inv.fullSync) return notNeeded('inventory_room', 'no full server inventory');
  const free = freeSlots(ctx.inv);
  if (free > ctx.cfg.inventory.minFreeSlots) return notNeeded('inventory_room', `${free} free slots`);
  const sur = surplus(ctx.inv, ctx);
  const here = ctx.snapshot?.self.at;
  const storage = ctx.storage.filter((s) => s.dimension === ctx.connection.dimension && (!here || distance(here, s.at) <= ctx.travelRadius - 2));
  const signature = `inv:${free}:${storage.map((s) => s.factId).join(',')}:${sur.length}`;
  if (storage.length === 0) return blocked('inventory_room', signature, 'no_designated_storage', `${free} free slots; no owner-designated storage is remembered within reach (arbitrary chests are never used; nothing is thrown away)`);
  if (sur.length === 0) return blocked('inventory_room', signature, 'no_surplus', `${free} free slots but every stack is a tool, armor, food, reserve or valuable`);
  const target = storage[0] as DesignatedStorage;
  return {
    routine: 'inventory_room',
    need: true,
    signature,
    proposal: {
      routine: 'inventory_room',
      priority: 'support',
      reason: `${free} free inventory slots`,
      signature,
      serves: ctx.serves,
      execution: {
        kind: 'planner_goal',
        instruction: `Automatic support routine (not an owner request): make inventory room. Inspect the owner-designated storage "${target.label}" (memory ${target.factId}) fresh, then deposit surplus stacks there until at least ${ctx.cfg.inventory.targetFreeSlots} inventory slots are free; finish when survival_state inventory_room is satisfied.`,
        context: {
          routine: 'inventory_room',
          facts: [`free slots: ${free}`, `surplus candidates: ${listItems(sur)}`, `designated storage: ${storage.slice(0, 3).map((s) => `"${s.label}" (${s.factId})`).join(', ')}`],
          suggestedCapabilities: ['go_to_memory', 'inspect_container', 'container_transfer'],
          rules: ['use only the designated storage, inspected fresh before relying on its contents', 'keep tools, armor, food reserve and valuables', 'never drop or throw items away'],
        },
      },
      ceilings: ceilings(ctx, { plannerTurns: 6, tasks: 10, replans: 2, deadlineMs: 8 * 60_000 }),
    },
  };
}

// ---------------------------------------------------------------- resupply

export function reserveCount(key: string, inv: InventoryFacts | null, ctx: Pick<PolicyContext, 'cfg' | 'registry'>): number {
  if (!inv) return 0;
  if (key === 'chunkbot:safe_food') return safeFoodCount(inv, ctx.registry, ctx.cfg.food.avoid);
  return inv.stacks.filter((s) => s.key === key).reduce((n, s) => n + s.count, 0);
}

export function evalResupply(ctx: PolicyContext, onCooldown: (key: string) => boolean): RoutineEval {
  if (!ctx.inv || !ctx.inv.fullSync) return notNeeded('resupply', 'no full server inventory');
  for (const r of ctx.cfg.resupply.reserves) {
    const have = reserveCount(r.key, ctx.inv, ctx);
    if (have >= r.low || onCooldown(r.key)) continue;
    const want = r.high - have;
    const here = ctx.snapshot?.self.at;
    const signature = `resupply:${r.key}:${have}:${here ? `${Math.floor(here.x / 32)},${Math.floor(here.z / 32)}` : '?'}`;
    const what = r.key === 'chunkbot:safe_food' ? 'safe food items (for example bread, cooked meat, apples, carrots or baked potatoes)' : strip(r.key);
    return {
      routine: 'resupply',
      need: true,
      signature,
      proposal: {
        routine: 'resupply',
        priority: 'support',
        reason: `${r.key} reserve ${have} below ${r.low}`,
        signature,
        serves: ctx.serves,
        execution: {
          kind: 'planner_goal',
          instruction: `Automatic support routine (not an owner request): restock a basic reserve. Obtain about ${want} more ${what} from reachable sources inside the travel radius; finish when survival_state resupply is satisfied (at least ${r.high}).`,
          context: {
            routine: 'resupply',
            facts: [`reserve ${r.key}: have ${have}, low ${r.low}, target ${r.high}`],
            suggestedCapabilities: ['mine_block', 'pickup_item', 'craft_item', 'furnace_insert', 'furnace_wait', 'furnace_take', 'attack_entity', 'move_near', 'explore_frontier'],
            rules: ['acquire only the shortfall, then stop', 'do not take items from other players or arbitrary containers', 'do not eat precious food'],
          },
        },
        ceilings: ceilings(ctx, { plannerTurns: 6, tasks: 12, replans: 2, deadlineMs: 10 * 60_000 }),
      },
    };
  }
  return notNeeded('resupply', 'reserves at or above their low thresholds (or cooling down)');
}

export const ROUTINE_ORDER: readonly SurvivalRoutine[] = ['eat', 'rest', 'death_recovery', 'tool_upkeep', 'inventory_room', 'resupply'];
