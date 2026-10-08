# MB-FLOW-003 — Survival routines and death recovery

Reported: 2026-10-06 UTC (2026-10-05 in Arizona). Status: **Native implementation integrated into development in [batch002](feature-batch-002-plan.md); acceptance incomplete, not deployed. Water and continuation reports recorded for planning.**
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

## Baseline at initial planning

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
6. **Reacquire and verify.** Only fresh visible drops in the scoped recovery area become candidates. Use existing server collection evidence plus authoritative inventory resync. Track regained quantities and identity/metadata only where proven. Item merging and mixed player drops can make origin uncertain; do not claim exact ownership or sweep unrelated loot. Ambiguous shared piles use a conservative boundary or a declarative blocker, never a follow-up question under MB-PLAN-006.
7. **Conclude or wait honestly.** Distinguish recovered, partially recovered, blocked, known destroyed and still missing/unknown. A local search finding nothing does not prove every item despawned. Item availability depends on server mechanics and loaded state; no fabricated exact countdown. Once bounded recovery ends, assess a supported replacement of essential missing gear or state the concrete blocker rather than repeating the same run or asking a question.
8. **Reassess the original work.** Recovery completion is not completion of the interrupted owner goal. Continue only from a compatible semantic checkpoint with its original accepted outcome/baseline and verified effects. If that cannot be preserved safely, show a declarative interruption instead of re-admitting “collect N new items” with a new baseline. MB-FLOW-003-C12 supplies the required continuation delivery gate. With no unresolved owner directive, resume progression through a fresh assessment.

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

Native incident capture, survival policies, durable recovery authority and skills are integrated in development. The second actual module trial passes death capture/canonical dimension/recovery admission but fails post-collection persistence and mixed-pile/full recovery (C9/C10); current server clock-reply parsing also needs a passing rerun. The first slice intentionally holds unsupported owner continuation. Real ordinary planner/Jev recovery, shared supervisor integration, core upkeep and continuation are not accepted. The last live batch001 application has neither these policies nor configured persistent memory. C11/C12 below define the new water and continuation requirements; this intake implements nothing. Review target: docs/reviews/mb-flow-003-survival-routines.md.

## Batch002 contract review and decisions

Native contract milestone `545da3a37cb4449f5b1bf10a670bf7ed1cd564aa` proposes the authoritative `SurvivalPolicyPort`, `LowHealthAllowancePort` and episode schemas. The progression worker consumes those ports and owns shared composition; no competing policy or health exception is approved. The original milestone is not feature acceptance.

**MB-FLOW-003-C1 — Support authority and truthful recovery outcomes.** Recorded from contract review before acceptance. Each low-health allowance binds to one admitted task, goal/epoch, connection and dimension, with fixed expiry, capability/item restrictions and consumed-action ceiling. Candidate filtering and a fresh check after the Jev await precede fenced execution. Renewal cannot reset or extend the admission. `concluded` recovery is distinct from all items regained: partial, unknown and blocked outcomes retain their own labels and cannot satisfy a claim that all belongings returned. Cause-based likely destruction does not become proven destruction.

For the first release, unsupported interrupted owner directives remain visible and require an owner decision. Predicate shape alone does not establish compatible continuation. Bare resume clears the stop latch without dismissing or replaying that directive; a new explicit owner instruction may supersede it. Necessary recovery may run while unrelated progression waits.

C1 remains open for retained inventory: source `9af4ef35` still sends the retained respawn manifest to memory as `regained`, although the shared memory milestone now supports a distinct `retained` field and `no_loss` status. Carry retained possessions through that field; a keepInventory trial must leave memory's regained count at zero and cannot claim recovered work.

Lifecycle ordering is synchronous ownership revocation, survival's packet-frozen last-alive capture, memory recording from that same capture, then evidence invalidation/resource teardown. Disk writes cannot delay capture or cancellation. Initial codec listeners attach before ready; packet provenance, ordering and metadata still require actual version-specific fixture evidence.

