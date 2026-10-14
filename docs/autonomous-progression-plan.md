# MB-FLOW-001 — Default survival progression and a home

Reported: 2026-10-06. Status: **Native implementation integrated into development in [batch002](feature-batch-002-plan.md); real/combined acceptance incomplete, not deployed.**
Parent: [companion upgrades](companion-upgrades-plan.md). Foundations: [handoff](smooth-handoff-plan.md), [memory](gameplay-memory-plan.md).
Subplan: [MB-FLOW-003 survival routines and death recovery](survival-routines-plan.md).

## Outcome and happy path

After Jake connects Chunkbot, Chunkbot assesses inventory, nearby terrain and remembered projects, then chooses a useful survival milestone. It gathers supplies, improves tools/equipment, establishes a small home and continues with another useful milestone instead of waiting between owner commands.

Jake asks for help; that directive takes priority. A finite owner task finishes, Chunkbot reports its verified result, then returns to progression. A persistent follow directive retains priority until stopped or blocked. Stop pauses all autonomous work until an explicit resume.

## Confirmed decisions and coordinator assumptions

Jake confirmed progression as the default after connection, owner priority, return after finite completion, and the stop/resume latch.

Coordinator assumptions:
- A small practical shelter with roof, usable entrance, crafting/furnace access and storage is the initial home-building target. Elaborate architecture, settlements and every end-game mechanic are later capability extensions.
- Progression is available through normal run, not auth login, connect-check, doctor or diagnostic harnesses. A fresh world/profile starts with progression enabled; the owner stop latch is preserved across restarts until resume.
- Add !chunkbot resume (and the terminal equivalent) as an explicit control. !chunkbot status shows mode, active directive, next preparation, progress and blockers. Ordinary Minecraft goals remain open-ended.
- If an owner task blocks, preserve and show its unresolved intent; do not silently abandon it for unrelated progression. Finite verified completion is the automatic return trigger. Jake's later MB-PLAN-006 policy requires reasonable grounded defaults and no follow-up questions.
- Prefer useful verified work over artificial motion. Rest or pause on a real prerequisite/provider/safety limit; state the blocker declaratively rather than waiting for a requested answer.

No automatic Microsoft login, server connection/reconnect service, model billing fallback or indefinite unbudgeted calls.

## Proposed architecture and behavior

Add an application-owned progression supervisor above the existing GoalEngine. It selects goals through the same catalog-backed planner and single admission path; it never controls actuators directly. Represent source/priority (owner versus progression), persistent projects and operating mode separately from task capabilities. Do not add resource-specific command handlers or a hardcoded log-to-stone-to-iron loop.

Use durable verified milestone/project summaries plus current perception. Ask the planner for the next achievable outcome and reason, considering tools, food, shelter, known supplies and actual implemented capabilities. The result is still a bounded goal with immutable, code-verified completion.

- One active goal, one pending preparation and one actuator owner. Owner intake cancels autonomous preparation and uses the handoff protocol.
- Look ahead while a valid task executes. Commit a prepared milestone only with fresh observation, baseline and reference validation.
- Keep goal turn/task/deadline/replan limits. Add a session-level scheduling/attempt bound and cooldown so repeated blocked goals cannot reset limits and spin forever.
- Preserve the existing per-run SpendLedger and USD 1 cap across all milestones. Empty or ambiguous outcomes never trigger a fresh ledger. Subscription quota/auth/provider drift pauses the supervisor with a clear reason.
- Productive completion uses actual inventory/equipment/world predicates, not elapsed time, goal text or “I built it” messages.
- Missing mechanics get a precise blocker. Do not repeatedly choose the same impossible upgrade, poll a clarification with inference, or hide limitations behind endless wandering.
- Death, disconnect and dimension change revoke active work and preparation. Low health stops unsafe work before a narrowly admitted restorative action can run. [MB-FLOW-003](survival-routines-plan.md) adds fresh-state survival upkeep and bounded death recovery, preserving the interrupted owner's intent without replaying old actions. Explicit reconnect uses memory and operating preference, not old action IDs.
- Stop cancels active work, preparations and scheduling, and latches paused. Resume performs a fresh assessment. Logout/shutdown disconnects; a session supervisor cannot override it.

## Survival routines subplan

