# MB-FLOW-003 — Survival routines and death recovery

Reported: 2026-10-06 UTC (2026-10-05 in Arizona). Status: **Proposed; unassigned.**
Subplan of [MB-FLOW-001 default progression](autonomous-progression-plan.md). Integrates [handoff](smooth-handoff-plan.md), [gameplay memory](gameplay-memory-plan.md) and [dashboard](chunkbot-dashboard-plan.md).

## Outcome and happy path

Chunkbot handles the ordinary upkeep a player would remember: eat, protect health, use suitable equipment, replace a worn tool, make inventory room, restock before a trip and return to a safe home. These routines support the current directive and progression instead of needing a separate owner command each time.

If Chunkbot dies, record the death location and what he was carrying. After respawn, assess what was actually lost, prepare only what is necessary, return by a supported safe route and collect recoverable belongings. Report full, partial or blocked recovery honestly, then reassess the interrupted directive. Do not repeatedly sacrifice more gear on the same unsafe route.

## Confirmed direction and coordinator assumptions

Jake requested death recovery, death coordinates and other automatic player habits as a subplan of overall game flow. The existing confirmed owner priority and stop/resume latch still apply.

Coordinator defaults:

- Automatic recovery is enabled with progression after an authorized connection. It takes priority over unrelated progression; Jake can redirect it or stop. A safety guard may interrupt an unsafe action while retaining the owner's intent.
- Recovery may also support an interrupted owner directive, but never silently mark that directive complete or discard it. Keep its unresolved state visible until continuation is safe and semantically valid, or Jake supplies a new instruction.
- Start with death recovery, eating/resting, equipment/tool upkeep, inventory space and basic resupply. Home/bed/night routines integrate with the parent's verified home. Replanting and more specialized mechanics are later slices of this subplan, each with its own capability evidence.
- Prefer ordinary safe food. Preserve scarce consumables, valuable tools and other players' property unless Jake explicitly authorizes their use.
- Proposed recovery limit: at most two attempts per incident, with another attempt allowed only after a meaningful improvement in route or preparation. A repeated death from the same unresolved hazard blocks recovery earlier. Choose finite search and upkeep thresholds in the gates below; they are not permission for endless activity.

Stop latches all autonomous action, including eating and recovery, until explicit resume. Recording a death and showing status may continue while paused. Logout leaves recovery pending for a future authorized connection; it never triggers a reconnect.

## Current implementation and gaps

Source inspection for this plan found:

- The [connection adapter](../src/game/connection.ts) enables respawn and emits death/respawn lifecycle events, but the death event contains no location, loss manifest or cause. [ChunkbotApp](../src/app/app.ts) revokes goal ownership and returns idle after respawn.
- [SkillRuntime](../src/app/skill-runtime.ts) invalidates perception, evidence and interface ownership on death. A bounded historical record must survive that invalidation without preserving executable handles.
- Registered skills already include eating through use_held_item, equipment changes, visible item pickup, crafting, containers and conservative navigation. They are primitives, not an automatic survival policy.
- [TaskRuntime](../src/tasks/task-runtime.ts) blocks work at low health. Adding an eating goal alone cannot solve that conflict. A narrowly admitted health-restoring or escape action needs its own verified prerequisites through the same execution boundary; do not disable the health guard globally.
- The filtered [observation contract](../src/contracts/observation.ts) exposes health, hunger and bounded inventory/equipment summaries. It does not yet supply all durability, oxygen, damage, sleep/spawn or time/weather facts these routines need.
- The installed 26.2 protocol's SpawnInfo has an optional death GlobalPos. Whether the adapter can reliably use it for the bot's own latest death remains a version-specific gate, including 26.1.2 regression. Do not assume Mineflayer already exposes it.

