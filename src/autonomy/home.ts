// HomeProjectService: the scope's single small-shelter construction project
// (MB-FLOW-001 A3/A6), persisted through AutonomyControl (same explicit
// world/revision/bot scope as the stop latch).
//
// - approve(): a code-selected, freshly checked vacant footprint becomes the
//   approved project (one per scope; never replaces an existing project).
// - checkpoints are server-confirmed effects of the bot's OWN construction
//   actions (placements, and the removal of its own temporary aid); they are
//   the only blocks the project may repair or remove.
// - verification is always a fresh inspection of the actual site; a stored
//   checkpoint or verification is historical, never proof of the present.
import type { Clock, EvidenceEvent } from '../contracts/index.ts';
import type { HomeProject, HomeProjectSummary, ProjectState } from '../contracts/autonomy.ts';
import type { AutonomyControl } from './control.ts';
import { PHASE_NAMES, SHELTER_MATERIALS, smallShelterCells, type Facing, type ShelterVerdict, type V3 } from './blueprint.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class HomeProjectService {
  private readonly control: AutonomyControl;
  private readonly clock: Clock;
  private readonly record: (e: EvidenceEvent) => void;
  private seq = 0;

  constructor(options: { control: AutonomyControl; clock: Clock; record: (e: EvidenceEvent) => void }) {
    this.control = options.control;
    this.clock = options.clock;
    this.record = options.record;
  }

  /** Durable project state can be written (scope ready). */
  writable(): boolean {
    return this.control.usable();
  }

  project(): HomeProject | undefined {
    return this.control.home();
  }

  /** Approves an observed vacant footprint as THE scope's home project (durable before success). */
  async approve(site: { origin: V3; interior: 2 | 3; facing: Facing; dimension: string; checks: string[]; goalId?: string }): Promise<{ ok: true; project: HomeProject } | { ok: false; reason: string; detail: string }> {
    if (!this.writable()) return { ok: false, reason: 'scope_not_writable', detail: `home projects need durable scope: ${this.control.persistence().detail}` };
    const existing = this.project();
    if (existing) return { ok: false, reason: 'home_project_exists', detail: `project ${existing.id} (${existing.state}) already exists in this world profile; it is inspected and continued, never replaced` };
    const now = this.clock.now();
    this.seq += 1;
    const outer = site.interior + 2;
    const project: HomeProject = {
      id: `proj-${now.toString(36)}${this.seq.toString(36)}`.slice(0, 29),
      blueprint: 'small_shelter_v1',
      dimension: site.dimension,
      origin: { ...site.origin },
      size: { outerX: outer, outerZ: outer, wallHeight: 2 },
      entranceFacing: site.facing,
      cells: smallShelterCells(site.origin, site.interior, site.facing),
      state: 'approved',
      stateDetail: 'site approved from current observation; nothing built yet',
      approvedAtMs: now,
      approval: { basis: 'observed_vacant_site', checks: site.checks.slice(0, 8).map((c) => clip(c, 200)), ...(site.goalId ? { goalId: site.goalId as `goal-${string}` } : {}) },
      checkpoints: [],
      unknownEffects: 0,
      updatedAtMs: now,
    };
    const ok = await this.control.setHome(project, 'home_approved');
    if (!ok) return { ok: false, reason: 'durable_write_failed', detail: `could not persist the approved site: ${this.control.persistence().detail}` };
    this.record({ type: 'home_project_approved', projectId: project.id, origin: project.origin, facing: project.entranceFacing, outer, dimension: project.dimension });
    return { ok: true, project };
  }

  /** Records a server-confirmed own construction effect (placement or own-aid removal). Durable before resolving true. */
  async checkpoint(entry: { at: V3; to: string; confirmedAtMs: number; capability: string }): Promise<boolean> {
    const p = this.project();
    if (!p) return false;
    const i = p.checkpoints.findIndex((c) => c.at.x === entry.at.x && c.at.y === entry.at.y && c.at.z === entry.at.z);
    if (i >= 0) p.checkpoints.splice(i, 1);
    p.checkpoints.push({ at: { ...entry.at }, to: entry.to, confirmedAtMs: entry.confirmedAtMs, capability: entry.capability });
    if (p.checkpoints.length > 128) p.checkpoints.splice(0, p.checkpoints.length - 128);
    if (p.state === 'approved' || p.state === 'interrupted') {
      p.state = 'building';
      p.stateDetail = 'construction in progress';
    }
    p.updatedAtMs = this.clock.now();
    return this.control.setHome(p, 'home_checkpoint');
  }

  /** Counts an interrupted construction action whose later effects are unknown (fresh inspection resolves them). */
  async unknownEffect(detail: string): Promise<void> {
    const p = this.project();
    if (!p) return;
    p.unknownEffects += 1;
    p.stateDetail = clip(`interrupted action: ${detail}`, 200);
    p.updatedAtMs = this.clock.now();
    await this.control.setHome(p, 'home_unknown_effect');
  }

  /** Stores a fresh code verification and derives the project state from it. */
  async verified(verdict: ShelterVerdict): Promise<HomeProject | undefined> {
    const p = this.project();
    if (!p) return undefined;
    const now = this.clock.now();
    p.verified = { atMs: now, status: verdict.status, satisfied: verdict.satisfied, total: verdict.total, detail: clip(verdict.detail, 1_000) };
    let state: ProjectState = p.state;
    if (verdict.status === 'complete') state = 'complete';
    else if (verdict.foreign.length > 0) state = 'blocked';
    else if (p.state === 'complete' || p.state === 'blocked') state = p.checkpoints.length > 0 ? 'building' : 'approved';
    if (state !== p.state || verdict.status === 'complete' || verdict.foreign.length > 0) {
      p.state = state;
      p.stateDetail = clip(verdict.status === 'complete' ? 'verified complete shelter' : verdict.foreign.length > 0 ? `blocked: ${verdict.detail}` : verdict.detail, 200);
    }
    p.updatedAtMs = now;
    await this.control.setHome(p, 'home_verified');
    return p;
  }

  /** A build goal ended without verified completion: confirmed checkpoints stay; nothing is replayed. */
  async interrupted(detail: string): Promise<void> {
    const p = this.project();
    if (!p || p.state === 'complete' || p.state === 'blocked') return;
    if (p.checkpoints.length === 0 && p.state === 'approved') return;
    p.state = 'interrupted';
    p.stateDetail = clip(`interrupted: ${detail}; the site is inspected afresh before continuing`, 200);
    p.updatedAtMs = this.clock.now();
    await this.control.setHome(p, 'home_interrupted');
  }

  summary(): HomeProjectSummary | null {
    const p = this.project();
    if (!p) return null;
    const own = new Set(p.checkpoints.filter((c) => c.to !== 'minecraft:air').map((c) => `${c.at.x},${c.at.y},${c.at.z}`));
    const byRole: Record<string, { required: number; ownConfirmed: number }> = {};
    const remaining = new Map<string, { role: string; count: number; accept: string[] }>();
    for (const c of p.cells) {
      if (c.role === 'entrance') continue;
      const r = (byRole[c.role] ??= { required: 0, ownConfirmed: 0 });
      r.required += 1;
      const placed = own.has(`${c.at.x},${c.at.y},${c.at.z}`);
      if (placed) r.ownConfirmed += 1;
      else if (c.role !== 'aid') {
        const k = `${c.role}|${c.accept.join(',')}`;
        const m = remaining.get(k) ?? { role: c.role, count: 0, accept: [...c.accept] };
        m.count += 1;
        remaining.set(k, m);
      }
    }
    const cells = p.cells.filter((c) => c.role !== 'entrance').length;
    return {
      id: p.id,
      state: p.state,
      detail: p.stateDetail,
      dimension: p.dimension,
      origin: { ...p.origin },
      outer: { x: p.size.outerX, z: p.size.outerZ },
      entranceFacing: p.entranceFacing,
      progress: { cells, ownConfirmed: own.size, byRole },
      materials: [...remaining.values()].slice(0, 8),
      verified: p.verified ?? null,
      approvedAtMs: p.approvedAtMs,
      updatedAtMs: p.updatedAtMs,
    };
  }
}

/** Planner-facing note on what the home needs (no hidden plan; blueprint facts only). */
export function homeRequirementNote(): string {
  return `small_shelter_v1: walls 2 high and a flat roof of ${SHELTER_MATERIALS.join(' / ')}, an open entrance, a crafting table, a furnace and a chest inside; phases: ${Object.values(PHASE_NAMES).join(' -> ')}`;
}