Jake requested routine player upkeep and recovery of dropped belongings after death. [MB-FLOW-003](survival-routines-plan.md) specifies death coordinates and loss records, bounded retrieval, food/health, equipment/tool replacement, inventory space, resupply and safe home/spawn preparation. Approved replanting and specialized mechanics are staged behind capability gates.

These routines support the current directive through the same supervisor, goal admission, catalog and single actuator owner. Recovery precedes unrelated progression, preserves unresolved owner intent and stops on unsafe/repeated failures. Stop/logout still govern all automatic action. Define shared interfaces with handoff and memory before assigning the child work; integrate the first accepted routines before claiming a self-sufficient progression loop.

## Home construction and maintenance

House building is a deliverable, not merely a remembered coordinate. Plan a bounded small footprint and construction objective with material prerequisites, confirmed block placements, a navigable entrance, enclosure/roof verification and named workstation/storage facts.

Select an unoccupied site; do not demolish existing structures to create room. Preserve an approved footprint and a versioned project checklist. Only known bot-built/approved blocks are repairable by the project; placement/mining outside that scope needs a new explicit plan.

Inspect whether placement, reach, doors, material acquisition and shelter verification can support the complete build. Add missing general construction/evidence capabilities where demonstrated necessary, through the shared catalog and generic task runtime. Explicit building may place blocks; navigation still must not silently dig, tower or scaffold.

A stopped build records confirmed placements and unknown effects separately. After restart, inspect the actual site and repair/replan from observed differences rather than replaying the checklist. Register “home” only with honest evidence; remember a chosen site separately from a verified usable shelter.

### Owner-directed home placement without questions

