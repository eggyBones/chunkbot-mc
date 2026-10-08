// Safety family (MB-FLOW-003-C11/C13): bounded registered capabilities bound
// to an installed, ENABLED SafetyService (safetySkills(service)).
//
//   escape_water           surface from local submersion (held jump with
//                          open headroom; toward an observed open column
//                          under a ceiling) then swim to an observed dry exit.
//   retreat_from_threat    one conservative pathfinder leg to a visible dry
//                          cell that increases separation from every visible
//                          active threat (no water/lava/hazard floors, deep
//                          water refused in the path).
//   defend_against_threat  bounded melee against ONE supported visible target
//                          with a verified weapon; every attack revalidates
//                          target visibility/identity/reach and readiness; no
//                          pursuit; defeat only from the server death status.
//
// AUTHORITY: no parameter carries a grant, coordinate or entity id. The
// executor passes the ACTUAL owner. For `{ kind: 'safety' }` the skill
// resolves the CURRENT grant from the service (expiry, displacement origin,
// bound defense target); a stale/foreign grant id refuses before any command.
// Goal/diagnostic owners get no safety exception: the goal's travel bounds and
// a defense target from a fresh observation handle only.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import type { ExecutionOwner } from '../contracts/ports.ts';
import { SAFETY_CAPABILITIES, type SafetyConfig, type SafetyEntityFact, type SafetyExecutionOwner, type SafetyGrant } from '../contracts/safety.ts';
import type { Actuator } from '../execution/actuator.ts';
import { ENTITY_REACH, eyeOf } from '../perception/perception.ts';
import { entityVisibleNow } from '../safety/adapter.ts';
import { dispositionOf, weaponFacts } from '../safety/dispositions.ts';
import { deepWaterStepCost, findFluidExits, findOpenColumn, findRetreatTargets, fluidState, type SafetyBlockReader } from '../safety/geometry.ts';
import { defenseReadiness, fluidHazards, threatHazards } from '../safety/policy.ts';
import type { SafetyService } from '../safety/service.ts';
import { liveEntity, pos3 } from './common.ts';
import { failed, precondition, type AnySkill, type ExecuteContext, type SkillDefinition, type SkillResult } from './definition.ts';
import { assertPolicy, conservativeMovements, goals } from './navigation.ts';
import { HandleRefSchema } from './refs.ts';

type Vec = { x: number; y: number; z: number };
const hyp = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);

/** Bounds of ONE execution, from the verified owner only. */
interface ExecBounds {
  grant: Readonly<SafetyGrant> | undefined;
  origin: Vec;
  maxDisplacement: number;
  deadlineMs: number;
  /**
   * Target admission. Safety owner: the grant's displacement bound ONLY (the
   * same prospective bound the monitor assessed; never the goal/route radius).
   * Goal/diagnostic owner: the goal's travel bounds AND a displacement bound
   * (no safety exception is borrowed). `requireTravel` is accepted for call-site
   * clarity and ignored by the safety branch.
   */
  allowed(x: number, y: number, z: number, requireTravel: boolean): boolean;
}

function boundsFor(ctx: ExecuteContext, service: SafetyService, maxMs: number, kind: 'water' | 'mobs'): ExecBounds | SkillResult {
  const now = ctx.services.clock.now();
  const p = ctx.session.bot.entity.position;
  const cfg = service.config;
  const owner = ownerOf(ctx);
  if (owner.kind === 'safety') {
    const grant = service.grant(owner.grantId);
    if (!grant || grant.episodeId !== owner.episodeId || grant.connectionEpoch !== owner.connectionEpoch) return precondition('safety_grant_not_current', 'the safety grant is not current (revoked, expired, fenced or foreign); no command was issued');
    const origin = grant.origin;
    return {
      grant,
      origin,
      maxDisplacement: grant.maxDisplacement,
      deadlineMs: Math.min(grant.expiresAtMs, now + maxMs),
      allowed: (x, _y, z) => Math.hypot(x + 0.5 - origin.x, z + 0.5 - origin.z) <= grant.maxDisplacement,
    };
  }
  // Goal / diagnostic owner: no safety exception; the goal travel bounds always apply.
  const origin = { x: p.x, y: p.y, z: p.z };
  const maxDisplacement = kind === 'water' ? cfg.water.maxDisplacement : cfg.mobs.maxDisplacement;
  return {
    grant: undefined,
    origin,
    maxDisplacement,
    deadlineMs: now + maxMs,
    allowed: (x, y, z) => Math.hypot(x + 0.5 - origin.x, z + 0.5 - origin.z) <= maxDisplacement && ctx.services.perception.withinTravel({ x: x + 0.5, y, z: z + 0.5 }),
  };
}

