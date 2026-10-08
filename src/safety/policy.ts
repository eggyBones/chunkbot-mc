// Pure immediate-safety policy: fresh facts -> hazards -> one bounded plan.
//
// Priority: fluid hazards (submerged / swimming-depth water / low or unknown
// air while submerged / lava) first — nothing is fought from water — then mob
// threats. Mob responses default to RETREAT. Defensive melee is admitted only
// when EVERY check passes for exactly one supported, visible, reachable
// threat (dispositions.ts) with a verified equipped weapon, armor,
// durability, health/food and dry footing, and with no creeper, ranged,
// group or provoked-neutral threat present. A retreat that cannot be found
// with adequate readiness becomes a cornered defense; without readiness it is
// a declarative blocker. No model is consulted.
import type { DefenseReadiness, SafetyConfig, SafetyEntityFact, SafetyHazard, SafetyHazardKind, SafetyItemFact, SafetyPlan, SafetySelfFacts } from '../contracts/safety.ts';
import { armorPointsOf, weaponFacts, type WeaponFacts } from './dispositions.ts';

export interface PolicyContext {
  config: SafetyConfig;
  nowMs: number;
  /** Exact-version item tag membership (VersionKnowledge). */
  inTag(tag: '#minecraft:swords' | '#minecraft:axes', key: string): boolean;
  /** Whether a fluid exit exists (computed lazily by the caller). */
  fluidExitAvailable(): boolean;
  /** Whether a retreat leg exists away from the given threats (computed lazily). */
  retreatAvailable(threats: readonly SafetyEntityFact[]): boolean;
  /** Entity type supports defense (dispositions.ts) — supplied with the fact's held item. */
  defenseSupported(fact: SafetyEntityFact): boolean;
}

const sev = (h: SafetyHazard) => (h.severity === 'critical' ? 3 : h.severity === 'high' ? 2 : 1);

export function fluidHazards(self: SafetySelfFacts, config: SafetyConfig): SafetyHazard[] {
  const out: SafetyHazard[] = [];
  const f = self.fluid;
  if (f.feetIn === 'lava' || f.eyeIn === 'lava') out.push({ kind: 'in_lava', severity: 'critical', detail: 'in lava (local estimate)', entityIds: [] });
  if (f.eyeIn === 'water') {
    out.push({ kind: 'submerged', severity: 'critical', detail: `eyes under water (local estimate); headroom ${f.headroom}${f.surfaceDy !== null ? `, surface ${f.surfaceDy} up` : ''}`, entityIds: [] });
  } else if (f.feetIn === 'water' && f.wadeable !== true) {
    out.push({ kind: 'deep_water', severity: 'high', detail: `in water at swimming depth: no floor that keeps the eyes above water (support ${f.support}, local estimate)`, entityIds: [] });
  }
  const air = self.air;
  if (air.source === 'server_metadata' && air.value !== null && air.value <= config.water.lowAirAtOrBelow && (f.eyeIn === 'water' || air.trend === 'falling')) {
    out.push({ kind: 'low_air', severity: 'critical', detail: `server air ${air.value}/${air.max}`, entityIds: [] });
  } else if (air.source === 'unknown' && f.eyeIn === 'water') {
    out.push({ kind: 'low_air', severity: 'critical', detail: 'air unknown (no server statement on this connection) while submerged; treated as urgent, not as a full reserve', entityIds: [] });
  }
  return out;
}

