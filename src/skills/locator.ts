// Locator/route family (MB-LOC-001): two registered capabilities over the
// owner locator service and the code-owned route controller. Created bound to
// installed services (locatorSkills(...)); nothing is registered without them.
//
//   seek_owner    find and rejoin the OWNER: with the owner out of sight, walk
//                 toward the server locator-bar cue through safe local
//                 frontiers (beginning counted route legs when the travel bound
//                 — not the terrain — limits progress), then approach the
//                 owner once VISIBLE. Arrival is the bot's own position near
//                 the visible owner; a locator cue never proves arrival.
//   route_travel  travel toward a far CODE-OWNED destination: owner-typed
//                 coordinates (owner_destination selector) or, when the route
//                 policy authorizes it and a provider is installed, the bot's
//                 own recorded death position. Never planner-invented
//                 coordinates.
//
// Both are bounded execution windows (sustained: a window that made progress
// continues locally without inference). Movement uses the conservative
// navigation policy through the fenced actuator: no digging, placing,
// towering, parkour or doors.
import { z } from 'zod';
import { DimensionSchema, type JsonValue, type Vec3 } from '../contracts/index.ts';
import type { LocatorService } from '../locator/service.ts';
import type { RouteController } from '../locator/routes.ts';
import { runRoute, type RouteEnv, type RouteTarget } from '../locator/route-runner.ts';
import { admittedParameters, json, pos3 } from './common.ts';
import { precondition, type AnySkill, type CandidateDraft, type ExecuteContext, type ResolveContext, type SkillDefinition, type SkillResult, type Unavailable } from './definition.ts';
import { distanceTo, goals, navigate } from './navigation.ts';

export interface LocatorSkillDeps {
  locator?: LocatorService;
  /** Route controller (also holds the survival own-death provider seam). */
  routes: RouteController;
}

const WITHIN = z.number().min(1).max(16).default(3);
const DURATION = z.number().int().min(1_000).max(120_000).default(60_000);

function goalEpochOf(ctx: ExecuteContext): number {
  return ctx.owner.kind === 'goal' ? ctx.owner.goalEpoch : ctx.candidate.goalEpoch;
}

/** Production RouteEnv over the fenced actuator, perception and the skill services. */
export function routeEnv(ctx: ExecuteContext): RouteEnv {
  const { services, session, act } = ctx;
  const bot = session.bot;
  const perception = services.perception;
  const goalEpoch = goalEpochOf(ctx);
  const ownerVisible = (): Vec3 | undefined => {
    for (const e of Object.values(bot.entities)) {
      // Identity first, then visibility; the position is read only when visible now.
      if (e && perception.isOwnerEntity(bot, e) && perception.entityVisibleNow(e.id)) return { x: e.position.x, y: e.position.y, z: e.position.z };
    }
    return undefined;
  };
  return {
    goalEpoch,
    connectionEpoch: () => session.connectionEpoch,
    dimension: () => String(bot.game.dimension),
    self: () => ({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }),
    now: () => services.clock.now(),
    sleep: (ms) => act.sleep(ms),
    observe: () => {
      const snap = perception.take(goalEpoch);
      const seen = snap ? perception.seenBlocks(snap.id) : undefined;
      return seen ? { seen } : undefined;
    },
    world: () => perception.world(),
    visited: () => perception.visitedLocations().filter((v) => v.dimension === String(bot.game.dimension)).map((v) => v.at),
    recordVisited: () => perception.recordVisited(),
    ownerVisible,
    admissionBounds: () => perception.travelBounds?.(),
    move: async (target, within, bounds, options) => {
      let goalAt = target;
      const r = await navigate(act, {
        goal: new goals.GoalNear(target.x, target.y, target.z, Math.max(1, within - 0.5)),
        arrived: () => distanceTo(bot, goalAt) <= within + 0.25,
        distance: () => distanceTo(bot, goalAt),
        timeoutMs: options.timeoutMs,
        searchRadius: Math.min(bounds.radius * 2, Math.ceil(distanceTo(bot, target)) + 24),
        bounds,
        ...(options.abortIf ? { abortIf: options.abortIf } : {}),
        ...(options.retarget
          ? {
              retarget: () => {
                const p = options.retarget?.();
                if (!p) return undefined;
                goalAt = p;
                return new goals.GoalNear(p.x, p.y, p.z, Math.max(1, within - 0.5));
              },
            }
          : {}),
      });
      return { status: r.status, finalDistance: r.finalDistance, ...(r.aborted ? { aborted: r.aborted } : {}) };
    },
    progress: (e) => ctx.progress(e),
    observationRadius: services.limits.observationRadius,
    ownerLossMs: services.limits.ownerLossMs,
  };
}

