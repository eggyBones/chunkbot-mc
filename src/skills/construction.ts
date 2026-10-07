// Construction family (MB-FLOW-001 A3/A6): a small practical shelter built
// from a code-generated blueprint on a code-approved, observed vacant site.
//
//   select_home_site  approve ONE small vacant footprint (flat natural ground,
//                     every ground block visible now, whole volume air or
//                     replaceable vegetation, walkable entrance approach, no
//                     foreign structure nearby, inside travel bounds); stored
//                     durably in the explicit scope. A site is not a home.
//   build_home        one fenced construction action per Jev choice, offered
//                     only for the earliest incomplete phase: place a missing
//                     blueprint block against a visible support, step onto /
//                     off the single approved construction aid, remove the
//                     bot's OWN aid block (server-confirmed unchanged identity
//                     on this connection), or reposition inside the footprint.
//
// Never: demolition of blocks the project did not place, navigation digging,
// towering, scaffolding or parkour (pathfinder keeps the conservative policy),
// placement outside blueprint positions, or claims without server evidence.
// The goal outcome is the code-evaluated `structure_state` predicate.
import { Vec3 } from 'vec3';
import { z } from 'zod';
import type { BlueprintCell, HomeProject } from '../contracts/autonomy.ts';
import type { JsonValue, PredicateEvaluation } from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import { BLOCK_REACH, eyeOf, sessionWorld } from '../perception/perception.ts';
import { faceNormal, visibleFaces, type FaceName } from '../perception/visibility.ts';
import { aidCell, accepts, checkSite, entranceInterior, entranceOutside, findSites, judgeCells, verifyShelter, type CellVerdict, type Facing, type ShelterVerdict, type SiteProbe, type V3, type VoxelTruth } from '../autonomy/blueprint.ts';
import type { HomeProjectService } from '../autonomy/home.ts';
import { clientCounts, ensureInHand, eyeDistanceToBlock, mk } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type SkillServices, type Unavailable } from './definition.ts';
import { goals, navigate } from './navigation.ts';
import { occupyingEntity } from './placement.ts';

type Bot = GameSession['bot'];

const NATURAL_GROUND = /^minecraft:(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|stone|deepslate|granite|diorite|andesite|tuff|sand|red_sand|gravel|snow_block|clay|terracotta|moss_block|mud|calcite|sandstone|red_sandstone|dirt_path)$/;
const REPLACEABLE = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|short_dry_grass|tall_dry_grass|leaf_litter)$/;
const INTERACTIVE_SUPPORT = /(chest|barrel|crafting_table|furnace|smoker|_door|_trapdoor|_bed|_button|lever|_fence_gate|anvil|table|loom|stonecutter|grindstone|bell|lectern|composter|hopper)$/;

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const at3 = (p: V3) => `${p.x},${p.y},${p.z}`;
/** Plain JSON copy of a position (candidate parameters/evidence). */
const pj = (p: V3): { x: number; y: number; z: number } => ({ x: p.x, y: p.y, z: p.z });

function stateName(bot: Bot, stateId: number): string {
  return (bot.registry as unknown as { blocksByStateId: Record<number, { name: string } | undefined> }).blocksByStateId[stateId]?.name ?? `state_${stateId}`;
}

// ---------------------------------------------------------------- inspector (shared with the structure_state predicate)

interface Seen {
  key: string;
  seq: number;
  connectionEpoch: number;
  generation: number;
}

/**
 * Fresh shelter inspection from server evidence. A cell is decided by (1) the
 * latest server statement for a position this connection's skills changed,
 * (2) loaded chunk data for a position in line of sight now (no pending client
 * prediction), or (3) an earlier line-of-sight observation on THIS connection
 * and lifecycle generation that no later server statement for that voxel has
 * superseded. Anything else is unknown (never assumed).
 */
export class ShelterInspector {
  private readonly cache = new Map<string, Seen>();
  private readonly session: () => GameSession | undefined;
  private readonly services: SkillServices;

  constructor(session: () => GameSession | undefined, services: SkillServices) {
    this.session = session;
    this.services = services;
  }

  inTag = (tag: string, key: string): boolean => Boolean(this.services.knowledge.recipes?.matches(tag, key));

  private generation(): number {
    return this.services.ledger.invalidations.length;
  }

