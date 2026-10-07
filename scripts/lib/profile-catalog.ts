// MB-FLOW-001-C9: the capability catalog a `run` REGISTERS for a config
// profile, for live-harness expectations (never a hard-coded count). Mirrors
// the run composition (src/cli.ts features -> SkillRuntime registry):
//   foundation skill definitions (always)
//   + memory skills when memory is configured and enabled
//   + locator skills unless `locator.enabled: false`
//   + home construction / survival skills only when automatic work is enabled
//     (never with `run --no-autonomy` or the disabled-planner profile) and the
//     config enables them with a durable scope.
// tests/harness-profile-catalog.test.ts proves the expectation against the
// actual composed SkillRuntime registry for the fixture profiles.
// Pure: no world, process or network access.
import type { ChunkbotConfig } from '../../src/config/schema.ts';
import { SURVIVAL_CAPABILITIES } from '../../src/contracts/survival.ts';
import { CONSTRUCTION_CAPABILITIES, MEMORY_CAPABILITIES } from '../../src/planner/wire.ts';
import { allSkills } from '../../src/skills/index.ts';

/** Locator skill ids (src/skills/locator.ts); registered whenever route legs are composed. */
export const LOCATOR_SKILL_IDS = ['seek_owner', 'route_travel'] as const;

export interface RunProfile {
  memory: boolean;
  locator: boolean;
  construction: boolean;
  survival: boolean;
}

/** `automatic`: autonomy is enabled for this run (false under `--no-autonomy` or a disabled planner). */
export function runProfile(config: ChunkbotConfig, automatic: boolean): RunProfile {
  const memory = Boolean(config.memory?.enabled);
  const scope = Boolean(config.autonomy?.scope) || memory;
  return {
    memory,
    locator: config.locator?.enabled !== false,
    construction: automatic && scope && config.autonomy?.home?.enabled !== false,
    survival: automatic && scope && config.survival?.enabled !== false,
  };
}

export function expectedCapabilityIds(profile: RunProfile): string[] {
  return [
    ...allSkills().map((s) => s.descriptor.id),
    ...(profile.memory ? MEMORY_CAPABILITIES : []),
    ...(profile.construction ? CONSTRUCTION_CAPABILITIES : []),
    ...(profile.survival ? Object.values(SURVIVAL_CAPABILITIES) : []),
    ...(profile.locator ? LOCATOR_SKILL_IDS : []),
  ];
}

/** Every disagreement between what the run reported and what the profile registers (empty = consistent). */
export function catalogProblems(observed: { skillsLineCount: number | null; statusCount: number | null; diagCount: number | null; ids: string[] }, expected: readonly string[]): string[] {
  const problems: string[] = [];
  const want = new Set(expected);
  const got = new Set(observed.ids);
  for (const [name, n] of [['skills line', observed.skillsLineCount], ['status capabilities', observed.statusCount], ['/diag catalog header', observed.diagCount]] as const) {
    if (n === null) problems.push(`${name}: no count reported`);
    else if (n !== want.size) problems.push(`${name}: ${n} capabilities, expected ${want.size} for this profile`);
  }
  if (got.size !== observed.ids.length) problems.push('duplicate capability ids listed');
  const missing = [...want].filter((id) => !got.has(id));
  const unexpected = [...got].filter((id) => !want.has(id));
  if (missing.length) problems.push(`missing for this profile: ${missing.join(', ')}`);
  if (unexpected.length) problems.push(`not expected for this profile: ${unexpected.join(', ')}`);
  return problems;
}
