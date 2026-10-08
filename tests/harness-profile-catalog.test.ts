// MB-FLOW-001-C9 regression: live-harness catalog expectations come from the
// profile's ACTUAL registered catalog, never a fixed count. The 26.2 skills
// trial failed S0 because it expected 20 capabilities while the composed run
// registers 22 (the locator adds seek_owner and route_travel) and then
// cascaded into dependent scenarios. Offline only: no world, no process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT, fixturePins } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock } from '../src/contracts/index.ts';
import { allSkills } from '../src/skills/index.ts';
import { SAFETY_CAPABILITIES } from '../src/contracts/safety.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { LOCATOR_SKILL_IDS, catalogProblems, expectedCapabilityIds, runProfile } from '../scripts/lib/profile-catalog.ts';

const foundation = allSkills().map((s) => s.descriptor.id);

/** The registry a `run --no-autonomy` composes for a config (src/cli.ts: locator unless disabled; no survival/home). */
function composedNoAutonomyIds(configPath: string): string[] {
  const loaded = loadConfigFile(configPath);
  const config = loaded.config;
  const runtime = new SkillRuntime({
    config,
    session: () => undefined,
    connectionEpoch: () => 0,
    goalEpoch: () => 0,
    diagnosticCurrent: () => false,
    admission: () => ({ serverOnlineMode: false }),
    store: new MemoryRunStore(),
    clock: systemClock,
    ids: sequentialIds(),
    features: { safety: true, ...(config.locator?.enabled === false ? {} : { locator: true }) },
  });
  return runtime.registry.catalog().capabilities.map((c) => c.id);
}

describe('harness catalog expectations follow the registered profile (C9)', () => {
  for (const profile of ['26.1.2', '26.2'] as const) {
    it(`skills profile ${profile} (inference-free, --no-autonomy): expectation equals the composed registry`, () => {
      const path = join(PROJECT_ROOT, fixturePins(profile).inferenceFreeConfig);
      const actual = composedNoAutonomyIds(path);
      const expected = expectedCapabilityIds(runProfile(loadConfigFile(path).config, false));
      assert.deepEqual([...actual].sort(), [...expected].sort());
      for (const id of LOCATOR_SKILL_IDS) assert.ok(actual.includes(id), `${id} registered by the locator`);
      assert.equal(actual.length, foundation.length + LOCATOR_SKILL_IDS.length + Object.values(SAFETY_CAPABILITIES).length);
      assert.notEqual(actual.length, foundation.length, 'the stale foundation-only count no longer describes a run');
      assert.deepEqual(catalogProblems({ skillsLineCount: actual.length, statusCount: actual.length, diagCount: actual.length, ids: actual }, expected), []);
    });
  }

  it('the scoped fixture profile adds construction for owner goals with an explicit scope; survival only when automatic work runs', () => {
    const cfg = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-autonomy.json')).config;
    assert.deepEqual(runProfile(cfg, true), { safety: true, memory: true, locator: true, construction: true, survival: true });
    assert.deepEqual(runProfile(cfg, false), { safety: true, memory: true, locator: true, construction: true, survival: false });
    const unscoped = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture.json')).config;
    assert.equal(runProfile(unscoped, true).construction, false, 'no scope is ever invented');
    const ids = expectedCapabilityIds(runProfile(cfg, true));
    for (const id of ['select_home_site', 'build_home', 'eat_safe_food', 'remember_location', 'seek_owner']) assert.ok(ids.includes(id), id);
  });

  it('catalogProblems reports the stale-count failure, unexpected/missing ids, inconsistency and missing counts', () => {
    const expected = expectedCapabilityIds({ memory: false, locator: true, construction: false, survival: false });
    const n = expected.length;
    assert.match(catalogProblems({ skillsLineCount: foundation.length, statusCount: n, diagCount: n, ids: expected }, expected).join(';'), new RegExp(`skills line: ${foundation.length} capabilities, expected ${n}`));
    assert.match(catalogProblems({ skillsLineCount: n, statusCount: n, diagCount: n, ids: expected.filter((id) => id !== 'route_travel') }, expected).join(';'), /missing for this profile: route_travel/);
    assert.match(catalogProblems({ skillsLineCount: n, statusCount: n, diagCount: n, ids: [...expected, 'build_home'] }, expected).join(';'), /not expected for this profile: build_home/);
    assert.match(catalogProblems({ skillsLineCount: n, statusCount: n, diagCount: n, ids: [...expected, expected[0]!] }, expected).join(';'), /duplicate/);
    assert.match(catalogProblems({ skillsLineCount: null, statusCount: n, diagCount: n, ids: expected }, expected).join(';'), /skills line: no count reported/);
  });

  it('skills-live-check has no fixed capability count and stops after a failed initial setup', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'scripts/skills-live-check.ts'), 'utf8');
    assert.ok(!/capabilities=20|skills: 20 capabilities|length >= 20/.test(src), 'no stale fixed count');
    assert.ok(src.includes('expectedCapabilityIds(runProfile(loadConfigFile(CONFIG).config, false))'), 'S0 derives the profile expectation');
    assert.ok(/planner=not-ready knowledge=ready perception=ready skills=ready capabilities=/.test(src), 'planner-disabled/readiness check retained');
    const s0 = src.indexOf("await check('S0'");
    const guard = src.indexOf("if (!results.find((r) => r.id === 'S0')?.pass)");
    const p1 = src.indexOf("await check('P1'");
    assert.ok(s0 > 0 && guard > s0 && p1 > guard, 'the S0 abort guard sits between S0 and every dependent scenario');
    assert.match(src, /process\.exitCode = passed === results\.length && !aborted && !interrupted && cleanup\.every\(\(s\) => s\.ok\) && cliRuns\.every/, 'abort, interruption or incomplete cleanup cannot pass');
  });
});
