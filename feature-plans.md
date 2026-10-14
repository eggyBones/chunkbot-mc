# Chunkbot feature plans

Updated: 2026-10-13 Arizona. Owner: Codex. Current offline batch: **authorized / preparing; nine scopes, no worker launched, no live deployment/join.** Baseline delivery status: **V1 foundation/planner and batch001 accepted; commands/survival/recovery release 64e2609 accepted and registered locally. Broad idle progression/building and MB-V1-05 remain open.**

Historical authorization: Jake authorized Codex supervision, local DSH startup and Claude Opus 5.5 implementation on 2026-10-04. Current 2026-10-13 development authorization uses native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. Native CLI 0.162.1 passed the current metadata gate; historical sessions/commits/drafts and gameplay planner settings remain preserved.


## Authorized offline batch — 2026-10-13

Jake starts these EXISTING planned scopes. Status is **authorized / preparing**, not accepted. No live deployment/join, fixture lease, worker launch or inference acceptance is included in mechanical preparation. This dated assignment table supersedes older unassigned labels for these scopes; accepted baseline behavior is retained.

| Suffix | Scope / existing plan | Status |
| --- | --- | --- |
| progression | MB-FLOW-001 A1/A2/A4/A5/A7/A8 — [docs/autonomous-progression-plan.md](docs/autonomous-progression-plan.md) | authorized / preparing |
| home | MB-FLOW-001 A3/A6; MB-PLAN-006 full-house gathering — [docs/autonomous-progression-plan.md](docs/autonomous-progression-plan.md) | authorized / preparing |
| upkeep | MB-FLOW-003 remaining Routine policies R6/R7 — [docs/survival-routines-plan.md](docs/survival-routines-plan.md) | authorized / preparing |
| packaging | MB-OPS-001 U-G1/U1/U5 — [docs/live-update-plan.md](docs/live-update-plan.md) | authorized / preparing |
| manager | MB-OPS-001 U-G2/U-G5/U2/U3/U5 — [docs/live-update-plan.md](docs/live-update-plan.md) | authorized / preparing |
| checkpoints | MB-OPS-001 U-G3/U-G4/U4/U6 — [docs/live-update-plan.md](docs/live-update-plan.md) | authorized / preparing |
| bridge | MB-OPS-002 vanilla bridge C1-C7 — [docs/server-control-plan.md](docs/server-control-plan.md) | authorized / preparing |
| integration | Single shared MB-FLOW/MB-OPS composition writer — [docs/companion-upgrades-plan.md](docs/companion-upgrades-plan.md) | authorized / preparing |
| acceptance | MB-V1-05 V1-1 through V1-5 acceptance preparation — [docs/v1-integration-plan.md](docs/v1-integration-plan.md) | authorized / preparing |

Nine new branches/worktrees use one focused coordination-docs base. See [scope/ownership checkpoint](docs/agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona). Shared contracts/integration have one writer; coordinator owns main integration, roadmap/supervision and manifests/lock/vendor approval. All 19 older worktrees remain preserved.

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

Jake authorized implementation on 2026-10-07 Arizona and continued native DSH workers. His historical 2026-10-08 instruction restored **Claude Opus 5.5**; the 2026-10-13 native Codex instruction above supersedes that development route. Codex coordinates and independently reviews; all earlier Codex and Claude sessions/worktrees remain preserved. The gameplay planner stays **gpt-6.1-sol / low**, separate from development workers.

Jake explicitly selected **commands, survival and item recovery** for the first upgraded release. Its registered operator profile disables idle progression (`maxProgressionGoals: 0`) while retaining bounded survival support. It does not start autonomous gathering or building. The bot remains logged out until Jake starts Play or gives a fresh join instruction.

The reviewed gameplay source is integrated, including generic resource-search guidance, concrete catalog-checked unsupported-mechanic notices and quiet maintained following. The latest combined source passes all nine real-planner/Jev water and mob cases on both fixtures, including equipped defense, unarmed retreat, creeper avoidance, neutral animals and interrupted following/planning; both real Jev controller suites pass 12/12 and both handoff suites pass 9/9. The latest combined source passes root typecheck/build and **1,665/1,665** tests, both doctors and a fresh isolated gameplay-planner probe. Fresh original P0/P4/P6/P10 command regressions pass 4/4 on both worlds, including sparse-world bread discovery and quiet following. The accepted operator artifact is now **64e26096e0ef78d7595d1f5d0a1205fbecdba8f1**, registered with Play after immutable-source checks and the actual separate-fixture launcher trial. The bot is logged out; dashboard7382 is serving the accepted artifact. The previous batch001 artifact/config are preserved for rollback.