/** The ACTUAL executor owner (ExecutionOwner gains the `safety` variant in the shared contract; this view is forward-compatible). */
function ownerOf(ctx: ExecuteContext): ExecutionOwner | SafetyExecutionOwner {
  return ctx.owner as ExecutionOwner | SafetyExecutionOwner;
}

const isResult = (b: ExecBounds | SkillResult): b is SkillResult => 'status' in b;

/** Yaw that faces a horizontal target (installed physics/pathfinder convention). */
function yawTo(from: Vec, to: Vec): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function releaseControls(act: Actuator): void {
  if (!act.lease.active) return;
  for (const c of ['forward', 'jump', 'sprint', 'back', 'left', 'right'] as const) {
    try {
      act.setControl(c, false);
    } catch {
      // revoked meanwhile: the lease already cleared shared controls
    }
  }
}

/** Server air statement evidence (provenance-labeled). */
function airEvidence(service: SafetyService): JsonValue {
  const a = service.tracker.air;
  return a ? { value: a.value, previous: a.previous, source: 'server_metadata', atMs: a.atMs } : { value: null, source: 'unknown' };
}

/**
 * C11 deep-water path policy for the installed mineflayer-pathfinder 2.4.5
 * Movements (instance-level; node_modules untouched). Verified against the
 * installed source: `exclusionAreasStep` is consulted only by safeOrBreak,
 * while getMoveDiagonal's step-down and getLandingBlock's drop accept a
 * liquid landing without it. Every move reads blocks through
 * `Movements.getBlock`, so the wrapper marks water that is at swimming depth
 * (no solid block directly beneath) or a bubble column as `safe = false`:
 * safeOrBreak then costs 100 (refused), the diagonal step-down returns
 * ("don't self-immolate") and a liquid landing is no longer accepted. One
 * block of water over a solid floor (wading) is unchanged. The step hook is
 * kept as a second layer. `world` must be a live view (e.g. safetyWorld(session)).
 */
export function applyDeepWaterAvoidance(movements: unknown, world: SafetyBlockReader): void {
  const m = movements as {
    getBlock?: (pos: unknown, dx: number, dy: number, dz: number) => { position?: Vec; safe?: boolean };
    exclusionAreasStep?: Array<(b: { position: Vec }) => number>;
  };
  const original = m.getBlock;
  if (typeof original === 'function') {
    m.getBlock = function wrapped(this: unknown, pos, dx, dy, dz) {
      const b = original.call(this, pos, dx, dy, dz);
      const p = b.position;
      if (p && deepWaterStepCost(world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) >= 100) b.safe = false;
      return b;
    };
  }
  m.exclusionAreasStep?.push((b) => deepWaterStepCost(world, Math.floor(b.position.x), Math.floor(b.position.y), Math.floor(b.position.z)));
}