/** Active threats among VISIBLE entities (the caller passes visible facts only). */
export function threatHazards(entities: readonly SafetyEntityFact[], config: SafetyConfig, nowMs: number): { hazards: SafetyHazard[]; active: SafetyEntityFact[] } {
  const m = config.mobs;
  const hazards: SafetyHazard[] = [];
  const active: SafetyEntityFact[] = [];
  const provoked = (e: SafetyEntityFact) => e.damagedSelfAtMs !== null && nowMs - e.damagedSelfAtMs <= m.provokedWindowMs;
  for (const e of entities) {
    if (e.distance > m.scanRadius) continue;
    const add = (kind: SafetyHazardKind, severity: SafetyHazard['severity'], detail: string) => {
      hazards.push({ kind, severity, detail: `${e.key} ${Math.round(e.distance * 10) / 10} blocks: ${detail}`, entityIds: [e.entityId] });
      active.push(e);
    };
    switch (e.disposition) {
      case 'owner':
      case 'player':
      case 'passive':
        break;
      case 'hostile_explosive':
        if (e.fuse && (e.fuse.swelling || e.fuse.ignited)) add('creeper', 'critical', e.fuse.ignited ? 'ignited (server metadata)' : 'fuse swelling (server metadata)');
        else if (e.distance <= m.creeperRadius) add('creeper', 'high', 'creeper within avoidance radius');
        break;
      case 'hostile_ranged':
        if (provoked(e)) add('ranged_threat', 'high', 'damaged the bot (server damage event)');
        else if (e.distance <= m.closeRadius) add('ranged_threat', 'high', 'very close');
        else if (e.distance <= m.rangedRadius && e.aggressive === true) add('ranged_threat', 'high', 'aggressive (server metadata)');
        else if (e.distance <= m.dangerRadius && e.approaching === true) add('ranged_threat', 'moderate', 'approaching');
        break;
      case 'hostile_melee':
      case 'hostile_other':
        if (provoked(e)) add('melee_threat', 'high', 'damaged the bot (server damage event)');
        else if (e.distance <= m.closeRadius) add('melee_threat', 'high', 'very close');
        else if (e.distance <= m.dangerRadius && (e.aggressive === true || e.approaching === true)) add('melee_threat', 'moderate', e.aggressive ? 'aggressive (server metadata)' : 'approaching');
        break;
      case 'neutral':
      case 'unknown':
        // Never an enemy merely for being near; only server-attributed damage provokes it.
        if (provoked(e)) add('provoked_threat', 'high', `${e.disposition} entity damaged the bot (server damage event)`);
        break;
    }
  }
  const grouped = active.filter((e) => e.distance <= m.groupRadius);
  if (new Set(grouped.map((e) => e.entityId)).size >= 2) {
    hazards.push({ kind: 'group_threat', severity: 'high', detail: `${grouped.length} active threats within ${m.groupRadius} blocks`, entityIds: [...new Set(grouped.map((e) => e.entityId))] });
  }
  return { hazards, active: [...new Map(active.map((e) => [e.entityId, e])).values()] };
}

function weaponOk(item: SafetyItemFact | null, ctx: PolicyContext): { ok: boolean; facts?: WeaponFacts; why?: string } {
  const d = ctx.config.mobs.defense;
  if (!item) return { ok: false, why: 'no_verified_weapon' };
  if (item.metadata !== 'server_slot') return { ok: false, why: 'weapon_metadata_unknown' };
  const facts = weaponFacts(item.key, ctx.inTag);
  if (!facts) return { ok: false, why: 'not_a_supported_weapon' };
  if (item.maxDurability === null || item.remainingUses === null) return { ok: false, why: 'weapon_durability_unknown' };
  if (item.remainingUses < Math.max(d.minWeaponUses, Math.ceil(item.maxDurability * d.minWeaponFraction))) return { ok: false, why: 'weapon_nearly_worn' };
  return { ok: true, facts };
}

/** Armor points of server-stated equipped pieces that keep the minimum durability fraction. */
export function verifiedArmorPoints(self: SafetySelfFacts, minFraction: number): number {
  if (self.equipment.source !== 'server_slots') return 0;
  let points = 0;
  for (const a of self.equipment.armor) {
    if (a.metadata !== 'server_slot') continue;
    if (a.maxDurability !== null && a.remainingUses !== null && a.remainingUses < Math.ceil(a.maxDurability * minFraction)) continue;
    points += armorPointsOf(a.key);
  }
  return points;
}

/**
 * Defense readiness for the (single) active threat. Every refusal is listed;
 * admitted only with none. `cornered`: no retreat leg exists (the escape-space
 * requirement is then reported, not waived silently).
 */