  truth(p: V3): VoxelTruth {
    const s = this.session();
    if (!s) return { evidence: 'unknown', detail: 'not connected' };
    const bot = s.bot;
    const ev = s.evidence as Partial<Pick<GameSession['evidence'], 'serverBlock' | 'predictionPending'>> & { seq: number };
    const fact = typeof ev.serverBlock === 'function' ? ev.serverBlock(p.x, p.y, p.z) : undefined;
    const own = this.services.ledger.ownBlockChange(p.x, p.y, p.z, 0);
    const visible = this.services.perception.blockVisibleNow(p.x, p.y, p.z);
    const k = at3(p);
    if (fact && (visible || own)) {
      const name = stateName(bot, fact.stateId);
      const key = mk(name);
      this.cache.set(k, { key, seq: fact.seq, connectionEpoch: s.connectionEpoch, generation: this.generation() });
      return { key, evidence: own && !visible ? 'server_own_change' : 'visible' };
    }
    const pending = typeof ev.predictionPending === 'function' ? ev.predictionPending(p.x, p.y, p.z) : true;
    if (!pending && visible) {
      const b = this.services.perception.world()?.blockAt(p.x, p.y, p.z);
      if (b) {
        const key = mk(b.name);
        this.cache.set(k, { key, seq: ev.seq, connectionEpoch: s.connectionEpoch, generation: this.generation() });
        return { key, evidence: 'visible' };
      }
    }
    const seen = this.cache.get(k);
    if (seen && seen.connectionEpoch === s.connectionEpoch && seen.generation === this.generation() && !(fact && fact.seq > seen.seq) && !pending) return { key: seen.key, evidence: 'visible', detail: 'earlier line-of-sight observation on this connection, not superseded by a server change' };
    return { evidence: 'unknown', detail: pending ? 'pending client prediction' : 'not in line of sight now' };
  }

  inspect(project: HomeProject): { verdicts: CellVerdict[]; verdict: ShelterVerdict } {
    const verdicts = judgeCells(project.cells, (p) => this.truth(p), this.inTag);
    return { verdicts, verdict: verifyShelter(project.cells, verdicts) };
  }

  /** Clears cached observations (lifecycle). */
  reset(): void {
    this.cache.clear();
  }
}

/** Code evaluation of `structure_state` (structure: home). */
export function evaluateStructure(home: HomeProjectService, inspector: ShelterInspector, session: () => GameSession | undefined, expect: 'site_approved' | 'enclosed' | 'complete'): PredicateEvaluation {
  const project = home.project();
  const out = (status: PredicateEvaluation['status'], detail: string, evidence: PredicateEvaluation['evidence'] = {}): PredicateEvaluation => ({ status, predicate: 'structure_state', detail, evidence });
  if (!project) return out(home.writable() ? 'unsatisfied' : 'unknown', home.writable() ? 'no home project is approved in this world profile' : 'home projects need a writable durable scope');
  if (expect === 'site_approved') return out('satisfied', `home project ${project.id} approved at ${at3(project.origin)} (${project.dimension}), state ${project.state}`, { projectId: project.id, state: project.state });
  const s = session();
  if (!s) return out('unknown', 'not connected');
  if (String(s.bot.game.dimension) !== project.dimension) return out('unknown', `the home is in ${project.dimension}, the bot is in ${String(s.bot.game.dimension)}`);
  const { verdict } = inspector.inspect(project);
  const ev = { projectId: project.id, satisfied: verdict.satisfied, total: verdict.total, missing: verdict.missing, unknown: verdict.unknown, foreign: verdict.foreign.length };
  void home.verified(verdict).catch(() => undefined);
  if (expect === 'enclosed') return out(verdict.enclosed === 'satisfied' ? 'satisfied' : verdict.enclosed === 'unknown' ? 'unknown' : 'unsatisfied', `enclosure ${verdict.enclosed}: ${verdict.detail}`, ev);
  return out(verdict.status === 'complete' ? 'satisfied' : verdict.status === 'unknown' ? 'unknown' : 'unsatisfied', verdict.detail, ev);
}

// ---------------------------------------------------------------- site probe

function siteProbe(session: GameSession, services: SkillServices): SiteProbe {
  const world = sessionWorld(session);
  return {
    blockAt: (p) => {
      const b = world.blockAt(p.x, p.y, p.z);
      return b && b.name !== 'unconfirmed_prediction' ? mk(b.name) : undefined;
    },
    visible: (p) => services.perception.blockVisibleNow(p.x, p.y, p.z),
    naturalGround: (k) => NATURAL_GROUND.test(k),
  };
}

const FACINGS = ['north', 'south', 'east', 'west'] as const;

const SiteParams = z
  .object({
    interior: z.union([z.literal(2), z.literal(3)]).optional(),
    origin: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
    facing: z.enum(FACINGS).optional(),
  })
  .strict();

export interface ConstructionOptions {
  home: HomeProjectService;
  inspector: ShelterInspector;
  interior: 2 | 3;
  maxSiteDistance: number;
}

