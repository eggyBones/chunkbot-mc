// Narrow low-health allowance (R6/R-G3). Survival issues AT MOST ONE grant
// per admitted support goal epoch, for its eat/rest code task only. A grant is
// bound to goal id/epoch, connection epoch, dimension, the admitted support
// task (first check binds it), and the exact capabilities/items of the
// proposal, with a fixed expiry and maximum of consumed actions. There is no
// renewal path: a second grant for the same epoch is refused, so counts and
// expiry can never be reset or extended.
//
// `check` gates a low-health round (candidate filter); `recheck` re-verifies
// ownership, connection/dimension, expiry, remaining actions, fresh vitals,
// visible threats and that the chosen item is still owned, AFTER the Jev
// choice and BEFORE execution. Executor lease/epoch fencing still applies.
import type { ObservationSnapshot } from '../contracts/observation.ts';
import type { AllowanceTaskRef, InventoryFacts, LowHealthAllowanceGrant, LowHealthAllowanceRequest, LowHealthCheck, Vitals } from '../contracts/survival.ts';
import { mk } from './items.ts';

/** Visible hostile mobs that refuse an allowance within the threat radius (code table; vanilla hostile entity ids). */
export const HOSTILE_ENTITIES = new Set(
  [
    'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom',
    'pillager', 'vindicator', 'evoker', 'illusioner', 'ravager', 'vex', 'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'guardian', 'elder_guardian', 'silverfish', 'endermite',
    'shulker', 'warden', 'breeze', 'creaking', 'ender_dragon', 'wither', 'zombified_piglin', 'enderman',
  ].map(mk),
);

export function visibleThreat(snapshot: ObservationSnapshot, radius: number): { key: string; distance: number } | undefined {
  const t = snapshot.entities.filter((e) => HOSTILE_ENTITIES.has(e.key) && e.distance <= radius).sort((a, b) => a.distance - b.distance)[0];
  return t ? { key: t.key, distance: Math.round(t.distance * 10) / 10 } : undefined;
}

export interface AllowanceFacts {
  now: () => number;
  connectionEpoch: () => number | undefined;
  dimension: () => string | undefined;
  vitals: () => Vitals | null;
  inventory: () => InventoryFacts | null;
  threatRadius: number;
  record?: (event: Record<string, unknown> & { type: string }) => void;
}

let grantCounter = 0;

export class AllowanceBook {
  private readonly grants = new Map<string, LowHealthAllowanceGrant>();
  /** Goal epochs that ever received a grant (no second grant, even after revocation). */
  private readonly issuedFor = new Set<number>();
  private readonly facts: AllowanceFacts;

  constructor(facts: AllowanceFacts) {
    this.facts = facts;
  }

  issue(req: LowHealthAllowanceRequest, binding: { goalId: string; goalEpoch: number; connectionEpoch: number; dimension: string }): LowHealthAllowanceGrant | undefined {
    if (this.issuedFor.has(binding.goalEpoch)) {
      this.facts.record?.({ type: 'survival_allowance_refused', goalId: binding.goalId, goalEpoch: binding.goalEpoch, reason: 'already_issued_for_epoch' });
      return undefined;
    }
    this.issuedFor.add(binding.goalEpoch);
    grantCounter += 1;
    const now = this.facts.now();
    const grant: LowHealthAllowanceGrant = {
      allowanceId: `lha-${binding.goalEpoch}-${grantCounter}`,
      goalId: binding.goalId,
      goalEpoch: binding.goalEpoch,
      connectionEpoch: binding.connectionEpoch,
      dimension: binding.dimension,
      taskId: null,
      routine: req.routine,
      capabilities: Object.freeze([...req.capabilities]),
      items: Object.freeze(req.items.map(mk)),
      maxActions: req.maxActions,
      actionsUsed: 0,
      grantedAtMs: now,
      expiresAtMs: now + req.ttlMs,
    };
    this.grants.set(grant.allowanceId, grant);
    this.facts.record?.({ type: 'survival_allowance_granted', allowanceId: grant.allowanceId, goalId: grant.goalId, goalEpoch: grant.goalEpoch, routine: grant.routine, capabilities: [...grant.capabilities], items: [...grant.items], maxActions: grant.maxActions, expiresAtMs: grant.expiresAtMs });
    return { ...grant };
  }

  private refuse(reason: string, detail: string): LowHealthCheck {
    return { allowed: false, reason, detail };
  }

  private find(task: AllowanceTaskRef): LowHealthAllowanceGrant | undefined {
    for (const g of this.grants.values()) if (g.goalId === task.goalId && g.goalEpoch === task.goalEpoch) return g;
    return undefined;
  }