Small eat/rest tasks use the same GoalEngine admission and TaskRuntime with a support source. Normal autonomous runs compose core survival under the same explicit world/revision/bot scope, respecting an explicit disable and diagnostic/inference-free suppression. Far own-death travel uses the locator's code-owned route port only after integration, bound to the current proven incident and admission; missing authorization remains a blocker.

**MB-FLOW-003-C2 — Every allowance dispatch counts.** Review of the shared task-runtime milestone `ea5903d4` finds fresh filtering/consumption only around the Jev dispatch, while the existing sustained local-continuation branch also executes actions. The same fixed grant and chosen-candidate recheck must cover both branches, with conservative accounting for each dispatch even on cancellation/exception. Otherwise local windows can avoid the declared maximum action count. This shared correction belongs to the progression writer; survival provides the canonical grant/recheck semantics. Prove the last admitted action, a further sustained window, expiry and stop/replacement during an await. No global health threshold change is approved.

**MB-FLOW-003-C3 — Recovery pickup scope and identity.** Reported in coordinator review on 2026-10-07 UTC (2026-10-06 Arizona); correction assigned, not accepted. At survival milestone `5e39cb5368595d0bff52e206d1f536e8b7502865`, `recover_lost_items` selects a visible drop by registry key and radius, collects the whole entity stack, and clamps only the quantity recorded as regained afterward. An inference-free resolver probe with one bread sought offered an observed stack of 64 bread. The resolver also omits the existing named-target scope, and a registry-key/count manifest alone cannot prove that a valuable named or enchanted item was returned. These are source and offline findings; no fixture pickup has yet been run.

Before movement or collection, require fresh authoritative stack facts, the admitted target scope and conservative checks for oversized/merged piles and nearby unrelated loot that ordinary pickup could collect. Revalidate through movement. Do not parse display labels as authoritative item counts. Ambiguous origin or unproven valuable-item metadata must remain explicitly uncertain or blocked, rather than collecting first and counting less afterward or claiming full recovery. Preserve valuable/custom items during food and upkeep selection too. Survival owns its new skills/service; the progression writer supplies any necessary shared perception or executor facts. Acceptance requires an oversized-stack refusal, named-target fencing, metadata ambiguity, a mixed-pile fixture trial, and ordinary unambiguous recovery with server-confirmed collection evidence.

**MB-FLOW-003-C4 — Necessary support for interrupted owner intent.** Recorded on 2026-10-07 UTC (2026-10-06 Arizona), not accepted. The integrated supervisor marks an already interrupted owner directive as ownerIntentPending, and survival `311b8db0` returns none before using ownerIntentInterrupted. A real-service inference-free probe with health 6, food 12 and owned bread returns no action when both flags are true; clearing only the pending flag produces the bounded safety-eating proposal. Distinguish a currently preparing/unanswered owner instruction from an already interrupted retained directive. Necessary survival/recovery may support the latter while keeping its outcome/baseline held and unrelated progression blocked. Prove owner death/low-health interruption, support, unchanged unresolved intent, resume and a newly superseding owner command, including restart. Progression owns shared flag/status/persistence composition; survival owns policy and its canonical port.

**MB-FLOW-003-C5 — Durable recovery authority.** Recorded on 2026-10-07 UTC (2026-10-06 Arizona), not accepted. Source `311b8db0` queues attempt persistence but lets recoveryTarget authorize immediately; a failed store write records an event without withdrawing authority. An actual-service offline fault probe, using the provided beforeRename seam after a previously saved incident, refuses the attempt save and still receives an authorized recovery target. Recovery can then move without the persisted attempt needed to enforce restart limits. Keep the exact death/memory link and current attempt/budget durably committed before recovery actions; pending or failed writes expose a bounded waiting/blocker and cannot authorize travel/pickup. Capture and goal revocation remain synchronous and cannot wait for disk. Prove a held write, failed write, restart, exact memory-fact durability, cancellation during the wait and successful recovery after persistence. Survival owns its store/authority; progression owns any shared admission/memory durability seam.

