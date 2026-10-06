// Movement family: grounded approach, following an observed entity, bounded
// exploration toward visible frontiers, and look-around surveys.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import type { Vec } from '../perception/visibility.ts';
import { ENTITY_REACH } from '../perception/perception.ts';
import { admittedParameters, json, liveEntity, namedTargetUnavailable, pos3, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type ExecuteContext, type SkillDefinition, type SkillResult, type Unavailable } from './definition.ts';
import { GoalBesideBlock, assertPolicy, conservativeMovements, distanceTo, goals, navigate, standingOn } from './navigation.ts';
import { HandleRefSchema, MoveTargetSchema, type MoveTarget } from './refs.ts';

const SUPPORTED_MOVE_PREDICATES = ['near_target', 'visited_location'];

interface ResolvedPlace {
  at: Vec;
  label: string;
  entityId?: number;
  remembered?: boolean;
  /** Block targets: approach beside the block, never stand on it. */
  block?: { x: number; y: number; z: number };
}

function resolveMoveTarget(ctx: ExecuteContext, target: MoveTarget): ResolvedPlace | SkillResult {
  const { services, session } = ctx;
  const bot = session.bot;
  switch (target.kind) {
    case 'handle': {
      const rec = services.perception.resolve(target.snapshotId, target.handle);
      if ('error' in rec) return precondition(rec.error, `target ${target.handle} cannot be resolved (${rec.error})`);
      const t = rec.target;
      if (t.kind === 'block') return { at: { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }, label: `minecraft:${t.name} at ${t.x},${t.y},${t.z}`, block: { x: t.x, y: t.y, z: t.z } };
      if (t.kind === 'frontier') return { at: t.at, label: `frontier ${target.handle}` };
      const live = liveEntity(services, session, target.snapshotId, target.handle);
      if ('error' in live) return precondition(live.error, live.detail);
      return { at: live.position, label: `minecraft:${live.name} (${target.handle})`, entityId: live.entityId };
    }
    case 'owner': {
      for (const e of Object.values(bot.entities)) {
        if (e && services.perception.isOwnerEntity(bot, e) && services.perception.entityVisibleNow(e.id)) {
          return { at: e.position, label: 'owner', entityId: e.id };
        }
      }
      return precondition('owner_not_visible', 'the owner is not currently visible; a remembered position is not proof of presence');
    }
    case 'anchor': {
      const a = services.perception.anchor(target.anchorId);
      if (!a) return precondition('unknown_anchor', `anchor ${target.anchorId} is not remembered on this connection`);
      if (a.dimension !== String(bot.game.dimension)) return precondition('dimension_mismatch', `anchor is in ${a.dimension}`);
      return { at: a.at, label: `remembered ${a.label} (observed ${Math.round((services.clock.now() - a.observedAtMs) / 1000)}s ago)`, remembered: true };
    }
    case 'destination': {
      if (target.dimension !== String(bot.game.dimension)) return precondition('dimension_mismatch', `destination is in ${target.dimension}`);
      return { at: { x: target.x, y: target.y, z: target.z }, label: `owner-supplied destination ${target.x},${target.y},${target.z}` };
    }
  }
}


/**
 * Follows a moving entity ONLY through fresh visible observations. Visibility
 * is tested before the position is read; while the entity is out of sight its
 * protocol position is never consulted, and only the frozen last-observed
 * waypoint (with its age) may be used or reported.
 */
class VisibleTracker {
  private readonly ctx: ExecuteContext;
  private readonly id: number;
  last: { at: Vec; atMs: number };
  constructor(ctx: ExecuteContext, id: number, at: Vec) {
    this.ctx = ctx;
    this.id = id;
    this.last = { at: { x: at.x, y: at.y, z: at.z }, atMs: ctx.services.clock.now() };
  }
  /** Fresh visible position, or undefined (position not read) when out of sight. */
  sample(): Vec | undefined {
    if (!this.ctx.services.perception.entityVisibleNow(this.id)) return undefined;
    const p = this.ctx.session.bot.entities[this.id]?.position;
    if (!p) return undefined;
    this.last = { at: { x: p.x, y: p.y, z: p.z }, atMs: this.ctx.services.clock.now() };
    return this.last.at;
  }
  lostForMs(): number {
    return this.ctx.services.clock.now() - this.last.atMs;
  }
}