export function defenseReadiness(self: SafetySelfFacts, active: readonly SafetyEntityFact[], hazards: readonly SafetyHazard[], ctx: PolicyContext, cornered: boolean): DefenseReadiness {
  const d = ctx.config.mobs.defense;
  const refusals: string[] = [];
  if (!d.enabled) refusals.push('defense_disabled');
  const kinds = new Set(hazards.map((h) => h.kind));
  if (kinds.has('creeper')) refusals.push('creeper');
  if (kinds.has('ranged_threat')) refusals.push('ranged_threat');
  if (kinds.has('group_threat') || active.length > 1) refusals.push('group');
  if (kinds.has('provoked_threat')) refusals.push('neutral_or_unknown_threat');
  const target = active.length === 1 ? (active[0] as SafetyEntityFact) : undefined;
  if (target && !ctx.defenseSupported(target)) refusals.push(`unsupported_matchup:${target.key.replace(/^minecraft:/, '')}`);
  if (target && target.baby === true) refusals.push('baby_variant');
  if (self.health < d.minHealth) refusals.push('health_below_minimum');
  if (self.food < d.minFood) refusals.push('food_below_minimum');
  if (self.vitalsSource !== 'server_update_health') refusals.push('vitals_not_server_stated');
  if (self.fluid.feetIn !== 'none' || self.fluid.eyeIn !== 'none') refusals.push('in_fluid');
  if (!self.fluid.onGround) refusals.push('not_on_ground');
  if (self.equipment.source !== 'server_slots') refusals.push('equipment_not_server_stated');
  // Weapon: held now, else an owned verified hotbar weapon (one hotbar packet) when allowed.
  let weapon: DefenseReadiness['weapon'] = null;
  const held = weaponOk(self.equipment.mainHand, ctx);
  if (held.ok && self.equipment.mainHand) {
    weapon = { key: self.equipment.mainHand.key, slot: self.equipment.mainHand.slot, remainingUses: self.equipment.mainHand.remainingUses, switchFromHotbar: null };
  } else if (d.allowHotbarSwitch) {
    const best = self.equipment.hotbar
      .filter((h) => weaponOk(h, ctx).ok)
      .sort((a, b) => (b.remainingUses ?? 0) - (a.remainingUses ?? 0))[0];
    if (best) weapon = { key: best.key, slot: best.slot, remainingUses: best.remainingUses, switchFromHotbar: best.slot - 36 };
  }
  if (!weapon) refusals.push(held.why ?? 'no_verified_weapon');
  const armorPoints = verifiedArmorPoints(self, d.minArmorFraction);
  if (armorPoints < d.minArmorPoints) refusals.push('armor_below_minimum');
  if (cornered) refusals.push('no_retreat_space');
  return {
    admitted: refusals.length === 0,
    refusals,
    target: target ? { entityId: target.entityId, key: target.key, distance: target.distance } : null,
    weapon,
    armorPoints,
    health: self.health,
    food: self.food,
  };
}

function signatureOf(hazards: readonly SafetyHazard[]): string {
  return [...new Set(hazards.map((h) => `${h.kind}:${[...h.entityIds].sort((a, b) => a - b).join('.')}`))].sort().join('|') || 'none';
}

/** One bounded plan from fresh facts (pure; the caller supplies lazily computed geometry checks). */
export function planSafety(self: SafetySelfFacts, entities: readonly SafetyEntityFact[], ctx: PolicyContext): SafetyPlan {
  const fluid = fluidHazards(self, ctx.config);
  if (fluid.length > 0) {
    const hazards = fluid.sort((a, b) => sev(b) - sev(a));
    const signature = signatureOf(hazards);
    // Submerged with open headroom can always start by surfacing; otherwise an exit/open column must exist.
    const canSurface = self.fluid.eyeIn === 'water' && self.fluid.headroom === 'open';
    if (canSurface || ctx.fluidExitAvailable()) {
      return { kind: 'respond', response: 'escape_water', hazards, reason: hazards.map((h) => h.kind).join('+'), signature };
    }
    return { kind: 'blocked', hazards, reason: self.fluid.headroom === 'ceiling' ? 'no_reachable_surface' : 'no_reachable_exit', detail: `${hazards.map((h) => h.detail).join('; ')}; no observed surface or dry exit within the search radius`, signature };
  }
  if (!ctx.config.mobs.enabled) return { kind: 'none', reason: 'mob_safety_disabled' };
  const { hazards: mob, active } = threatHazards(entities, ctx.config, ctx.nowMs);
  if (mob.length === 0) return { kind: 'none', reason: 'no_active_hazard' };
  const hazards = mob.sort((a, b) => sev(b) - sev(a));
  const signature = signatureOf(hazards);
  const retreat = ctx.retreatAvailable(active);
  const readiness = defenseReadiness(self, active, hazards, ctx, !retreat);
  if (readiness.admitted) {
    return { kind: 'respond', response: 'defend', hazards, reason: `defend against ${readiness.target?.key ?? 'threat'}`, defense: readiness, signature };
  }
  if (retreat) {
    return { kind: 'respond', response: 'retreat', hazards, reason: `retreat (${readiness.refusals.slice(0, 4).join(', ') || 'avoidance'})`, defense: readiness, signature };
  }
  // Cornered: defense is allowed only when every OTHER check passes.
  const cornered = defenseReadiness(self, active, hazards, ctx, false);
  if (cornered.admitted) {
    return { kind: 'respond', response: 'defend', hazards, reason: `cornered: no retreat leg; defend against ${cornered.target?.key ?? 'threat'}`, defense: cornered, signature };
  }
  return {
    kind: 'blocked',
    hazards,
    reason: 'no_retreat_and_defense_refused',
    detail: `${hazards.map((h) => h.detail).join('; ')}; no observed dry retreat leg and defense refused (${cornered.refusals.slice(0, 5).join(', ')})`,
    signature,
  };
}