export function safetySkills(service: SafetyService | undefined): AnySkill[] {
  if (!service || !service.enabled) return [];
  const cfg: SafetyConfig = service.config;

  // ---------------------------------------------------------------- escape_water
  const escapeWater: SkillDefinition<{ maxMs: number }> = {
    descriptor: {
      id: SAFETY_CAPABILITIES.escapeWater,
      family: 'safety',
      purpose: 'Get out of deep water or lava: surface (held jump with open water above; toward a nearby open column under a ceiling), then swim to a visible dry exit.',
      parameters: [{ name: 'maxMs', type: 'integer', description: 'time bound in ms', required: false, minimum: 1_000, maximum: 30_000 }],
      targets: ['none'],
      preconditions: ['the bot is in water/lava at swimming depth or submerged (local estimate)'],
      effects: ['the bot surfaces and moves to a dry standable cell'],
      supportedPredicates: [],
      timeoutMs: 32_000,
      cancellation: 'stop/lifecycle clears jump/forward controls immediately through the actuator lease',
      limitations: ['no swimming under a solid ceiling beyond a few blocks', 'no digging, placing, boats, potions or sprint-swimming', 'fluid state is a local estimate; air is server metadata or unknown'],
      evidence: ['local fluid state before/after', 'server air metadata when stated', 'server position corrections counted'],
    },
    params: z.object({ maxMs: z.number().int().min(1_000).max(30_000).default(20_000) }).strict(),
    resolve(ctx) {
      const self = service.assess()?.self;
      if (!self) return { drafts: [], unavailable: [{ reason: 'not_connected', detail: 'no fresh self state' }] };
      const hz = fluidHazards(self, cfg).filter((h) => h.kind !== 'low_air' || self.fluid.eyeIn !== 'none');
      if (hz.length === 0) return { drafts: [], unavailable: [{ reason: 'not_in_deep_fluid', detail: 'not submerged or at swimming depth (local estimate)' }] };
      void ctx;
      return { drafts: [{ parameters: { maxMs: 20_000 }, description: `escape ${hz.map((h) => h.kind).join('+')}` }] };
    },
    async execute(ctx, params) {
      const b = boundsFor(ctx, service, params.maxMs, 'water');
      if (isResult(b)) return b;
      const { act, session } = ctx;
      const bot = session.bot;
      const clock = ctx.services.clock;
      const startSeq = session.evidence.seq;
      const airBefore = airEvidence(service);
      const startFluid = service.assess()?.self.fluid;
      const tried = new Set<string>();
      let target: { x: number; y: number; z: number; kind: 'column' | 'exit' } | undefined;
      let lastProgress = { at: clock.now(), d: Infinity };
      let surfaced = false;
      const finish = (r: SkillResult): SkillResult => ({
        ...r,
        evidence: { ...(r.evidence ?? {}), airBefore, airAfter: airEvidence(service), fluidBefore: startFluid ? { eyeIn: startFluid.eyeIn, feetIn: startFluid.feetIn, headroom: startFluid.headroom, source: 'local_estimate' } : null, position: pos3(bot.entity.position), displacement: Math.round(hyp(bot.entity.position, b.origin) * 10) / 10, serverCorrections: session.evidence.since(startSeq, 'position_correction').length },
      });
      try {
        while (true) {
          act.fence();
          if (clock.now() > b.deadlineMs) return finish(failed('timeout', surfaced ? 'surfaced but no dry exit reached within the time bound' : 'did not surface within the time bound'));
          const world = service.world();
          const visible = service.visible();
          if (!world || !visible) return finish(failed('not_connected', 'no world view'));
          const p = bot.entity.position;
          if (hyp(p, b.origin) > b.maxDisplacement) return finish({ status: 'partial', reason: 'displacement_limit', effect: `stopped at the ${b.maxDisplacement}-block displacement bound`, confirmation: 'client_only' });
          const eyeHeight = (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62;
          const fs = fluidState(world, { x: p.x, y: p.y, z: p.z }, eyeHeight);
          if (fs.eyeIn === 'none' && !surfaced && startFluid?.eyeIn !== 'none') surfaced = true;
          const deep = fs.feetIn !== 'none' && (fs.feetIn === 'lava' || fs.wadeable !== true);
          if (fs.eyeIn === 'none' && !deep) {
            return finish({ status: 'succeeded', effect: `out of deep fluid (local estimate)${surfaced ? ' after surfacing' : ''}; feet ${fs.feetIn}`, confirmation: 'client_only' });
          }
          const fluid = fs.eyeIn !== 'none' ? fs.eyeIn : fs.feetIn === 'none' ? 'water' : fs.feetIn;
          if (fs.eyeIn !== 'none' && fs.headroom === 'ceiling') {
            // Never jump blindly under a solid ceiling: steer to an observed open column.
            const col = target?.kind === 'column' ? target : (() => {
              const c = findOpenColumn(world, p, fluid, cfg.water.surfaceSearchRadius, eyeHeight);
              return c && b.allowed(c.x, c.surfaceY, c.z, false) ? { x: c.x + 0.5, y: c.surfaceY, z: c.z + 0.5, kind: 'column' as const } : undefined;
            })();
            if (!col) return finish(failed('no_reachable_surface', `a solid ceiling is above and no open water column within ${cfg.water.surfaceSearchRadius} blocks (local estimate)`));
            target = col;
          } else if (fs.eyeIn !== 'none' && fs.headroom === 'unknown') {
            return finish(failed('headroom_unknown', 'cannot verify an open surface above; no blind jump into unknown geometry'));
          } else if (fs.eyeIn !== 'none' && fs.headroom === 'open') {
            // Open headroom: hold jump straight up (forward toward a known exit only once one is chosen).
            target = target?.kind === 'exit' ? target : undefined;
          } else {
            // Surfaced but at swimming depth: choose an observed dry exit.
            if (!target || target.kind !== 'exit') {
              const exits = findFluidExits(world, p, fluid, { radius: cfg.water.shoreSearchRadius, visible, allowed: (x, y, z) => b.allowed(x, y, z, false) && !tried.has(`${x},${y},${z}`) });
              const e = exits[0];
              if (!e) return finish({ status: surfaced ? 'partial' : 'failed', reason: 'no_reachable_exit', effect: `${surfaced ? 'surfaced; ' : ''}no observed dry exit within ${cfg.water.shoreSearchRadius} blocks inside the bounds (local estimate)`, confirmation: 'client_only' });
              target = { x: e.x + 0.5, y: e.y, z: e.z + 0.5, kind: 'exit' };
              lastProgress = { at: clock.now(), d: hyp(p, target) };
            }
          }
          // Controls: jump while in fluid; forward toward a target if any.
          if (target) {
            await act.look(yawTo(p, target), 0);
            act.setControl('forward', true);
          } else {
            act.setControl('forward', false);
          }
          act.setControl('sprint', false);
          act.setControl('jump', fs.headroom !== 'ceiling');
          await act.sleep(100);
          if (target) {
            const d = hyp(bot.entity.position, target);
            if (d < lastProgress.d - 0.3) lastProgress = { at: clock.now(), d };
            else if (clock.now() - lastProgress.at > 2_500) {
              // Swimming into a wall or a current: drop this target and choose another.
              tried.add(`${Math.floor(target.x)},${target.y},${Math.floor(target.z)}`);
              if (tried.size > 3) return finish(failed('stuck', 'no progress toward three observed exits'));
              target = undefined;
              lastProgress = { at: clock.now(), d: Infinity };
            }
            if (target?.kind === 'column' && d < 0.6) target = undefined;
          }
          ctx.progress({ surfaced, exitTarget: target ? pos3(target) : null });
        }
      } finally {
        releaseControls(act);
      }
    },
  };

  // ---------------------------------------------------------------- retreat_from_threat
  const activeThreats = (): SafetyEntityFact[] => {
    const r = service.assess();
    return r ? threatHazards(r.entities, cfg, service.now()).active : [];
  };

  const retreat: SkillDefinition<{ maxMs: number }> = {
    descriptor: {
      id: SAFETY_CAPABILITIES.retreatFromThreat,
      family: 'safety',
      purpose: 'Move away from visible hostile threats along one conservative walking leg to a visible dry cell farther from every threat.',
      parameters: [{ name: 'maxMs', type: 'integer', description: 'time bound in ms', required: false, minimum: 1_000, maximum: 30_000 }],
      targets: ['none'],
      preconditions: ['a visible active threat (code policy)', 'an observed dry retreat cell inside the bounds'],
      effects: ['separation from visible threats increases (client position)'],
      supportedPredicates: [],
      timeoutMs: 32_000,
      cancellation: 'stop clears the path goal and controls immediately',
      limitations: ['never digs, places, pillars, parkours or enters deep water/lava', 'only visible threats are considered', 'separation is measured on the client model'],
      evidence: ['minimum threat distance before/after', 'server position corrections counted'],
    },
    params: z.object({ maxMs: z.number().int().min(1_000).max(30_000).default(15_000) }).strict(),
    resolve(ctx) {
      const t = activeThreats();
      if (t.length === 0) return { drafts: [], unavailable: [{ reason: 'no_active_threat', detail: 'no visible active threat' }] };
      return { drafts: [{ parameters: { maxMs: 15_000 }, description: `retreat from ${t.map((x) => x.key).slice(0, 3).join(', ')}` }] };
    },
    async execute(ctx, params) {
      const b = boundsFor(ctx, service, params.maxMs, 'mobs');
      if (isResult(b)) return b;
      const { act, session } = ctx;
      const bot = session.bot;
      const clock = ctx.services.clock;
      const startSeq = session.evidence.seq;
      const threats0 = activeThreats();
      if (threats0.length === 0) return { status: 'succeeded', effect: 'no visible active threat remains', confirmation: 'none' };
      const minDist = (t: SafetyEntityFact[]) => (t.length ? Math.min(...t.map((e) => e.distance)) : null);
      const before = minDist(threats0);
      const tried = new Set<string>();
      const pf = (bot as unknown as { pathfinder: { setMovements(m: unknown): void; isMoving(): boolean; thinkTimeout: number; searchRadius: number } }).pathfinder;
      const travel = ctx.services.perception.travelBounds?.();
      const evidenceOf = (extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => {
        const now = activeThreats();
        return { minThreatBefore: before, minThreatAfter: minDist(now), threatsAfter: now.length, position: pos3(bot.entity.position), displacement: Math.round(hyp(bot.entity.position, b.origin) * 10) / 10, serverCorrections: session.evidence.since(startSeq, 'position_correction').length, ...extra };
      };
      try {
        for (let leg = 0; leg < 3; leg += 1) {
          act.fence();
          const world = service.world();
          const visible = service.visible();
          if (!world || !visible) return failed('not_connected', 'no world view');
          const threats = activeThreats();
          if (threats.length === 0) return { status: 'succeeded', effect: 'no visible active threat remains', confirmation: 'client_only', evidence: evidenceOf() };
          const p = bot.entity.position;
          const targets = findRetreatTargets(world, { x: p.x, y: p.y, z: p.z }, { threats: threats.map((t) => t.at), separation: cfg.mobs.retreatSeparation, legMax: cfg.mobs.retreatLegMax, visible, allowed: (x, y, z) => b.allowed(x, y, z, true) && !tried.has(`${x},${y},${z}`) });
          const t = targets[0];
          if (!t) return failed('no_retreat_leg', 'no observed dry cell farther from the visible threats inside the bounds', evidenceOf());
          tried.add(`${t.x},${t.y},${t.z}`);
          const pathBound = b.grant ? { anchor: b.origin, radius: b.maxDisplacement } : travel;
          const { movements, verified } = conservativeMovements(bot, pathBound);
          assertPolicy(verified);
          applyDeepWaterAvoidance(movements, world);
          const mm = movements as { entitiesToAvoid?: Set<string> };
          for (const th of threats) mm.entitiesToAvoid?.add(th.key.replace(/^minecraft:/, ''));
          act.fence();
          pf.setMovements(movements);
          pf.thinkTimeout = 2_000;
          pf.searchRadius = Math.ceil(cfg.mobs.retreatLegMax + 8);
          let noPath = false;
          const onUpdate = (r: { status: string }) => {
            if (r.status === 'noPath') noPath = true;
          };
          bot.on('path_update' as never, onUpdate as never);
          try {
            act.setPathGoal(new goals.GoalNear(t.x + 0.5, t.y, t.z + 0.5, 1));
            const legStart = clock.now();
            let lastMove = { at: clock.now(), p: bot.entity.position.clone() };
            while (true) {
              await act.sleep(100);
              const q = bot.entity.position;
              if (hyp(q, b.origin) > b.maxDisplacement) {
                act.clearPathGoal();
                return { status: 'partial', reason: 'displacement_limit', effect: `stopped at the ${b.maxDisplacement}-block displacement bound`, confirmation: 'client_only', evidence: evidenceOf() };
              }
              const world2 = service.world();
              if (world2) {
                const fs = fluidState(world2, { x: q.x, y: q.y, z: q.z });
                if (fs.feetIn === 'lava' || (fs.feetIn === 'water' && fs.wadeable !== true)) {
                  act.clearPathGoal();
                  return failed('entered_fluid', 'the retreat path entered deep fluid; stopped (water escape takes over)', evidenceOf());
                }
              }
              if (hyp(q, { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }) <= 1.5) {
                act.clearPathGoal();
                const after = minDist(activeThreats());
                const ok = after === null || (before !== null && after >= Math.min(cfg.mobs.retreatSeparation, before + 3));
                return { status: ok ? 'succeeded' : 'partial', ...(ok ? {} : { reason: 'separation_not_reached' }), effect: `retreat leg reached (threat distance ${before ?? '-'} -> ${after ?? 'none visible'})`, confirmation: 'client_only', evidence: evidenceOf() };
              }
              if (q.distanceTo(lastMove.p) > 0.15) lastMove = { at: clock.now(), p: q.clone() };
              if ((noPath && !pf.isMoving()) || clock.now() - lastMove.at > 3_000) break; // next leg
              if (clock.now() > b.deadlineMs || clock.now() - legStart > params.maxMs) {
                act.clearPathGoal();
                return { status: 'partial', reason: 'timeout', effect: 'retreat leg not completed in time', confirmation: 'client_only', evidence: evidenceOf() };
              }
            }
          } finally {
            bot.off('path_update' as never, onUpdate as never);
            act.clearPathGoal();
          }
        }
        return failed('no_safe_path', 'no conservative walking path to three observed retreat cells', evidenceOf());
      } finally {
        releaseControls(act);
      }
    },
  };

  // ---------------------------------------------------------------- defend_against_threat
  const defend: SkillDefinition<{ target?: { snapshotId: string; handle: string } | undefined; maxAttacks: number }> = {
    descriptor: {
      id: SAFETY_CAPABILITIES.defendAgainstThreat,
      family: 'safety',
      purpose: 'Defend against ONE supported visible hostile melee mob in reach with a verified sword/axe, armor and health; bounded attacks, no pursuit.',
      parameters: [
        { name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible supported hostile (goal use only)', required: false },
        { name: 'maxAttacks', type: 'integer', description: 'maximum attacks', required: false, minimum: 1, maximum: 10 },
      ],
      targets: ['entity'],
      preconditions: ['one supported adult melee hostile (zombie, husk, zombie villager, drowned without a ranged item, spider)', 'verified stone-or-better sword/axe with durability, armor and health thresholds', 'no creeper, ranged, group or provoked-neutral threat'],
      effects: ['target damaged; possibly defeated (server-confirmed)'],
      supportedPredicates: ['entity_outcome'],
      timeoutMs: 25_000,
      cancellation: 'stop prevents further attacks immediately',
      limitations: ['never attacks players, the owner, passive or neutral mobs', 'no pursuit beyond reach; a target out of sight is not a defeat', 'readiness is rechecked before every attack and switches to retreat when it fails'],
      evidence: ['server damage_event per hit', 'server entity status 3 (death)'],
    },
    params: z.object({ target: HandleRefSchema.optional(), maxAttacks: z.number().int().min(1).max(10).default(8) }).strict(),
    resolve(ctx) {
      const r = service.assess();
      if (!r) return { drafts: [], unavailable: [{ reason: 'not_connected', detail: 'no fresh self state' }] };
      const { hazards, active } = threatHazards(r.entities, cfg, ctx.services.clock.now());
      // Planner/goal-owned path: the goal's travel bounds apply to escape space too (no safety exception).
      const goalBound = (x: number, y: number, z: number) => ctx.services.perception.withinTravel({ x: x + 0.5, y, z: z + 0.5 }) && Math.hypot(x + 0.5 - ctx.snapshot.self.at.x, z + 0.5 - ctx.snapshot.self.at.z) <= cfg.mobs.maxDisplacement;
      const pctx = service.policyContext(r.self, goalBound);
      const readiness = defenseReadiness(r.self, active, hazards, pctx, !pctx.retreatAvailable(active));
      if (!readiness.admitted || !readiness.target) return { drafts: [], unavailable: [{ reason: 'defense_not_admitted', detail: readiness.refusals.join(', ') || 'no single supported threat' }] };
      const target = readiness.target;
      // Map the code target to THIS snapshot's handle (never an entity id parameter).
      const handle = ctx.snapshot.entities.find((e) => {
        const rec = ctx.services.perception.resolve(ctx.snapshot.id, e.handle);
        return !('error' in rec) && rec.target.kind === 'entity' && rec.target.entityId === target.entityId;
      })?.handle;
      if (!handle) return { drafts: [], unavailable: [{ reason: 'target_not_in_snapshot', detail: `${target.key} is not in the current observation` }] };
      return { drafts: [{ parameters: { target: { snapshotId: ctx.snapshot.id, handle }, maxAttacks: cfg.mobs.defense.maxAttacks }, description: `defend against ${target.key} ${handle}` }] };
    },
    async execute(ctx, params) {
      const b = boundsFor(ctx, service, cfg.mobs.maxEpisodeMs, 'mobs');
      if (isResult(b)) return b;
      const { act, session, services } = ctx;
      const bot = session.bot;
      const clock = services.clock;
      // Target: safety owner -> the grant's code-bound target; goal owner -> a fresh observation handle.
      let entityId: number;
      let targetKey: string;
      if (ownerOf(ctx).kind === 'safety') {
        if (!b.grant?.target) return precondition('no_bound_target', 'the safety grant has no bound defense target');
        entityId = b.grant.target.entityId;
        targetKey = b.grant.target.key;
      } else {
        if (!params.target) return precondition('missing_target', 'goal use needs a visible target handle');
        const live = liveEntity(services, session, params.target.snapshotId, params.target.handle);
        if ('error' in live) return precondition(live.error, live.detail);
        if (live.record.target.kind !== 'entity' || live.record.target.isOwner || live.name === 'player') return precondition('refused_target', 'never attacks players or the owner');
        entityId = live.entityId;
        targetKey = `minecraft:${live.name}`;
      }
      const safetyOwner = ownerOf(ctx);
      const grantId = safetyOwner.kind === 'safety' ? safetyOwner.grantId : undefined;
      // Per-action cap; under a safety grant the CUMULATIVE episode budget is reserved per attack as well.
      const maxAttacks = Math.min(params.maxAttacks, cfg.mobs.defense.maxAttacks);
      const startHealth = typeof bot.health === 'number' ? bot.health : 20;
      const startSeq = session.evidence.seq;
      session.evidence.watch(entityId);
      let attacks = 0;
      let hits = 0;
      let lastAttackAt = 0;
      let outOfReachSince: number | undefined;
      const ev = (extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ entityId, attacksSent: attacks, hitsConfirmed: hits, defeatedByServerStatus: false, health: bot.health ?? null, ...extra });
      const dead = () => session.evidence.since(startSeq, 'entity_status', (s) => s.entityId === entityId && s.status === 3).length > 0;
      try {
        while (attacks < maxAttacks) {
          act.fence();
          if (clock.now() > b.deadlineMs) return { status: 'partial', reason: 'timeout', effect: `defense time bound reached after ${attacks} attack(s)`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
          if (dead()) break;
          // Fresh revalidation before EVERY attack.
          if (!entityVisibleNow(session, entityId, cfg.mobs.scanRadius)) {
            return { status: 'partial', reason: 'target_not_visible', effect: `target is no longer visible after ${attacks} attack(s); not counted as defeated`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
          }
          // Looking can await library work. Do it BEFORE the final target,
          // gear, health, terrain and reach checks; attackEntity below has no
          // look await between those checks and its fenced packet dispatch.
          const aiming = bot.entities[entityId];
          if (!aiming) return { status: 'partial', reason: 'target_not_visible', effect: 'target left before aiming', confirmation: 'none', evidence: ev() };
          await act.lookAt({ x: aiming.position.x, y: aiming.position.y + (aiming.height ?? 1.8) * 0.6, z: aiming.position.z });
          if (!entityVisibleNow(session, entityId, cfg.mobs.scanRadius)) return { status: 'partial', reason: 'target_not_visible', effect: 'target left during aiming; not counted as defeated', confirmation: 'none', evidence: ev() };
          const r = service.assess();
          if (!r) return failed('not_connected', 'no fresh self state', ev());
          const { hazards, active } = threatHazards(r.entities, cfg, clock.now());
          const fact = r.entities.find((e) => e.entityId === entityId);
          if (!fact || fact.key !== targetKey || !dispositionOf(fact.key, undefined, fact.heldItem).defenseSupported) return { status: 'partial', reason: 'target_unsupported', effect: 'the target identity or supported matchup changed', confirmation: 'none', evidence: ev() };
          const others = active.filter((e) => e.entityId !== entityId);
          // Every readiness check again, including escape terrain (an observed retreat leg): never waived mid-fight.
          const pctx = service.policyContext(r.self, (x, y, z) => b.allowed(x, y, z, true));
          const readiness = defenseReadiness(r.self, [fact, ...others], hazards, pctx, !pctx.retreatAvailable([fact, ...others]));
          const healthLoss = startHealth - r.self.health;
          if (r.self.health <= cfg.mobs.defense.disengageHealth || healthLoss >= 6 || !readiness.admitted) {
            const why = r.self.health <= cfg.mobs.defense.disengageHealth ? 'health at/below disengage' : healthLoss >= 6 ? `lost ${healthLoss} health during the engagement` : readiness.refusals.join(', ');
            return { status: 'partial', reason: 'readiness_changed', effect: `defense readiness changed (${why}); switching to avoidance`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev({ refusals: readiness.refusals, healthLoss }) };
          }
          if (hyp(bot.entity.position, b.origin) > b.maxDisplacement) return { status: 'partial', reason: 'displacement_limit', effect: 'outside the displacement bound', confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
          const weapon = readiness.weapon;
          if (!weapon) return { status: 'partial', reason: 'readiness_changed', effect: 'no verified weapon', confirmation: 'none', evidence: ev() };
          if (weapon.switchFromHotbar !== null) {
            act.selectHotbar(weapon.switchFromHotbar);
            await act.sleep(100);
            continue; // re-verify the held stack against the server-stated slot
          }
          const wf = weaponFacts(weapon.key, (tag, key) => service.inTag(tag, key));
          const e = bot.entities[entityId] as unknown as { position: Vec; height?: number } | undefined;
          if (!e?.position) return { status: 'partial', reason: 'target_not_visible', effect: 'target left the client model; not counted as defeated', confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
          const eye = eyeOf(bot);
          const h = e.height ?? 1.8;
          const cx = Math.max(e.position.x - 0.3, Math.min(eye.x, e.position.x + 0.3));
          const cy = Math.max(e.position.y, Math.min(eye.y, e.position.y + h));
          const cz = Math.max(e.position.z - 0.3, Math.min(eye.z, e.position.z + 0.3));
          const reach = Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
          if (reach > ENTITY_REACH) {
            // No pursuit: wait (looking at it) for a bounded time, then hand back to the monitor.
            outOfReachSince ??= clock.now();
            if (clock.now() - outOfReachSince > cfg.mobs.defense.reengageWaitMs) return { status: 'partial', reason: 'target_out_of_reach', effect: `target stayed out of reach (${reach.toFixed(1)} blocks); no pursuit`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
            await act.sleep(100);
            continue;
          }
          outOfReachSince = undefined;
          const wait = (wf?.cooldownMs ?? 1_300) - (clock.now() - lastAttackAt);
          if (wait > 0) {
            await act.sleep(Math.min(wait, 200));
            continue;
          }
          // The attack is reserved against the grant's cumulative budget immediately before it is sent.
          if (grantId !== undefined && !service.reserveAttack(grantId)) {
            return { status: 'partial', reason: 'attack_budget_exhausted', effect: `the episode's cumulative attack budget is used up (${cfg.mobs.defense.maxAttacks}); no further attack`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
          }
          const hitSeq = session.evidence.seq;
          await act.attackEntity(entityId);
          attacks += 1;
          lastAttackAt = clock.now();
          const dmg = await act.waitServer('damage', (d) => d.entityId === entityId, hitSeq, 800);
          if (dmg) hits += 1;
          ctx.progress({ attacksSent: attacks, hitsConfirmed: hits }, hits > 0 ? 'server_packet' : 'local');
        }
        if (dead()) {
          services.ledger.add({ kind: 'entity_defeated', entityId, entity: targetKey, atMs: clock.now() });
          return { status: 'succeeded', effect: `target defeated (server death status) after ${attacks} attack(s), ${hits} confirmed hit(s)`, confirmation: 'server_packet', evidence: ev({ defeatedByServerStatus: true }) };
        }
        return { status: 'partial', reason: 'attacks_exhausted', effect: `${hits}/${attacks} hits confirmed; not defeated`, confirmation: hits > 0 ? 'server_packet' : 'none', evidence: ev() };
      } finally {
        releaseControls(act);
      }
    },
  };

  return [escapeWater, retreat, defend];
}
