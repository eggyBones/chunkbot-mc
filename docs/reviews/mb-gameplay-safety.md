# MB-FLOW-003-C11/C13 — immediate water and mob safety (worker W handoff)

Worker: Claude Code (Opus 5.5, high, local DSH, subscription). Branch `chunkbot/gameplay-safety`, worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-safety`, base `37c4c170199b4c9d867f720e64561a63a816d14c`.

Status: **source and offline/module evidence complete for the owned scope; NOT integrated, NOT fixture-proven, NOT accepted.** No fixture lease was granted: nothing joined a server, read a fixture password, sent RCON or touched a world. No model/provider was called. Shared files were not edited.

## Commits

| Commit | Content |
| --- | --- |
| `804e61d` | Contract `src/contracts/safety.ts` (authority basis, grant, ports). |
| `c35353f` | Policy, geometry, tracker, adapter, service, skills, wiring; offline tests. |
| `b246e55` | Module-level skill/service tests; fix: a mob with a server death status stayed targetable during its death animation (re-attacked) — dying bodies excluded. |
| `db4071a` | **Stable API after coordinator review 2**; deep-water pathfinder policy fix; leased harness + guard. |
| `001c1df` | Review/integration handoff (first version). |
| `5b3b003` | Review 3 SOURCE milestone for P: melee contact capped at 3.5 independent of config; harness interventions labeled as no-credit; difficulty always verified; harness footprint/guard review. |
| next commit | Review 4 (harness only): never-silent executor selection (real shared executor whenever the `safety` owner variant exists, `--require-real-executor`), M2/M2b staged as already-engaging threats, W3/M2b interventions labeled, unreadable server evidence fails. |

Checks on the review-3/4 tree (Node 24.21.0 first in PATH, direct exit codes): `npm run typecheck` 0, `npm run build` 0, `npm test` 0 — **849/849 pass** (all pre-existing suites unchanged). Safety files individually: policy, service, defense, skills, geometry, pathing, physics, harness-guard — each exit 0.

Owned paths changed: `src/contracts/safety.ts`, `src/safety/{dispositions,geometry,policy,tracker,adapter,service,wiring}.ts`, `src/skills/safety.ts`, `scripts/safety-live-check.ts`, `tests/safety-*.test.ts`, test helpers `tests/safety-helpers.ts` and `tests/safety-session.ts` (helper names outside the literal `*.test.ts` pattern; flagged for Codex), this document. Source = built (`npm run build` of the same tree); nothing is running.

## Mechanics findings (source/offline evidence)

1. **Sinking is an ownership/control failure, not a physics mismatch (W-G1, client side).** The integrity-pinned vendored prismarine-physics (26.2 compat build, also serving 26.1.2) uses `proportionalLiquidGravity` (waterGravity 0.005/tick); held jump adds 0.04/tick. Simulated over each exact version's real block states: from the floor of 5-deep water, held jump surfaces the eyes in **23 ticks (1.15 s)** and keeps them out while held; with controls released the eyes re-submerge in **22 ticks** and the body sinks to the floor. Installed pathfinder holds jump only while it has a path; `setGoal(null)`/`clearControlStates` (follow end, target loss, travel bound, lease release) leaves nobody holding jump. No vendor patch is proposed.
2. **Installed Mineflayer `bot.oxygenLevel` is wrong for us:** `entities.js` sets it from `air_supply` metadata of *any* entity. Own air is read only from `entity_metadata` addressed to the login entity id (exact-version `player` key `air_supply` = index 1 in 26.1.2 and 26.2). Air is sent only when it differs from 300, so never-stated air is `unknown`; surfacing starts from local submersion without waiting for air.
3. **Pathfinder water entry bypasses `exclusionAreasStep`:** installed `getMoveDiagonal` step-down and `getLandingBlock` accept a liquid landing without `safeOrBreak`. The C11 policy therefore wraps the Movements *instance's* `getBlock` (deep water / bubble column → `safe=false`), plus the step hook. Proven on the installed A*: baseline offers a bank→swimming-depth step; with the policy no entry, a dry detour, no successful path across a full channel, and wading 1-deep water still allowed.
4. Entity disposition cannot use minecraft-data `category` alone (enderman/piglin/zombified piglin filed as hostile, strider as hostile). Curated per exact names; `sulfur_cube` (26.2-only), `parched`, `camel_husk` are `unknown`.
5. Defense evidence: server `damage_event` per hit and `entity_status 3` only; visibility loss is reported as `target_not_visible`, never a defeat.

## Behavior delivered (owned modules)

- **Authority (review 1):** explicit `SafetyAuthority.basis` from the host: `owner_goal` (an admitted non-terminal manual owner goal — authorizes protection even while the automatic pause latch is set; covers planning/provider waits, task/window transitions, blocker replans), `unpaused` (no owner goal, stop latch clear; idle coverage when `coverIdle`), `none` (explicit stop without a newer owner goal, shutdown, not ready, dead). No dependency on memory/progression/supervisor guard.
- **Monitor:** local tick (default 250 ms) → fresh self/visible-entity facts → `planSafety`. Fluid hazards first (submerged, swimming depth via `wadeable`, low/unknown air while submerged, lava), then mobs.
- **Any active hazard preempts ordinary motion (review 2):** the current non-safety lease is revoked synchronously (`safety_preempt`) even when no safety action is possible; a declarative blocker then holds ordinary dispatch until the hazard signature changes (no rogue action).
- **Grant:** finite expiry, action count, cumulative attack budget (`reserveAttack` before each attack), displacement from origin, connection/dimension, authority basis. Enforced at dispatch, in every lease fence (`grantCurrent`) and while controls run (expiry timer + monitor watchdog).
- **Mob criterion (documented in `policy.ts`):** RETREAT is the default. Defense only when every readiness check passes — single supported adult target (zombie, husk, zombie villager, drowned without bow/crossbow/trident, spider), no creeper/ranged/group/provoked/unknown threat, server health ≥14 and food ≥7, dry footing on ground, server-stated stone+ sword/axe with ≥max(16 uses, 15%), armor ≥6 server-stated points (pieces ≥10% durability), **an observed retreat leg (escape terrain never waived)** — AND the target is already in melee contact (≤ min(closeRadius, 3.5) = entity reach 3.0 + body margin, never widened by config; a mob is never approached to start a fight) and engaging (server aggressive flag or server-attributed damage within the provoked window). A newly approaching mob is avoided even when the bot is fully equipped. No cornered fights: no leg → blocker. Each attack revalidates visibility/identity/reach/readiness/terrain; disengage at health ≤10 or ≥6 health lost; no pursuit (bounded re-engage wait). Unknown entities and aggressive neutrals are avoided on established visible danger; passive/neutral/players/owner are never attacked.
- **Water response:** surface by held jump only with open headroom; under a ceiling steer toward an observed open column (≤5), else a `no_reachable_surface` blocker (no blind jump); then swim to a visible dry exit (surface-connected, one climb). Exits outside the goal radius are allowed only inside the grant's displacement bound (explicit narrow exception; the anchor never moves).
- **Skills** (same descriptor/params/resolver/executor design): `escape_water`, `retreat_from_threat`, `defend_against_threat`. No grant/coordinate/entity id parameter exists; safety bounds come only from a verified `{kind:'safety'}` owner's current grant. Goal-owned use keeps the goal travel bounds.

## Integration for P (exact obligations)

Factory (no shared edits needed to construct): `createSafetyRuntime({ config, session, perception, inTag, authority, actuation: leaseActuation(leases, executor), clock, ids, record })` → `{ service: SafetyService, reader }`.

Shared edits requested (P owns):
1. `contracts/index.ts`: `export * from './safety.ts'`. Config: `safety: SafetyConfigSchema.optional()` (absent = enabled defaults).
2. `ports.ts`: `ExecutionOwner |= SafetyExecutionOwner` (`{kind:'safety', grantId, episodeId, connectionEpoch}`); `SkillOutcome.owner` enum add `'safety'`. `SkillExecutorImpl`: for safety owners skip goal-epoch/travel-anchor checks but **verify `service.grantCurrent(owner.grantId)` before acquiring**; TaskRuntime always passes its goal owner (planners can never supply a safety owner).
3. `SkillRuntime` `ActuatorLeases.ownerCurrent`: `owner.kind === 'safety' ? safety.service.grantCurrent(owner.grantId) : …`.
4. Registry: `...safetySkills(safety.service)` (catalog gains 3 capabilities; P decides planner visibility).
5. `onBotCreated`: `safety.service.attachConnection(bot._client, { connectionEpoch, registry: () => bot.registry })`. `onLifecycle`: call `safety.service.onLifecycle(event)` **before** lease/ledger invalidation.
6. Authority provider (`SafetyAuthority`, synchronous, cheap): basis from GoalEngine current goal source/state + explicit stop latch (owner goal ⇒ `owner_goal` regardless of latch; no owner goal ⇒ `unpaused` iff latch clear; else `none`), connection ready/epoch/dimension, alive, current goal, admitted travel bounds. Call `safety.service.onAuthorityChanged('owner_stop'|'resume'|'owner_goal_admitted'|'goal_terminal')` synchronously at those points (stop revokes before returning). `start()` after composition; `await close()` on shutdown.
7. TaskRuntime / route runner / any dispatcher: `await safety.service.waitClear(task.signal)` before EVERY dispatch (Jev and sustained local continuation); `clear` → re-observe fresh; `blocked` → one declarative blocker (recommend goal-level `safety_interrupted`-style hold without inference polling on an unchanged hazard; never a replan loop); outcome `cancelled` with reason `safety_preempt` = suspension (not a per-target failure, not unproductive; wait, then re-observe). Recommend excluding the suspension duration from the no-progress window (freeze, not reset). Nothing resets outcome/baseline/progress/turns/tasks/travel/spend.
8. Navigation: in `conservativeMovements`, `applyDeepWaterAvoidance(movements, safetyWorld(session))` when `config.safety.water.avoidDeepWaterPaths`.
9. Status/dashboard: `safety.service.status(now)` (bounded; `state`, `authority`, vitals/air provenance, fluid `local_estimate`, visible threats, episode, blocker, counters, limits). Optional planner observation: air/submerged facts.

## Harness footprint and guard review

- **Guard** (`tests/safety-harness-guard.test.ts`, exit 0): importing runs nothing; `main()` refuses with exit 2 before any password read, RCON, join or output directory unless `--fixture-lease <id>` matches `^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$` (spawned with missing/empty/`../evil`/1-char leases; no `var/live-check` entry created). The password is read only in the `Gate` constructor, which `run()` creates after the lease check.
- **Footprint, statically checked:** every `@e[...]` selector carries the scene `ENTITY_AREA`; every `kill @e` names the per-run tag or item/xp drops; every `fill` uses the declared AREA/POOL/BACKUP boxes; no gamerule, time or spawnpoint command; forceload removal only for trial-added chunks; a non-empty backup volume refuses the trial.
- **Restoration:** tagged mobs removed and verified; difficulty ALWAYS verified (restored when changed from peaceful, otherwise proven unchanged); bot inventory/effects cleared; scene drops removed; scene restored from the backup and verified with `execute if blocks … all`; backup cleared and verified empty; trial-added forceload removed and verified. Any failed step fails the report (`RESTORE` result).
- **Interventions are not credit:** every state-changing command inside a gate (tp/positioning incl. W1s surface placement, `/damage` in M2b, effects, equipment, summons, scene fills) is recorded in `interventions` with its gate and summarized in that gate's evidence as "setup only, no pass credit". Verdicts rest on server-read RCON facts and safety episode results after the intervention. W1 has a static check: no teleport after admission (no RCON rescue).
- **Executor selection (never silent):** `realSafetyExecutorAvailable()` probes whether the shared `SkillOutcomeSchema` accepts a `safety` owner. If yes (combined build), safety owners ALWAYS run through the real `SkillExecutorImpl` and the stand-in is never used; if not, the labeled stand-in runs (mechanics/module evidence only). The report records `executor: 'real' | 'stand_in'`; `--require-real-executor` refuses (exit 2) before any output or fixture access when the variant is absent. On this tree the probe returns `false` (stand-in).
- **Staging:** M2/M2b wait (no safety authority yet, so nothing acts) for a fresh visible read of the summoned zombie already engaging within melee contact (server aggressive flag or attributed damage, ≤3.5) before admitting the owner goal; otherwise the gate fails as `staging_unready` (retained). M2 asserts `defend` was chosen; retreat-default remains the product criterion for any non-engaging mob. W3's water breathing and teleport rescue and M2b's `/damage` are written into the gate evidence as `INTERVENTION (no credit)`. A missing/unreadable server position or health fails the gate instead of passing.

## Fixture lease request (not yet granted)

Harness: `node scripts/safety-live-check.ts --fixture-lease <id> [--fixture 26.2]` (pre-integration: real connection/SkillRuntime/SkillExecutorImpl for goal work, own single ActuatorLeases, a **labeled stand-in** safety executor until P's owner variant lands). Refuses (exit 2) without a valid lease before any password read/RCON/join/output (guard test).

- Footprint: scene x 240..270, y -61..-48, z 190..220; backup x 240..270, y 200..213, z 190..220 (must be verified empty; restored and re-verified). Disjoint from the skills/survival scene (x 196..224).
- Entities: only mobs tagged with a unique per-run tag (zombies get fire resistance; no time change), item/xp entities inside the scene box. Bot inventory/effects/position/health only.
- Settings: difficulty read; changed to easy only if peaceful, restored and verified. No gamerule/time/spawnpoint changes. Any failed restoration fails the report.
- Gates: W1, W1s (stop wins; sink + server air fall without authority, then escape once an owner goal is admitted), W2 (ordinary goal move_near across water → preempted or refused), W3 (ceiling blocker; water breathing; recorded tp intervention afterwards), M1, M2, M2b, M3, M3b, M4. Both fixtures (26.1.2 and exactly 26.2) required.

## Remaining evidence / open items

- No fixture, integrated-application or real Codex/Jev evidence exists (W1–W5, M1–M5 acceptance all open). Module evidence uses client physics and scripted packets only.
- Retreat skill movement is untested offline (needs the real pathfinder plugin on a live bot); its target selection, water policy and grant fencing are tested.
- Coordinator assumptions needing approval: equipment/health thresholds above; supported matchup list; idle coverage default on; `unknown` entities avoided on approach; health-loss disengage ≥6.
- Lava is detected and uses the same exit search; not separately proven.
- Difficulty (Hard damage) is not part of readiness yet.
