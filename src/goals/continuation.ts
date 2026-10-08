// MB-FLOW-003-C12 pure continuation helpers (P). Groundability comes from the
// predicate SEMANTICS of the immutable accepted outcome (never a goal intent);
// count lineage arithmetic is code-owned (src/contracts/continuation.ts rule 2).
import type { AtomGrounding, CountLineage, GoalOutcomeContract, OutcomePredicate, TargetSelector } from '../contracts/index.ts';

type Atom = Exclude<OutcomePredicate, { predicate: 'all' | 'any' | 'not' }>;

/** Every atom with its evaluation path ('root', 'root.0', 'root.0.1', ...) and whether it sits under any/not. */
export function outcomeAtoms(contract: GoalOutcomeContract): Array<{ path: string; atom: Atom; underAnyOrNot: boolean }> {
  const out: Array<{ path: string; atom: Atom; underAnyOrNot: boolean }> = [];
  const walk = (p: OutcomePredicate, path: string, soft: boolean) => {
    if (p.predicate === 'all') p.of.forEach((c, i) => walk(c, `${path}.${i}`, soft));
    else if (p.predicate === 'any') p.of.forEach((c, i) => walk(c, `${path}.${i}`, true));
    else if (p.predicate === 'not') walk(p.of, `${path}.0`, true);
    else out.push({ path, atom: p, underAnyOrNot: soft });
  };
  walk(contract.kind === 'finite' ? contract.outcome : contract.maintain, 'root', false);
  return out;
}

const COUNT = new Set(['inventory_delta', 'crafting_result', 'smelting_result']);

/** A count atom carried through the lineage (possession or effect basis). */
export function isCountAtom(a: Atom): a is Extract<Atom, { predicate: 'inventory_delta' | 'inventory_amount' | 'crafting_result' | 'smelting_result' }> {
  return COUNT.has(a.predicate) || (a.predicate === 'inventory_amount' && a.mode === 'collect_additional');
}

function selectorReason(s: TargetSelector): string | undefined {
  switch (s.kind) {
    case 'registry':
    case 'owner':
    case 'owner_destination':
      return undefined;
    case 'observed':
      return 'observed_handle';
    case 'prior_result':
      return 'prior_result_action';
    case 'remembered_anchor':
      return 'remembered_anchor';
    case 'memory_ref':
      return 'memory_ref';
  }
}

/**
 * Groundability of every atom from predicate semantics. Count atoms need a
 * known admission baseline and may not sit under any/not; selector-bound atoms
 * need a semantic selector; `blocks_removed` is grounded by its carried bound
 * positions (never by its handle); entity outcomes on observed handles are not.
 */
export function groundOutcome(contract: GoalOutcomeContract, baselineKnown: boolean): AtomGrounding[] {
  return outcomeAtoms(contract).map(({ path, atom, underAnyOrNot }) => {
    const g = (reason?: string): AtomGrounding => (reason ? { path, predicate: atom.predicate, status: 'not_groundable', reason } : { path, predicate: atom.predicate, status: 'groundable' });
    if (isCountAtom(atom)) {
      if (underAnyOrNot) return g('count_under_any_or_not');
      if (atom.predicate !== 'crafting_result' && atom.predicate !== 'smelting_result' && !baselineKnown) return g('baseline_unknown');
      return g();
    }
    switch (atom.predicate) {
      case 'blocks_removed':
        return g();
      case 'entity_outcome':
        return atom.target.kind === 'owner' ? g() : g(selectorReason(atom.target) ?? 'observed_handle');
      case 'near_target':
      case 'visited_location':
      case 'block_state':
      case 'container_state':
        return g(selectorReason(atom.target));
      default:
        return g();
    }
  });
}

/** Sum of counts whose key matches the selector (exact key or tag via `matches`). */
export function countFor(counts: Readonly<Record<string, number>>, selector: string, matches: (selector: string, key: string) => boolean): number {
  let n = 0;
  for (const [k, v] of Object.entries(counts)) if (matches(selector, k)) n += v;
  return n;
}

/**
 * Rule 2 progress of one possession count atom in a continuation segment.
 *   restored = min(C, max(0, X - N)), X = own-incident returns now (incident) or F (no incident)
 *   new      = max(0, now - F - (returnsNow - returnsAtF)) + consumedSinceRebind
 */
export function segmentProgress(s: { credited: number; nonCredit: number; fresh: number; incident: boolean; returnsAtF: number }, now: { count: number; returns: number; consumed: number }): { restored: number; acquiredNew: number; progress: number } {
  const x = s.incident ? now.returns : s.fresh;
  const restored = Math.min(s.credited, Math.max(0, x - s.nonCredit));
  const ownSinceF = s.incident ? Math.max(0, now.returns - s.returnsAtF) : 0;
  const acquiredNew = Math.max(0, now.count - s.fresh - ownSinceF) + Math.max(0, now.consumed);
  return { restored, acquiredNew, progress: restored + acquiredNew };
}

/** Lineage entries for every count atom (credited/held filled at capture time). */
export function initialCountLineage(contract: GoalOutcomeContract, admissionCounts: Readonly<Record<string, number>> | null, matches: (selector: string, key: string) => boolean): CountLineage[] {
  return outcomeAtoms(contract)
    .filter((x) => isCountAtom(x.atom))
    .map(({ path, atom }) => {
      const a = atom as Extract<Atom, { predicate: CountLineage['predicate'] }>;
      const selector = a.predicate === 'crafting_result' || a.predicate === 'smelting_result' ? a.output : a.selector;
      const basis: CountLineage['basis'] = a.predicate === 'crafting_result' || a.predicate === 'smelting_result' ? 'effect' : 'possession';
      return {
        path,
        basis,
        predicate: a.predicate,
        selector,
        atLeast: a.atLeast,
        admissionCount: basis === 'possession' ? (admissionCounts ? countFor(admissionCounts, selector, matches) : null) : null,
        credited: null,
        heldAtInterruption: null,
        evidence: 'pending',
        latched: false,
        incidentId: null,
        segments: 0,
      };
    });
}