Mojang describes the recovery compass as pointing to the player's last death in the same dimension, and recommends a home emergency kit. This supports remembering one's own death, not access to hidden player/entity locations. [Recovery compass](https://www.minecraft.net/en-us/article/taking-inventory--recovery-compass).

Food, health, oxygen and equipment are ordinary survival concerns; exact regeneration conditions still depend on supported mechanics and observed server behavior. [Mojang's health guide](https://www.minecraft.net/en-us/article/health-minecraft). Neither reference establishes exact item persistence or timing for this server version.

## Routine policies

| Routine | Trigger and intended result | Important boundary |
| --- | --- | --- |
| Recover belongings | Death followed by fresh respawn state shows missing items. Retrieve what is safely recoverable before unrelated progression. | Own incident/location, bounded attempts, verified pickup; no guaranteed return of destroyed items or all XP. |
| Eat and recover health | Hunger or damage makes continuing risky. Eat suitable owned food and rest in a supported safe place until a verified threshold is met. | No repeated food use at full hunger, precious-food consumption by default, or endless waiting when regeneration is unavailable. |
| Avoid immediate danger | Observed damaging terrain, unsafe fall, low oxygen or nearby threat makes the active action unsafe. Cancel it; use a proven escape when supported. | Conservative navigation already avoids several hazards. New escape/air/combat primitives need evidence; no claim of an invulnerable reflex system. |
| Equip and maintain tools | A task needs an appropriate tool/armor, or the held tool is nearly worn out. Equip owned gear or obtain a bounded replacement/spare. | Check harvest requirements and admitted durability facts; avoid unnecessary wear/loss of valuable gear and do not invent repair/enchantment capabilities. |
| Make inventory room | Needed pickups/crafting would not fit. Deposit surplus in a designated, freshly inspected bot/owner-approved container while retaining useful supplies. | No arbitrary chest use or dumping valuable items. No approved storage is a prerequisite/blocker, not permission to throw everything away. |
| Restock before travel | Food, torches, fuel, basic tools or building supplies are below a task-appropriate reserve. Acquire only the shortfall. | Low/high thresholds and cooldown prevent gathering forever; upkeep must not continually starve the actual directive. |
| Use a safe home and spawn | A verified shelter is available and rest/night preparation is useful. Return, use a supported safe bed and verify the intended spawn/sleep result. | Start with approved Overworld beds; dimension safety, spawn-setting evidence and multiplayer sleep behavior need gates. One bot cannot assume it controls everyone's night. |
| Light approved work areas | A known home, work area or route needs lighting. Place a bounded set of torches using observed conditions and verified placement. | Later home slice; light/spawn mechanics need evidence. Only approved areas, with no claim that unknown rooms or routes are safe from mobs. |
| Keep work areas useful | Harvest approved crops, finish a small job or return home with loot. Replant when supported, store output and leave equipment ready for the next task. | Only bot-managed or owner-approved areas. No unsolicited alteration of Jake's farms, buildings or redstone. |
| Break stuck/retry loops | A route, target or recipe repeatedly fails. Stop that attempt, use fresh evidence to choose a materially different option, or show a blocker. | No repeated inference on unchanged state, silent travel-limit expansion, or mining/placing a shortcut through others' property. |

Use condition thresholds with hysteresis, cooldowns and a bounded upkeep allowance. For example, replenish a reserve once after crossing its low threshold, rather than interrupting for every consumed item. Exact counts depend on the directive and verified capability/recipe facts, not a fixed wood-to-stone-to-iron script.

## Death incident and recovery sequence

1. **Capture a bounded historical incident.** Maintain a last-alive snapshot so a death packet followed immediately by empty inventory/respawn cannot erase the evidence. Record stable incident ID, explicit world profile/revision, bot identity, dimension, death time, location source/accuracy, last pre-death inventory/equipment with freshness and available item metadata, observed cause or unknown, and the interrupted directive's semantic checkpoint. A last client position is an estimate; an optional own server-reported death location can refine it. Preserve the timestamp of each source rather than calling old inventory exact loss.
2. **Revoke before doing new work.** Cancel goal/planner/provider ownership, preparation and actuators through the existing lifecycle. Recording cannot delay cancellation for disk I/O. Commit the historical incident atomically through memory; invalidate all old handles, leases and interface bindings. No action starts until respawn and fresh connection-scoped state are established.
3. **Assess loss and feasibility.** Compare fresh server-confirmed inventory/equipment with the pre-death record. Retained inventory may mean no recovery trip is needed; do not assume keepInventory rules or query privileged server state. Missing/unknown pre-death evidence produces an explicitly partial manifest. Determine whether the location, route, gear and current health are adequate.
4. **Prepare minimally.** Use a small, freshly verified home emergency kit or acquire essential cheap food/tool/protection when that is feasible within the recovery budget. Reserve pickup space. Do not carry more irreplaceable gear into the same hazard or spend an unbounded time rebuilding before looking for the original belongings.
5. **Travel within accepted bounds.** Reuse catalog-backed navigation to an own-death location and known route. A death outside the current admission radius needs an explicitly accepted bounded route policy, such as [MB-LOC-001](locator-follow-plan.md), rather than silently moving the anchor. Unknown portal routes, unsupported dimensions and unsafe paths remain blockers. No teleport, RCON-assisted travel, hidden map or global dropped-entity scan.
6. **Reacquire and verify.** Only fresh visible drops in the scoped recovery area become candidates. Use existing server collection evidence plus authoritative inventory resync. Track regained quantities and identity/metadata only where proven. Item merging and mixed player drops can make origin uncertain; do not claim exact ownership or sweep unrelated loot. Ambiguous shared piles require a conservative boundary or owner clarification.
7. **Conclude or wait honestly.** Distinguish recovered, partially recovered, blocked, known destroyed and still missing/unknown. A local search finding nothing does not prove every item despawned. Item availability depends on server mechanics and loaded state; no fabricated exact countdown. Once bounded recovery ends, propose replacement of essential missing gear or ask for a specific blocker rather than repeating the same run.
8. **Reassess the original work.** Recovery completion is not completion of the interrupted owner goal. Continue only from a compatible semantic checkpoint with its original accepted outcome/baseline and verified effects. If that cannot be preserved safely, show the interruption and obtain clarification rather than re-admitting “collect N new items” with a new baseline. With no unresolved owner directive, resume progression through a fresh assessment.

Further deaths append related incidents; they do not overwrite the original valuable gear location with an empty-handed recovery death. Bound history/retrieval and distinguish each incident's losses and recovered items. Persist only historical facts and compatible semantic state, never old actions or an active lease. Reconnect/update behavior follows [MB-OPS-001](live-update-plan.md) and the owner's current pause/logout preference.

## Supervisor and integration boundaries

Use the MB-FLOW-001 application supervisor, the same generic GoalEngine admission path, catalog and task runtime. Routine trigger names are scheduling policies, not a goal whitelist or new resource-specific task enum. Code detects bounded conditions and verifies outcomes; the gameplay planner chooses supported prerequisites/steps. No model call per physics tick and no second direct Mineflayer controller.

Priority is stop/logout/lifecycle revocation, then immediate safety checks, then owner intent. Recovery and necessary upkeep support that intent and precede unrelated autonomous milestones. A new owner command can cancel recovery. Any automatic interruption retains the prior directive and explains why it cannot currently run. Normal handoff may continue safe current work during preparation; unsafe work stops immediately.

One actuator lease and one accepted execution owner remain. If a fast deterministic escape is justified, specify its small preapproved action surface through the same fenced skill/execution boundary and prove ownership/cancellation; a planner response is not a reliable emergency reaction time. Unsupported safety states block rather than bypass the boundary.

Recovery/upkeep consume the existing goal limits and logical-session budget. Aggregate the recovery episode's turns, tasks, replans and elapsed time across retry/subgoal admissions under ceilings no larger than the existing goal limits. Death, respawn, routine switching or an update must not reset attempt counters or the SpendLedger. A persistent unresolved hazard pauses with one clear blocker and no inference polling.

Memory adds historical death incidents, known hazards, approved emergency-kit/storage facts and interrupted-project summaries. The dashboard/status projection shows routine, reason, phase, incident/location provenance, recovered versus missing items, attempt count and blocker. Displaying this state is read-only and does not trigger actions or model calls.

## Seams and bounded research gates

Inspect src/game/connection.ts, src/game/server-evidence.ts, src/app/app.ts, src/app/skill-runtime.ts, src/goals/goal-engine.ts, shared lifecycle/observation/planner/status contracts, src/tasks/task-runtime.ts, src/skills/mining.ts, src/skills/inventory.ts, src/skills/placement.ts, src/skills/navigation.ts and the assigned supervisor/memory modules.

Proposed worker ownership: survival policy and recovery module, focused tests and assigned fixture scenarios after the shared supervisor/memory interfaces are defined. Codex owns contracts, lifecycle ordering, shared scheduler integration, config/manifests and final acceptance. Shared goal/lifecycle files overlap MB-FLOW-001/002; name one writer rather than launching competing edits. An isolated incident recorder or durability adapter may be a separate assignment once its interface is fixed.

- **R-G1 — Incident evidence:** verify death/respawn packet ordering, optional own death GlobalPos and null/cross-dimension behavior on 26.2 and 26.1.2. Demonstrate snapshot preservation before invalidation, source accuracy, retained inventory and multiple-death correlation.
- **R-G2 — Recovery mechanics:** fixture trials for pickup identity/counts, merged/mixed drops, inventory capacity, unavailable/destroyed items, loaded versus unloaded item aging, known/unknown routes and repeated hazards. Select finite search/deadline/attempt defaults from evidence; do not invent a universal wall-clock despawn timer.
- **R-G3 — Safety and health:** define the narrow low-health admission exception and cancellation rules for supported eating/escape. Verify healthy-food selection, unavailable regeneration, threatened eating and stop/replacement races. Add necessary general primitives; do not lower the health threshold to force work through.
- **R-G4 — Upkeep facts:** prove durability/harvest/equipment/reserve decisions and their metadata sources. Gate safe bed interaction, spawn verification, lighting, time/air/weather and approved replanting independently. Missing facts stay unknown; thresholds and hysteresis are bounded documented configuration.
- **R-G5 — Continuation and budgets:** prove interrupted owner outcome/baseline semantics with recovery pickups, count-based goals and partial crafting/building. Test pause/logout/update races, stale callbacks, episode caps and session charge continuity. If compatible continuation is unsupported, deliver an honest interrupted state instead of replay.

## Milestones and acceptance tests

Delivery slices: incident/recovery (R1–R5), core upkeep (R6–R7), then home/spawn/lighting and any approved replanting (R8). Each slice also meets its relevant continuation/budget integration cases (R9–R10). Parent A9 requires the recovery and core-upkeep slices; later slices stay explicitly pending until accepted.

| ID | Observable acceptance |
| --- | --- |
| R1 | Controlled fixture death preserves correctly scoped position/provenance and last-alive inventory across immediate respawn/invalidation. Unknown cause/location/metadata remains unknown; retained inventory avoids an unnecessary trip. |
| R2 | Real planner/Jev returns to an accessible death site and recovers belongings through server-confirmed collection/inventory evidence, with no in-trial teleport, item restoration or route fix. Full and partial recovery are distinguished. |
| R3 | Missing/destroyed/merged/mixed drops and full inventory produce accurate bounded behavior. No broad loot sweep, fabricated ownership, exact despawn promise or guaranteed XP restoration. |
| R4 | Far, cross-dimension, obstructed or repeatedly fatal recovery routes stop with a useful blocker. A later recovery death retains the original incident and cannot reset the episode limit. |
| R5 | Stop before death, after respawn, during preparation/travel/pickup and while a provider awaits prevents further autonomous action. Logout/update races preserve intent; stale callbacks cannot restart recovery. |
| R6 | Suitable food use and bounded rest work at admitted low health through the same fenced executor. No food, risky food, full hunger, unavailable regeneration and unsafe escape scenarios terminate honestly without guard bypass or loops. |
| R7 | Appropriate owned equipment is selected; nearly worn or unsuitable tools cause a bounded replacement. Inventory/resupply uses designated verified storage and reserve thresholds, preserves valuable items and does not continually preempt the directive. |
| R8 | A supported home/bed trial verifies sleep/spawn behavior without unsafe dimension use or assumed server-wide night control. Lighting/replanting included in the assigned slice affects only approved areas and verifies its actual result without asserting unknown surroundings are safe. |
| R9 | Interrupted count-based owner goals retain original semantics; recovered prior possessions cannot double-count as newly acquired work. New owner instructions take priority; unsupported continuation remains visibly interrupted. |
| R10 | Fake clocks, repeated deaths and unchanged blocked conditions prove finite attempts, cooldowns, accumulated limits and no model polling/reset spending. A combined real fixture trial resumes useful progression after verified recovery with honest memory/dashboard status when available. |

Required checks when implemented: affected AGENTS.md typecheck/build/test and both doctors; connection/lifecycle, skill/evidence and fault-controller regressions; planner diagnostic/fault checks for supervisor/admission changes; then coordinator-run real-provider fixture acceptance and the new R scenarios. Retain 26.1.2 regressions. Current installed harnesses do not certify automatic recovery. Add/document actual new harness entry points during implementation, lease the local fixture and record all setup/interventions. Workers never fetch keys; real-provider checks retain the existing cap. No live-world fault tests.

## Remaining delivery

All automatic policies, durable incident capture, safe recovery, new metadata/primitives, continuation semantics and end-to-end evidence remain unimplemented/unverified. Assign staged briefs after MB-FLOW-001/002 and MB-MEM-001 integration seams are settled; no workers or runtime setup are authorized by this proposal. Review target: docs/reviews/mb-flow-003-survival-routines.md.
