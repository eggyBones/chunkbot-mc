// Owner-target semantics, independent of instruction wording or goal kinds.
import { BOUNDS, type CapabilityCatalog, type OutcomePredicate, type TaskSpec } from '../contracts/index.ts';

export function predicateTargetsOwner(p: OutcomePredicate): boolean {
  if (p.predicate === 'all' || p.predicate === 'any') return p.of.some(predicateTargetsOwner);
  return 'target' in p && p.target.kind === 'owner';
}

export function taskTargetsOwner(t: TaskSpec): boolean {
  const target = t.parameters['target'];
  return t.targetSelectors.some((s) => s.kind === 'owner') || predicateTargetsOwner(t.completion) ||
    (target !== null && typeof target === 'object' && !Array.isArray(target) && target['kind'] === 'owner');
}

/** Adds the registered seeking capability, never route authority or limits. */
export function enableOwnerSeeking(tasks: TaskSpec[], catalog: CapabilityCatalog): string[] {
  const seek = catalog.capabilities.find((c) => c.id === 'seek_owner' && c.targets?.includes('owner'));
  if (!seek) return [];
  const problems: string[] = [];
  for (const [index, task] of tasks.entries()) {
    const ownerMovement = catalog.capabilities.some((c) => task.allowedCapabilities.includes(c.id) && c.family === 'movement' && c.targets?.includes('owner'));
    if (!taskTargetsOwner(task) || !ownerMovement || task.allowedCapabilities.includes(seek.id)) continue;
    if (task.allowedCapabilities.length >= BOUNDS.listSmall) problems.push(`tasks[${index}]: owner navigation needs a slot for the registered seeking capability`);
    else task.allowedCapabilities.push(seek.id);
  }
  return problems;
}