  private validate(g: LowHealthAllowanceGrant, task: AllowanceTaskRef, snapshot: ObservationSnapshot): LowHealthCheck | undefined {
    const now = this.facts.now();
    if (g.revoked) return this.refuse('allowance_revoked', `allowance ${g.allowanceId} was revoked (${g.revoked})`);
    if (now >= g.expiresAtMs) return this.refuse('allowance_expired', `allowance ${g.allowanceId} expired`);
    if (g.actionsUsed >= g.maxActions) return this.refuse('allowance_exhausted', `allowance ${g.allowanceId} used all ${g.maxActions} actions`);
    const conn = this.facts.connectionEpoch();
    if (conn !== g.connectionEpoch || task.connectionEpoch !== g.connectionEpoch || snapshot.connectionEpoch !== g.connectionEpoch) return this.refuse('connection_changed', 'the allowance belongs to another connection');
    if (this.facts.dimension() !== g.dimension || snapshot.dimension !== g.dimension) return this.refuse('dimension_changed', 'the allowance belongs to another dimension');
    if (snapshot.goalEpoch !== g.goalEpoch) return this.refuse('stale_snapshot', 'the observation belongs to another goal epoch');
    if (g.taskId !== null && g.taskId !== task.taskId) return this.refuse('task_mismatch', `the allowance is bound to task ${g.taskId}`);
    if (task.allowedCapabilities.some((c) => !g.capabilities.includes(c))) return this.refuse('task_capabilities_exceed_allowance', `the task allows capabilities beyond ${g.capabilities.join(', ')}`);
    const v = this.facts.vitals();
    if (!v || v.connectionEpoch !== g.connectionEpoch) return this.refuse('vitals_unknown', 'no fresh server health/food for this connection');
    if (v.health <= 0) return this.refuse('dead', 'the bot is dead');
    const threat = visibleThreat(snapshot, this.facts.threatRadius);
    if (threat) return this.refuse('threat_nearby', `visible ${threat.key} ${threat.distance} blocks away: eating/resting here is unsafe and no escape capability is supported`);
    if (g.routine === 'eat') {
      if (v.food >= 20) return this.refuse('not_hungry', 'food is full; eating is not possible');
      const inv = this.facts.inventory();
      const owned = new Set((inv?.stacks ?? []).map((s) => s.key));
      if (!g.items.some((k) => owned.has(k))) return this.refuse('no_allowed_food_owned', 'none of the allowed foods is in the server inventory');
    }
    if (g.routine === 'rest' && v.food < 18) return this.refuse('regeneration_unlikely', `food ${v.food} is below 18: natural regeneration is not expected; eat first`);
    return undefined;
  }

  check(task: AllowanceTaskRef, snapshot: ObservationSnapshot): LowHealthCheck {
    const g = this.find(task);
    if (!g) return this.refuse('no_allowance', 'no low-health allowance was granted to this goal epoch');
    const bad = this.validate(g, task, snapshot);
    if (bad) return bad;
    if (g.taskId === null) g.taskId = task.taskId;
    return { allowed: true, allowanceId: g.allowanceId, capabilities: g.capabilities, items: g.items, detail: `low-health allowance ${g.allowanceId} (${g.routine}): ${g.maxActions - g.actionsUsed} action(s) left, expires in ${Math.max(0, Math.round((g.expiresAtMs - this.facts.now()) / 1000))}s` };
  }

  recheck(allowanceId: string, task: AllowanceTaskRef, candidate: { capability: string; parameters: Readonly<Record<string, unknown>> }, snapshot: ObservationSnapshot): LowHealthCheck {
    const g = this.grants.get(allowanceId);
    if (!g || g.goalId !== task.goalId || g.goalEpoch !== task.goalEpoch) return this.refuse('no_allowance', 'the allowance does not belong to this goal epoch');
    if (g.taskId !== task.taskId) return this.refuse('task_mismatch', 'the allowance was not bound to this task');
    const bad = this.validate(g, task, snapshot);
    if (bad) return bad;
    if (!g.capabilities.includes(candidate.capability)) return this.refuse('capability_not_allowed', `${candidate.capability} is not allowed at low health`);
    const item = candidate.parameters['item'];
    if (g.routine === 'eat') {
      if (typeof item !== 'string' || !g.items.includes(mk(item))) return this.refuse('item_not_allowed', 'the chosen food is not one of the allowed safe foods');
      const owned = (this.facts.inventory()?.stacks ?? []).some((s) => s.key === mk(item));
      if (!owned) return this.refuse('item_not_owned', `${item} is no longer in the server inventory`);
    } else if (item !== undefined) return this.refuse('item_not_allowed', 'resting takes no item');
    return { allowed: true, allowanceId: g.allowanceId, capabilities: g.capabilities, items: g.items, detail: 'rechecked after the choice' };
  }

  consumed(allowanceId: string, outcome: { actionId: string; capability: string; status: string }): void {
    const g = this.grants.get(allowanceId);
    if (!g) return;
    g.actionsUsed += 1;
    this.facts.record?.({ type: 'survival_allowance_consumed', allowanceId, actionId: outcome.actionId, capability: outcome.capability, status: outcome.status, actionsUsed: g.actionsUsed, maxActions: g.maxActions });
  }

  /** Goal end / lifecycle: the grant can never be used again (not deleted, so it is never re-issued). */
  revokeFor(goalEpoch: number | undefined, reason: string): void {
    for (const g of this.grants.values()) if ((goalEpoch === undefined || g.goalEpoch === goalEpoch) && !g.revoked) g.revoked = reason;
    if (this.grants.size > 64) {
      for (const [id, g] of this.grants) {
        if (g.revoked && this.grants.size > 32) this.grants.delete(id);
      }
    }
  }

  get(allowanceId: string): Readonly<LowHealthAllowanceGrant> | undefined {
    const g = this.grants.get(allowanceId);
    return g ? { ...g } : undefined;
  }
}
