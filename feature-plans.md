# Chunkbot feature plans

Updated: 2026-10-07 Arizona (2026-10-08 UTC). Owner: Codex. Status: **MB-V1-00 through MB-V1-04 and feature batch001 accepted; batch002 acceptance incomplete; four gameplay-fix branches under review, shared corrections quota-blocked; MB-V1-05 remains unassigned.**

Jake authorized Codex supervision, local DSH startup, and implementation of these plans with Claude Opus 5.5 workers and full access on 2026-10-04. Use parallel native Opus 5.5 workers for separable authorized assignments and continue them through independent review.


## V1 outcome

One Java Edition companion accepts open-ended instructions from Jake. The gameplay planner, using Jake's Codex subscription, decides the steps and prerequisites. Jev through OpenRouter chooses grounded actions within each current step. Reusable Minecraft skills execute those actions and verify results.

“Come here,” “collect stone,” and “get resources and make armor” are examples of goals the architecture must handle. They are acceptance scenarios, not hardcoded command categories or a fixed roadmap of allowed instructions. Capability coverage grows through the shared skill catalog; an unmet capability or world prerequisite must be reported precisely.

## Read first

- [Standing workflow](agent-workflow.md) and [repository instructions](AGENTS.md).
- [V1 behavior and architecture](docs/v1-architecture-plan.md): confirmed decisions, open-ended planning, initial capabilities, and limits.
- [Shared contracts](docs/v1-contracts.md): goal/task generation, capability catalog, grounded actions, completion, and interruption.
- [Research and gates](docs/v1-research.md): dated findings and bounded implementation probes.
- [Coordinator checkpoint](docs/agent-supervision.md): current assignment and evidence.

## Current maintenance assignment

**MB-NAME-001 — [Chunkbot rebrand and public repository](docs/chunkbot-rebrand-plan.md): complete; public initial push verified.** Jake chose Chunkbot and requested the public `eggyBones/chunkbot-mc` repository. This maintenance assignment leaves the separate feature roadmap statuses below intact.

## Accepted feature batch001

Jake requested three parallel native Opus5.5/full-permission DSH features after the initial public push. [Batch001](docs/feature-batch-001-plan.md) selects **MB-UI-001 dashboard**, **MB-FLOW-002 smooth handoff** and **MB-MEM-001 persistent memory**. The initial push is verified; all three native implementations are integrated from distinct branches/worktrees. All three selected features are accepted; see [independent review](docs/reviews/mb-batch001-coordinator-review.md) for measured outcomes, audited-publication evidence and retained navigation limitations. Other feature statuses remain unchanged.

## Authorized feature batch002

Jake selected **MB-FLOW-001 progression**, **MB-FLOW-003 survival/death recovery** and **MB-LOC-001 locator following** on 2026-10-06. [Batch002](docs/feature-batch-002-plan.md) defines disjoint native Opus 5.5 worktrees, one shared scheduler writer and exclusive fixture leases. Implementation and feature fixture checks are authorized now; **MB-V1-05 and live gameplay acceptance wait for Jake tonight**. No live reconnect is authorized by this assignment.

## Current gameplay-fix implementation

Jake authorized implementation on 2026-10-07 Arizona and requested parallel workflow workers. [Live gameplay fixes](docs/live-gameplay-fixes-plan.md) assigns no-question behavior, correct distant following, water safety, recovery/continuation and newly reported mob survival. Four native local DSH Claude Opus 5.5 workers implemented separate branches with one shared application writer. [Independent review](docs/reviews/mb-gameplay-fixes-coordinator.md) records both-release recovery/locator module passes, real ordinary goal results and critical remaining corrections. Claude reported a subscription session limit resetting at 11 p.m. Arizona (2026-10-08 06:00 UTC); drafts and consolidated pending reviews are preserved. No gameplay-fix source is accepted or deployed. The prior logout still governs the live server; wait for a fresh join instruction.