/** Travel-bound evidence (the goal's own anchor, never hidden world data). */
function boundsEvidence(ctx: ExecuteContext): Record<string, JsonValue> {
  const b = ctx.services.perception.travelBounds?.();
  return b ? { travelAnchor: pos3(b.anchor), travelRadius: b.radius } : { travelRadius: ctx.services.limits.travelRadius };
}

export const moveNear: SkillDefinition<{ target: MoveTarget; within: number }> = {
  descriptor: {
    id: 'move_near',
    family: 'movement',
    purpose: 'Walk to within a distance of a grounded target: a visible block/entity/drop/frontier handle, the visible owner, a remembered anchor, or owner-supplied coordinates.',
    parameters: [
      { name: 'target', type: 'target_selector', description: '{kind:"handle",snapshotId,handle} | {kind:"owner"} | {kind:"anchor",anchorId} | {kind:"destination",dimension,x,y,z}', required: true },
      { name: 'within', type: 'number', description: 'arrival distance in blocks', required: false, minimum: 1, maximum: 32 },
    ],
    targets: ['block', 'entity', 'drop', 'frontier', 'owner', 'remembered_anchor', 'owner_destination'],
    preconditions: ['target resolvable in the current connection and dimension', 'destination inside the goal travel radius', 'a safe walking path exists'],
    effects: ['bot position changes; visited location recorded'],
    supportedPredicates: SUPPORTED_MOVE_PREDICATES,
    timeoutMs: 120_000,
    cancellation: 'stop clears the path goal and movement controls immediately through the actuator lease',
    limitations: ['never digs, places, pillars, parkours or sprints', 'drops at most 3 blocks', 'no-safe-path is reported instead of modifying terrain', 'position is client physics corrected by the server'],
    evidence: ['final distance from the actual bot position', 'server position corrections counted'],
  },
  params: z.object({ target: MoveTargetSchema, within: z.number().min(1).max(32).default(2) }).strict(),
  resolve(ctx) {
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    const { snapshot, hints, services } = ctx;
    const scope = targetScope(ctx);
    const within = (admittedParameters(ctx, moveNear.params).values['within'] as number | undefined) ?? 2;
    const book = services.knowledge.recipes;
    const keyMatches = (key: string) => hints.keys.some((h) => (h.startsWith('#') ? book?.matches(h, key) : h === key));
    // A wanted item also matches visible blocks that drop it (installed drop data), e.g. cobblestone -> stone.
    const matches = (key: string) => keyMatches(key) || services.knowledge.blockDrops(key).some(keyMatches);
    const add = (target: MoveTarget, description: string, distance: number) => {
      if (distance <= within) return;
      drafts.push({ parameters: { target: json(target), within }, description, score: -distance, criteria: [`${Math.round(distance)} blocks away`] });
    };
    for (const handle of scope.current) {
      const thing = [...snapshot.blocks, ...snapshot.entities, ...snapshot.drops].find((t) => t.handle === handle);
      const frontier = snapshot.frontiers.find((f) => f.handle === handle);
      const at = thing?.at ?? frontier?.at;
      if (at && !services.perception.withinTravel(at)) {
        unavailable.push({ reason: 'outside_travel_bounds', detail: `named target ${handle} is outside the travel radius` });
        continue;
      }
      if (thing) add({ kind: 'handle', snapshotId: snapshot.id, handle }, `approach ${thing.key} ${handle}`, thing.distance);
      if (frontier) add({ kind: 'handle', snapshotId: snapshot.id, handle }, `approach frontier ${handle}`, frontier.distance);
    }
    if (scope.named && scope.current.size === 0) unavailable.push(namedTargetUnavailable(scope, 'destination'));
    if (hints.wantsOwner) {
      if (snapshot.owner.visible) add({ kind: 'owner' }, 'walk to the visible owner', snapshot.owner.distance ?? 99);
      else unavailable.push({ reason: 'owner_not_visible', detail: 'the owner is not currently visible', evidence: { rememberedOwner: snapshot.remembered.some((r) => r.label === 'owner last seen') } });
    }
    for (const anchorId of hints.anchors) {
      const a = snapshot.remembered.find((r) => r.anchorId === anchorId);
      if (a) add({ kind: 'anchor', anchorId }, `walk to remembered ${a.label}`, Math.hypot(a.at.x - snapshot.self.at.x, a.at.z - snapshot.self.at.z));
    }
    for (const d of hints.destinations) {
      if (!services.perception.withinTravel(d.at)) {
        unavailable.push({ reason: 'outside_travel_bounds', detail: 'the owner-supplied destination is outside the travel radius' });
        continue;
      }
      add({ kind: 'destination', dimension: d.dimension, ...d.at }, `walk to owner-supplied ${d.at.x},${d.at.y},${d.at.z}`, Math.hypot(d.at.x - snapshot.self.at.x, d.at.z - snapshot.self.at.z));
    }
    if (!scope.named && hints.keys.length > 0) {
      for (const t of [...snapshot.blocks, ...snapshot.entities, ...snapshot.drops]) {
        if (!matches(t.key)) continue;
        if (!services.perception.withinTravel(t.at)) continue;
        add({ kind: 'handle', snapshotId: snapshot.id, handle: t.handle }, `approach visible ${t.key} ${t.handle}`, t.distance);
      }
    }
    if (drafts.length === 0 && unavailable.length === 0) unavailable.push({ reason: 'no_grounded_destination', detail: 'no visible, remembered, or owner-supplied destination matches the task' });
    return { drafts: drafts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6), unavailable };
  },
  async execute(ctx, params) {
    const place = resolveMoveTarget(ctx, params.target);
    if ('status' in place) return place;
    const bot = ctx.session.bot;
    if (!ctx.services.perception.withinTravel(place.at)) {
      return precondition('outside_travel_bounds', `destination is outside the travel radius (${ctx.services.limits.travelRadius})`, { destination: pos3(place.at), ...boundsEvidence(ctx) });
    }
    const bounds = ctx.services.perception.travelBounds?.();
    const entityId = place.entityId;
    // Moving targets are tracked only through fresh visible observations.
    const tracker = entityId !== undefined ? new VisibleTracker(ctx, entityId, place.at) : undefined;
    const at = () => tracker?.last.at ?? place.at;
    let goalAt = { x: place.at.x, y: place.at.y, z: place.at.z };
    const block = place.block;
    const goal = block ? new GoalBesideBlock(block.x, block.y, block.z, Math.max(1, params.within - 0.5)) : new goals.GoalNear(place.at.x, place.at.y, place.at.z, Math.max(1, params.within - 0.5));
    const r = await navigate(ctx.act, {
      goal,
      ...(tracker
        ? {
            retarget: () => {
              const p = tracker.sample(); // visibility first; hidden positions are never read
              if (!p) return undefined;
              if (!ctx.services.perception.withinTravel(p)) return undefined;
              if (Math.hypot(p.x - goalAt.x, p.y - goalAt.y, p.z - goalAt.z) < 1.5) return undefined;
              goalAt = { x: p.x, y: p.y, z: p.z };
              return new goals.GoalNear(p.x, p.y, p.z, Math.max(1, params.within - 0.5));
            },
            abortIf: () => (tracker.lostForMs() > ctx.services.limits.ownerLossMs ? 'target_lost' : tracker.sample() === undefined || ctx.services.perception.withinTravel(tracker.last.at) ? undefined : 'target_outside_travel_bounds'),
          }
        : {}),
      arrived: () => distanceTo(bot, at()) <= params.within + 0.25 && !(block && standingOn(bot, block.x, block.y, block.z)),
      distance: () => distanceTo(bot, at()),
      timeoutMs: ctx.candidate.timeoutMs,
      searchRadius: Math.min(ctx.services.limits.travelRadius, Math.ceil(distanceTo(bot, place.at)) + 24),
      inBounds: () => ctx.services.perception.withinTravel(bot.entity.position),
      ...(bounds ? { bounds } : {}),
    });
    ctx.services.perception.recordVisited();
    const evidence: Record<string, JsonValue> = {
      target: place.label,
      ...(tracker ? { lastObservedTarget: pos3(tracker.last.at), lastObservedAgeMs: tracker.lostForMs() } : {}),
      finalDistance: r.finalDistance,
      position: pos3(bot.entity.position),
      elapsedMs: r.elapsedMs,
      serverCorrections: r.corrections,
      remembered: Boolean(place.remembered),
    };
    if (r.status === 'arrived') {
      return { status: 'succeeded', effect: `arrived within ${params.within} of ${place.label}${tracker ? ' (last observed position)' : ''} (distance ${r.finalDistance})${place.remembered ? '; remembered target, presence not verified' : ''}`, confirmation: 'client_only', evidence };
    }
    if (r.status === 'out_of_bounds') return failed('outside_travel_bounds', `stopped at the travel radius while walking to ${place.label}`, { ...evidence, ...boundsEvidence(ctx) });
    if (r.status === 'no_path') return failed('no_safe_path', `no safe walking path to ${place.label} inside the travel radius; stopped ${r.finalDistance} blocks away`, { ...evidence, ...boundsEvidence(ctx) });
    if (r.aborted === 'target_lost') return failed('target_lost', `${place.label} out of sight for longer than ${ctx.services.limits.ownerLossMs}ms; stopped at its last observed position`, evidence);
    if (r.aborted) return failed(r.aborted, `approach to ${place.label} stopped (${r.aborted})`, { ...evidence, ...boundsEvidence(ctx) });
    return failed(r.status === 'timeout' ? 'timeout' : 'stuck', `${r.status} while walking to ${place.label} (${r.finalDistance} blocks away)`, evidence);
  },
};

