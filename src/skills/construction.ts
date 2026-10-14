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
import type { InventoryView } from '../execution/ledger.ts';
import type { JsonValue, PredicateEvaluation } from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import { BLOCK_REACH, eyeOf, sessionWorld } from '../perception/perception.ts';
import { faceNormal, isFullCube, visibleFaces, type FaceName } from '../perception/visibility.ts';
import { aidCell, accepts, canonicalProject, materialRequirements, checkSite, interiorCells, entranceInterior, entranceOutside, findSites, judgeCells, verifyShelter, type CellVerdict, type Facing, type ShelterVerdict, type SiteProbe, type V3, type VoxelTruth } from '../autonomy/blueprint.ts';
import type { HomeProjectService } from '../autonomy/home.ts';
import { confirmInventory, clientCounts, ensureInHand, eyeDistanceToBlock, mk } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type SkillServices, type Unavailable } from './definition.ts';
import { goals, navigate } from './navigation.ts';
import { occupyingEntity } from './placement.ts';

type Bot = GameSession['bot'];

const NATURAL_GROUND = /^minecraft:(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|stone|deepslate|granite|diorite|andesite|tuff|sand|red_sand|gravel|snow_block|clay|terracotta|moss_block|mud|calcite|sandstone|red_sandstone|dirt_path)$/;
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|short_dry_grass|tall_dry_grass|leaf_litter)$/;
const INTERACTIVE_SUPPORT = /(chest|barrel|crafting_table|furnace|smoker|_door|_trapdoor|_bed|_button|lever|_fence_gate|anvil|table|loom|stonecutter|grindstone|bell|lectern|composter|hopper)$/;

const at3 = (p: V3) => `${p.x},${p.y},${p.z}`;
const projectWithinTravel = (project: HomeProject, services: SkillServices): boolean => {
  const p = project.origin;
  const x = p.x + project.size.outerX - 1;
  const z = p.z + project.size.outerZ - 1;
  return [p, { ...p, x }, { ...p, z }, { ...p, x, z }, entranceOutside(project)].every((at) => services.perception.withinTravel(at));
};
/** The authoritative world view (perception's sessionWorld; prediction-marked voxels are unconfirmed). */
const worldOf = (session: GameSession, services: SkillServices) => services.perception.world() ?? sessionWorld(session);
/** Plain JSON copy of a position (candidate parameters/evidence). */
const sameParameters = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => Object.keys(a).length === Object.keys(b).filter((k) => b[k] !== undefined).length && Object.keys(a).every((k) => typeof a[k] === 'object' && a[k] !== null ? sameParameters(a[k] as Record<string, unknown>, b[k] as Record<string, unknown> ?? {}) : a[k] === b[k]);
const pj = (p: V3): { x: number; y: number; z: number } => ({ x: p.x, y: p.y, z: p.z });

function stateName(bot: Bot, stateId: number): string {
  return (bot.registry as unknown as { blocksByStateId: Record<number, { name: string } | undefined> }).blocksByStateId[stateId]?.name ?? `state_${stateId}`;
}

// ---------------------------------------------------------------- inspector (shared with the structure_state predicate)

interface Seen {
  key: string;
  seq: number;
  connectionEpoch: number;
  generation: unknown;
  dimension: string;
}