Reported 2026-10-06 Arizona under [MB-PLAN-006](v1-planner-plan.md#mb-plan-006--act-without-follow-up-questions): “set up his house here” caused another question. Desired behavior: state that a small practical home will be built at the grounded local site, then acquire supported missing materials and build. No size/material/location menu, confirmation or alternate resource-only goal.

Coordinator default: capture a fresh visible owner's local position or an explicit owner-supplied site when interpreting “here.” Search only a small observed vacant neighborhood around that anchor, within admitted travel/site limits; prefer the nearest safe footprint and retain its identity through the project. If the owner/site cannot be grounded, state a blocker without guessing hidden coordinates. Safe handoff preparation carries a provisional site only; revalidate it before admission and prevent a moving owner from silently relocating an accepted project.

An existing scoped home/project must not silently override the explicit new-site instruction or create a second incompatible persisted “home.” Gate the current single-home selector/project contract: distinguish continuation at the same site from an explicit replacement site, retire only the previous bot project identity with truthful history, and never demolish its old house or another player's structure. Shared construction/project changes stay with the progression writer.

Acceptance: ordinary real Codex/Jev “build your house here” starts without an answer, gathers prerequisites and verifies the complete approved shelter near the grounded anchor. Repeat an occupied site, owner moving during preparation, an existing home elsewhere, insufficient materials and stop/restart. Correct target/site binding, no unrelated destruction, honest partial progress and fresh repair are required. These scenarios supplement A3/A6; provisioned-material scripted construction alone does not close them.

## Seams and bounded research gates

Inspect src/goals/goal-engine.ts, src/app/app.ts, src/app/skill-runtime.ts, src/planner/prompt.ts, shared goal/planner/capability/predicate contracts, src/tasks/task-runtime.ts, src/skills/crafting.ts, src/skills/placement.ts, src/skills/inventory.ts, src/skills/interfaces.ts, src/execution/predicates.ts and decision/spend limits.

Proposed ownership: a progression supervisor module, construction/project integration, tests and an assigned fixture harness. Codex owns shared schemas, scheduler/handoff integration, manifests and final acceptance.

Gate A-G1: catalog audit plus a separate fixture trial for eating, tool upgrades, doors and multi-block shelter construction. Identify genuinely missing primitives before promising the full milestone. The assigned outcome includes necessary scoped capabilities, not just the audit.

Gate A-G2: determine which session budget/cooldown and blocked-outcome policy prevents repeated goals without constraining ordinary user goals. Use fake clocks, failed providers and no-resource scenes; choose documented finite defaults without changing the run cap.

Gate A-G3: define code-verifiable shelter criteria from a small fixture build. Verify reach/path constraints and interrupted repair. Avoid treating an arbitrary decorative blueprint as proof of shelter.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| A1 | Normal run starts a useful bounded goal without an owner command. Disabled/inference-free profiles and diagnostics make zero model calls; no new connection is initiated by scheduling. |
| A2 | Empty-inventory and prepared-inventory survival trials choose different prerequisites, verify useful supplies/upgrades, then automatically select another attainable milestone. No per-phrase code/prompt edits. |
| A3 | Real planner/Jev gathers materials and completes a small home with verified roof/enclosure/entrance/workstations/storage. Save the home and inspect server truth; zero in-trial world fixes. |
| A4 | Owner command overrides progression; finite completion returns to progression. Persistent follow retains ownership. Blocked owner instruction stays visible without a requested answer under MB-PLAN-006. |
| A5 | Stop during planning, movement, crafting and building cancels both execution and lookahead and stays paused through a timer advance/restart. Resume freshly reassesses. |
| A6 | Partial house survives stop/restart. Fresh verification correctly continues or repairs, without duplicate placements, fabricated stored materials or changing another world's base. |
| A7 | No resources, unsafe path, low health, provider failure, run spend cap and repeated blocked goals produce bounded, meaningful waiting. They do not create inference loops or fresh budgets. |
| A8 | Combined acceptance uses memory, smooth handoff and a read-only dashboard when available; records productive work, waiting, interventions, model calls/cost and end-state facts over multiple milestones. |
| A9 | Integrate the accepted MB-FLOW-003 first slice: ordinary food/tool/inventory upkeep and a recoverable death lead back to useful work; unsafe recovery, stop/logout and unresolved owner intent remain bounded and visible. Child R criteria supply the detailed evidence. |

Required checks: affected AGENTS.md typecheck/build/test, both doctors, connection/controller/skill regressions, planner diagnostic and fault checks, then coordinator-run real-provider fixture acceptance. Retain 26.1.2 behavior. Assign new autonomous and house scenarios explicitly; current P0–P9 checks alone cannot certify this feature.

## Remaining delivery

Supervisor, pause/resume preference, bounded milestone selection, house capabilities/verification, survival-routine integration, real multi-milestone trials and delivery evidence remain unverified. MB-FLOW-003 core recovery/upkeep is assigned concurrently in batch002; later mechanics remain separately gated. Review target: docs/reviews/mb-flow-001-progression.md.

Delivery checkpoint 2026-10-06 Arizona: native supervisor, durable pause/project scope and home construction are integrated in development; scripted/fault-provider U0–U5 provide limited milestone evidence. Real full material-gathering house A3, combined progression/survival and [compatible work continuation](survival-routines-plan.md#mb-flow-003-c12--resume-compatible-work-after-recovery) remain open. The live batch001 application has no default progression/home loop. [Current gameplay-fix intake](live-gameplay-fixes-plan.md) is planning only and assigns no new worker work.

## Batch002 shared-port review

Native milestone `ce214b08090821b2f65b0c0f604d1494f92ab859` proposes goal source, control/project schemas and consumer ports. Companion survival `545da3a37cb4449f5b1bf10a670bf7ed1cd564aa` and locator `b894867fdf3155b35570fc4926ca577f00005213` provide their own authoritative ports. Codex chooses **GoalSource from autonomy; SurvivalPolicyPort/LowHealthAllowancePort from survival; LocatorPort/RoutePort from locator**. Remove duplicate/incompatible consumer-side port definitions rather than maintaining independent schedulers or allowances. Only exact reviewed contract commits may be integrated.

**MB-FLOW-001-C1 — Resume preserves unresolved owner intent.** Recorded from the native proposal before behavioral implementation acceptance: P2 says bare resume dismisses unresolved owner intent. Resume clears the automatic pause latch and freshly reassesses; it does not abandon a blocked, unanswered or interrupted owner directive. A new explicit owner instruction may supersede that intent. First release may honestly hold unsupported continuation for the owner; it cannot silently replay original text with a fresh baseline or classify all inventory/current-state outcomes compatible without proving ownership/lifecycle semantics.

A single temporary construction aid block is approved as an explicit bounded building operation inside the observed approved footprint. Placement, standing on it and removal use registered fenced capabilities and server evidence. It is not a pathfinder scaffolding/tower permission. Remove only the project's own unchanged proven aid. Stop immediately revokes building and leaves any unremoved aid as a recorded partial effect; cleanup must not mine/place after ownership is lost. Full shelter verification requires that temporary aid removed and the usable interior/entrance restored.

An explicit stop of a currently active owner goal cancels that goal. A blocked/interrupted intent already waiting before stop remains visible; resume does not clear it. Both paths require evidence, including stop while an owner clarification or replacement is pending.

**MB-FLOW-001-C2 — Automatic planner-turn ceiling.** Review of native `ea5903d4` finds the session total checked before a progression admission, but the new admission receives the full configured per-goal planner allowance. Support admission checks its goal count without the session's remaining planner turns. Counters collected at terminal can therefore overshoot the declared run allowance. Clamp each automatic admission to the minimum of remaining session turns, configured per-goal limits and any episode ceiling; refuse exhausted planner goals and retain bounded code-task support when Jev and the existing spend reservation are available. Code tasks skip the planner but still call Jev. Count initial/repair/retry/knowledge/lookahead turns and do not replenish on resume, death or milestone change. Fake-clock/fault scenarios must prove the last remaining turns and support-after-exhaustion cases.

**MB-FLOW-001-C3 — Shelter evidence freshness.** Reported in coordinator review on 2026-10-07 UTC (2026-10-06 Arizona); not accepted. At construction milestone `4dcfc489`, the inspector returns an old server block fact before checking a pending client prediction, and reuses an earlier sighting after its chunk is unavailable. Two inference-free probes against the actual inspector reproduce both results as an accepted oak-plank cell; both must be unknown. Pending predictions are opaque everywhere. Cached cell evidence needs current chunk/connection/dimension validity; an unseen change after unload must not certify a finished house. Prove stale facts, prediction-before-confirmation, chunk unload/reload and actual fresh completed-shelter verification.

**MB-FLOW-001-C4 — Construction movement and bound parameters.** The same source milestone uses a broad `near_missing` circle around the house center whose arrival condition can already be true at the current position while a missing wall is out of reach. Select an observed reachable standing position that makes progress toward the specific missing cell, rather than returning a successful no-op. Also include admitted `material` in resolved construction parameters and honor it: the generic candidate generator rejects drafts missing a bound parameter. Verify a far wall, all roof cells, repositioning without digging/towering, missing requested material and a complete server-confirmed fixture build. These are source findings pending correction and actual gameplay evidence, not a successful house trial.

**MB-FLOW-001-C5 — Consistent explicit scope.** Recorded on 2026-10-07 UTC (2026-10-06 Arizona), before correction. Shared composition `c704ad4b` prefers autonomy.scope for progression/survival but passes the independently configured memory service into the same run without checking that worldProfile, worldRevision and botProfile match. A mismatched configuration can mix home/death facts from one scope with automatic work recorded in another. Missing or conflicting scope must visibly block automatic work while manual goals remain available. When both scopes are configured, require equality before composing automatic persistence-dependent behavior; test each field mismatch and the matching normal path. This is source-review evidence, not a live wrong-world reproduction.

## MB-FLOW-001-C6 — planner wire and rendered context

Reported: 2026-10-07 02:50 UTC. Status: recorded during integration review; worker dependency `4a281429` pending coordinator acceptance. The worker discovered that the generated planner wire omitted the installed `structure_state`/`survival_state` predicates, while its request renderer omitted automatic origin/context, route authority and coarse locator hints. Root source still has the old wire at intake. This prevents the real planner from expressing the new code-verifiable home/survival outcomes. The worker's proposed wire/prompt correction predates this coordinator record; its implementation is not accepted by that fact. Acceptance: installed predicates round-trip without namespacing their enum fields; real planner receives bounded automatic context and coarse locator/route information, owner goals retain owner labeling, and actual provider fixture goals can select and verify these outcomes.

## MB-FLOW-001-C7 — truthful support dashboard copy

Reported: 2026-10-07 02:50 UTC. Status: recorded before correction. Review of `e6b66986` shows the support callout still says “your directive stays queued” unconditionally. The delivered first-slice owner-support contract holds unsupported continuation for a fresh owner decision rather than automatically replaying it, and support may occur without any owner directive. Replace this assertion with the actual support state; show held/interrupted owner intent using the canonical autonomy projection. Acceptance: a support routine with no owner goal makes no queued-owner claim; an interrupted goal needing a decision is labeled held/interrupted; no promise of automatic replay.

Live-play isolation decision (2026-10-07): Jake's published live release is isolated in `var/batch001/clean-install`, using root `var/runs/dashboard/auth`. Existing regression harnesses may publish status under their own project root; run those in a separate immutable integration checkout with independent `var`, `dist`, `node_modules` and no copied credentials. Only fixture stores may be symlinked under an explicit world lease. This keeps the live dashboard and telemetry independent while development continues.

## MB-FLOW-001-C8 — bounded, truthful autonomy-harness cleanup

Reported: 2026-10-07 02:54 UTC. Status: recorded before correction/lease. Full `bb3594a`/`5503827` harness review finds: entity selectors actually span y -64..-24 while the comment describes only block changes y -63..-50; forceload is added without recording/restoring just the additions; cleanup catches all failures and can report success despite an uncleared inventory/item area or a child not yet proven gone after a forced kill. These are harness evidence/cleanup issues, not a demonstrated shelter-production defect. Acceptance: document the complete entity/block/player footprint; preserve pre-existing forceload and remove/verify only additions; await owned child termination; fail the report when bounded cleanup fails, preserving the original scenario result. The approved isolated fixture may retain its explicitly built shelter after a successful run; exact original-scene restoration is not required for this standard scene reset. The normal live world remains untouched.


## MB-FLOW-001-C9 — integrated skills regression waits for the old catalog count

Recorded by Codex on 2026-10-07 03:11 UTC before worker correction. The frozen combined 674dab6c 26.2 skills trial failed exit1 (13/33): S0 waits for 20 capabilities, while the actual registered runtime catalog has 22 (foundation20 plus locator seek_owner/route_travel). S0 times out before initial scene setup and diagnostic anchoring, so later scenario failures are preserved as unaccepted cascade evidence. Correct the shared harness to compare the actual registered catalog for its profile, preserve readiness/planner-disabled assertions, and fail setup explicitly before dependent tests when readiness cannot be proved. Review other affected hard-coded counts. L made no shared-file changes. Source correction and unit checks alone do not accept the combined mechanics; rerun on a fresh frozen integration checkout. Returning the locator fixture player to the standard scene is optional, not a substitute for correcting S0. Failed report: batch002-674dab6c/var/live-check/2026-10-07T02-57-33-606Z-26.2-skills/report.json.

## Offline assignment authorization — 2026-10-13 Arizona

Status: **authorized / preparing; not accepted; no worker launched.** Jake starts only the scopes below using native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. The current CLI 0.162.1 read-only native gate passed; gameplay planner configuration and all historical evidence remain unchanged. Source implementation/entry-point wiring is authorized for the later coordinator-launched workers, while this preparation performs coordination documents/worktrees/dependency installs only. No live deployment/join is authorized; all fixture leases are **ABSENT**. World/provider/vault/key/live-control work is coordinator-only and requires a later explicit grant.

| Prepared lane | Existing scope | Ownership / dependency |
| --- | --- | --- |
| progression | MB-FLOW-001 A1/A2/A4/A5/A7/A8 | `src/autonomy/supervisor.ts`, `src/autonomy/scope.ts`, `src/autonomy/control.ts`; Accepted handoff/memory/survival ports; integration owns ALL common contracts including autonomy/survival/update contracts and shared admissions. HOME exclusively owns src/autonomy/blueprint.ts, home.ts and store.ts; consume their exported APIs and route proposed changes to the coordinator/home owner. |
| home | MB-FLOW-001 A3/A6; MB-PLAN-006 full-house gathering | `src/autonomy/blueprint.ts`, `src/autonomy/home.ts`, `src/autonomy/store.ts`; HOME owns the canonical blueprint/HomeProjectService/project-store modules; extend these rather than duplicate them. Progression exclusively owns supervisor/scope/control/context/status-text/barrier.ts. ALL common contracts and shared predicates/catalog/composition go to integration; propose exact typed seam changes to the coordinator. |

Complete outcomes/exclusions, exact owned tests/paths and source/build/live boundaries are in [the preparation checkpoint](agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona) and the ignored per-lane briefs. No shared schema/predicate/CLI/composition edit is accepted by proposal alone. Dedicated local role review: `docs/reviews/mb-20261013-<suffix>-worker.md`; acceptance instead owns `docs/reviews/mb-v1-05-20261013.md`. Coordinator approval of exact contract/companion commits precedes cross-branch imports.