export const followEntity: SkillDefinition<{ target: MoveTarget; within: number; durationMs: number }> = {
  descriptor: {
    id: 'follow_entity',
    family: 'movement',
    purpose: 'Stay near a visible moving entity (e.g. the owner) for a bounded time, re-pathing as it moves.',
    parameters: [
      { name: 'target', type: 'target_selector', description: '{kind:"owner"} or {kind:"handle",snapshotId,handle} of a visible entity', required: true },
      { name: 'within', type: 'number', description: 'follow distance', required: false, minimum: 1, maximum: 16 },
      { name: 'durationMs', type: 'integer', description: 'how long to follow before returning', required: false, minimum: 1_000, maximum: 120_000 },
    ],
    targets: ['entity', 'owner'],
    preconditions: ['target entity visible now'],
    effects: ['bot keeps moving after the target'],
    supportedPredicates: ['near_target'],
    timeoutMs: 125_000,
    cancellation: 'stop clears the dynamic path goal and controls immediately',
    limitations: ['ends with target_lost when the target stays out of sight longer than the owner-loss window', 'stable following is a local wait, not repeated inference'],
    evidence: ['fraction of samples within the follow distance', 'visibility samples'],
  },
  // A completed follow window (the target stayed in sight) is healthy waiting, not task success.
  sustained: { windowElapsed: (o) => o.status === 'succeeded' || (o.status === 'partial' && o.reason === 'trailing_target') },
  params: z.object({ target: MoveTargetSchema, within: z.number().min(1).max(16).default(3), durationMs: z.number().int().min(1_000).max(120_000).default(30_000) }).strict(),
  resolve(ctx) {
    const drafts: CandidateDraft[] = [];
    const scope = targetScope(ctx);
    const admitted = admittedParameters(ctx, followEntity.params).values as { within?: number; durationMs?: number };
    const within = admitted.within ?? 3;
    const durationMs = admitted.durationMs ?? 30_000;
    if (ctx.hints.wantsOwner && ctx.snapshot.owner.visible) drafts.push({ parameters: { target: { kind: 'owner' }, within, durationMs }, description: `follow the visible owner for ${Math.round(durationMs / 1000)}s` });
    for (const handle of scope.current) {
      const e = ctx.snapshot.entities.find((t) => t.handle === handle);
      if (e) drafts.push({ parameters: { target: { kind: 'handle', snapshotId: ctx.snapshot.id, handle }, within, durationMs }, description: `follow ${e.key} ${e.handle}` });
    }
    const unavailable: Unavailable[] = [];
    if (scope.named && drafts.length === 0) unavailable.push(namedTargetUnavailable(scope, 'entity to follow'));
    else if (drafts.length === 0) unavailable.push({ reason: 'no_visible_entity', detail: 'no visible entity to follow' });
    return { drafts, unavailable };
  },
  async execute(ctx, params) {
    if (params.target.kind !== 'owner' && params.target.kind !== 'handle') return precondition('invalid_target', 'follow needs the owner or an entity handle');
    const place = resolveMoveTarget(ctx, params.target);
    if ('status' in place) return place;
    if (place.entityId === undefined) return precondition('not_an_entity', `${place.label} is not an entity`);
    const bot = ctx.session.bot;
    const perception = ctx.services.perception;
    if (!perception.withinTravel(place.at)) return precondition('target_outside_travel_bounds', `${place.label} is outside the travel radius`, boundsEvidence(ctx));
    if (!perception.withinTravel(bot.entity.position)) return precondition('outside_travel_bounds', 'the bot is outside the travel radius', boundsEvidence(ctx));
    const tracker = new VisibleTracker(ctx, place.entityId, place.at);
    const { pathfinder } = bot as unknown as { pathfinder: { setMovements(m: unknown): void } };
    const bounds = perception.travelBounds?.();
    const { movements, verified } = conservativeMovements(bot, bounds);
    assertPolicy(verified);
    ctx.act.fence();
    pathfinder.setMovements(movements);
    const started = ctx.services.clock.now();
    let samples = 0;
    let visibleSamples = 0;
    let near = 0;
    let goalAt: { x: number; y: number; z: number } | undefined;
    let lastVisibleDistance: number | null = null;
    const pf = (bot as unknown as { pathfinder: { isMoving?(): boolean; goal?: unknown } }).pathfinder;
    const stopWith = (status: 'failed' | 'partial', reason: string, effect: string): SkillResult => ({
      status,
      reason,
      effect,
      confirmation: 'client_only',
      evidence: { samples, visibleSamples, nearFraction: visibleSamples ? Math.round((near / visibleSamples) * 100) / 100 : 0, lastObservedTarget: pos3(tracker.last.at), lastObservedAgeMs: tracker.lostForMs(), ...boundsEvidence(ctx) },
    });
    try {
      while (ctx.services.clock.now() - started < params.durationMs) {
        // Visibility FIRST: the target's position is read only when it is visible now.
        const seen = tracker.sample();
        if (seen) {
          if (!perception.withinTravel(seen)) return stopWith('failed', 'target_outside_travel_bounds', `${place.label} left the travel radius; following stopped`);
          const d = Math.hypot(seen.x - bot.entity.position.x, seen.y - bot.entity.position.y, seen.z - bot.entity.position.z);
          if (d > params.within + 0.75) {
            const moved = goalAt ? Math.hypot(seen.x - goalAt.x, seen.z - goalAt.z) : Infinity;
            if (moved > 1.0 || !pf.isMoving?.()) {
              goalAt = { ...seen };
              ctx.act.setPathGoal(new goals.GoalNear(seen.x, seen.y, seen.z, Math.max(1, params.within - 0.5)), false);
            }
          } else if (pf.goal) {
            ctx.act.clearPathGoal();
            goalAt = undefined;
          }
        } else if (tracker.lostForMs() > ctx.services.limits.ownerLossMs) {
          return stopWith('failed', 'target_lost', `${place.label} out of sight for ${ctx.services.limits.ownerLossMs}ms; following stopped at its last observed position`);
        }
        // Out of sight: no new goal; the frozen last-observed waypoint (if any) stays the only target.
        await ctx.act.sleep(250);
        if (!perception.withinTravel(bot.entity.position)) {
          ctx.act.clearPathGoal();
          return stopWith('failed', 'outside_travel_bounds', 'reached the travel radius while following; stopped');
        }
        samples += 1;
        const after = tracker.sample();
        if (after) {
          visibleSamples += 1;
          lastVisibleDistance = Math.round(Math.hypot(after.x - bot.entity.position.x, after.y - bot.entity.position.y, after.z - bot.entity.position.z) * 10) / 10;
          if (lastVisibleDistance <= params.within + 1) near += 1;
        }
        ctx.progress({ followSamples: samples, visibleSamples, nearSamples: near });
      }
    } finally {
      ctx.act.clearPathGoal();
    }
    perception.recordVisited();
    const fraction = visibleSamples ? Math.round((near / visibleSamples) * 100) / 100 : 0;
    // A distance is reported only if the target is visible at the end.
    const finalSeen = tracker.sample();
    const finalDistance = finalSeen ? Math.round(Math.hypot(finalSeen.x - bot.entity.position.x, finalSeen.y - bot.entity.position.y, finalSeen.z - bot.entity.position.z) * 10) / 10 : null;
    const evidence: Record<string, JsonValue> = { samples, visibleSamples, nearFraction: fraction, finalDistance, lastVisibleDistance, lastObservedTarget: pos3(tracker.last.at), lastObservedAgeMs: tracker.lostForMs() };
    if (finalDistance === null) {
      return { status: 'partial', reason: 'target_not_visible_at_end', effect: `followed ${place.label}; it is not visible now (last seen ${tracker.lostForMs()}ms ago)`, confirmation: 'client_only', evidence };
    }
    return {
      status: finalDistance <= params.within + 1 ? 'succeeded' : 'partial',
      ...(finalDistance <= params.within + 1 ? {} : { reason: 'trailing_target' }),
      effect: `followed ${place.label} for ${Math.round(params.durationMs / 1000)}s; within ${params.within + 1} blocks in ${Math.round(fraction * 100)}% of visible samples; final distance ${finalDistance}`,
      confirmation: 'client_only',
      evidence,
    };
  },
};

