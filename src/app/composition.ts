// Central composition rules shared by the CLI and the live-harness catalog
// expectations (scripts/lib/profile-catalog.ts), so the registered catalog is
// derived in ONE place.
import type { ChunkbotConfig } from '../config/schema.ts';

/**
 * MB-PLAN-006 coordinator decision: home construction (select_home_site /
 * build_home) serves ordinary OWNER goals whenever the configuration enables
 * it, the real planner runs, and an explicit durable world scope resolves
 * (checked by the caller) — independently of automatic progression. No scope
 * is ever invented; a profile without one never registers it.
 */
export function homeConstructionWanted(config: Pick<ChunkbotConfig, 'autonomy' | 'models'>): boolean {
  return config.autonomy?.home?.enabled !== false && config.models.planner.mode === 'codex';
}