export function constructionSkills(options: ConstructionOptions): SkillDefinition[] {
  const { home, inspector } = options;

  const selectHomeSite: SkillDefinition<z.infer<typeof SiteParams>> = {
    descriptor: {
      id: 'select_home_site',
      family: 'construction',
      purpose: 'Approve one small vacant site near the bot for the home shelter (flat natural ground in sight, empty volume, no nearby structures); recorded durably for this world profile. A site is not a home.',
      parameters: [{ name: 'interior', type: 'integer', description: 'interior side length (2 or 3; default from config)', required: false, minimum: 2, maximum: 3 }],
      targets: ['none'],
      preconditions: ['no home project exists yet in this world profile', 'writable durable scope', 'flat natural ground visible nearby inside the travel radius'],
      effects: ['an approved home project (footprint + blueprint) stored in the scope; no world change'],
      supportedPredicates: ['structure_state'],
      timeoutMs: 5_000,
      cancellation: 'nothing is written after cancellation',
      limitations: ['only observed vacant sites; never clears, digs or levels terrain', 'one home project per world profile'],
      evidence: ['loaded server chunk data with line of sight to every footprint ground block', 'durable autonomy store revision'],
    },
    params: SiteParams,
    resolve(ctx) {
      const { session, services, snapshot } = ctx;
      const existing = home.project();
      if (existing) return { drafts: [], unavailable: [{ reason: 'home_project_exists', detail: `home project ${existing.id} (${existing.state}) already exists; use build_home to inspect and continue it`, evidence: { state: existing.state } }] };
      if (!home.writable()) return { drafts: [], unavailable: [{ reason: 'scope_not_writable', detail: 'home projects need a writable durable world/bot scope' }] };
      const want = ((ctx.hints.parameters as Record<string, unknown>)['interior'] === 2 || (ctx.hints.parameters as Record<string, unknown>)['interior'] === 3 ? (ctx.hints.parameters as Record<string, unknown>)['interior'] : options.interior) as 2 | 3;
      const probe = siteProbe(session, services);
      const sites = findSites(probe, snapshot.self.at, want, options.maxSiteDistance, (p) => services.perception.withinTravel(p), 4);
      if (sites.length === 0) return { drafts: [], unavailable: [{ reason: 'no_vacant_site', detail: `no flat, visible, vacant ${want + 2}x${want + 2} footprint within ${options.maxSiteDistance} blocks; move to open flat ground and look again (survey_surroundings)` }] };
      return {
        drafts: sites.map((s, i) => ({
          parameters: { interior: s.interior, origin: pj(s.origin), facing: s.facing },
          description: `approve a ${s.interior + 2}x${s.interior + 2} home site at ${at3(s.origin)}, entrance facing ${s.facing}, ${s.distance} blocks away`,
          criteria: s.checks,
          score: 10 - i,
        })),
      };
    },
    async execute(ctx, params) {
      const { session, services } = ctx;
      if (!params.origin || !params.facing || !params.interior) return precondition('site_not_specified', 'a site candidate must come from the resolver');
      const probe = siteProbe(session, services);
      // Fresh re-check at execution (no stale approval).
      const check = checkSite(probe, params.origin, params.interior, params.facing as Facing);
      if (!check.ok) return precondition('site_no_longer_vacant', check.reason);
      const centre = { x: params.origin.x + (params.interior + 2) / 2, y: params.origin.y, z: params.origin.z + (params.interior + 2) / 2 };
      if (!services.perception.withinTravel(centre)) return precondition('outside_travel_bounds', 'the site is outside the travel bounds');
      const r = await home.approve({ origin: params.origin, interior: params.interior, facing: params.facing as Facing, dimension: String(session.bot.game.dimension), checks: check.checks, ...(ctx.owner.kind === 'goal' ? { goalId: ctx.owner.goalId } : {}) });
      if (!r.ok) return failed(r.reason, r.detail);
      return { status: 'succeeded', effect: `approved home site ${r.project.id} at ${at3(r.project.origin)} (entrance ${r.project.entranceFacing}); stored durably — nothing is built yet`, confirmation: 'none', evidence: { projectId: r.project.id, origin: r.project.origin, facing: r.project.entranceFacing, checks: check.checks } };
    },
  };

  const BuildParams = z
    .object({
      action: z.enum(['place', 'remove_aid', 'reposition']).optional(),
      cell: z.number().int().min(0).max(255).optional(),
      item: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(),
      support: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
      face: z.enum(['up', 'down', 'north', 'south', 'west', 'east']).optional(),
      to: z.enum(['stand_on_aid', 'step_off_aid', 'stand_under_hole', 'inside', 'outside', 'near_missing']).optional(),
      /** Planner-admitted only: preferred building material (key or tag). */
      material: z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(),
    })
    .strict();
  type BuildP = z.infer<typeof BuildParams>;

  /** Inventory items (concrete keys) accepted by a cell, preferring a material hint. */
  const itemsFor = (cell: BlueprintCell, bot: Bot, material?: string): string[] => {
    const counts = clientCounts(bot);
    const keys = [...counts.keys()].filter((k) => (counts.get(k) ?? 0) > 0 && accepts(cell, k, inspector.inTag));
    if (!material) return keys;
    const pref = keys.filter((k) => (material.startsWith('#') ? inspector.inTag(material, k) : material === k));
    return pref.length ? pref : keys;
  };

  /** Support blocks with a visible face whose placement lands exactly on `dest`. */
  const supportsFor = (bot: Bot, session: GameSession, dest: V3): Array<{ support: V3; face: FaceName; distance: number }> => {
    const world = sessionWorld(session);
    const eye = eyeOf(bot);
    const out: Array<{ support: V3; face: FaceName; distance: number }> = [];
    for (const face of ['up', 'down', 'north', 'south', 'west', 'east'] as FaceName[]) {
      const n = faceNormal(face);
      const s = { x: dest.x - n.x, y: dest.y - n.y, z: dest.z - n.z };
      const b = world.blockAt(s.x, s.y, s.z);
      if (!b || b.shapes.length === 0 || REPLACEABLE.test(b.name) || b.name === 'unconfirmed_prediction' || INTERACTIVE_SUPPORT.test(b.name)) continue;
      const d = eyeDistanceToBlock(bot, s.x, s.y, s.z);
      if (d > BLOCK_REACH - 0.3) continue;
      if (!visibleFaces(world, eye, s.x, s.y, s.z).includes(face)) continue;
      out.push({ support: s, face, distance: d });
    }
    return out.sort((a, b) => (a.face === 'up' ? -1 : 0) - (b.face === 'up' ? -1 : 0) || a.distance - b.distance);
  };

  const intersectsBot = (p: { x: number; y: number; z: number }, c: V3) => c.x + 1 > p.x - 0.3 && c.x < p.x + 0.3 && c.z + 1 > p.z - 0.3 && c.z < p.z + 0.3 && c.y + 1 > p.y && c.y < p.y + 1.8;
  const onTopOf = (bot: Bot, c: V3) => {
    const p = bot.entity.position;
    return Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y >= c.y + 0.9 && p.y <= c.y + 1.6;
  };
  const inColumn = (bot: Bot, c: V3) => Math.floor(bot.entity.position.x) === c.x && Math.floor(bot.entity.position.z) === c.z;
  const insideFootprint = (bot: Bot, project: HomeProject) => {
    const p = bot.entity.position;
    return p.x > project.origin.x + 1 && p.x < project.origin.x + project.size.outerX - 1 && p.z > project.origin.z + 1 && p.z < project.origin.z + project.size.outerZ - 1;
  };

  /** Own-aid identity: placed by THIS connection's skill (ledger) and no later server statement changed it. */
  const aidIdentity = (session: GameSession, services: SkillServices, cell: BlueprintCell): { ok: true; key: string } | { ok: false; detail: string } => {
    const own = services.ledger.latestOwnChange(cell.at.x, cell.at.y, cell.at.z);
    if (!own || own.to === 'minecraft:air') return { ok: false, detail: 'no server-confirmed own placement of the construction aid on this connection (e.g. after a restart); it is left in place and reported' };
    const fact = (session.evidence as Partial<Pick<GameSession['evidence'], 'serverBlock'>>).serverBlock?.(cell.at.x, cell.at.y, cell.at.z);
    if (!fact) return { ok: false, detail: 'no server statement for the aid position' };
    const current = mk(stateName(session.bot, fact.stateId));
    if (current !== own.to || fact.atMs > own.atMs + 50) return { ok: false, detail: `the aid position changed after the bot placed it (now ${current})` };
    return { ok: true, key: current };
  };

  /** The construction actions available now (earliest incomplete phase only). */
  const plan = (session: GameSession, services: SkillServices, project: HomeProject, material?: string): { drafts: CandidateDraft[]; unavailable: Unavailable[]; verdict: ShelterVerdict } => {
    const bot = session.bot;
    const { verdicts, verdict } = inspector.inspect(project);
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    if (verdict.foreign.length > 0) {
      unavailable.push({ reason: 'foreign_block_in_blueprint', detail: `blueprint positions hold blocks the project did not place (${verdict.foreign.slice(0, 3).map((f) => `${f.key} at ${at3(f.at)}`).join('; ')}); the project never removes them — the owner decides`, evidence: { foreign: verdict.foreign.length } });
      return { drafts, unavailable, verdict };
    }
    const status = (role: BlueprintCell['role'], phase?: number) => verdicts.filter((v) => v.cell.role === role && (phase === undefined || v.cell.phase === phase));
    const missingOf = (vs: CellVerdict[]) => vs.filter((v) => v.status === 'missing');
    const unknownOf = (vs: CellVerdict[]) => vs.filter((v) => v.status === 'unknown');
    const aid = aidCell(project) as BlueprintCell;
    const aidTruth = inspector.truth(aid.at);
    const aidPresent = Boolean(aidTruth.key && accepts(aid, aidTruth.key, inspector.inTag));
    const placeDrafts = (cells: CellVerdict[], label: string) => {
      for (const v of cells) {
        const dest = v.cell.at;
        if (intersectsBot(bot.entity.position, dest)) continue;
        if (occupyingEntity(bot as never, dest.x, dest.y, dest.z)) continue;
        const items = itemsFor(v.cell, bot, material);
        if (items.length === 0) continue;
        const sup = supportsFor(bot, session, dest)[0];
        if (!sup) continue;
        drafts.push({
          parameters: { action: 'place', cell: v.index, item: items[0] as string, support: pj(sup.support), face: sup.face },
          description: `${label}: place ${items[0]} at ${at3(dest)} (on the ${sup.face} face of ${at3(sup.support)})`,
          score: 20 - sup.distance,
        });
      }
    };
    const needItems = (cells: CellVerdict[]) => {
      const missingItems = cells.filter((v) => itemsFor(v.cell, bot, material).length === 0);
      if (missingItems.length > 0) {
        const accept = [...new Set(missingItems.flatMap((v) => v.cell.accept))];
        unavailable.push({ reason: 'missing_building_material', detail: `${missingItems.length} ${missingItems[0]?.cell.role} cell(s) need one of ${accept.join(', ')} in the inventory`, evidence: { cells: missingItems.length, accept } });
      }
    };
    const reposition = (to: NonNullable<BuildP['to']>, why: string) => drafts.push({ parameters: { action: 'reposition', to }, description: `move ${to.replace(/_/g, ' ')} (${why})`, score: 1 });

    const w1 = status('wall', 1);
    const w2 = status('wall', 2);
    const roof = status('roof', 4);
    const hole = status('roof', 6);
    const furnish = verdicts.filter((v) => (v.cell.role === 'workstation' || v.cell.role === 'storage') && v.cell.phase === 7);
    const stage = missingOf(w1).length
      ? 'wall1'
      : missingOf(w2).length
        ? 'wall2'
        : missingOf(roof).length
          ? 'roof'
          : aidPresent
            ? 'remove_aid'
            : missingOf(hole).length
              ? 'hole'
              : missingOf(furnish).length
                ? 'furnish'
                : unknownOf(verdicts).length
                  ? 'inspect'
                  : 'done';
    switch (stage) {
      case 'wall1':
      case 'wall2': {
        const cells = missingOf(stage === 'wall1' ? w1 : w2);
        placeDrafts(cells, stage === 'wall1' ? 'wall layer 1' : 'wall layer 2');
        needItems(cells);
        if (drafts.length === 0) reposition(insideFootprint(bot, project) ? 'outside' : 'near_missing', 'no missing wall cell has a visible support within reach here');
        break;
      }
      case 'roof': {
        if (!aidPresent) {
          if (aidTruth.key && !/^minecraft:(air|cave_air|void_air)$/.test(aidTruth.key) && !accepts(aid, aidTruth.key, inspector.inTag)) {
            unavailable.push({ reason: 'aid_position_occupied', detail: `the construction aid position ${at3(aid.at)} holds ${aidTruth.key}` });
            break;
          }
          if (!insideFootprint(bot, project)) reposition('inside', 'the construction aid is placed from inside');
          else if (inColumn(bot, aid.at)) reposition('step_off_aid', 'the bot stands where the construction aid goes');
          else {
            const v = verdicts.find((x) => x.cell === aid) as CellVerdict;
            placeDrafts([{ ...v, status: 'missing' }], 'construction aid (temporary, removed before completion)');
            needItems([{ ...v, status: 'missing' }]);
          }
          break;
        }
        if (!onTopOf(bot, aid.at)) {
          reposition('stand_on_aid', 'the roof is placed standing on the construction aid');
          break;
        }
        const cells = missingOf(roof);
        placeDrafts(cells, 'roof');
        needItems(cells);
        if (drafts.length === 0 && cells.length === 0 && unknownOf(roof).length) reposition('step_off_aid', 'roof cells are not observable from here');
        break;
      }
      case 'remove_aid': {
        if (onTopOf(bot, aid.at) || inColumn(bot, aid.at)) {
          reposition('step_off_aid', 'the construction aid is removed from the floor beside it');
          break;
        }
        const id = aidIdentity(session, services, aid);
        if (!id.ok) {
          unavailable.push({ reason: 'aid_identity_unproven', detail: id.detail });
          break;
        }
        const d = eyeDistanceToBlock(bot, aid.at.x, aid.at.y, aid.at.z);
        if (d > BLOCK_REACH - 0.3 || visibleFaces(sessionWorld(session), eyeOf(bot), aid.at.x, aid.at.y, aid.at.z).length === 0) {
          reposition('inside', 'the construction aid is not visible within reach');
          break;
        }
        drafts.push({ parameters: { action: 'remove_aid', cell: project.cells.indexOf(aid) }, description: `remove the bot's own construction aid ${id.key} at ${at3(aid.at)} (server-confirmed own placement, unchanged)`, score: 30 });
        break;
      }
      case 'hole': {
        if (!inColumn(bot, aid.at)) {
          reposition('stand_under_hole', 'the last roof cell is placed from directly below');
          break;
        }
        const cells = missingOf(hole);
        placeDrafts(cells, 'close the roof');
        needItems(cells);
        break;
      }
      case 'furnish': {
        if (!insideFootprint(bot, project)) {
          reposition('inside', 'workstation, furnace and storage are placed inside');
          break;
        }
        const cells = missingOf(furnish);
        placeDrafts(cells, 'furnishing');
        needItems(cells);
        if (drafts.length === 0) reposition('inside', 'no furnishing cell is placeable from this spot');
        break;
      }
      case 'inspect':
        reposition(insideFootprint(bot, project) ? 'outside' : 'inside', `${verdict.unknown} blueprint cell(s) are not observable from here`);
        break;
      case 'done':
        unavailable.push({ reason: 'structure_complete', detail: verdict.detail });
        break;
    }
    return { drafts: drafts.slice(0, 6), unavailable, verdict };
  };

  const repositionGoal = (project: HomeProject, to: NonNullable<BuildP['to']>, bot: Bot, verdict?: ShelterVerdict): { goal: unknown; at: V3; arrived: () => boolean } | undefined => {
    const aid = aidCell(project) as BlueprintCell;
    const block = (p: V3, standOn = false) => ({ goal: new goals.GoalBlock(p.x, p.y + (standOn ? 1 : 0), p.z), at: p, arrived: () => Math.floor(bot.entity.position.x) === p.x && Math.floor(bot.entity.position.z) === p.z && Math.abs(bot.entity.position.y - (p.y + (standOn ? 1 : 0))) < 0.6 });
    switch (to) {
      case 'stand_on_aid':
        return block(aid.at, true);
      case 'stand_under_hole':
        return block(aid.at);
      case 'step_off_aid':
      case 'inside':
        return block(entranceInterior(project));
      case 'outside':
        return block(entranceOutside(project));
      case 'near_missing': {
        void verdict;
        const ctr = { x: project.origin.x + Math.floor(project.size.outerX / 2), y: project.origin.y, z: project.origin.z + Math.floor(project.size.outerZ / 2) };
        return { goal: new goals.GoalNear(ctr.x, ctr.y, ctr.z, project.size.outerX), at: ctr, arrived: () => Math.hypot(bot.entity.position.x - ctr.x, bot.entity.position.z - ctr.z) <= project.size.outerX };
      }
    }
  };

  const buildHome: SkillDefinition<BuildP> = {
    descriptor: {
      id: 'build_home',
      family: 'construction',
      purpose: 'Build or repair the approved home shelter one verified step at a time (walls, roof using one temporary construction aid, removing that aid, workstation/furnace/chest inside), only at blueprint positions.',
      parameters: [{ name: 'material', type: 'registry_key', description: 'preferred wall/roof material key or tag from the inventory (optional)', required: false }],
      targets: ['none'],
      preconditions: ['an approved home project in this world profile and dimension', 'accepted building blocks / crafting table / furnace / chest in the inventory for the current phase', 'blueprint positions empty or already correct (never demolishes)'],
      effects: ['one server-confirmed block placed at a blueprint position, the bot\'s own aid removed, or the bot repositioned inside the footprint'],
      supportedPredicates: ['structure_state', 'block_state'],
      timeoutMs: 30_000,
      cancellation: 'stop sends no further place/dig/move after revocation; an unremoved construction aid is reported as a partial effect',
      limitations: ['small_shelter_v1 only (walls 2 high, flat roof, open entrance)', 'an aid placed before a restart is not removed automatically (identity unproven)', 'never digs/towers during navigation'],
      evidence: ['server block_change at the blueprint position', 'durable project checkpoint'],
    },
    params: BuildParams,
    resolve(ctx) {
      const { session, services } = ctx;
      const project = home.project();
      if (!project) return { drafts: [], unavailable: [{ reason: 'no_home_project', detail: 'no approved home site in this world profile; use select_home_site first' }] };
      if (String(session.bot.game.dimension) !== project.dimension) return { drafts: [], unavailable: [{ reason: 'wrong_dimension', detail: `the home is in ${project.dimension}` }] };
      const centre = { x: project.origin.x + project.size.outerX / 2, y: project.origin.y, z: project.origin.z + project.size.outerZ / 2 };
      if (!services.perception.withinTravel(centre)) return { drafts: [], unavailable: [{ reason: 'outside_travel_bounds', detail: 'the home site is outside this goal\'s travel bounds; move near it first' }] };
      const material = (ctx.hints.parameters as Record<string, unknown>)['material'];
      const r = plan(session, services, project, typeof material === 'string' ? material : undefined);
      return { drafts: r.drafts, unavailable: r.unavailable };
    },
    async execute(ctx, params) {
      const { session, services, act } = ctx;
      const bot = session.bot;
      const project = home.project();
      if (!project) return precondition('no_home_project', 'no approved home project');
      if (String(bot.game.dimension) !== project.dimension) return precondition('wrong_dimension', `the home is in ${project.dimension}`);
      if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
      if (params.action === 'reposition' && params.to) {
        const target = repositionGoal(project, params.to, bot);
        if (!target) return precondition('no_reposition_target', 'no standing position for this step');
        const bounds = services.perception.travelBounds();
        const nav = await navigate(act, {
          goal: target.goal,
          arrived: target.arrived,
          distance: () => Math.hypot(bot.entity.position.x - (target.at.x + 0.5), bot.entity.position.z - (target.at.z + 0.5)),
          timeoutMs: 20_000,
          searchRadius: 24,
          ...(bounds ? { bounds } : {}),
          inBounds: () => services.perception.withinTravel(bot.entity.position),
        });
        if (nav.status !== 'arrived') return failed(nav.status === 'out_of_bounds' ? 'outside_travel_bounds' : 'no_path', `could not move ${params.to.replace(/_/g, ' ')} (${nav.status})`, { status: nav.status }, 'client_only');
        return { status: 'succeeded', effect: `moved ${params.to.replace(/_/g, ' ')} (${at3(target.at)})`, confirmation: 'client_only', evidence: { to: params.to, at: { ...target.at } } };
      }
      const cell = params.cell !== undefined ? project.cells[params.cell] : undefined;
      if (!cell) return precondition('unknown_cell', 'not a blueprint cell of the approved project');
      if (params.action === 'remove_aid') {
        if (cell.role !== 'aid') return precondition('not_the_aid', 'only the project\'s own construction aid may be removed');
        const id = aidIdentity(session, services, cell);
        if (!id.ok) return precondition('aid_identity_unproven', id.detail);
        if (inColumn(bot, cell.at)) return precondition('standing_on_aid', 'step off the aid first');
        const live = bot.blockAt(new Vec3(cell.at.x, cell.at.y, cell.at.z));
        if (!live || mk(live.name) !== id.key) return precondition('aid_changed', `the aid position holds ${live?.name ?? 'unloaded'}`);
        const faces = visibleFaces(sessionWorld(session), eyeOf(bot), cell.at.x, cell.at.y, cell.at.z);
        if (faces.length === 0 || eyeDistanceToBlock(bot, cell.at.x, cell.at.y, cell.at.z) > BLOCK_REACH) return precondition('not_visible', 'the aid is not visible within reach');
        const n = faceNormal(faces[0] as FaceName);
        await act.lookAt({ x: cell.at.x + 0.5 + n.x * 0.5, y: cell.at.y + 0.5 + n.y * 0.5, z: cell.at.z + 0.5 + n.z * 0.5 });
        const startSeq = session.evidence.seq;
        const dig = act.startDig(live);
        dig.catch(() => undefined);
        await Promise.race([dig, new Promise((resolve) => act.signal.addEventListener('abort', resolve, { once: true }))]);
        act.fence();
        const change = await act.waitServer('block_change', (e) => e.x === cell.at.x && e.y === cell.at.y && e.z === cell.at.z, startSeq, 2_500);
        if (!change) return failed('unconfirmed_break', 'no server block change for the aid', {}, 'client_only');
        const after = mk(stateName(bot, change.stateId));
        if (after === id.key) return failed('server_rejected_break', 'the server kept the aid', {}, 'server_packet');
        services.ledger.add({ kind: 'block_changed', x: cell.at.x, y: cell.at.y, z: cell.at.z, from: id.key, to: after, atMs: change.atMs, actionId: ctx.candidate.id });
        ctx.progress({ aidRemoved: id.key, at: { ...cell.at } }, 'server_packet');
        const durable = await home.checkpoint({ at: cell.at, to: 'minecraft:air', confirmedAtMs: change.atMs, capability: 'build_home' });
        return { status: 'succeeded', effect: `removed the bot's own construction aid ${id.key} at ${at3(cell.at)} (server block change -> ${after})${durable ? '' : '; project checkpoint NOT durable'}`, confirmation: 'server_packet', evidence: { removed: id.key, at: { ...cell.at }, became: after, durable } };
      }
      // place
      if (!params.item || !params.support || !params.face) return precondition('incomplete_candidate', 'placement needs item, support and face');
      const item = mk(params.item);
      if (!accepts(cell, item, inspector.inTag)) return precondition('item_not_accepted', `${item} is not accepted for this ${cell.role} cell`);
      const n = faceNormal(params.face);
      const dest = { x: params.support.x + n.x, y: params.support.y + n.y, z: params.support.z + n.z };
      if (dest.x !== cell.at.x || dest.y !== cell.at.y || dest.z !== cell.at.z) return precondition('not_a_blueprint_position', 'the placement would not land on the blueprint cell');
      const world = sessionWorld(session);
      const destBlock = world.blockAt(dest.x, dest.y, dest.z);
      if (!destBlock || !REPLACEABLE.test(destBlock.name)) return precondition('destination_occupied', `${at3(dest)} holds ${destBlock?.name ?? 'unloaded'}`);
      if (intersectsBot(bot.entity.position, dest)) return precondition('destination_occupied_by_bot', 'the bot stands in the destination');
      const occupant = occupyingEntity(bot as never, dest.x, dest.y, dest.z);
      if (occupant) return precondition('destination_occupied_by_entity', `a ${occupant} occupies the destination`);
      const support = world.blockAt(params.support.x, params.support.y, params.support.z);
      if (!support || support.shapes.length === 0 || REPLACEABLE.test(support.name) || INTERACTIVE_SUPPORT.test(support.name)) return precondition('support_changed', 'the support block is gone or unsuitable');
      if (eyeDistanceToBlock(bot, params.support.x, params.support.y, params.support.z) > BLOCK_REACH) return precondition('out_of_reach', 'the support is out of reach');
      if (!visibleFaces(world, eyeOf(bot), params.support.x, params.support.y, params.support.z).includes(params.face)) return precondition('face_not_visible', `the ${params.face} face of the support is not visible`);
      const held = await ensureInHand(act, services, item);
      if (!held.ok) return precondition('item_not_in_inventory', held.detail);
      const startSeq = session.evidence.seq;
      await act.useOnBlock(params.support, params.face);
      let change: { stateId: number; atMs: number } | undefined;
      const deadline = services.clock.now() + 2_500;
      while (services.clock.now() < deadline) {
        change = session.evidence.since(startSeq, 'block_change', (e) => e.x === dest.x && e.y === dest.y && e.z === dest.z)[0];
        if (change || session.evidence.since(startSeq, 'open_window').length > 0) break;
        await act.sleep(25);
      }
      const opened = session.evidence.since(startSeq, 'open_window')[0];
      if (opened) {
        if (bot.currentWindow) act.closeWindow(bot.currentWindow as never);
        return failed('opened_interface_instead', `using the support opened ${opened.windowType}; closed it`, {}, 'server_packet');
      }
      if (!change) return failed('placement_unconfirmed', `server sent no block change at ${at3(dest)}`, {}, 'none');
      const placed = mk(stateName(bot, change.stateId));
      if (REPLACEABLE.test(placed.replace('minecraft:', ''))) return failed('server_refused_placement', `server kept ${placed} at ${at3(dest)}`, {}, 'server_packet');
      services.ledger.add({ kind: 'block_changed', ...dest, from: mk(destBlock.name), to: placed, atMs: change.atMs, actionId: ctx.candidate.id });
      services.ledger.setResult(ctx.candidate.id, { dimension: String(bot.game.dimension), ...dest, key: placed });
      ctx.progress({ placed, at: dest, role: cell.role }, 'server_packet');
      const durable = await home.checkpoint({ at: dest, to: placed, confirmedAtMs: change.atMs, capability: 'build_home' });
      const evidence: Record<string, JsonValue> = { placed, at: dest, role: cell.role, phase: cell.phase, accepted: accepts(cell, placed, inspector.inTag), durable, priorResult: ctx.candidate.id };
      return { status: 'succeeded', effect: `placed ${placed} at ${at3(dest)} (${cell.role}, server block change)${durable ? '' : '; project checkpoint NOT durable'}`, confirmation: 'server_packet', evidence };
    },
  };

  return [selectHomeSite, buildHome] as SkillDefinition[];
}

void clip;