function toSkillResult(r: Awaited<ReturnType<typeof runRoute>>): SkillResult {
  return { status: r.status, ...(r.reason ? { reason: r.reason } : {}), effect: r.effect, confirmation: 'client_only', evidence: r.evidence };
}

function routeCtx(ctx: ResolveContext) {
  return { goalEpoch: ctx.snapshot.goalEpoch, connectionEpoch: ctx.session.connectionEpoch, dimension: ctx.snapshot.dimension };
}

function routeCriteria(deps: LocatorSkillDeps, ctx: ResolveContext): string[] {
  const st = deps.routes.status(ctx.snapshot.goalEpoch);
  if (!st || st.state === 'revoked') return ['inside the goal travel radius only (no route authorization)'];
  return [`route legs ${st.legsUsed}/${st.maxLegs}, ${Math.round(st.distanceUsed)}/${st.maxTotalDistance} route blocks used`];
}

export function seekOwnerSkill(deps: LocatorSkillDeps): SkillDefinition<{ within: number; durationMs: number }> {
  const params = z.object({ within: WITHIN, durationMs: DURATION }).strict();
  const skill: SkillDefinition<{ within: number; durationMs: number }> = {
    descriptor: {
      id: 'seek_owner',
      family: 'movement',
      purpose:
        "Find and rejoin the owner when out of sight: walk toward the owner's server locator-bar direction through safe visible frontiers (beginning counted, code-authorized route legs when the travel radius limits progress), then approach the owner once visible.",
      parameters: [
        { name: 'within', type: 'number', description: 'stop distance from the VISIBLE owner (blocks)', required: false, minimum: 1, maximum: 16 },
        { name: 'durationMs', type: 'integer', description: 'length of one seeking window before re-evaluating', required: false, minimum: 1_000, maximum: 120_000 },
      ],
      targets: ['owner'],
      preconditions: [
        'the task targets the owner',
        'owner not visible with a current locator cue (observation.locator.actionable), or visible beyond the travel bound with a route authorization',
      ],
      effects: ['bot walks toward the owner; may begin a counted route leg; arrival only near the visible owner'],
      supportedPredicates: ['near_target'],
      timeoutMs: 125_000,
      cancellation: 'stop clears the path goal and controls immediately through the actuator lease; used route legs are never refunded',
      limitations: [
        'a locator cue is a coarse server direction, not visibility, a target or proof of arrival',
        'never digs, places, towers, parkours or opens doors; walls, drops, lava and height differences are reported',
        'no cue while the owner crouches, is invisible, wears a head item, is out of locator range, the locator bar is disabled, or after a dimension change',
        'route legs, distance and time are capped by operator policy; plans cannot change them',
      ],
      evidence: ['owner visible-now proximity from the bot position', 'route legs/distance counters', 'locator cue age and precision (no coordinates)'],
    },
    params,
    // A seeking window that made progress continues locally (no inference).
    sustained: { windowElapsed: (o) => o.status === 'partial' && o.reason === 'route_window_elapsed' },
    resolve(ctx) {
      const unavailable: Unavailable[] = [];
      if (!ctx.hints.wantsOwner) return { drafts: [], unavailable: [{ reason: 'owner_not_targeted', detail: 'seek_owner needs a task whose selectors or completion target the owner' }] };
      const admitted = admittedParameters(ctx, params).values as { within?: number; durationMs?: number };
      const within = admitted.within ?? 3;
      const durationMs = admitted.durationMs ?? 60_000;
      const drafts: CandidateDraft[] = [];
      const { snapshot, services } = ctx;
      if (snapshot.owner.visible) {
        const at = snapshot.owner.at;
        if (!at || services.perception.withinTravel(at)) {
          return { drafts, unavailable: [{ reason: 'owner_visible', detail: 'the owner is visible inside the travel bound; follow or approach the visible owner directly' }] };
        }
        const can = deps.routes.canBegin(routeCtx(ctx), 'owner');
        if (!can.ok) return { drafts, unavailable: [{ reason: `route_${can.blocker}`, detail: `the owner is visible beyond the travel bound and ${can.detail}` }] };
        drafts.push({ parameters: { within, durationMs }, description: 'the owner is visible beyond the travel bound: begin a counted route leg and approach', criteria: routeCriteria(deps, ctx) });
        return { drafts, unavailable };
      }
      if (!deps.locator) return { drafts, unavailable: [{ reason: 'locator_not_installed', detail: 'locator perception is not installed; the owner is not visible' }] };
      const hint = deps.locator.ownerHint();
      if (!hint.actionable) return { drafts, unavailable: [{ reason: 'no_locator_hint', detail: hint.note, evidence: { hintReason: hint.reason } }] };
      const st = deps.routes.status(snapshot.goalEpoch);
      if (st && (st.state === 'exhausted' || st.state === 'blocked') && !services.perception.withinTravel(snapshot.self.at)) {
        unavailable.push({ reason: `route_${st.blocker?.reason ?? 'ended'}`, detail: st.blocker?.detail ?? 'the route budget of this goal is spent' });
      }
      drafts.push({
        parameters: { within, durationMs },
        description: `seek the owner toward ${hint.direction} (${hint.distanceBand} distance, ${hint.elevation} height; ${hint.precision} locator cue ${Math.round((hint.ageMs ?? 0) / 1000)}s old) via safe frontiers`,
        criteria: [...routeCriteria(deps, ctx), 'stops when the owner is visible and near, or the cue is withdrawn'],
      });
      return { drafts, unavailable };
    },
    async execute(ctx, p) {
      const env = routeEnv(ctx);
      const result = await runRoute(env, { kind: 'owner' }, p, { routes: deps.routes, ...(deps.locator ? { locator: deps.locator } : {}) });
      return toSkillResult(result);
    },
  };
  return skill;
}