/**
 * Fresh shelter inspection from server evidence (MB-FLOW-001-C3). Order:
 * (0) a pending client prediction or an unloaded chunk is UNKNOWN before any
 * server fact or cached observation is consulted; (1) the latest server
 * statement for a voxel this connection's skills changed or that is in line of
 * sight now (it must agree with the loaded chunk data); (2) loaded chunk data
 * in line of sight now; (3) an earlier line-of-sight observation on THIS
 * connection, lifecycle generation and dimension, still loaded, unchanged in
 * the current chunk data and not superseded by a later server statement —
 * labeled `seen_this_connection`. Anything else is unknown (never assumed).
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

  private generation(): unknown {
    return this.services.ledger.invalidations.at(-1);
  }

  truth(p: V3): VoxelTruth {
    const s = this.session();
    if (!s) return { evidence: 'unknown', detail: 'not connected' };
    const bot = s.bot;
    const k = at3(p);
    const dimension = String(bot.game.dimension);
    const ev = s.evidence as Partial<Pick<GameSession['evidence'], 'serverBlock' | 'predictionPending'>> & { seq: number };
    // (0) Opaque first: a pending prediction is not a fact, and an unloaded chunk certifies nothing.
    const pending = typeof ev.predictionPending === 'function' ? ev.predictionPending(p.x, p.y, p.z) : true;
    if (pending) {
      this.cache.delete(k);
      return { evidence: 'unknown', detail: 'pending client prediction (opaque until the server states it)' };
    }
    const loaded = worldOf(s, this.services).blockAt(p.x, p.y, p.z);
    if (!loaded || loaded.name === 'unconfirmed_prediction') {
      this.cache.delete(k);
      return { evidence: 'unknown', detail: 'chunk not loaded or voxel unconfirmed' };
    }
    const current = mk(loaded.name);
    const fact = typeof ev.serverBlock === 'function' ? ev.serverBlock(p.x, p.y, p.z) : undefined;
    const own = this.services.ledger.ownBlockChange(p.x, p.y, p.z, 0);
    const visible = this.services.perception.blockVisibleNow(p.x, p.y, p.z);
    const remember = (key: string, seq: number) => {
      if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(k, { key, seq, connectionEpoch: s.connectionEpoch, generation: this.generation(), dimension });
    };
    if (fact && (visible || own)) {
      const key = mk(stateName(bot, fact.stateId));
      if (key !== current) return { evidence: 'unknown', detail: `server statement (${key}) disagrees with the loaded chunk data (${current})` };
      remember(key, fact.seq);
      return { key, evidence: own && !visible ? 'server_own_change' : 'visible' };
    }
    if (visible) {
      remember(current, ev.seq);
      return { key: current, evidence: 'visible' };
    }
    const seen = this.cache.get(k);
    if (seen && seen.connectionEpoch === s.connectionEpoch && seen.generation === this.generation() && seen.dimension === dimension && !(fact && fact.seq > seen.seq) && seen.key === current) {
      return { key: seen.key, evidence: 'seen_this_connection', detail: 'observed earlier on this connection; still loaded, unchanged and not superseded by a server statement' };
    }
    if (seen) this.cache.delete(k);
    return { evidence: 'unknown', detail: 'not in line of sight now and not observed unchanged on this connection' };
  }

  inspect(project: HomeProject): { verdicts: CellVerdict[]; verdict: ShelterVerdict } {
    if (!canonicalProject(project)) {
      return { verdicts: [], verdict: { status: 'unknown', enclosed: 'unknown', satisfied: 0, total: project.cells.length, missing: 0, foreign: [], unknown: project.cells.length || 1, nextPhase: null, detail: 'stored project checklist differs from the canonical small_shelter_v1 blueprint; no construction or completion is admitted' } };
    }
    const verdicts = judgeCells(project.cells, (p) => this.truth(p), this.inTag);
    // Correct-looking blocks cannot become the bot's construction merely by
    // occupying an approved position. Checkpoints are historical ownership;
    // truth() above still independently proves their present state.
    for (const v of verdicts) {
      if (v.status !== 'satisfied' || v.cell.role === 'entrance' || v.cell.role === 'aid') continue;
      if (!project.checkpoints.some((c) => at3(c.at) === at3(v.cell.at) && c.to === v.key && c.capability === 'build_home')) v.status = 'foreign';
    }
    const verdict = verifyShelter(project.cells, verdicts);
    const access = this.access(project);
    if (access.status !== 'satisfied') {
      verdict.status = access.status === 'unsatisfied' ? 'incomplete' : verdict.status === 'complete' ? 'unknown' : verdict.status;
      verdict.enclosed = access.status === 'unsatisfied' ? 'unsatisfied' : verdict.enclosed === 'satisfied' ? 'unknown' : verdict.enclosed;
      verdict.unknown += access.status === 'unknown' ? 1 : 0;
      verdict.detail = `${verdict.satisfied}/${verdict.total} blueprint cells verified; usable entrance/interior: ${access.detail}; shelter completion is not verified`;
    }
    return { verdicts, verdict };
  }

  /** Walkable entry and a grounded route to each workstation/storage block. */
  private access(project: HomeProject): { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string } {
    const s = this.session();
    if (!s) return { status: 'unknown', detail: 'not connected' };
    const world = worldOf(s, this.services);
    const path = [...interiorCells(project), entranceOutside(project), ...project.cells.filter((c) => c.role === 'entrance' && c.at.y === project.origin.y).map((c) => c.at)];
    const furnishings = project.cells.filter((c) => c.role === 'workstation' || c.role === 'storage');
    const walkable = new Set<string>();
    let unknown = false;
    for (const p of path) {
      if (furnishings.some((c) => at3(c.at) === at3(p))) continue;
      const feet = this.truth(p);
      const head = this.truth({ ...p, y: p.y + 1 });
      const ground = this.truth({ ...p, y: p.y - 1 });
      if (!feet.key || !head.key || !ground.key) { unknown = true; continue; }
      const g = world.blockAt(p.x, p.y - 1, p.z);
      if (REPLACEABLE.test(feet.key.replace('minecraft:', '')) && REPLACEABLE.test(head.key.replace('minecraft:', '')) && g && isFullCube(g) && !/lava|fire|magma|cactus|powder_snow/.test(g.name)) walkable.add(at3(p));
    }
    const start = entranceOutside(project);
    const seen = new Set<string>();
    const queue = [start];
    for (const p of queue) {
      if (!walkable.has(at3(p)) || seen.has(at3(p))) continue;
      seen.add(at3(p));
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const next = { x: p.x + dx!, y: p.y, z: p.z + dz! };
        if (walkable.has(at3(next)) && !seen.has(at3(next))) queue.push(next);
      }
    }
    const accessible = seen.has(at3(entranceInterior(project))) && furnishings.every((c) => path.some((p) => {
      if (!seen.has(at3(p))) return false;
      const eye = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 };
      return Math.hypot(c.at.x + 0.5 - eye.x, c.at.y + 0.5 - eye.y, c.at.z + 0.5 - eye.z) <= BLOCK_REACH - 0.3 && visibleFaces(world, eye, c.at.x, c.at.y, c.at.z).length > 0;
    }));
    return accessible ? { status: 'satisfied', detail: 'grounded entry and access to crafting table, furnace and chest' } : unknown ? { status: 'unknown', detail: 'entry or floor route is not observable now' } : { status: 'unsatisfied', detail: 'entry or workstation/storage route is blocked or unsupported (no demolition)' };
  }

  /** Clears cached observations (lifecycle). */
  reset(): void {
    this.cache.clear();
  }
}

/** Code evaluation of `structure_state` (structure: home). */
export function evaluateStructure(home: HomeProjectService, inspector: ShelterInspector, session: () => GameSession | undefined, expect: 'site_approved' | 'enclosed' | 'complete', projectId?: string, site?: { dimension: string; at: V3; maxDistance: number }): PredicateEvaluation {
  const project = home.project();
  const out = (status: PredicateEvaluation['status'], detail: string, evidence: PredicateEvaluation['evidence'] = {}): PredicateEvaluation => ({ status, predicate: 'structure_state', detail, evidence });
  if (!project) return out(home.writable() ? 'unsatisfied' : 'unknown', home.writable() ? 'no home project is approved in this world profile' : 'home projects need a writable durable scope');
  if (!home.writable()) return out('unknown', 'the durable home scope is not writable; site approval and saved shelter verification cannot be certified');
  if (projectId && projectId !== project.id) return out('unsatisfied', `bound project ${projectId} is no longer the active home project`);
  if (site && (project.dimension !== site.dimension || Math.hypot(project.origin.x + project.size.outerX / 2 - site.at.x, project.origin.z + project.size.outerZ / 2 - site.at.z) > site.maxDistance)) return out('unsatisfied', 'the active project does not match the originally grounded home site');
  if (!canonicalProject(project)) return out('unknown', 'stored home blueprint is invalid');
  if (expect === 'site_approved') return out('satisfied', `home project ${project.id} approved at ${at3(project.origin)} (${project.dimension}), state ${project.state}`, { projectId: project.id, state: project.state });
  const s = session();
  if (!s) return out('unknown', 'not connected');
  if (String(s.bot.game.dimension) !== project.dimension) return out('unknown', `the home is in ${project.dimension}, the bot is in ${String(s.bot.game.dimension)}`);
  const { verdict } = inspector.inspect(project);
  const ev = { projectId: project.id, satisfied: verdict.satisfied, total: verdict.total, missing: verdict.missing, unknown: verdict.unknown, foreign: verdict.foreign.length };
  void home.verified(verdict, project.id).catch(() => undefined);
  if (expect === 'enclosed') return out(verdict.enclosed === 'satisfied' ? 'satisfied' : verdict.enclosed === 'unknown' ? 'unknown' : 'unsatisfied', `enclosure ${verdict.enclosed}: ${verdict.detail}`, ev);
  return out(verdict.status === 'complete' ? 'satisfied' : verdict.status === 'unknown' ? 'unknown' : 'unsatisfied', verdict.detail, ev);
}