| ID | Detailed fix plan | Current evidence and remaining work |
| --- | --- | --- |
| MB-PLAN-006 | [Act without follow-up questions; chicken/tree/house grounding](docs/v1-planner-plan.md#mb-plan-006--act-without-follow-up-questions) | Zero-question ordinary examples and selective tree removal pass; sparse-world bread discovery and exact unsupported-mechanic notices pass on both versions; full house gathering remains open |
| MB-LOC-002 | [Correct direction, lost-owner behavior and distant ordinary following](docs/locator-follow-plan.md#mb-loc-002--wrong-direction-and-distance-loss) | Direction, 300-block reunion, ordinary follow/replacement and privacy checks pass on both versions; integrated |
| MB-FLOW-003-C11 | [Surface/shore protection during movement](docs/survival-routines-plan.md#mb-flow-003-c11--water-safety-during-following) | Both versions pass escape, stop/fresh authorization, planning/follow preemption and far-cue withdrawal with strict dry-support proof |
| MB-FLOW-003-C12 | [Resume compatible unfinished work after recovery](docs/survival-routines-plan.md#mb-flow-003-c12--resume-compatible-work-after-recovery) | Real recovery/compatible continuation passes both versions; foreign and unknown stacks remain refused; integrated |
| MB-FLOW-003-C13 | [Survival first around mobs](docs/survival-routines-plan.md#mb-flow-003-c13--survival-first-around-mobs) | Both versions pass unarmed/equipped retreat, same-attacker equipped defense, creeper retreat and neutral no-damage controls |

See [independent review](docs/reviews/mb-gameplay-fixes-coordinator.md) and [supervision](docs/agent-supervision.md) for exact source, reports, retained failures and release registration. Automatic live update/reconnect remains unimplemented.

## Companion feature plans

Jake's requested upgrades are broken down in [the companion roadmap](docs/companion-upgrades-plan.md). These are proposed feature assignments; existing V1 behavior remains the baseline until each is implemented and accepted.

| ID | Feature plan | Status |
| --- | --- | --- |
| MB-FLOW-001 | [Default progression, upgrades and home building](docs/autonomous-progression-plan.md) | Development integrated; broad idle gathering/building acceptance remains open; disabled in first upgrade |
| MB-FLOW-002 | [Continue current work while the next directive loads](docs/smooth-handoff-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-FLOW-003 | [Survival routines and death recovery — progression subplan](docs/survival-routines-plan.md) | Recovery, continuation and ordinary safety accepted in fixtures; operator release 64e2609 accepted and registered locally |
| MB-LOC-001 | [Locator-assisted following and bounded travel](docs/locator-follow-plan.md) | Both-version module and ordinary following/privacy pass; operator release 64e2609 accepted and registered locally |
| MB-MEM-001 | [Persistent gameplay memory and known locations](docs/gameplay-memory-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-UI-001 | [Local dashboard, token usage, OpenRouter spend and optional Codex allowance](docs/chunkbot-dashboard-plan.md) | Implemented/integrated; accepted in batch001 |
| MB-OPS-001 | [Verified live updates with a brief automatic reconnect](docs/live-update-plan.md) | Proposed; unassigned |
| MB-OPS-002 | [Local play scripts and proposed vanilla server controls](docs/server-control-plan.md) | Local slice L1 implemented/accepted; vanilla bridge proposed/unassigned |

Broader planned operating flow: progression by default after connection, owner commands take priority, then return to progression after finite completion. The first upgraded operator profile keeps idle progression off; stop stays paused until explicit resume. Recommended foundations: handoff and memory before full progression. Locator and dashboard are separable assignments. See the companion roadmap for ownership, dependencies and acceptance.

MB-FLOW-003 is the MB-FLOW-001 child plan for automatic player upkeep. Jake requested recovery of belongings and death coordinates; it also proposes food/health, tools/equipment, inventory space, resupply and safe-home routines. Recovery is bounded, preserves interrupted owner intent and respects pause/logout. Implemented recovery can recover proved own belongings and resume compatible unfinished work within its original authority; stop, unsafe evidence and scope mismatch prevent replay.

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

Use parallel native DSH Codex `gpt-6.1-sol/xhigh/danger-full-access/never` workers for the explicitly authorized independent scopes. Codex owns shared contracts, manifests, lockfiles, plan reconciliation and acceptance. Each brief has explicit ownership, dependencies and runtime leases; use separate branches/worktrees after Git setup. Serialize overlapping integration and shared fixture work, following [the standing workflow](agent-workflow.md#parallel-assignments-and-git-isolation).

## Execution and acceptance

1. Verify the current local native Codex development route.
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