| ID | Detailed fix plan | Status |
| --- | --- | --- |
| MB-PLAN-006 | [Act without follow-up questions; chicken/tree/house grounding](docs/v1-planner-plan.md#mb-plan-006--act-without-follow-up-questions) | Branch under review: real chicken/absent-target/stop examples pass with zero questions; destructive tree replan fails; house gathering remains open |
| MB-LOC-002 | [Correct direction, lost-owner behavior and beyond-128-block ordinary following](docs/locator-follow-plan.md#mb-loc-002--wrong-direction-and-distance-loss) | Module passes both fixtures: directions and 300-block reunion; canonical lineage ready for shared wiring, ordinary acceptance open |
| MB-FLOW-003-C11 | [Surface/shore protection during follow and movement transitions](docs/survival-routines-plan.md#mb-flow-003-c11--water-safety-during-following) | Source/draft under review: first escape passes, interrupted trial and stop/reauthorization failure remain; shared real executor wiring open |
| MB-FLOW-003-C12 | [Resume compatible unfinished work after recovery](docs/survival-routines-plan.md#mb-flow-003-c12--resume-compatible-work-after-recovery) | Shared checkpoint/ports under review; acquisition arithmetic and unknown-return attribution failures block acceptance; unsafe replay prohibited |
| MB-FLOW-003-C13 | [Survival first around mobs](docs/survival-routines-plan.md#mb-flow-003-c13--survival-first-around-mobs) | Retreat/defense source under review; unknown gear/age readiness and shared wiring require correction; ordinary hazard trials pending |

Batch002 native source is integrated in the development checkout, with acceptance gaps. The last live application remains accepted batch001 d348d58; public 90450c4 adds only local controls/docs. Locator module gates include a 300-block reunion, but normal real-planner/Jev following remains unaccepted. Progression and recovery **have started**, but are not loaded in that live artifact; automatic item retrieval and compatible owner-work continuation are not delivered. Do not describe a Git push as a loaded gameplay update.

## Companion feature plans

Jake's requested upgrades are broken down in [the companion roadmap](docs/companion-upgrades-plan.md). These are proposed feature assignments; existing V1 behavior remains the baseline until each is implemented and accepted.

| ID | Feature plan | Status |
| --- | --- | --- |
| MB-FLOW-001 | [Default progression, upgrades and home building](docs/autonomous-progression-plan.md) | Development integrated; real/combined acceptance incomplete; not live |
| MB-FLOW-002 | [Continue current work while the next directive loads](docs/smooth-handoff-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-FLOW-003 | [Survival routines and death recovery — progression subplan](docs/survival-routines-plan.md) | Old batch002 development integrated; new pickup/persistence/meal modules pass both fixtures; continuation/safety acceptance incomplete; not live |
| MB-LOC-001 | [Locator-assisted following and bounded travel](docs/locator-follow-plan.md) | Both fixture module gates pass 19/19; ordinary/combined acceptance open; not live |
| MB-MEM-001 | [Persistent gameplay memory and known locations](docs/gameplay-memory-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-UI-001 | [Local dashboard, token usage, OpenRouter spend and optional Codex allowance](docs/chunkbot-dashboard-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-OPS-001 | [Verified live updates with a brief automatic reconnect](docs/live-update-plan.md) | Proposed; unassigned |
| MB-OPS-002 | [Local play scripts and proposed vanilla server controls](docs/server-control-plan.md) | Local slice L1 implemented/accepted; vanilla bridge proposed/unassigned |

Confirmed operating flow: progression by default after connection; owner commands take priority; return to progression after finite task completion; stop remains paused until explicit resume. Recommended foundations: handoff and memory before full progression. Locator and dashboard are separable assignments. See the companion roadmap for ownership, dependencies and acceptance.

MB-FLOW-003 is the MB-FLOW-001 child plan for automatic player upkeep. Jake requested recovery of belongings and death coordinates; it also proposes food/health, tools/equipment, inventory space, resupply and safe-home routines. Recovery is bounded, preserves interrupted owner intent and respects pause/logout. These automatic policies are new work; current death handling respawns idle.

Jake also confirmed brief Chunkbot-only reconnects for verified updates. MB-OPS-001 plans isolated immutable releases, bounded replacement, loaded-version verification, chat notices and rollback. Its minimal session/budget checkpoint is independent of full gameplay memory; transparent task continuation requires compatible outcome semantics. The accepted implementation must add actual deployment commands to the workflow and operator guide. This is not an implemented hot-reload service.

MB-OPS-002 controls eggyBot69 joining/leaving while Jake stays connected. Jake selected vanilla /trigger commands; a server control bridge and the shared application manager remain available when the bot is offline. MB-UI-001 now explicitly includes token/spend history and conservative local budget display. Account-level OpenRouter metadata and Codex remaining quota are optional supported reads with clear unavailable/stale states; a pinned-CLI compatibility gate precedes quota claims.

## Implementation assignments

| ID | Assignment | Depends on | Complete assigned outcome | Status |
| --- | --- | --- | --- | --- |
| MB-V1-00 | [Local DSH worker setup](docs/v1-local-runtime-plan.md) | Local installation/subscription | Verified local Claude Code Opus 5.5 development route | Verified locally; accepted |
| MB-V1-01 | [Application foundation](docs/v1-foundation-plan.md) | MB-V1-00 for its worker | Java connection, owner controls, open-ended goal intake, contracts, and diagnostics | Verified locally and built; accepted |
| MB-V1-02 | [Perception and general Minecraft skills](docs/v1-perception-skills-plan.md) | MB-V1-01 | Grounded movement, exploration, resource, crafting, inventory, and interaction capabilities | Verified locally and built; accepted |
| MB-V1-03 | [Jev action controller](docs/v1-jev-controller-plan.md) | MB-V1-02 | Task-driven candidate generation and real Jev choices drive general skills | Accepted: 24 probes, 232 tests, 12/12 real Jev cases |
| MB-V1-04 | [Codex gameplay planner](docs/v1-planner-plan.md) | MB-V1-01 contracts; integrates after MB-V1-03 | Subscription-backed goal interpretation, prerequisite planning, clarification, and replanning | Accepted: rolling real subscription planning,36 passing commands,19 scenario criteria |
| MB-V1-05 | [Integration and V1 acceptance](docs/v1-integration-plan.md) | MB-V1-01 through MB-V1-04 | Varied and previously untemplated goals work through the real hybrid loop | Planned; unassigned |

Use parallel Claude Opus 5.5 workers for independent authorized feature work. Codex owns shared contracts, manifests, lockfiles, plan reconciliation and acceptance. Each brief has explicit ownership, dependencies and runtime leases; use separate branches/worktrees after Git setup. Serialize overlapping integration and shared fixture work, following [the standing workflow](agent-workflow.md#parallel-assignments-and-git-isolation).

## Execution and acceptance

1. Verify the local Claude development route.
2. Establish the application, capability contracts, and owner command slice.
3. Implement and validate reusable Minecraft actions and game-knowledge queries.
4. Connect Jev to task-specific valid actions and resolve the Codex subscription planner probe.
5. Verify open-ended planning and the real integrated result across varied goals.

Resolve auth/model/version gates early once implementation is assigned, continuing independent fixture/foundation work if an external prerequisite is missing. No paid API planner fallback is authorized.

A skill milestone is a reusable mechanism, not a user-facing command whitelist. Adding an ordinary goal composed of existing capabilities must not require another intent handler, task enum, or hardcoded recipe progression.

Accept V1 against [integration criteria](docs/v1-integration-plan.md), using real Codex planning, real Jev choices, and real Minecraft actions. Save delivery evidence under `docs/reviews/` when it exists.

## Later expansion

Jake authorized configuring and joining the existing shared server as `eggyBot69` on 2026-10-06, then explicitly authorized the required26.2 compatibility work. MB-SERVER-001/002 are now **built and independently accepted locally**: reproducible pinned26.2 stack, exact-version mechanics,297 tests, both fixtures'16/33/12 connection/skill/fault-controller checks, and3 real Codex/real Jev26.2 scenarios. [Independent evidence](docs/reviews/mb-server-001-coordinator-review.md), [live connection plan](docs/live-server-connection-plan.md). The single native Opus5.5 worker is completed/idle. Jake's new instruction to try connecting supersedes the04:28 UTC deferral. Actual online check now passes after bot-only session refresh and Jake's whitelist addition. `eggyBot69` connected successfully in the persistent application hosted on this Mac, then was logged out and stopped at Jake's request. Account/configuration remain prepared for the next authorized session; actual process evidence is in supervision and the live connection plan. MB-V1-05 remains a separate unassigned final-acceptance phase.

Future work can improve execution reliability, memory, perception, larger worlds, specialized mechanics, voice, multiple companions, and model adapters. Initial capability gaps should be documented individually. Do not reject a whole goal category merely because it was absent from an example list.
