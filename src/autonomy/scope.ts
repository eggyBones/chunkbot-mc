// MB-FLOW-001-C5: ONE explicit durable scope for automatic persistence-
// dependent work (stop latch, home project, survival episodes). `autonomy.scope`
// and an enabled memory profile must name the SAME worldProfile/worldRevision/
// botProfile when both exist; any difference is a visible scope conflict that
// blocks automatic work only (manual goals and ordinary config loading are
// unaffected). Absent autonomy.scope: the memory scope is used.
import type { AutonomyScope } from '../contracts/autonomy.ts';

export type ScopeResolution = { scope: AutonomyScope; source: 'autonomy' | 'memory' | 'both'; conflict?: undefined } | { scope: undefined; source: 'none'; conflict?: undefined } | { scope: undefined; source: 'conflict'; conflict: string };

export function resolveAutonomyScope(autonomyScope: AutonomyScope | undefined, memory: { enabled?: boolean; worldProfile: string; worldRevision: number; botProfile: string } | undefined): ScopeResolution {
  const mem = memory && memory.enabled !== false ? { worldProfile: memory.worldProfile, worldRevision: memory.worldRevision, botProfile: memory.botProfile } : undefined;
  if (autonomyScope && mem) {
    const diff = (['worldProfile', 'worldRevision', 'botProfile'] as const).filter((k) => autonomyScope[k] !== mem[k]);
    if (diff.length > 0) {
      return {
        scope: undefined,
        source: 'conflict',
        conflict: `scope conflict: autonomy.scope (${autonomyScope.worldProfile}@r${autonomyScope.worldRevision}/${autonomyScope.botProfile}) differs from the memory profile (${mem.worldProfile}@r${mem.worldRevision}/${mem.botProfile}) in ${diff.join(', ')}; automatic work is off until they name the same world/revision/bot (manual goals still work)`,
      };
    }
    return { scope: { ...autonomyScope }, source: 'both' };
  }
  if (autonomyScope) return { scope: { ...autonomyScope }, source: 'autonomy' };
  if (mem) return { scope: mem, source: 'memory' };
  return { scope: undefined, source: 'none' };
}