const DestinationTargetSchema = z.object({ kind: z.literal('destination'), dimension: DimensionSchema, x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();

type RouteTravelParams = { target?: z.infer<typeof DestinationTargetSchema>; destination?: 'own_death'; within: number; durationMs: number };

export function routeTravelSkill(deps: LocatorSkillDeps): SkillDefinition<RouteTravelParams> {
  const params = z
    .object({ target: DestinationTargetSchema.optional(), destination: z.enum(['own_death']).optional(), within: WITHIN, durationMs: DURATION })
    .strict()
    .refine((p) => Number(p.target !== undefined) + Number(p.destination !== undefined) === 1, 'exactly one of target or destination') as unknown as z.ZodType<RouteTravelParams>;
  const shape = z.object({ target: DestinationTargetSchema.optional(), destination: z.enum(['own_death']).optional(), within: WITHIN, durationMs: DURATION }).strict();
  const skill: SkillDefinition<RouteTravelParams> = {
    descriptor: {
      id: 'route_travel',
      family: 'movement',
      purpose:
        'Travel toward a far code-owned destination — coordinates the owner typed, or (when authorized) the bot\'s own recorded death location — through safe visible frontiers and counted, code-authorized route legs beyond the travel radius.',
      parameters: [
        { name: 'target', type: 'target_selector', description: '{kind:"destination",dimension,x,y,z} using coordinates the owner typed', required: false },
        { name: 'destination', type: 'string', description: 'a code-owned destination instead of coordinates', required: false, enum: ['own_death'] },
        { name: 'within', type: 'number', description: 'arrival distance (blocks)', required: false, minimum: 1, maximum: 16 },
        { name: 'durationMs', type: 'integer', description: 'length of one travel window before re-evaluating', required: false, minimum: 1_000, maximum: 120_000 },
      ],
      targets: ['owner_destination'],
      preconditions: ['destination in the current dimension', 'a route authorization for legs beyond the travel radius'],
      effects: ['bot walks toward the destination; may begin counted route legs; arrival verified from the bot position'],
      supportedPredicates: ['near_target', 'visited_location'],
      timeoutMs: 125_000,
      cancellation: 'stop clears the path goal and controls immediately; used route legs are never refunded',
      limitations: [
        'arrival is the bot position near the destination; presence of items/players there is not verified',
        'never digs, places, towers, parkours or opens doors; walls, drops, lava and height differences are reported',
        'route legs, distance and time are capped by operator policy; plans cannot change them',
      ],
      evidence: ['final distance from the bot position', 'route legs/distance counters'],
    },
    params,
    sustained: { windowElapsed: (o) => o.status === 'partial' && o.reason === 'route_window_elapsed' },
    resolve(ctx) {
      const drafts: CandidateDraft[] = [];
      const unavailable: Unavailable[] = [];
      const admitted = admittedParameters(ctx, shape).values as Partial<RouteTravelParams>;
      const within = admitted.within ?? 3;
      const durationMs = admitted.durationMs ?? 60_000;
      const rc = routeCtx(ctx);
      const self = ctx.snapshot.self.at;
      for (const d of ctx.hints.destinations) {
        if (d.dimension !== ctx.snapshot.dimension) {
          unavailable.push({ reason: 'dimension_mismatch', detail: `the owner-supplied destination is in ${d.dimension}` });
          continue;
        }
        if (ctx.services.perception.withinTravel(d.at)) {
          unavailable.push({ reason: 'destination_within_travel_bounds', detail: 'the destination is inside the travel radius; walk there directly' });
          continue;
        }
        // Provenance: only coordinates the owner typed for THIS admitted goal (route record).
        const verified = deps.routes.verifyDestination(rc, 'owner_destination', d.at, d.dimension);
        if (!verified.ok) {
          unavailable.push({ reason: `route_${verified.blocker}`, detail: verified.detail });
          continue;
        }
        const can = deps.routes.canBegin(rc, 'owner_destination');
        if (!can.ok) {
          unavailable.push({ reason: `route_${can.blocker}`, detail: can.detail });
          continue;
        }
        const dist = Math.hypot(d.at.x - self.x, d.at.z - self.z);
        drafts.push({ parameters: { target: json({ kind: 'destination', dimension: d.dimension, ...d.at }), within, durationMs }, description: `travel toward owner-supplied ${d.at.x},${d.at.y},${d.at.z} (${Math.round(dist)} blocks) through route legs`, criteria: routeCriteria(deps, ctx), score: -dist });
      }
      if (admitted.destination === 'own_death') {
        const verified = deps.routes.verifyDestination(rc, 'own_death');
        const can = deps.routes.canBegin(rc, 'own_death');
        if (!verified.ok) unavailable.push({ reason: `route_${verified.blocker}`, detail: verified.detail });
        else if (!can.ok) unavailable.push({ reason: `route_${can.blocker}`, detail: can.detail });
        else drafts.push({ parameters: { destination: 'own_death', within, durationMs }, description: `travel toward ${verified.label} through route legs`, criteria: routeCriteria(deps, ctx) });
      }
      if (drafts.length === 0 && unavailable.length === 0) unavailable.push({ reason: 'no_route_destination', detail: 'no owner-typed far destination or authorized code-owned destination for this task' });
      return { drafts, unavailable };
    },
    async execute(ctx, p) {
      const bot = ctx.session.bot;
      const dimension = String(bot.game.dimension);
      const rc = { goalEpoch: goalEpochOf(ctx), connectionEpoch: ctx.session.connectionEpoch, dimension };
      // Executor re-verification (independent of the resolver): admitted route for
      // this goal/epoch/connection/dimension, authorized kind, and provenance.
      let target: RouteTarget;
      if (p.target) {
        const verified = deps.routes.verifyDestination(rc, 'owner_destination', { x: p.target.x, y: p.target.y, z: p.target.z }, p.target.dimension);
        if (!verified.ok) return precondition(`route_${verified.blocker}`, verified.detail);
        target = { kind: 'fixed', destination: 'owner_destination', dimension, at: verified.at, label: verified.label };
      } else {
        const verified = deps.routes.verifyDestination(rc, 'own_death');
        if (!verified.ok || verified.kind !== 'own_death') return precondition(`route_${verified.ok ? 'destination_unverified' : verified.blocker}`, verified.ok ? 'unexpected destination kind' : verified.detail);
        if (!deps.routes.bindOwnDeath(rc, verified.destinationId)) return precondition('route_destination_changed', 'the recorded own death location changed after this route began');
        target = { kind: 'fixed', destination: 'own_death', dimension, at: verified.at, label: verified.label };
      }
      const result = await runRoute(routeEnv(ctx), target, p, { routes: deps.routes, ...(deps.locator ? { locator: deps.locator } : {}) });
      const out = toSkillResult(result);
      if (target.kind === 'fixed') out.evidence = { ...(out.evidence ?? {}), destination: target.destination === 'owner_destination' ? pos3(target.at) : 'own_death', position: pos3(bot.entity.position) } as Record<string, JsonValue>;
      return out;
    },
  };
  return skill;
}

/** The registered locator/route capabilities for installed services (empty without a route controller). */
export function locatorSkills(deps: LocatorSkillDeps | undefined): AnySkill[] {
  if (!deps) return [];
  return [seekOwnerSkill(deps), routeTravelSkill(deps)];
}