export const exploreFrontier: SkillDefinition<{ frontier: { snapshotId: string; handle: string } }> = {
  descriptor: {
    id: 'explore_frontier',
    family: 'exploration',
    purpose: 'Walk to a visible, safely reachable frontier waypoint at the edge of current sight (inside the travel radius) and observe from there.',
    parameters: [{ name: 'frontier', type: 'handle', description: '{snapshotId, handle} of a frt-* frontier from an observation', required: true }],
    targets: ['frontier'],
    preconditions: ['frontier from the current connection/dimension', 'inside the goal travel radius'],
    effects: ['bot moves; visited location recorded; a new observation is taken on arrival'],
    supportedPredicates: ['visited_location', 'near_target'],
    timeoutMs: 120_000,
    cancellation: 'stop clears the path goal and controls immediately',
    limitations: ['frontiers come from loaded local geometry the bot can see, never from hidden-resource searches or the world seed', 'resources may still be absent after exploring'],
    evidence: ['arrival distance', 'counts of newly visible block types/entities after arrival'],
  },
  params: z.object({ frontier: HandleRefSchema }).strict(),
  resolve(ctx) {
    const scope = targetScope(ctx);
    const list = ctx.snapshot.frontiers.filter((f) => ctx.services.perception.withinTravel(f.at) && scope.allows(f.handle));
    if (scope.named && list.length === 0) return { drafts: [], unavailable: [namedTargetUnavailable(scope, 'frontier')] };
    if (list.length === 0) {
      return { drafts: [], unavailable: [{ reason: 'no_frontier', detail: 'no safe visible frontier inside the travel radius', evidence: { travel: json(ctx.snapshot.perception?.travel ?? null) } }] };
    }
    return {
      drafts: list.slice(0, 6).map((f) => ({
        parameters: { frontier: { snapshotId: ctx.snapshot.id, handle: f.handle } },
        description: `explore ${f.direction} toward ${f.handle} (${Math.round(f.distance)} blocks${f.visited ? ', near a visited spot' : ''})`,
        score: (f.visited ? 0 : 100) + f.distance,
      })),
    };
  },
  async execute(ctx, params) {
    const before = ctx.services.perception.latest();
    const r = await moveNear.execute(ctx, { target: { kind: 'handle', ...params.frontier }, within: 2 });
    if (r.status !== 'succeeded') return r;
    const snap = ctx.services.perception.take(ctx.candidate.goalEpoch);
    const beforeKeys = new Set(before?.blockSummary.map((b) => b.key) ?? []);
    const newKeys = (snap?.blockSummary ?? []).map((b) => b.key).filter((k) => !beforeKeys.has(k));
    return {
      ...r,
      effect: `${r.effect}; observed ${snap?.blockSummary.length ?? 0} visible block types (${newKeys.length} new), ${snap?.entities.length ?? 0} entities, ${snap?.drops.length ?? 0} drops`,
      evidence: { ...(r.evidence ?? {}), snapshotId: snap?.id ?? null, newBlockTypes: newKeys.slice(0, 16), frontiers: snap?.frontiers.length ?? 0 },
    };
  },
};