**MB-FLOW-003-C6 — Gate restoration and behavioral assertions.** Recorded in coordinator source review on 2026-10-07 UTC (2026-10-06 Arizona), before a survival fixture lease. Harness `a660d21d` records settings-restoration failures only as warnings, omits final scene restoration, and uses item-removal selectors beyond its declared scene. Its regeneration trial records health values without requiring a verified improvement, and its eat support can be labeled complete after a partial hunger increase. Correct the setup/cleanup footprint and verify all changed scene/settings state; failed restoration fails the report. Assert the actual admitted food/rest thresholds and meaningful server-confirmed health recovery, with unavailable regeneration remaining an honest bounded result. Bed interaction alone is an observational mechanics probe, not proof of sleep/spawn behavior; any supported R8 claim needs the actual server result. These are harness review findings, not live survival failures. Preserve the module-versus-integrated-application evidence distinction.

## MB-FLOW-003-C7 — canonical death-location dimensions

Reported: 2026-10-07 03:03 UTC. Status: failed integrated module trial; worker correction in progress, not accepted. Frozen combined source674dab6 (749 offline tests pass) fails `G2` in `2026-10-07T02-56-19-968Z-survival`: G1 captures the correct server GlobalPos in `minecraft:overworld`, but current Mineflayer/observation context uses `overworld`; literal dimension comparison prevents the recovery proposal and the trial receives resupply instead. This is a real supported-fixture boundary missed by fake tests. Keep exact server provenance/location/capture link, normalize only recognized vanilla dimension aliases to the application's canonical form, preserve arbitrary distinct dimension identities, and make the tracker, persisted episodes and policy compare the same identity. Acceptance: ordinary server-packet deaths in both exact versions yield an own-incident recovery proposal with same-world authority; true cross-dimension cases still refuse; old namespaced stored incidents are handled conservatively; stop/revocation and the exact memory link remain intact. Worker source correction began during its diagnosis before this coordinator record; no fixture rerun or acceptance is implied.

## MB-FLOW-003-C8 — current settings query syntax/parsing

Reported: 2026-10-07 03:03 UTC. Status: integrated harness setup failed; worker correction in progress, not accepted. The same trial's SETUP cannot read original keepInventory/naturalRegeneration/daytime and reports nothing changed, so with-settings G1k/G3/G4 never ran. Its five restoration checks pass and source/build remains frozen. Update the harness against each exact release's official command report and actual bounded query responses; require successful original snapshots before any setting writes, and verified restoration with honest failures. Preserve this exit1 report. The original 26.1.2 lease allows no rerun or acceptance-checkout source mutation; a new reviewed snapshot/grant is required after correction.


Corrected trial 2 (2026-10-07 03:16 UTC, immutable2472442) preserves exit1. C7 now passes: death is canonical overworld, offset0, same-capture durable memory and recovery proposal/attempt authority are verified. Current command names read keep_inventory=false and natural_health_regeneration=true, but the clock reply is “Clock minecraft:overworld is at 3466899 tick(s)”; the old TIME_REPLY still fails and no settings are changed. S-C8 remains open with this concrete response. Five restoration checks pass; native Claude quota prevents further implementation in its route.

**MB-FLOW-003-C9 — invalid post-collection persistence.** Recorded before correction from the same actual trial: after a server-confirmed cobblestone20 collection, the attempt write fails schema validation (“Too small: expected number to be >0”), revoking further authority as attempt_write_failed. Diagnose the invalid stored record, retain attempt/budget accounting, and prove full collection/persistence/restart. No source fix or acceptance is inferred from this report.

**MB-FLOW-003-C10 — mixed-pile trial inventory exceeds the admitted lost manifest.** Recorded before correction: G2 RCON sees bread5 where the manifest lost4; G2b sees cobblestone84 and no recovered iron pickaxe/enchanted sword, while full recovery is not claimed. Inspect actual server-stated summoned stack counts, identity, passive pickup during travel/collection and the action/partial-effect journal before attributing the cause; the setup prose alone does not prove an oversized foreign stack. Keep known foreign piles and unrelated loot outside recovery authority and report incidental effects truthfully. The failed trial remains evidence, not acceptance. Report: batch002-2472442/var/live-check/2026-10-07T03-16-10-804Z-survival/report.json.