// ---------------------------------------------------------------- site probe

function siteProbe(session: GameSession, services: SkillServices): SiteProbe {
  const world = worldOf(session, services);
  return {
    blockAt: (p) => {
      const b = world.blockAt(p.x, p.y, p.z);
      return b && b.name !== 'unconfirmed_prediction' ? mk(b.name) : undefined;
    },
    visible: (p) => services.perception.blockVisibleNow(p.x, p.y, p.z),
    naturalGround: (k) => NATURAL_GROUND.test(k) && !/:(sand|red_sand|gravel|dirt_path|mud)$/.test(k),
  };
}

const FACINGS = ['north', 'south', 'east', 'west'] as const;

const SiteParams = z
  .object({
    interior: z.union([z.literal(2), z.literal(3)]).optional(),
    /** MB-PLAN-006 "here": search around the FRESH visible owner (default: the bot's own position). */
    near: z.enum(['self', 'owner']).optional(),
    origin: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
    facing: z.enum(FACINGS).optional(),
    anchor: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict().optional(),
    dimension: z.string().optional(),
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
  // TaskOutcomeSummary deliberately omits raw action evidence. A completed
  // read therefore returns its bounded receipt through the NEXT resolver's
  // unavailable evidence (the established TaskFeedback -> planner seam),
  // rather than issuing repeated inspection choices or inventing completion.
  let inspectionReceipt: { projectId: string; connectionEpoch: number; generation: unknown; material: string | undefined; atMs: number } | undefined;

  const selectHomeSite: SkillDefinition<z.infer<typeof SiteParams>> = {
    descriptor: {
      id: 'select_home_site',
      family: 'construction',
      purpose: 'Approve one small vacant site near the bot for the home shelter (flat natural ground in sight, empty volume, no nearby structures); recorded durably for this world profile. A site is not a home.',
      parameters: [
        { name: 'interior', type: 'integer', description: 'interior side length (2 or 3; default from config)', required: false, minimum: 2, maximum: 3 },
        { name: 'near', type: 'string', enum: ['self', 'owner'], description: 'search around the bot (self, default) or the currently VISIBLE owner (owner: "here"); never a hidden position', required: false },
      ],
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
      const near = (ctx.hints.parameters as Record<string, unknown>)['near'] === 'owner' || ctx.hints.wantsOwner ? 'owner' : 'self';
      // "Here" = the FRESH visible owner position in this snapshot (never a remembered or hidden one).
      if (!ctx.hints.destinations.length && near === 'owner' && (!snapshot.owner.visible || !snapshot.owner.at)) return { drafts: [], unavailable: [{ reason: 'owner_not_visible', detail: 'the owner is not visible now, so "here" cannot be grounded; no hidden position is used' }] };
      const center = ctx.hints.destinations[0]?.at ?? (near === 'owner' ? snapshot.owner.at! : snapshot.self.at);
      const supplied = ctx.hints.destinations[0];
      if (supplied && supplied.dimension !== snapshot.dimension) return { drafts: [], unavailable: [{ reason: 'wrong_dimension', detail: 'the supplied home site is in a different dimension' }] };
      const probe = siteProbe(session, services);
      const sites = findSites(probe, center, want, options.maxSiteDistance, (p) => services.perception.withinTravel(p), 8).filter((site) => {
        const b = snapshot.self.at;
        const n = site.interior + 2;
        return !(b.x >= site.origin.x && b.x < site.origin.x + n && b.z >= site.origin.z && b.z < site.origin.z + n);
      }).slice(0, 4);
      if (sites.length === 0) return { drafts: [], unavailable: [{ reason: 'no_vacant_site', detail: `no flat, visible, vacant ${want + 2}x${want + 2} footprint within ${options.maxSiteDistance} blocks of ${near === 'owner' ? 'the visible owner' : 'the bot'}; move to open flat ground and look again (survey_surroundings)` }] };
      return {
        drafts: sites.map((s, i) => ({
          parameters: { interior: s.interior, near, anchor: pj(center), dimension: snapshot.dimension, origin: pj(s.origin), facing: s.facing },
          description: `approve a ${s.interior + 2}x${s.interior + 2} home site at ${at3(s.origin)}, entrance facing ${s.facing}, ${s.distance} blocks from ${near === 'owner' ? 'the visible owner' : 'the bot'}`,
          criteria: s.checks,
          score: 10 - i,
        })),
      };
    },
    async execute(ctx, params) {
      const { session, services } = ctx;
      if (!params.origin || !params.facing || !params.interior) return precondition('site_not_specified', 'a site candidate must come from the resolver');
      ctx.act.fence();
      if (params.dimension !== String(session.bot.game.dimension)) return precondition('wrong_dimension', 'the candidate site belongs to another dimension');
      if (!params.anchor) return precondition('site_anchor_missing', 'site selection needs its grounded resolver anchor');
      const siteDistance = Math.hypot(params.origin.x + (params.interior + 2) / 2 - params.anchor.x, params.origin.z + (params.interior + 2) / 2 - params.anchor.z);
      if (siteDistance > options.maxSiteDistance) return precondition('site_too_far', 'the site exceeds the grounded local neighborhood');
      const probe = siteProbe(session, services);
      // Fresh re-check at execution (no stale approval).
      const check = checkSite(probe, params.origin, params.interior, params.facing as Facing);
      if (!check.ok) return precondition('site_no_longer_vacant', check.reason);
      const centre = { x: params.origin.x + (params.interior + 2) / 2, y: params.origin.y, z: params.origin.z + (params.interior + 2) / 2 };
      if (!services.perception.withinTravel(centre)) return precondition('outside_travel_bounds', 'the site is outside the travel bounds');
      const r = await home.approve({ origin: params.origin, interior: params.interior, facing: params.facing as Facing, dimension: String(session.bot.game.dimension), checks: check.checks, ...(ctx.owner.kind === 'goal' ? { goalId: ctx.owner.goalId } : {}) }, () => !ctx.act.signal.aborted);
      ctx.act.fence();
      if (!r.ok) return failed(r.reason, r.detail);
      return { status: 'succeeded', effect: `approved home site ${r.project.id} at ${at3(r.project.origin)} (entrance ${r.project.entranceFacing}); stored durably — nothing is built yet`, confirmation: 'none', evidence: { projectId: r.project.id, origin: r.project.origin, facing: r.project.entranceFacing, checks: check.checks } };
    },
  };

  const BuildParams = z
    .object({
      projectId: z.string().optional(),
      action: z.enum(['place', 'remove_aid', 'reposition']).optional(),
      cell: z.number().int().min(0).max(255).optional(),
      item: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(),
      support: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
      face: z.enum(['up', 'down', 'north', 'south', 'west', 'east']).optional(),
      to: z.enum(['stand_on_aid', 'step_off_aid', 'stand_under_hole', 'inside', 'outside', 'near_cell', 'inspect_cell']).optional(),
      /** near_cell: a code-chosen, observed safe standing block within reach of the specific missing `cell`. */
      stand: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
      /** Planner-admitted only: preferred building material (key or tag). */
      material: z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(),
    })
    .strict();
  type BuildP = z.infer<typeof BuildParams>;

  /** Inventory items (concrete keys) accepted by a cell, preferring a material hint. */
  const itemsFor = (cell: BlueprintCell, bot: Bot, material?: string): string[] => {
    const counts = clientCounts(bot);
    const keys = [...counts.keys()].filter((k) => (counts.get(k) ?? 0) > 0 && accepts(cell, k, inspector.inTag));
    if (!material || !['wall', 'roof', 'aid'].includes(cell.role)) return keys;
    // An admitted (requested) material is binding: never substitute another one.
    return keys.filter((k) => (material.startsWith('#') ? inspector.inTag(material, k) : material === k));
  };

  /**
   * C4: an observed, safe standing block (feet and head air/replaceable,
   * solid natural or placed ground below, not a blueprint position, not the
   * bot's current block) whose eye position is within reach of `cell`, inside
   * travel bounds. Never digging, towering or standing on the cell itself.
   */
  const standPointFor = (session: GameSession, services: SkillServices, project: HomeProject, cell: BlueprintCell, needsSupport = true): V3 | undefined => {
    const bot = session.bot;
    const world = worldOf(session, services);
    const blueprint = new Set(project.cells.filter((c) => c.role !== 'aid').map((c) => at3(c.at)));
    const here = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };
    const out: Array<{ p: V3; d: number }> = [];
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        for (const dy of [0, -1, 1]) {
          const p = { x: cell.at.x + dx, y: project.origin.y + dy, z: cell.at.z + dz };
          if (p.x === here.x && p.y === here.y && p.z === here.z) continue;
          if (blueprint.has(at3(p)) || blueprint.has(at3({ ...p, y: p.y + 1 }))) continue;
          const feet = world.blockAt(p.x, p.y, p.z);
          const head = world.blockAt(p.x, p.y + 1, p.z);
          const ground = world.blockAt(p.x, p.y - 1, p.z);
          if (!feet || !head || !ground || !REPLACEABLE.test(feet.name) || !REPLACEABLE.test(head.name) || !isFullCube(ground) || REPLACEABLE.test(ground.name) || /lava|fire|magma|cactus|powder_snow/.test(ground.name)) continue;
          const eye = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 };
          const reach = Math.hypot(cell.at.x + 0.5 - eye.x, cell.at.y + 0.5 - eye.y, cell.at.z + 0.5 - eye.z);
          if (reach > BLOCK_REACH - 0.8) continue;
          if (!services.perception.withinTravel(p) || inspector.truth({ ...p, y: p.y - 1 }).evidence === 'unknown') continue;
          const supported = (['up', 'down', 'north', 'south', 'west', 'east'] as FaceName[]).some((face) => {
            const n = faceNormal(face);
            const support = { x: cell.at.x - n.x, y: cell.at.y - n.y, z: cell.at.z - n.z };
            const b = world.blockAt(support.x, support.y, support.z);
            return Boolean(b && isFullCube(b) && !REPLACEABLE.test(b.name) && !INTERACTIVE_SUPPORT.test(b.name) && Math.hypot(support.x + 0.5 - eye.x, support.y + 0.5 - eye.y, support.z + 0.5 - eye.z) <= BLOCK_REACH - 0.3 && visibleFaces(world, eye, support.x, support.y, support.z).includes(face));
          });
          if (needsSupport ? !supported : visibleFaces(world, eye, cell.at.x, cell.at.y, cell.at.z).length === 0) continue;
          out.push({ p, d: Math.hypot(p.x + 0.5 - bot.entity.position.x, p.z + 0.5 - bot.entity.position.z) });
        }
      }
    }
    return out.sort((a, b) => a.d - b.d)[0]?.p;
  };

  /** Support blocks with a visible face whose placement lands exactly on `dest`. */
  const supportsFor = (bot: Bot, session: GameSession, services: SkillServices, dest: V3): Array<{ support: V3; face: FaceName; distance: number }> => {
    const world = worldOf(session, services);
    const eye = eyeOf(bot);
    const out: Array<{ support: V3; face: FaceName; distance: number }> = [];
    for (const face of ['up', 'down', 'north', 'south', 'west', 'east'] as FaceName[]) {
      const n = faceNormal(face);
      const s = { x: dest.x - n.x, y: dest.y - n.y, z: dest.z - n.z };
      const b = world.blockAt(s.x, s.y, s.z);
      if (!b || !isFullCube(b) || REPLACEABLE.test(b.name) || b.name === 'unconfirmed_prediction' || INTERACTIVE_SUPPORT.test(b.name)) continue;
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
    if (!canonicalProject(project)) return { drafts: [], unavailable: [{ reason: 'invalid_home_blueprint', detail: verdict.detail }], verdict };
    const drafts: CandidateDraft[] = [];
    const unavailable: Unavailable[] = [];
    if (verdict.foreign.length > 0) {
      unavailable.push({ reason: 'foreign_block_in_blueprint', detail: `blueprint positions hold blocks the project did not place (${verdict.foreign.slice(0, 3).map((f) => `${f.key} at ${at3(f.at)}`).join('; ')}); the project cannot safely continue through these blocks`, evidence: { foreign: verdict.foreign.length } });
      return { drafts, unavailable, verdict };
    }
    const status = (role: BlueprintCell['role'], phase?: number) => verdicts.filter((v) => v.cell.role === role && (phase === undefined || v.cell.phase === phase));
    const missingOf = (vs: CellVerdict[]) => vs.filter((v) => v.status === 'missing');
    const unknownOf = (vs: CellVerdict[]) => vs.filter((v) => v.status === 'unknown');
    const aid = aidCell(project) as BlueprintCell;
    const aidTruth = inspector.truth(aid.at);
    const roofNeedsWork = verdicts.some((v) => v.cell.role === 'roof' && v.status === 'missing');
    const sharedTable = project.cells.some((c) => c.role === 'workstation' && c.accept[0] === 'minecraft:crafting_table' && at3(c.at) === at3(aid.at));
    // The 2x2 checklist already reuses the SAME approved aid position for its
    // table. Use that own full cube as the one temporary aid; remove it with
    // the ordinary proven-identity rule before the final roof cell, then
    // furnish again. No second aid, new coordinate or navigation privilege.
    const aidPresent = Boolean(aidTruth.key && (accepts(aid, aidTruth.key, inspector.inTag) || sharedTable && roofNeedsWork && aidTruth.key === 'minecraft:crafting_table'));
    const sharedAidRemoved = sharedTable && project.checkpoints.some((c) => at3(c.at) === at3(aid.at) && /^minecraft:(air|cave_air|void_air)$/.test(c.to));
    const placeDrafts = (cells: CellVerdict[], label: string) => {
      for (const v of cells) {
        const dest = v.cell.at;
        if (intersectsBot(bot.entity.position, dest)) continue;
        if (occupyingEntity(bot as never, dest.x, dest.y, dest.z)) continue;
        const items = itemsFor(v.cell, bot, material);
        if (items.length === 0) continue;
        const sup = supportsFor(bot, session, services, dest)[0];
        if (!sup) continue;
        drafts.push({
          parameters: { projectId: project.id, action: 'place', cell: v.index, item: items[0] as string, support: pj(sup.support), face: sup.face, ...(material ? { material } : {}) },
          description: `${label}: place ${items[0]} at ${at3(dest)} (on the ${sup.face} face of ${at3(sup.support)})`,
          score: 20 - sup.distance,
        });
      }
    };
    const needItems = (cells: CellVerdict[]) => {
      const missingItems = cells.filter((v) => itemsFor(v.cell, bot, material).length === 0);
      if (missingItems.length > 0) {
        const accept = [...new Set(missingItems.flatMap((v) => v.cell.accept))];
        if (material && missingItems.some((v) => ['wall', 'roof', 'aid'].includes(v.cell.role))) unavailable.push({ reason: 'requested_material_missing', detail: `the requested material ${material} is not in the inventory (or not accepted) for ${missingItems.length} ${missingItems[0]?.cell.role} cell(s); no other material is substituted`, evidence: { material, cells: missingItems.length } });
        else unavailable.push({ reason: 'missing_building_material', detail: `${missingItems.length} ${missingItems[0]?.cell.role} cell(s) need one of ${accept.join(', ')} in the inventory`, evidence: { cells: missingItems.length, accept } });
      }
    };
    const mat = { projectId: project.id, ...(material ? { material } : {}) };
    const reposition = (to: NonNullable<BuildP['to']>, why: string) => {
      const target = repositionGoal(project, to, bot);
      if (target?.arrived()) { unavailable.push({ reason: 'no_inspection_progress', detail: `${why}; the bot already stands at the relevant viewpoint` }); return; }
      drafts.push({ parameters: { action: 'reposition', to, ...mat }, description: `move ${to.replace(/_/g, ' ')} (${why})`, score: 1 });
    };
    const repositionNear = (cells: CellVerdict[], why: string): boolean => {
      for (const v of cells.slice(0, 4)) {
        if (itemsFor(v.cell, bot, material).length === 0) continue;
        const stand = standPointFor(session, services, project, v.cell);
        if (!stand) continue;
        drafts.push({ parameters: { action: 'reposition', to: 'near_cell', cell: v.index, stand: pj(stand), ...mat }, description: `move to ${at3(stand)} to reach the missing ${v.cell.role} at ${at3(v.cell.at)} (${why})`, score: 2 });
        return true;
      }
      return false;
    };

    const w1 = status('wall', 1);
    const w2 = status('wall', 2);
    const roof = status('roof', 4);
    const hole = status('roof', 6);
    const furnish = verdicts.filter((v) => (v.cell.role === 'workstation' || v.cell.role === 'storage') && v.cell.phase === 7);
    const table = verdicts.filter((v) => v.cell.accept.length === 1 && v.cell.accept[0] === 'minecraft:crafting_table');
    const stage = missingOf(table).length && !(sharedAidRemoved && missingOf(w1).length === 0 && missingOf(w2).length === 0 && missingOf(roof).length === 0)
      ? 'bootstrap'
      : missingOf(w1).length
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
      case 'bootstrap': {
        const cells = missingOf(table);
        placeDrafts(cells, 'crafting table (unlock furnishing and tool recipes before enclosing the site)');
        needItems(cells);
        if (drafts.length === 0) repositionNear(cells, 'reach the approved crafting-table cell');
        break;
      }
      case 'wall1':
      case 'wall2': {
        const cells = missingOf(stage === 'wall1' ? w1 : w2);
        placeDrafts(cells, stage === 'wall1' ? 'wall layer 1' : 'wall layer 2');
        needItems(cells);
        const placeable = cells.some((v) => itemsFor(v.cell, bot, material).length > 0);
        if (drafts.length === 0 && placeable && !repositionNear(cells, 'no missing wall cell has a visible support within reach here')) reposition(insideFootprint(bot, project) ? 'outside' : 'inside', 'no safe stand point next to a missing wall cell was observed; look from the other side');
        break;
      }
      case 'roof': {
        const cells = missingOf(roof);
        placeDrafts(cells, 'roof (grounded visible support)');
        needItems(cells);
        if (drafts.length > 0) break;
        if (repositionNear(cells, 'reach a grounded visible roof support')) break;
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
        const identity = aidIdentity(session, services, aid);
        if (!identity.ok) { unavailable.push({ reason: 'aid_identity_unproven', detail: identity.detail }); break; }
        if (!onTopOf(bot, aid.at)) {
          reposition('stand_on_aid', 'the roof is placed standing on the construction aid');
          break;
        }
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
        if (d > BLOCK_REACH - 0.3 || visibleFaces(worldOf(session, services), eyeOf(bot), aid.at.x, aid.at.y, aid.at.z).length === 0) {
          reposition('inside', 'the construction aid is not visible within reach');
          break;
        }
        drafts.push({ parameters: { ...mat, action: 'remove_aid', cell: project.cells.indexOf(aid) }, description: `remove the bot's own construction aid ${id.key} at ${at3(aid.at)} (server-confirmed own placement, unchanged)`, score: 30 });
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
        if (drafts.length === 0) repositionNear(cells, 'no furnishing cell is placeable from this spot');
        break;
      }
      case 'inspect': {
        for (const v of unknownOf(verdicts)) {
          const stand = standPointFor(session, services, project, v.cell, false);
          if (!stand) continue;
          drafts.push({ parameters: { action: 'reposition', to: 'inspect_cell', cell: v.index, stand: pj(stand), ...mat }, description: `move to ${at3(stand)} to freshly inspect ${v.cell.role} at ${at3(v.cell.at)}`, score: 3 });
          break;
        }
        if (!drafts.length) reposition(insideFootprint(bot, project) ? 'outside' : 'inside', `${verdict.unknown} project cell(s) or entrance/floor readings are not observable from here`);
        break;
      }
      case 'done':
        unavailable.push({ reason: verdict.status === 'complete' ? 'structure_complete' : 'shelter_access_blocked', detail: verdict.detail });
        break;
    }
    if (unavailable.some((u) => u.reason === 'missing_building_material' || u.reason === 'requested_material_missing')) unavailable.push({ reason: 'home_prerequisites', detail: 'inspect_home reports fresh total deficits and version-correct recipes; gather/craft them through the generic catalog while retaining structure_state complete as the goal outcome', evidence: { projectId: project.id, requirements: JSON.parse(JSON.stringify(materialRequirements(verdicts, clientCounts(bot), inspector.inTag, material))) } });
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
      case 'near_cell':
      case 'inspect_cell':
        void verdict;
        return undefined; // resolved by the executor from the validated stand point
    }
  };

  const buildHome: SkillDefinition<BuildP> = {
    descriptor: {
      id: 'build_home',
      family: 'construction',
      purpose: 'Build the approved home: place its crafting table early to unlock tools/furnishing recipes, then walls/roof and furnishings. One own temporary aid at the approved cell is removed before finishing (2x2 temporarily reuses its table); use inspect_home plus generic gathering/crafting for missing supplies.',
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
      if (!home.writable()) return { drafts: [], unavailable: [{ reason: 'scope_not_writable', detail: 'construction is blocked until the scoped project store is writable' }] };
      if (!project) return { drafts: [], unavailable: [{ reason: 'no_home_project', detail: 'no approved home site in this world profile; use select_home_site first' }] };
      if (String(session.bot.game.dimension) !== project.dimension) return { drafts: [], unavailable: [{ reason: 'wrong_dimension', detail: `the home is in ${project.dimension}` }] };
      const centre = { x: project.origin.x + project.size.outerX / 2, y: project.origin.y, z: project.origin.z + project.size.outerZ / 2 };
      if (!services.perception.withinTravel(centre) || !projectWithinTravel(project, services)) return { drafts: [], unavailable: [{ reason: 'outside_travel_bounds', detail: 'the home site is outside this goal\'s travel bounds; move near it first' }] };
      const material = (ctx.hints.parameters as Record<string, unknown>)['material'];
      const r = plan(session, services, project, typeof material === 'string' ? material : undefined);
      return { drafts: r.drafts, unavailable: r.unavailable };
    },
    async execute(ctx, params) {
      const { session, services, act } = ctx;
      let commandSent = false;
      let commandConfirmed = false;
      let ownedProjectId: string | undefined;
      try {
        const bot = session.bot;
        const project = home.project();
        if (!project) return precondition('no_home_project', 'no approved home project');
        if (!home.writable()) return precondition('scope_not_writable', 'construction requires a writable durable project scope');
        ownedProjectId = project.id;
        if (params.projectId !== project.id || !canonicalProject(project)) return precondition('project_changed', 'the candidate belongs to a different or invalid project');
        act.fence();
        if (String(bot.game.dimension) !== project.dimension) return precondition('wrong_dimension', `the home is in ${project.dimension}`);
        if (!projectWithinTravel(project, services)) return precondition('outside_travel_bounds', 'the project is outside this goal travel anchor');
        if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
        const fresh = plan(session, services, project, params.material);
        if (!fresh.drafts.some((d) => sameParameters(d.parameters, params))) return precondition('construction_step_changed', fresh.unavailable[0]?.detail ?? 'this exact construction step is no longer available in the current phase');
        if (params.action === 'reposition' && params.to) {
          let target = repositionGoal(project, params.to, bot);
          if (params.to === 'near_cell' || params.to === 'inspect_cell') {
            const cell = params.cell !== undefined ? project.cells[params.cell] : undefined;
            if (!cell || !params.stand) return precondition('no_reposition_target', 'cell repositioning needs a blueprint cell and a stand point');
            // Re-validate the stand point FRESH (still safe, still within reach of that cell).
            const fresh = standPointFor(session, services, project, cell, params.to !== 'inspect_cell');
            const s = params.stand;
            const world = worldOf(session, services);
            const ok = (p: V3) => {
              const f = world.blockAt(p.x, p.y, p.z);
              const hd = world.blockAt(p.x, p.y + 1, p.z);
              const g = world.blockAt(p.x, p.y - 1, p.z);
              return Boolean(f && hd && g && REPLACEABLE.test(f.name) && REPLACEABLE.test(hd.name) && isFullCube(g) && !REPLACEABLE.test(g.name) && Math.hypot(cell.at.x - p.x, cell.at.y - (p.y + 1.12), cell.at.z - p.z) <= BLOCK_REACH - 0.3 && services.perception.withinTravel(p));
            };
            if (!fresh || !sameParameters(pj(fresh), pj(s)) || !ok(s)) return precondition('stand_point_invalid', `stand point ${at3(s)} is no longer safe or within reach of ${at3(cell.at)}${fresh ? `; ${at3(fresh)} is` : ''}`);
            target = { goal: new goals.GoalBlock(s.x, s.y, s.z), at: s, arrived: () => Math.floor(bot.entity.position.x) === s.x && Math.floor(bot.entity.position.z) === s.z && Math.abs(bot.entity.position.y - s.y) < 0.6 };
            if (target.arrived()) return precondition('already_there', 'the bot already stands on this stand point (no movement offered)');
          }
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
          const faces = visibleFaces(worldOf(session, services), eyeOf(bot), cell.at.x, cell.at.y, cell.at.z);
          if (faces.length === 0 || eyeDistanceToBlock(bot, cell.at.x, cell.at.y, cell.at.z) > BLOCK_REACH) return precondition('not_visible', 'the aid is not visible within reach');
          const n = faceNormal(faces[0] as FaceName);
          await act.lookAt({ x: cell.at.x + 0.5 + n.x * 0.5, y: cell.at.y + 0.5 + n.y * 0.5, z: cell.at.z + 0.5 + n.z * 0.5 });
          const startSeq = session.evidence.seq;
          commandSent = true;
          const dig = act.startDig(live);
          dig.catch(() => undefined);
          await Promise.race([dig, new Promise((resolve) => act.signal.addEventListener('abort', resolve, { once: true }))]);
          act.fence();
          const change = await act.waitServer('block_change', (e) => e.x === cell.at.x && e.y === cell.at.y && e.z === cell.at.z, startSeq, 2_500);
          if (!change) return failed('unconfirmed_break', 'no server block change for the aid', {}, 'client_only');
          const after = mk(stateName(bot, change.stateId));
          if (after === id.key) return failed('server_rejected_break', 'the server kept the aid', {}, 'server_packet');
          commandConfirmed = true;
          services.ledger.add({ kind: 'block_changed', x: cell.at.x, y: cell.at.y, z: cell.at.z, from: id.key, to: after, atMs: change.atMs, actionId: ctx.candidate.id });
          ctx.progress({ aidRemoved: id.key, at: { ...cell.at } }, 'server_packet');
          if (!/^minecraft:(air|cave_air|void_air)$/.test(after)) return failed('aid_not_removed', `the server changed the aid to ${after}; no air checkpoint is invented`, { became: after }, 'server_packet');
          const durable = await home.checkpoint({ at: cell.at, to: after, confirmedAtMs: change.atMs, capability: 'build_home', projectId: project.id });
          return { status: 'succeeded', effect: `removed the bot's own construction aid ${id.key} at ${at3(cell.at)} (server block change -> ${after})${durable ? '' : '; project checkpoint NOT durable'}`, confirmation: 'server_packet', evidence: { removed: id.key, at: { ...cell.at }, became: after, durable } };
        }
        // place
        if (!params.item || !params.support || !params.face) return precondition('incomplete_candidate', 'placement needs item, support and face');
        const item = mk(params.item);
        if (params.material && ['wall', 'roof', 'aid'].includes(cell.role) && !(params.material.startsWith('#') ? inspector.inTag(params.material, item) : params.material === item)) return precondition('requested_material_missing', 'the candidate substitutes a different admitted material');
        if (!accepts(cell, item, inspector.inTag)) return precondition('item_not_accepted', `${item} is not accepted for this ${cell.role} cell`);
        const n = faceNormal(params.face);
        const dest = { x: params.support.x + n.x, y: params.support.y + n.y, z: params.support.z + n.z };
        if (dest.x !== cell.at.x || dest.y !== cell.at.y || dest.z !== cell.at.z) return precondition('not_a_blueprint_position', 'the placement would not land on the blueprint cell');
        const world = worldOf(session, services);
        const destBlock = world.blockAt(dest.x, dest.y, dest.z);
        if (!destBlock || !REPLACEABLE.test(destBlock.name)) return precondition('destination_occupied', `${at3(dest)} holds ${destBlock?.name ?? 'unloaded'}`);
        if (intersectsBot(bot.entity.position, dest)) return precondition('destination_occupied_by_bot', 'the bot stands in the destination');
        const occupant = occupyingEntity(bot as never, dest.x, dest.y, dest.z);
        if (occupant) return precondition('destination_occupied_by_entity', `a ${occupant} occupies the destination`);
        const support = world.blockAt(params.support.x, params.support.y, params.support.z);
        if (!support || !isFullCube(support) || REPLACEABLE.test(support.name) || INTERACTIVE_SUPPORT.test(support.name)) return precondition('support_changed', 'the support block is gone or unsuitable');
        if (eyeDistanceToBlock(bot, params.support.x, params.support.y, params.support.z) > BLOCK_REACH) return precondition('out_of_reach', 'the support is out of reach');
        if (!visibleFaces(world, eyeOf(bot), params.support.x, params.support.y, params.support.z).includes(params.face)) return precondition('face_not_visible', `the ${params.face} face of the support is not visible`);
        const held = await ensureInHand(act, services, item);
        if (!held.ok || !held.confirmed) return precondition('item_not_in_inventory', held.detail);
        act.fence();
        if (home.project()?.id !== project.id || !plan(session, services, project, params.material).drafts.some((d) => sameParameters(d.parameters, params))) return precondition('construction_step_changed', 'the site, material or support changed while confirming the held item');
        const startSeq = session.evidence.seq;
        commandSent = true;
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
        commandConfirmed = true;
        services.ledger.add({ kind: 'block_changed', ...dest, from: mk(destBlock.name), to: placed, atMs: change.atMs, actionId: ctx.candidate.id });
        services.ledger.setResult(ctx.candidate.id, { dimension: String(bot.game.dimension), ...dest, key: placed });
        ctx.progress({ placed, at: dest, role: cell.role }, 'server_packet');
        const durable = await home.checkpoint({ at: dest, to: placed, confirmedAtMs: change.atMs, capability: 'build_home', projectId: project.id });
        const evidence: Record<string, JsonValue> = { placed, at: dest, role: cell.role, phase: cell.phase, accepted: accepts(cell, placed, inspector.inTag), durable, priorResult: ctx.candidate.id };
        if (!accepts(cell, placed, inspector.inTag)) return failed('unexpected_placement', `the server placed ${placed}, which does not satisfy the ${cell.role} cell`, evidence, 'server_packet');
        return { status: 'succeeded', effect: `placed ${placed} at ${at3(dest)} (${cell.role}, server block change)${durable ? '' : '; project checkpoint NOT durable'}`, confirmation: 'server_packet', evidence };
      } finally {
        if (commandSent && !commandConfirmed) await home.unknownEffect('issued construction command lacks a confirmed project effect; fresh inspection is required', ownedProjectId);
      }
    },
  };

  const inspectionFacts = (project: HomeProject, inventory: Pick<InventoryView, 'counts' | 'atMs'>, services: SkillServices, connectionEpoch: number, material?: string) => {
    const inspection = inspector.inspect(project);
    const requirements = materialRequirements(inspection.verdicts, inventory.counts, inspector.inTag, material);
    const recipes = requirements.filter((r) => r.missing > 0).flatMap((r) => r.accept.filter((k) => !k.startsWith('#')).slice(0, 8).flatMap((k) => (services.knowledge.recipes?.recipesFor(k) ?? []).filter((recipe) => recipe.family === 'crafting').slice(0, 2).map((recipe) => ({ output: k, count: r.missing, recipeId: recipe.id, yield: recipe.output.count, workstations: recipe.workstations, ingredients: recipe.ingredients.map((i) => ({ selector: i.spec.label, count: i.count * Math.ceil(r.missing / recipe.output.count) })) }))));
    const evidence: Record<string, JsonValue> = { projectId: project.id, requirements: JSON.parse(JSON.stringify(requirements)), recipes: JSON.parse(JSON.stringify(recipes)), inventorySource: 'server_sync', inventoryAtMs: inventory.atMs, connectionEpoch, structure: inspection.verdict.status };
    return { inspection, evidence };
  };

  const InspectParams = z.object({ material: z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/).optional(), projectId: z.string().optional() }).strict();
  const inspectHome: SkillDefinition<z.infer<typeof InspectParams>> = {
    descriptor: {
      id: 'inspect_home', family: 'construction',
      purpose: 'Freshly inspect the approved home and report full material deficits, current server inventory and exact-version crafting prerequisites. Use before gathering and after interruption; then generic mine/collect/craft skills supply build_home. A material task never completes the home goal.',
      parameters: [{ name: 'material', type: 'registry_key', description: 'binding wall/roof material (furnishings keep their exact recipe output)', required: false }],
      targets: ['none'], preconditions: ['approved project in the current dimension'], effects: ['fresh inspection and prerequisite feedback; no world change'],
      supportedPredicates: ['structure_state'], timeoutMs: 5_000, cancellation: 'ownership fenced before inspection and persistence',
      limitations: ['unknown cells require further visible inspection', 'recipes are facts, not a hidden acquisition script'], evidence: ['server inventory resync', 'current visible/confirmed project voxels'],
    },
    params: InspectParams,
    resolve(ctx) {
      const p = home.project();
      if (!p || !canonicalProject(p)) return { drafts: [], unavailable: [{ reason: 'no_home_project', detail: 'select a valid observed vacant home site first' }] };
      if (String(ctx.session.bot.game.dimension) !== p.dimension) return { drafts: [], unavailable: [{ reason: 'wrong_dimension', detail: `the home is in ${p.dimension}` }] };
      const material = ctx.hints.parameters['material'];
      const cached = inspectionReceipt;
      const freshInventory = ctx.services.ledger.inventory();
      if (cached && cached.projectId === p.id && cached.connectionEpoch === ctx.session.connectionEpoch && cached.generation === ctx.services.ledger.invalidations.at(-1) && cached.material === material && freshInventory && freshInventory.source === 'server_sync' && freshInventory.atMs >= cached.atMs && ctx.services.clock.now() - freshInventory.atMs <= 5_000 && ctx.services.clock.now() - cached.atMs <= 5_000) {
        inspectionReceipt = undefined;
        const facts = inspectionFacts(p, freshInventory, ctx.services, ctx.session.connectionEpoch, cached.material);
        return { drafts: [], unavailable: [{ reason: 'home_inspection_ready', detail: `${facts.inspection.verdict.detail}; use the prerequisite feedback to gather/craft, then continue build_home with the original structure_state outcome and remaining limits`, evidence: facts.evidence }] };
      }
      return { drafts: [{ parameters: { projectId: p.id, ...(typeof material === 'string' ? { material } : {}) }, description: `inspect project ${p.id} and its complete material prerequisites` }] };
    },
    async execute(ctx, params) {
      const p = home.project();
      if (!p || p.id !== params.projectId || !canonicalProject(p)) return precondition('project_changed', 'home project identity changed');
      if (String(ctx.session.bot.game.dimension) !== p.dimension) return precondition('wrong_dimension', `the home is in ${p.dimension}`);
      const inventory = await confirmInventory(ctx.act, ctx.services);
      ctx.act.fence();
      if (!inventory) return failed('no_server_sync', 'home prerequisites require server-confirmed inventory');
      const { inspection, evidence } = inspectionFacts(p, inventory, ctx.services, ctx.session.connectionEpoch, params.material);
      await home.verified(inspection.verdict, p.id);
      ctx.act.fence();
      inspectionReceipt = { projectId: p.id, connectionEpoch: ctx.session.connectionEpoch, generation: ctx.services.ledger.invalidations.at(-1), material: params.material, atMs: ctx.services.clock.now() };
      return { status: 'succeeded', confirmation: 'server_sync', effect: `fresh home inspection: ${inspection.verdict.detail}; prerequisite feedback follows on the next resolver pass`, evidence };
    },
  };

  return [selectHomeSite, inspectHome, buildHome] as SkillDefinition[];
}
