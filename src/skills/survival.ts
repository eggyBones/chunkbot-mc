// Survival family (MB-FLOW-003): bounded registered capabilities over the
// SurvivalService facts. They are created bound to an installed, ENABLED
// service (survivalSkills(service)); a disabled survival registers nothing.
//
//   eat_safe_food        eat one suitable OWNED safe food (no risky/precious
//                        food, never at full hunger); delegates to the fenced
//                        use_held_item mechanism; server food/inventory evidence.
//   rest_in_place        stand still for a bounded window and observe server
//                        health packets: success only on a server-stated gain;
//                        damage or no regeneration ends honestly. Sustained.
//   go_to_death_site     walk to the BOUND recovery goal's own death site
//                        (code-owned destination, never a planner coordinate),
//                        inside the goal's travel bounds only.
//   recover_lost_items   pick up a visible drop that matches a still-sought
//                        item within the bounded search radius of the site;
//                        counted only from the server collect packet; no
//                        unrelated loot.
//   equip_suitable_tool  hold the cheapest owned tool that can harvest a named
//                        block, avoiding a nearly worn one when a spare exists.
//
// Every candidate/execution is fenced by the snapshot/owner goal epoch and the
// connection epoch through the service; nothing here controls the bot outside
// the actuator lease.
import { z } from 'zod';
import type { JsonValue, SkillOutcome } from '../contracts/index.ts';
import { SURVIVAL_CAPABILITIES } from '../contracts/survival.ts';
import { HOSTILE_ENTITIES, visibleThreat } from '../survival/allowance.ts';
import { isSafeFood, nearlyWorn, remainingUses, safeFoods, toolTier } from '../survival/items.ts';
import type { SurvivalService } from '../survival/service.ts';
import { liveEntity, mk, pos3 } from './common.ts';
import { failed, precondition, type AnySkill, type CandidateDraft, type SkillDefinition, type Unavailable } from './definition.ts';
import { equipItem } from './inventory.ts';
import { pickupItem } from './mining.ts';
import { distanceTo, goals, navigate } from './navigation.ts';
import { useHeldItem } from './placement.ts';
import { HandleRefSchema, ItemKeySchema } from './refs.ts';

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function survivalSkills(service: SurvivalService | undefined): AnySkill[] {
  if (!service || !service.enabled) return [];
  const cfg = service.config();
  if (!cfg) return [];

  const eatSafeFood: SkillDefinition<{ item: string }> = {
    descriptor: {
      id: SURVIVAL_CAPABILITIES.eatSafeFood,
      family: 'survival',
      purpose: 'Eat one suitable owned safe food (never risky or precious food, never at full hunger).',
      parameters: [{ name: 'item', type: 'registry_key', description: 'owned safe food to eat (offered by code)', required: true }],
      targets: ['inventory_item'],
      preconditions: ['server food level below 20', 'a safe food in the server inventory', 'no visible hostile nearby at low health'],
      effects: ['food is consumed; server food level rises'],
      supportedPredicates: ['survival_state'],
      timeoutMs: 10_000,
      cancellation: 'stop releases the use action immediately',
      limitations: ['risky foods (rotten flesh, spider eye, pufferfish, poisonous potato, raw chicken, suspicious stew, chorus fruit) and precious foods (golden apples/carrots) are never offered'],
      evidence: ['server update_health food level', 'server inventory resync diff'],
    },
    params: z.object({ item: ItemKeySchema }).strict(),
    resolve(ctx) {
      const epoch = ctx.session.connectionEpoch;
      const v = service.vitals(epoch);
      const inv = service.inventory(epoch);
      if (!v || !inv) return { drafts: [], unavailable: [{ reason: 'vitals_unknown', detail: 'no fresh server food level or inventory' }] };
      if (v.food >= 20) return { drafts: [], unavailable: [{ reason: 'not_hungry', detail: 'food is full; vanilla does not eat at full hunger' }] };
      const foods = safeFoods(inv.stacks, service.registry(), v.food, cfg.food.avoid);
      if (foods.length === 0) return { drafts: [], unavailable: [{ reason: 'no_safe_food', detail: 'no suitable owned safe food', evidence: { food: v.food } }] };
      const drafts: CandidateDraft[] = foods.slice(0, 4).map((f, i) => ({ parameters: { item: f.key }, description: `eat ${f.key} (+${f.foodPoints} food, ${f.count} owned)`, score: -i }));
      return { drafts };
    },
    async execute(ctx, params) {
      const epoch = ctx.session.connectionEpoch;
      const item = mk(params.item);
      const v = service.vitals(epoch);
      const inv = service.inventory(epoch);
      if (!v || v.food >= 20) return precondition('not_hungry', 'food is full or unknown');
      if (!isSafeFood(item, service.registry(), cfg.food.avoid)) return precondition('unsafe_food', `${item} is not a safe routine food`);
      if (!inv?.stacks.some((s) => s.key === item)) return precondition('item_not_in_inventory', `${item} is not in the server inventory`);
      if (v.health <= 8) {
        const latest = ctx.services.perception.latest();
        const threat = latest ? visibleThreat(latest, cfg.lowHealthAllowance.threatRadius) : undefined;
        if (threat) return precondition('threat_nearby', `visible ${threat.key} ${threat.distance} blocks away`);
      }
      return useHeldItem.execute(ctx, { item });
    },
  };

  const restInPlace: SkillDefinition<{ windowMs: number }> = {
    descriptor: {
      id: SURVIVAL_CAPABILITIES.restInPlace,
      family: 'survival',
      purpose: 'Stay still for a bounded window while health regenerates; success only on a server-stated health gain.',
      parameters: [{ name: 'windowMs', type: 'number', description: 'rest window (ms)', required: false, minimum: 2_000, maximum: 15_000 }],
      targets: ['none'],
      preconditions: ['health below 20', 'food at least 18 (natural regeneration)', 'no visible hostile nearby'],
      effects: ['none in the world; health may regenerate per server rules'],
      supportedPredicates: ['survival_state'],
      timeoutMs: 20_000,
      cancellation: 'stop ends the wait immediately (no controls are held)',
      limitations: ['no regeneration (difficulty/gamerule/food) ends as no_regeneration; damage ends as took_damage; there is no escape or combat reflex'],
      evidence: ['server update_health health values'],
    },
    params: z.object({ windowMs: z.number().int().min(2_000).max(15_000).default(10_000) }).strict(),
    sustained: { windowElapsed: (o: SkillOutcome) => o.status === 'succeeded' && (o.evidence as Record<string, unknown>)['restWindow'] === true },
    resolve(ctx) {
      const v = service.vitals(ctx.session.connectionEpoch);
      if (!v) return { drafts: [], unavailable: [{ reason: 'vitals_unknown', detail: 'no fresh server health' }] };
      if (v.health >= 20) return { drafts: [], unavailable: [{ reason: 'full_health', detail: 'health is full' }] };
      if (v.food < 18) return { drafts: [], unavailable: [{ reason: 'regeneration_needs_food', detail: `food ${v.food} is below 18; eat first` }] };
      const threat = visibleThreat(ctx.snapshot, cfg.lowHealthAllowance.threatRadius);
      if (threat) return { drafts: [], unavailable: [{ reason: 'threat_nearby', detail: `visible ${threat.key} ${threat.distance} blocks away; no escape capability is supported` }] };
      return { drafts: [{ parameters: { windowMs: 10_000 }, description: `rest in place for 10s (health ${v.health}, food ${v.food})` }] };
    },
    async execute(ctx, params) {
      const { act, session } = ctx;
      act.clearPathGoal();
      const before = service.vitals(session.connectionEpoch);
      if (!before) return precondition('vitals_unknown', 'no fresh server health');
      const startSeq = session.evidence.seq;
      const start = before.health;
      let max = start;
      const until = Date.now() + params.windowMs;
      while (Date.now() < until) {
        await act.sleep(500);
        const seen = session.evidence.since(startSeq, 'health');
        if (seen.some((h) => h.health < start - 0.01)) {
          const low = Math.min(...seen.map((h) => h.health));
          return failed('took_damage', `took damage while resting (health ${start} -> ${low}); stopping (no escape capability)`, { healthBefore: start, healthLow: low }, 'server_packet');
        }
        for (const h of seen) max = Math.max(max, h.health);
        if (max >= 20) break;
        const latest = ctx.services.perception.latest();
        const threat = latest ? visibleThreat(latest, cfg.lowHealthAllowance.threatRadius) : undefined;
        if (threat) return failed('threat_nearby', `visible ${threat.key} approached while resting`, { healthBefore: start, healthAfter: max });
      }
      const evidence: Record<string, JsonValue> = { healthBefore: start, healthAfter: max, restWindow: true, windowMs: params.windowMs };
      if (max > start) return { status: 'succeeded', effect: `health ${start} -> ${max} (server update_health)`, confirmation: 'server_packet', evidence };
      return failed('no_regeneration', `no server-confirmed health gain in ${Math.round(params.windowMs / 1000)}s (regeneration unavailable now)`, { ...evidence, restWindow: false });
    },
  };

  const fenceOf = (snapshot: { goalEpoch: number; connectionEpoch: number; dimension: string }) => ({ goalEpoch: snapshot.goalEpoch, connectionEpoch: snapshot.connectionEpoch, dimension: snapshot.dimension });

  const goToDeathSite: SkillDefinition<Record<string, never>> = {
    descriptor: {
      id: SURVIVAL_CAPABILITIES.goToDeathSite,
      family: 'survival',
      purpose: "Walk to this automatic recovery goal's own recorded death site (code-owned destination; never a planner coordinate).",
      parameters: [],
      targets: ['own_death_site'],
      preconditions: ['the goal is the admitted automatic recovery goal', 'same dimension', 'site inside the goal travel radius (long-distance routing is not integrated)', 'safe walking path'],
      effects: ['bot position changes; arrival at the site is recorded for the bounded search'],
      supportedPredicates: ['survival_state'],
      timeoutMs: 120_000,
      cancellation: 'stop clears the path goal and movement controls immediately through the actuator lease',
      limitations: ['never digs, places, pillars or parkours', 'a site in lava or the void is never targeted', 'arrival is client physics corrected by the server'],
      evidence: ['final distance from the actual bot position to the recorded site'],
    },
    params: z.object({}).strict(),
    resolve(ctx) {
      const t = service.recoveryTarget(fenceOf(ctx.snapshot));
      if ('error' in t) return { drafts: [], unavailable: [{ reason: t.error, detail: t.detail }] };
      if (!ctx.services.perception.withinTravel(t.site.at)) return { drafts: [], unavailable: [{ reason: 'outside_travel_bounds', detail: 'the death site is outside this goal\'s travel radius; long-distance own-death routing is not integrated (the bound is not relaxed)' }] };
      const lava = ctx.snapshot.blocks.find((b) => b.key === 'minecraft:lava' && dist(b.at, t.site.at) <= 2.5);
      if (lava) return { drafts: [], unavailable: [{ reason: 'site_hazard_visible', detail: 'lava is visible at the death site' }] };
      const d = dist(ctx.snapshot.self.at, t.site.at);
      return { drafts: [{ parameters: {}, description: d <= t.arrivalWithin ? 'confirm arrival at the own death site' : `walk to the own death site (${Math.round(d)} blocks)`, score: -d }] };
    },
    async execute(ctx) {
      const { session, services } = ctx;
      const bot = session.bot;
      if (ctx.owner.kind !== 'goal') return precondition('not_a_recovery_goal', 'only the recovery goal may travel to its death site');
      const snap = services.perception.latest();
      if (!snap) return precondition('observation_unavailable', 'no fresh observation');
      const t = service.recoveryTarget({ goalEpoch: ctx.owner.goalEpoch, connectionEpoch: session.connectionEpoch, dimension: String(bot.game.dimension) });
      if ('error' in t) return precondition(t.error, t.detail);
      if (t.goalId !== ctx.owner.goalId) return precondition('not_a_recovery_goal', 'the recovery belongs to another goal');
      if (!services.perception.withinTravel(t.site.at)) return precondition('outside_travel_bounds', 'the death site is outside the travel radius');
      const site = t.site.at;
      const bounds = services.perception.travelBounds();
      const r = await navigate(ctx.act, {
        goal: new goals.GoalNear(site.x, site.y, site.z, Math.max(1, t.arrivalWithin - 0.5)),
        arrived: () => distanceTo(bot, site) <= t.arrivalWithin + 0.25,
        distance: () => distanceTo(bot, site),
        timeoutMs: ctx.candidate.timeoutMs,
        searchRadius: Math.min(services.limits.travelRadius, Math.ceil(distanceTo(bot, site)) + 24),
        inBounds: () => services.perception.withinTravel(bot.entity.position),
        ...(bounds ? { bounds } : {}),
      });
      services.perception.recordVisited();
      const evidence: Record<string, JsonValue> = { finalDistance: r.finalDistance, position: pos3(bot.entity.position), site: pos3(site), elapsedMs: r.elapsedMs, serverCorrections: r.corrections };
      if (r.status === 'arrived') {
        service.markArrived({ goalId: ctx.owner.goalId, goalEpoch: ctx.owner.goalEpoch, connectionEpoch: session.connectionEpoch });
        return { status: 'succeeded', effect: `arrived within ${t.arrivalWithin} of the own death site (distance ${r.finalDistance}); the items there are NOT verified`, confirmation: 'client_only', evidence };
      }
      if (r.status === 'out_of_bounds') return failed('outside_travel_bounds', 'stopped at the travel radius on the way to the death site', evidence);
      if (r.status === 'no_path') return failed('no_safe_path', `no safe walking path to the death site; stopped ${r.finalDistance} blocks away`, evidence);
      return failed(r.status === 'timeout' ? 'timeout' : 'stuck', `${r.status} on the way to the death site (${r.finalDistance} blocks away)`, evidence);
    },
  };

  const recoverLostItems: SkillDefinition<{ target: { snapshotId: string; handle: string } }> = {
    descriptor: {
      id: SURVIVAL_CAPABILITIES.recoverLostItems,
      family: 'survival',
      purpose: 'Pick up a visible drop that matches a still-missing item from the own death incident, near the recorded site only.',
      parameters: [{ name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible scoped drp-* drop (offered by code)', required: true }],
      targets: ['drop'],
      preconditions: ['the goal is the admitted automatic recovery goal', 'drop key is still sought', 'drop within the bounded search radius of the site', 'inventory has room'],
      effects: ['item moves into the inventory (server collect packet); counted as regained prior possessions, not new acquisition'],
      supportedPredicates: ['survival_state'],
      timeoutMs: 60_000,
      cancellation: 'stop clears the path goal and controls immediately',
      limitations: ['merged or mixed drops cannot prove ownership: only still-sought keys up to the missing count are counted', 'never collects unrelated loot', 'a drop that vanished or was taken by another player is reported, never counted'],
      evidence: ['server collect packet (collector = bot)', 'server inventory resync delta'],
    },
    params: z.object({ target: HandleRefSchema }).strict(),
    resolve(ctx) {
      const t = service.recoveryTarget(fenceOf(ctx.snapshot));
      if ('error' in t) return { drafts: [], unavailable: [{ reason: t.error, detail: t.detail }] };
      const unavailable: Unavailable[] = [];
      const drafts: CandidateDraft[] = ctx.snapshot.drops
        .filter((d) => t.sought.has(d.key) && dist(d.at, t.site.at) <= t.searchRadius && ctx.services.perception.withinTravel(d.at))
        .map((d) => ({ parameters: { target: { snapshotId: ctx.snapshot.id, handle: d.handle } }, description: `recover ${d.key} ${d.label ?? ''} near the death site (${Math.round(d.distance)} blocks)`.replace('  ', ' '), score: -d.distance }));
      if (drafts.length === 0) {
        const atSite = dist(ctx.snapshot.self.at, t.site.at) <= t.arrivalWithin + 1.5;
        unavailable.push({ reason: atSite ? 'no_scoped_drops_visible' : 'not_at_site', detail: atSite ? 'no visible drop near the site matches a still-missing item (not proof of despawn)' : 'go to the death site first', evidence: { stillSought: [...t.sought.keys()].slice(0, 8) } });
      }
      return { drafts: drafts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6), unavailable };
    },
    async execute(ctx, params) {
      const { session, services } = ctx;
      if (ctx.owner.kind !== 'goal') return precondition('not_a_recovery_goal', 'only the recovery goal may recover items');
      const fence = { goalId: ctx.owner.goalId, goalEpoch: ctx.owner.goalEpoch, connectionEpoch: session.connectionEpoch };
      const t = service.recoveryTarget({ goalEpoch: fence.goalEpoch, connectionEpoch: fence.connectionEpoch, dimension: String(session.bot.game.dimension) });
      if ('error' in t) return precondition(t.error, t.detail);
      const live = liveEntity(services, session, params.target.snapshotId, params.target.handle);
      if ('error' in live) return precondition(live.error, live.detail);
      if (live.record.target.kind !== 'drop') return precondition('wrong_target_kind', 'not a dropped item');
      const item = live.record.target.item;
      if (!t.sought.has(item)) return precondition('not_sought', `${item} is not a still-missing item of this incident`);
      if (dist(live.position, t.site.at) > t.searchRadius) return precondition('outside_search_radius', 'the drop is outside the bounded search radius of the site');
      const result = await pickupItem.execute(ctx, params);
      const collected = typeof result.evidence?.['collectedCount'] === 'number' ? (result.evidence['collectedCount'] as number) : 0;
      if (result.status !== 'succeeded' || collected <= 0) return result;
      const counted = service.recordRegain(fence, item, collected, ctx.candidate.id);
      return { ...result, effect: `${result.effect}; counted ${counted} as regained from the own death incident (prior possessions, not new acquisition)${counted < collected ? `; ${collected - counted} beyond the missing count were not counted` : ''}`, evidence: { ...(result.evidence ?? {}), countedRegained: counted } };
    },
  };

  const equipSuitableTool: SkillDefinition<{ item: string; block: string }> = {
    descriptor: {
      id: SURVIVAL_CAPABILITIES.equipSuitableTool,
      family: 'survival',
      purpose: 'Hold the cheapest owned tool that can harvest a named block, avoiding a nearly worn tool when a spare exists.',
      parameters: [
        { name: 'block', type: 'registry_key', description: 'block the tool must harvest', required: true },
        { name: 'item', type: 'registry_key', description: 'chosen owned tool (offered by code)', required: true },
      ],
      targets: ['inventory_item'],
      preconditions: ['a capable tool is owned (server inventory)'],
      effects: ['the tool is held in the main hand (server-confirmed)'],
      supportedPredicates: ['equipped'],
      timeoutMs: 10_000,
      cancellation: 'stop prevents further clicks',
      limitations: ['durability is known only from server slot metadata; unknown metadata is never treated as healthy or worn', 'no repair/enchanting capability'],
      evidence: ['server inventory resync of the held slot'],
    },
    params: z.object({ item: ItemKeySchema, block: ItemKeySchema }).strict(),
    resolve(ctx) {
      const inv = service.inventory(ctx.session.connectionEpoch);
      if (!inv) return { drafts: [], unavailable: [{ reason: 'inventory_unknown', detail: 'no server inventory' }] };
      const blocks = new Set<string>();
      for (const k of ctx.hints.keys) if (!k.startsWith('#') && ctx.services.knowledge.isBlock(k)) blocks.add(k);
      for (const h of ctx.hints.handles) {
        const b = ctx.snapshot.blocks.find((x) => x.handle === h.handle && h.snapshotId === ctx.snapshot.id);
        if (b) blocks.add(b.key);
      }
      if (blocks.size === 0) return { drafts: [], unavailable: [{ reason: 'no_target_block', detail: 'the task names no block to choose a tool for' }] };
      const drafts: CandidateDraft[] = [];
      const unavailable: Unavailable[] = [];
      for (const block of [...blocks].slice(0, 4)) {
        const valid = new Set(ctx.services.knowledge.harvestTools(block).map(mk));
        const owned = inv.stacks.filter((s) => valid.has(s.key));
        if (valid.size === 0) {
          unavailable.push({ reason: 'no_tool_required', detail: `${block} needs no specific tool` });
          continue;
        }
        if (owned.length === 0) {
          unavailable.push({ reason: 'harvest_tool_missing', detail: `no owned tool can harvest ${block}`, evidence: { validTools: [...valid].slice(0, 6) } });
          continue;
        }
        const healthy = owned.filter((s) => nearlyWorn(s, cfg.tools.wornFraction, cfg.tools.wornUses) !== true);
        const pool = healthy.length ? healthy : owned;
        const best = [...pool].sort((a, b) => toolTier(a.key) - toolTier(b.key) || (remainingUses(b) ?? 0) - (remainingUses(a) ?? 0))[0];
        if (!best) continue;
        if (ctx.snapshot.equipment['hand'] === best.key) {
          unavailable.push({ reason: 'already_equipped', detail: `${best.key} is already held` });
          continue;
        }
        drafts.push({ parameters: { item: best.key, block }, description: `hold ${best.key} for ${block}${remainingUses(best) !== undefined ? ` (${remainingUses(best)} uses left)` : ' (durability unknown)'}${healthy.length ? '' : ' — every capable tool is nearly worn'}` });
      }
      return { drafts, unavailable };
    },
    async execute(ctx, params) {
      const inv = service.inventory(ctx.session.connectionEpoch);
      const key = mk(params.item);
      if (!inv?.stacks.some((s) => s.key === key)) return precondition('item_not_in_inventory', `${key} is not in the server inventory`);
      const valid = new Set(ctx.services.knowledge.harvestTools(mk(params.block)).map(mk));
      if (!valid.has(key)) return precondition('tool_cannot_harvest', `${key} cannot harvest ${params.block}`);
      return equipItem.execute(ctx, { item: key, slot: 'hand' });
    },
  };

  return [eatSafeFood, restInPlace, goToDeathSite, recoverLostItems, equipSuitableTool];
}

export { HOSTILE_ENTITIES };