## MB-FLOW-003-C11 — Water safety during following

Reported: 2026-10-06 Arizona (2026-10-07 UTC). Implementation authorized: 2026-10-07 Arizona. Status: **Assigned to parallel immediate-safety work, with one shared integration writer.** Jake reports repeated drowning during follow, including immediate sinking when follow was lost around the 128-block distance. Affects ordinary follow and shared navigation, not only future autonomous survival. [Locator regression dependency](locator-follow-plan.md#mb-loc-002--wrong-direction-and-distance-loss).

### Evidence and outcome

Incident context: live run-9d8d6a18e52b, eggyBot69 on Java 26.2/protocol 776 using accepted d348d58. Exact failed goal, fluid depth, oxygen history, server corrections and action/control sequence are not identified. The source navigation policy allows water with liquidCost 4; water is not in the dangerous-block avoidance list. Follow clears its path/controls on task exit or ownership loss. The model-visible observation supplies health/food but no air/submersion facts. No existing gate certifies following across deep water or floating after follow ends. These are seams, not proof that a specific physics patch or path-clear call caused the report.

While authorized gameplay is active, Chunkbot must avoid unsupported water entry and promptly use a proven local surface/shore action when submerged. Losing sight, changing follow windows, finishing a route leg or hitting a route limit must not discard the protection needed to leave water. After escape, freshly reassess the owner directive without asking questions. Do not accept far following until this works on the actual 26.2 physics stack.

### Scope and defaults

- Begin with swimming/surfacing and safe shoreline exit, usable by existing follow, move_near, exploration and locator/death-site navigation. Boats, ocean expeditions, underwater mining, potions, bubble-column travel and combat are excluded unless separately supported.
- Prefer an observed safe dry route. If swimming is unproved, refuse a water-crossing path with a concrete blocker; a higher water cost alone is not drowning protection. A safe detour cannot require unseen terrain or navigation digging/placing.
- Track current own submersion, relevant fluid/head clearance and air/health with connection/dimension/freshness/provenance. Use supported server metadata where available and label local physics estimates separately. Missing air is unknown, not a full reserve; do not infer a safe state from health remaining high.
- Detect unsafe submersion locally; do not wait for a Codex/Jev turn to begin a proven emergency response. Use the same fenced executor/lease with a narrowly code-owned safety grant, finite action/time/displacement bounds and verified prerequisites. No independent controller or unowned setControlState loop.
- Suspend unsafe following, clear competing path controls, surface with a verified control pattern, then use a freshly observed reachable shore when needed. Do not blindly jump under a solid ceiling, chase the owner's vertical position underwater, dig a tunnel, or keep swimming into a wall.
- Safety spans normal movement/task transitions and a natural follow blocker while gameplay remains unpaused. Specify ownership transfer before implementing it; a stopped task cannot continue using its revoked lease. Any necessary emergency travel exception is explicit, narrow and code-owned, never a route re-anchor/global radius increase.
- Explicit stop/logout/death/disconnect wins. Stop revokes ordinary and safety controls and latches paused; it does not leave a hidden buoyancy worker. Status may state that the paused bot is submerged without asking a question. Logout disconnects and never starts a safety reconnect.
- On initial join/respawn, assess fresh self state before ordinary movement if this safety policy is enabled. No retained controls/handles from the previous lifecycle. Do not enable persistence-dependent automatic work by guessing a world scope.
- After surfacing, prove current clearance/air recovery as available before resuming compatible work. Unsupported/no-exit conditions produce one truthful blocker; no repeated model calls or repeated fatal attempts. Persist historical hazards/incidents only under the correct configured scope.

### Bounded gates and source ownership

Inspect src/skills/navigation.ts and movement.ts; src/execution/actuator.ts and lease.ts; TaskRuntime low-health/local-continuation branches; src/app/skill-runtime.ts; own metadata in game/server-evidence.ts and connection.ts; perception/observation/survival contracts and supervisor policy. Inspect installed pinned pathfinder/swim logic and integrity-recorded prismarine-physics/Mineflayer compatibility inputs. Never hand-edit node_modules.

| Gate | Question, probe and decision |
| --- | --- |
| W-G1 | Is sinking a control/ownership failure or a physics/data mismatch? On separately leased 26.1.2 and 26.2 fixtures, record server-observed body position, fluid/ceiling state, air metadata, health, corrections and actual controls for shallow/deep still water, a current and a wall. Compare installed physics/control behavior before proposing a vendor patch. |
| W-G2 | What surfacing/exit action is mechanically supported? Verify held jump/swim controls, available head clearance, an observed shore and no-path cases. Choose measured conservative air thresholds, finite episode bounds and hysteresis. A dry-land motion unit test or lack of death in peaceful mode does not prove underwater safety. |
| W-G3 | Who protects a boundary transition? Exercise visibility loss, 128-block ordinary bound, expanded-route exhaustion, follow-window settlement and replacement while in water. Decide the single-lease/safety-grant handoff and cancellation order, including stop during each await. Unknown authority cannot authorize a reflex. |

| ID | Observable acceptance |
| --- | --- |
| W1 | Controlled supported deep-water follow surfaces and exits/holds safely with server-confirmed air/health/position evidence. No drowning damage or death, no RCON rescue, and no provider round trip for the immediate response. Test both versions at unchanged recorded survival settings. |
| W2 | Visible follow and locator-seeking cross a supported water route, or deliberately choose a safe detour/blocker. Repeat owner visibility loss, ordinary radius failure, route exhaustion and task-window completion in water; protection survives natural transitions. |
| W3 | Low air, missing/stale metadata, ceiling, flowing water, unreachable shore and repeated hazard yield bounded truthful behavior. Unsupported crossings are refused before entry; no invented swim capability or endless retry. |
| W4 | Stop/replacement/logout/death/dimension change cancel controls and callbacks correctly; an old safety lease cannot move a new goal. Low-health escape uses the narrow existing admission rules; counters/budgets do not reset. |
| W5 | Combined immutable-build normal Codex/Jev follow trial passes after the local mechanics gates. Record fresh final vitals, actual motion and all fixture restoration; dashboard/status reports safety/blocked state accurately. |

Future split: survival worker owns new safety policy/metadata consumption and focused tests; the designated shared writer owns existing navigation, actuator, task/goal/app/contract wiring. Locator consumes the agreed safety port. Codex approves any vendor change and runs AGENTS.md affected checks, both fixtures' mechanics/compatibility regressions and real ordinary-goal acceptance. New harness entry points must be documented when they actually exist; no probe is run by this intake.

## MB-FLOW-003-C12 — Resume compatible work after recovery

Reported: 2026-10-06 Arizona (2026-10-07 UTC). Implementation authorized: 2026-10-07 Arizona. Status: **Assigned across recovery service and the designated shared GoalEngine writer.** Jake asks whether the planned loop, retrieval and resuming work have started. They have substantial native development source; the live release has no automatic recovery/progression, and compatible owner-work continuation is still missing. C1's first-slice held state is a safety boundary, not delivery of the eventual resume outcome.

Happy path: an owner job has verified partial progress; death revokes it; a durably recorded bounded recovery returns the belongings; fresh observation and code validate the semantic checkpoint; the planner chooses only remaining supported work; the original outcome is verified; progression resumes only after a finite owner job is finished. A persistent follow job returns to seeking/visible follow rather than being marked complete by recovery.

### Required continuation contract

- Hold the original owner instruction, immutable accepted outcome, admission inventory/anchor semantics, verified effects, remaining goal/session limits and explicit pause/supersession state. Recovery is separate supporting work and cannot satisfy the original job by itself.
- Never resubmit the old sentence as a fresh “collect N additional” goal or replay saved tasks/actions/handles. Define a typed code-owned continuation seam, with fresh epoch/connection bindings and reference/outcome revalidation, that preserves original semantic accounting. If the GoalEngine cannot preserve it yet, continuation remains blocked until that seam exists.
- Recovered prior possessions cannot count as newly gathered resources. Previously completed crafts/placements remain historical verified effects, while possession/equipment/structure conditions require fresh server truth. A replacement goal from Jake supersedes the held directive immediately.
- Stop/logout blocks recovery and continuation; bare resume clears only the pause latch and starts a fresh admissible assessment. It is not permission to replay an unsupported checkpoint. No automatic reconnect or update manager is included.
- First deliver compatible continuation after respawn/safety interruption in the same authorized application session. Restart may retain a non-executable scoped checkpoint, but does not silently resume it; restart/update continuation needs its own proven budget/semantic compatibility and release policy.
- If continuation or recovery is partial/unsupported, choose a safe supported next step within the original contract, or state one declarative blocker. Never ask a follow-up, silently change the outcome, abandon held owner intent for unrelated progression, or refill allowances by creating a new goal.

### Gates, milestones and remaining evidence

Gate RC-G1: inspect actual held owner checkpoint, GoalEngine outcome binding/evidence invalidation, supervisor admission and durable stores. Probe a count-based job with pre-death progress, recovered items and consumed ingredients. Decide a versioned semantic continuation schema and what is demonstrably compatible; predicate shape alone is insufficient.

Gate RC-G2: run genuine pickup/persistence acceptance after correcting C9/C10 and current clock parsing. Distinguish full recovery, partial pickup, incidental loot and keep-inventory retention before trying to resume. Use current server inventory/item identity as the oracle; no in-trial restored gear.

| ID | Observable acceptance |
| --- | --- |
| RC1 | Real Codex/Jev owner resource job dies after verified partial work, recovers accessible gear and continues only its remaining original job. Demonstrate preserved acquisition baseline and no double credit from recovered items. |
| RC2 | Partial construction/crafting/equipment and persistent follow each freshly re-ground supported remaining work. No duplicate craft/placement, false completion, question or saved action replay. |
| RC3 | Partial/unsafe recovery, unsupported checkpoint, stop, new owner command, restart and another recovery death remain truthful and bounded. Attempt/turn/task/elapsed/spend allowances survive supporting admissions without reset. |
| RC4 | With no held owner job, verified recovery returns to fresh useful progression. Status/memory/dashboard distinguish held directive, supporting recovery and actual continuation; ordinary pipeline acceptance proves the loop. |

This gate refines R9–R10 and parent A9; it does not replace their full feature acceptance. Progression/shared writer owns continuation admission and checkpoint/status composition; survival owns durable incident/recovery authority. Codex owns schema approval, combined review and real-provider checks. Persistent scope must be explicitly configured before recovery is installed in the real profile. Existing failed recovery reports remain open evidence, and no new release is accepted by this document.

## MB-FLOW-003-C13 — Survival first around mobs

Reported and implementation authorized: 2026-10-07 Arizona (2026-10-08 UTC). Status: **Assigned with C11 to the immediate-safety worker.** Jake reports poor mob handling and requires Chunkbot to prioritize his own survival regardless of the active job. Avoid mobs, or fight when current tools/armor and conditions make defense reasonable. Exact mob types, damage events and failed goal traces are unspecified; the report is user evidence, not a proven classifier or attack defect. Context is the preceding Java 26.2 live play on accepted batch001, which lacked batch002 survival.

Happy path: Chunkbot is following, collecting or building; a fresh visible hostile threat enters a bounded danger area. Code suspends unsafe work promptly, releases its competing controls, chooses an observed escape or a supported defensive engagement, verifies improved safety, and freshly resumes compatible remaining work without changing the original goal outcome. Immediate protection cannot wait on a new model turn. Being equipped alone does not make every mob safe to fight.

Confirmed direction: survival takes priority over work; avoidance and appropriately equipped fighting are both requested. **Coordinator assumptions:** prefer retreat; initially admit defensive melee only against individually supported, reachable threats with adequate equipped weapon/armor, durability, health/food and escape space. Creeper fuse/explosion, ranged threats, groups, low health, missing equipment, unknown disposition and unsafe terrain favor avoidance. Do not chase passive mobs or provoke neutral mobs merely because they are nearby. Never attack the owner or another player. No follow-up questions, automatic gear restoration, ranged-combat expansion or invulnerability promise is included.

### Mechanics, observation and ownership

- Consume bounded current player-visible entity observations with provenance/freshness and the actual supported release's entity/mechanics facts. Hidden global mob scans/coordinates cannot enter the models or policy. Supported damage/source packet evidence may corroborate a threat; unexplained damage remains unknown.
- Expose threat/retreat/defending/blocked status truthfully and quietly. Distinguish visibility loss from server-proven defeat. Validate attack reach, current target identity, server effects and equipped item facts at dispatch; a target leaving view is not a kill.
- Add a code-owned local safety policy through the same task/executor/lease infrastructure used by C11. There is one actuator owner. A finite safety grant explicitly suspends unsafe work and transfers ownership; old task cleanup cannot clear the new lease. Use finite duration/action/displacement and repeated-hazard ceilings. No unowned combat loop or model-granted escape authority.
- Reassess each bounded response from fresh state. Retreat follows observed safe geometry, accounts for water/falls/lava and route bounds, and cannot dig/place towers or roam indefinitely. No supported exit produces a declarative blocker with actual safety state. Do not freeze silently while continuing a hazardous goal.
- Explicit stop/logout/death/disconnect/dimension change wins over safety and cancels every timer, interface and control. Join/respawn starts from fresh assessment; startup replays no saved target. Normal task/window/route transitions retain safety coverage while gameplay remains unpaused.
- After safety, retain original admission semantics, immutable outcome, verified progress and remaining allowances. C12 supplies compatible continuation after death/recovery; a survival action cannot complete the owner job or refill its budgets.

### Bounded gates and acceptance

**M-G1:** inspect actual entity observation, damage/metadata and existing attack/pathfinder behavior for vanilla 26.1.2 and exactly 26.2. Use credential-free unit probes, then a leased bounded arena with recorded summons/settings and finally restoration. Decide which hostile matchups, equipment facts and escape mechanics are actually supported. Keep unsupported cases in avoidance.

**M-G2:** inject a threat during sustained following, mining, planner preparation and a local safety transition. Observe revocation, lease transfer, action fencing and fresh post-response continuation. Decide shared wiring from the real task/goal lifecycle rather than adding a second controller.

| ID | Observable acceptance |
| --- | --- |
| M1 | Unequipped/low-health Chunkbot promptly stops unsafe work and increases server-confirmed separation from a supported visible threat using a safe observed route; no inference is required to trigger protection. |
| M2 | With verified appropriate gear, a supported isolated melee threat is defended against using bounded attacks and code-verified effects. Downgrade to retreat when health/equipment/target conditions change. No player/passive/neutral accidental attacks. |
| M3 | Creeper/ranged/group/hidden/stale/unknown-threat and blocked escape cases remain conservative and bounded; water safety is retained; no fabricated kill/safe claim or endless retry. |
| M4 | Stop/replacement/death/disconnect/dimension changes clear owned actions promptly, stale callbacks cannot move/attack, and original goal accounting survives a safety pause. Both supported fixtures prove actual mechanics. |
| M5 | Combined ordinary Codex/Jev follow and resource goals respond to real fixture mobs while preserving their immutable outcomes and resuming compatible work. Record model calls, action journals, vitals, server evidence and restoration separately from module evidence. |

W owns new safety contracts/modules/tests/harnesses; P owns existing perception/game/task/goal/navigation/app wiring; S owns recovery state; L consumes the approved safety seam. Codex reviews contract and combat admission defaults, grants exclusive fixture driver leases and runs required integrated/provider checks. Any vendor change requires a separately reviewed reproducible patch; never edit node_modules.