export const surveySurroundings: SkillDefinition<Record<string, never>> = {
  descriptor: {
    id: 'survey_surroundings',
    family: 'observation',
    purpose: 'Look around (turn through four directions) and take a fresh bounded observation of visible blocks, entities, drops and frontiers.',
    parameters: [],
    targets: ['none'],
    preconditions: ['connected'],
    effects: ['head turns; new observation snapshot and remembered anchors'],
    supportedPredicates: ['entity_outcome', 'block_state'],
    timeoutMs: 10_000,
    cancellation: 'stop ends the look sequence immediately',
    limitations: ['line-of-sight sampling within the observation radius; small far objects can be missed between rays'],
    evidence: ['snapshot id and visible counts'],
  },
  params: z.object({}).strict(),
  resolve() {
    return { drafts: [{ parameters: {}, description: 'look around and refresh the observation' }] };
  },
  async execute(ctx) {
    const bot = ctx.session.bot;
    const yaw0 = bot.entity.yaw;
    for (let i = 0; i < 4; i += 1) {
      await ctx.act.look(yaw0 + (i * Math.PI) / 2, -0.2);
      await ctx.act.sleep(120);
    }
    const snap = ctx.services.perception.take(ctx.candidate.goalEpoch);
    if (!snap) return failed('not_connected', 'no observation available');
    return {
      status: 'succeeded',
      effect: `observed ${snap.blockSummary.length} visible block types, ${snap.entities.length} entities, ${snap.drops.length} drops, ${snap.frontiers.length} frontiers; owner ${snap.owner.visible ? 'visible' : 'not visible'}`,
      confirmation: 'none',
      evidence: { snapshotId: snap.id, blockTypes: snap.blockSummary.length, entities: snap.entities.length, drops: snap.drops.length, frontiers: snap.frontiers.length, ownerVisible: snap.owner.visible },
    };
  },
};
