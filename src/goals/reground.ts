// Draft revalidation (MB-FLOW-002): a plan prepared before admission (or a
// window lookahead) references observation handles from snapshots taken while
// older work was still changing the world. Before such a plan can be checked
// and executed it is re-grounded into a FRESH snapshot: each referenced target
// must be produced again as the SAME target (block position, entity/drop id,
// frontier waypoint) — never the nearest or another one. A reference that is
// no longer produced makes the draft materially stale; the goal engine then
// asks for a bounded, counted repair turn instead of acting on it.
import type { ObservationSnapshot } from '../contracts/index.ts';

export type Translate = (fromSnapshotId: string, handle: string, toSnapshotId: string) => string | undefined;

export interface RegroundResult {
  proposal: unknown;
  problems: string[];
  /** References moved to the fresh snapshot. */
  regrounded: number;
}

function isRef(v: unknown): v is { snapshotId: string; handle: string } {
  return Boolean(v && typeof v === 'object' && typeof (v as Record<string, unknown>)['snapshotId'] === 'string' && typeof (v as Record<string, unknown>)['handle'] === 'string');
}

/**
 * Re-grounds every handle reference inside the proposal's tasks (selectors and
 * parameters) and, with `outcome: true`, inside its goal outcome as well (a
 * prepared draft whose outcome is not bound yet, MB-FLOW-002-C2). An outcome
 * that is already accepted and bound is never passed here for rewriting: its
 * grounded binding is immutable. Pure; returns a copy.
 */
export function regroundProposal(raw: unknown, fresh: ObservationSnapshot | null, translate: Translate | undefined, options: { outcome?: boolean } = {}): RegroundResult {
  const problems: string[] = [];
  let regrounded = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    if (isRef(v)) {
      const ref = v;
      if (fresh && ref.snapshotId === fresh.id) return { ...ref };
      const moved = fresh && translate ? translate(ref.snapshotId, ref.handle, fresh.id) : undefined;
      if (!moved || !fresh) {
        if (problems.length < 12) {
          problems.push(`${ref.handle} from ${ref.snapshotId} is no longer observed as the same target in the current observation${fresh ? ` ${fresh.id}` : ''}; re-plan from the current observation (prefer registry selectors)`);
        }
        return { ...ref };
      }
      regrounded += 1;
      return { ...ref, snapshotId: fresh.id, handle: moved };
    }
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
  };
  if (!raw || typeof raw !== 'object') return { proposal: raw, problems, regrounded };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['tasks'])) return { proposal: raw, problems, regrounded };
  const tasks = (r['tasks'] as unknown[]).map(walk);
  const outcome = options.outcome && r['outcome'] !== undefined ? { outcome: walk(r['outcome']) } : {};
  return { proposal: { ...r, tasks, ...outcome }, problems, regrounded };
}
