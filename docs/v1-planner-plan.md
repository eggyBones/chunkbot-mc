# MB-V1-04 — Open-ended Codex subscription gameplay planner

Created/updated: 2026-10-06. Status: **Verified locally and built; accepted by Codex.** Contract dependency: MB-V1-01; integrated execution follows MB-V1-03. Read [architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and G-03/G-06 in [research](v1-research.md).

The accepted baseline below supports correlated clarification. Jake's later **MB-PLAN-006 no-follow-up policy** supersedes that product requirement for the next implementation; it is recorded, not yet implemented or deployed. See [live gameplay intake](live-gameplay-fixes-plan.md). Historical clarification evidence remains evidence of the previous release.

## Outcome and happy path

Jake gives a broad instruction. A separate Codex gameplay process uses his subscription to interpret the outcome, query relevant game knowledge, decide prerequisite steps, and produce bounded task-specific Jev instructions. The goal engine validates and executes the steps. As the world changes, Codex revises the plan until the accepted goal is verified, cancelled, or concretely blocked.

For “collect stone” from an empty inventory, the planner must reason about available resources, tools, recipes, and the requested output. It can decide to get wood, make a workbench/pickaxe, locate stone, mine, and if needed obtain actual stone items through smelting. This is an example inference path, not a hardcoded task template.

Jake selected Codex subscription planning and explicitly clarified that commands should be open-ended. Jev stays on OpenRouter and development workers stay on Claude through local DSH.

## Subscription transport and isolation gate

Inspection on 2026-10-04 found `/opt/homebrew/bin/codex`, CLI `0.160.0`, and ChatGPT login status. During the authorized implementation session, Codex assigned and passed a bounded subscription schema turn and in-flight cancellation probe. [G-03 transport evidence](reviews/g-03-codex-transport.md) records scoped tool registration, instruction controls, timing, usage, and process cleanup. The selected model was explicitly `gpt-6.1-sol`, low effort; the CLI JSON stream does not echo server-resolved identity. Gameplay proposal and integration acceptance remain outstanding.

Official routes: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [subscription authentication](https://learn.chatgpt.com/docs/auth), [noninteractive output](https://learn.chatgpt.com/docs/non-interactive-mode), and [app-server](https://learn.chatgpt.com/docs/app-server).

Coordinator default: a small adapter around the installed `codex exec`, using argument arrays, stdin, fixed schema, JSON events, ephemeral output, and an app-owned neutral working directory outside development instructions. Use the G-03 scoped controls, including restricted model tool metadata through supported `model_catalog_json`; stock read-only execution still has tools. Regenerate and verify against the installed version, and fail closed on unknown registration rules or prohibited tool events. Compare supported app-server only if the smaller transport is insufficient. Do not invent configuration switches or assume read-only means tools are absent.

Use supported managed subscription auth; do not copy tokens, change global account/settings, or call private endpoints. No OpenAI API key, OpenRouter planner, Claude gameplay fallback, or automatic credit purchase is authorized.

## Scope and ownership

Proposed owned paths: `src/planner/`, planner/proposal fixtures, and goal-engine integration assigned by Codex. Shared contracts, catalog/knowledge interfaces, lifecycle, telemetry, and entry points require coordination.

The planner receives owner instruction/clarification, filtered observations, implemented capability descriptions, queried version mechanics, accepted goal contract, verified task results, and remaining limits. It cannot directly control Minecraft or run development work.

Exclude inherited connectors/MCP, hooks, plugins, skills, worker sessions, and repository instructions through verified scoped settings. Disable tools using supported controls and use restrictive permissions. Prohibited tool requests invalidate a turn. A prose-only “do not use tools” instruction does not meet acceptance. If adequate isolation is unsupported, give exact evidence and finish independent validation work without shipping a privileged planner.

Select an account-supported model/effort in G-03 and record actual identity. Strip API-key billing inputs where applicable while preserving managed auth/OS requirements. Subscription sign-in does not establish unlimited usage.

## General planning behavior

Implement the shared proposal dispositions: plan, needs information, needs clarification, and cannot execute. There is no intent keyword whitelist, resource-specific task enum, or preauthored goal progression.

The model constructs a declarative goal outcome and a short ordered task window. Each step declares objective, allowed capabilities/targets, parameters, Jev instruction, and code-evaluable completion. Validate schemas, references, admitted skills, recipes/mechanics, size/limits, and consistency with the accepted outcome before any action.

G-06 supplies version-correct recipe/harvest/tool knowledge. Missing tools or workstations must lead to planner-chosen prerequisites. Capability handlers may validate mechanical requirements but cannot take over the overall decomposition.

Only ask Jake when ambiguity materially changes the requested result or necessary authority/context is missing. Correlate his answer to the goal. Simple reasonable interpretations can be stated before action; distinguish stone from cobblestone and possession from new acquisition. If a mechanic is missing, describe that mechanic rather than reject a whole goal category.

Use fresh bounded contexts with explicit verified progress; no reuse of coordinator/Claude chats or unlimited server conversation. World text is observation data. Generated JavaScript, invented world coordinates, and permission/limit changes are not executable proposals.

Extend/replan after a window or meaningful failure. Preserve requested outputs, admitted baselines, completed milestone evidence, and remaining limits. Do not reset work/counters or drop an armor/crafting/return requirement just to produce a doable resource task.

## States, interruption, and persistence

Planning and awaiting owner clarification are stationary. Status/stop remain available. Apply proposals only to current epochs. Knowledge rounds, retries, clarification responses, and replans count toward the architecture's total turn limit.

Cancel only app-owned Codex turns/processes; verify child cleanup and discard late replies. Never kill shared Codex/T3 or unrelated sessions. Login/model/quota errors block the goal with actionable subscription evidence, without billing fallback.

Persist redacted goal interpretation, plans/revisions, questions/answers, and usage where available. No auth secrets/private reasoning or restart-triggered goal resume.

## Milestones and acceptance

1. **PLAN-1 — Subscription/isolation probe.** Resolve G-03 with a tiny schema turn and scoped cancellation test. Record route, actual model, effective isolation, timing, output, and clean exit.
2. **PLAN-2 — General decomposition.** Different instructions produce materially different steps using the catalog. From empty inventory, a resource goal generates valid tool/workstation prerequisites; already-owned prerequisites change the plan.
3. **PLAN-3 — Knowledge/clarification.** Query recipes/tool rules, resolve important output ambiguity, and handle missing capability with an exact reason. Schema/reference/code-bearing failures cause no actions.
4. **PLAN-4 — Real integration/replanning.** Run broad goals through real Codex, Jev, and Minecraft. Remove/change a prerequisite and verify revised steps preserve outcomes. A planning window ending is not goal completion.
5. **PLAN-5 — Novel composition/interruption.** An untemplated combination of existing capabilities needs no code change. Stop/replacement/quota and stale replies do not revive old work or alter billing.

Run actual build/typecheck and meaningful schema, semantic, knowledge, clarification, process, and goal-runtime tests. Use provider fixtures for faults; record real model/usage/plan evidence for live behavior.

G-03 proves the scoped subscription transport; its selected-versus-resolved identity limitation remains explicit. Remaining application evidence: isolated structured gameplay proposals, dynamic prerequisites, game-knowledge use, clarification, real execution/replanning, and novel-goal results. Sign-in and a canned plan are insufficient.

## Current assignment

Assigned 2026-10-05 05:46 UTC to native Claude subscription worker `session-5cc2f441-1967-43ee-adf0-efb89a014e6c`, verified Opus 5.5/high/full and registered workspace. [Complete brief](reviews/mb-v1-04-worker-brief.md) covers PLAN-1 through PLAN-5 and required shared integration. MB-V1-03 is independently accepted; no implementation gate remains beyond the assigned production planner/integration work.

## Coordinator findings

### MB-PLAN-001 — Attributable child survives planner cancellation

Reported: 2026-10-05 06:08 UTC. Status: **Verified locally by coordinator.** Assigned feature/session: MB-V1-04, `session-5cc2f441-1967-43ee-adf0-efb89a014e6c`.

Expected: cancelling a planner turn terminates its process group and attributable children that left the group, reports any remaining owned process accurately, and leaves unrelated processes untouched.

Observed: the independent `/tmp/chunkbot-mc-planner-child-probe.mjs` imports the current `OwnedProcess`, starts a fixture parent that creates a child in a separate process group, then cancels the parent. Cleanup recorded both PIDs in `ownedBefore` (`96861`, `96862`), sent TERM/KILL and reported `remaining: []` after 1120 ms. The attributable child was still alive. The direct probe exited 1; its finalizer killed only its own surviving fixture child. No provider, Minecraft connection, DSH turn or shared Codex process was involved.

Likely cause: signalling the root group removes the parent relationship before the next process-table traversal; cleanup recomputes ownership without retaining the already-proven descendant. This is an explanation to verify, separate from the observed survival.

Acceptance: reproduce with a real app-owned parent/child fixture, verify an out-of-group child cannot survive cancellation or normal-exit cleanup, retain accurate bounded cleanup evidence and a maintained regression, and prove an unrelated sentinel process survives. Codex will recheck current source and the independent probe after the consolidated correction. No product choice is pending.

### MB-PLAN-002 — Subscription gate accepts persisted API-key authentication

Reported: 2026-10-05 06:13 UTC. Status: **Verified locally by coordinator.** Assigned feature/session: MB-V1-04, `session-5cc2f441-1967-43ee-adf0-efb89a014e6c`.

Expected: the gameplay planner admits only the managed ChatGPT subscription route. It rejects missing, unrecognized or API-key authentication before inference, without changing global auth/account/settings, copying tokens or attempting a paid fallback.

Observed: `/tmp/chunkbot-mc-planner-auth-probe.mjs` creates a separate temporary profile containing an invalid fake persisted API-key login (no real credential), then uses the installed CLI's read-only `login status` and current `verifyIsolation(..., false)`. The CLI recognized `api_key` auth and exited 0; the isolation gate nevertheless passed all five checks (binary, neutral directory, version, catalog, features). The direct probe exited 1. It performed no inference and did not touch Jake's actual account. Scrubbing API-key environment variables does not exclude an API key persisted in the managed auth location.

Acceptance: verify the actual non-mutating auth route before gameplay inference; reject API-key/absent/unrecognized auth and any route change with actionable subscription evidence; keep supported auth storage and the real account unchanged. Add meaningful negative and ChatGPT-positive coverage, recheck this independent fixture and a real subscription turn. Do not solve this by copying auth tokens or logging out/changing the user's account. No product choice is pending.

### MB-PLAN-003 — Shown frontier references cannot survive a fresh observation

Reported: 2026-10-05 07:10 UTC. Status: **Verified locally by coordinator.** Assigned feature/session: MB-V1-04, `session-5cc2f441-1967-43ee-adf0-efb89a014e6c`.

Expected: a planner-selected frontier waypoint can be re-grounded in a fresh observation when the same safe visible waypoint remains present in the current connection/dimension and within the admitted travel bounds. A removed, hidden, unsafe, expired or lifecycle-stale target must still be refused without fallback to an unrelated frontier.

Observed live context: the worker's `07-01-50-208Z-planner-jev-fault` run (vanilla 26.1.2, real Codex subscription, loopback Jev fixture) answered P4's clarification, then attempted exploration because bread was not observed. `var/runs/run-fff12e64298d` records `goal-32aa15b19d1b` repeated frontier tasks with `explore_frontier: invalid_task_parameter` and `move_near: named_target_not_visible`; no exploration action was dispatched. The goal remains an iteration result, not accepted delivery. Fixture pickup availability is a separate question.

Independent mechanism reproduction: `/tmp/chunkbot-mc-frontier-reference-probe.mjs` uses the actual `PerceptionService` with an isolated fake flat world, no live connection/provider/process. A visible safe waypoint `(-14.5, 0, 5.5)` appears in two successive snapshots (`snap-1` handle `frt-5`, `snap-2` handle `frt-17`). Actual `translateHandle` returns undefined; direct probe exits 1. Source translation handles blocks and entities/drops, but has no frontier case. The candidate generator consequently marks the admitted reference stale even though the same waypoint remains available.

Acceptance: fix generic frontier reference translation/admission, preserve visibility/lifecycle/travel authority and parameter identity, add maintained positive/negative coverage, rerun the independent probe without weakening it, and prove actual planner-selected exploration can move in the separate fixture. Resolve the final clarification trial's actual failure or fixture setup before claiming a pass. No phrase-specific planner handler or extra product choice is required.

### MB-PLAN-004 — Interface live checks inherit an occluded chest position

Reported: 2026-10-06 01:23 UTC. Status: **Verified locally by coordinator.** Session: `session-5cc2f441-1967-43ee-adf0-efb89a014e6c`.

Expected: X4 and I1 establish a server-recorded, visible chest precondition, then exercise actual container cancellation, late replies, and subsequent interface reuse without changing perception authority or weakening those assertions.

Observed: independent skill report `var/live-check/2026-10-06T01-17-34-036Z-skills/report.json` passed31/33 with CLI exit0 but harness exit1. X4 and I1 both failed at the first chest-handle lookup, before the interface action. Their complete snapshots `snap-363fc70976b6` / `snap-b496270f00ad` in `run-skills.log` place Chunkbot at `(201.5,-60,204.5)`, beside X2's obsidian. A furnace at `(201,-60,205)` and white wool at `(201,-59,205)` remain visible; the chest at `(203,-60,207)` is absent. Earlier T1 had successfully used this chest. X4 and I1 inherit X2/X3 position instead of independently staging the target. The occluding scene geometry is the supported explanation, distinct from any application failure.

Acceptance: stage each affected diagnostic at a recorded safe visible position and assert its actual snapshot/target before starting the cancellation race; retain the same cancellation, <=250ms control clear, server-state, late-reply and next-interface assertions. Run typecheck and all33 skill scenarios, capture direct exit codes and update the complete handoff. Do not relax LOS/handles, substitute hidden positions, or count this diagnostic setup as an autonomous gameplay trial. Root will independently recheck before real-provider acceptance.

MB-PLAN-004 verification: independent `var/live-check/2026-10-06T01-29-32-254Z-skills/report.json` passes33/33, harness and CLI exit0, X4/I1 staged visible/in-reach before their unchanged cancellation assertions. Only the harness changed; application/build unchanged. Real-provider phase acceptance remains pending.

### MB-PLAN-005 — Exploration assertion ignores later task windows

Reported: 2026-10-06 01:39 UTC. Status: **Verified locally by coordinator.** Worker session remains idle3568. Do not resume or edit source while root runner43350 owns the fixture.

Expected: P4 verifies planner-selected successful exploration anywhere in the SAME admitted goal, including replanned windows, followed by verified collection/delivery. Required clarification is stationary, answers stay correlated, and the original outcome is preserved. A blocked initial survey is allowed to trigger generic replanning.

Observed: real-provider run `var/live-check/2026-10-06T01-34-50-901Z-planner-jev-real`, app `run-48cf0828b719`, P4 goal `goal-373819d2603c`. After correlated q1, the first survey task blocked honestly (`no_progress`). A counted replan explicitly searched from a new vantage point. Actual `explore_frontier` succeeded at01:37:58.819, observed one drop, and vanilla collection acquired bread. A further window returned to the owner; code completed `outcome_verified` at01:38:11.912. RCON confirmed bread1 and owner distance1.40. No in-trial intervention supplied the item or position. Nevertheless P4 marked FAIL because `scripts/planner-live-check.ts` computes `findActions` by filtering all goal actions to the FIRST task ID, then searches only that list for exploration. The actual successful exploration was in a later planner window. Full root event evidence and failure log retained; the suite continues through its other independent scenarios.

Acceptance: use goal-correlated verified task/action evidence across all windows for this assertion, retain the requirement for actual successful exploration before verified acquisition/delivery, distinguish survey/auto-pickup and record replan windows, and preserve all stationary/correlation/goal/code/RCON assertions. No application/prompt/model fallback or phrase-specific change. Add useful harness coverage if needed and run typecheck plus a fresh real P4 trial at normal limits; retain this original false-negative report. Root will review and independently recheck the correction after the current suite finishes.

## Independent acceptance

All PLAN-1..5 and MB-PLAN-001..005 accepted2026-10-06. [Complete coordinator evidence](reviews/mb-v1-04-coordinator-review.md):36 direct passing checks and all19 distinct real/fault acceptance cases across the retained full run and corrected real P4 subset. Original18/19 false-negative report remains recorded. Source/build verified unchanged; final V1 delivery proceeds through MB-V1-05.

## MB-PLAN-006 — Act without follow-up questions

Reported: 2026-10-06 Arizona (2026-10-07 UTC). Implementation authorized: 2026-10-07 Arizona. Status: **Shared worker branch implemented; independent review corrections and integration remain open.** Applies to owner goals, replacement preparation, automatic goals and recovery continuation on both chat and terminal.

Jake's decision: “I never want him to ask me follow up question — just make him act.” Reports: “Kill that chicken” beside the bot produced “What chicken?”; removing a floating birch tree produced a confirmation and then another collection question; establishing Chunkbot's house “here” produced another question. There must be no follow-up or confirmation ladder.

### Evidence and unresolved cause

The accepted live artifact d348d58 and root development prompt explicitly permit needs_clarification. GoalEngine has separate active-goal and preparation branches that emit qN questions and wait for answers. This is a permitted behavior in the old release, now an unwanted policy. Merely changing a sentence in the prompt would leave executable question paths.

The shared catalog already contains attack_entity, mine_block, movement and collection primitives; development adds home construction. Missing combat capability is not established as the chicken failure. Exact snapshot inclusion, handle selection, stale-reference translation, distance/reach and planner output for Jake's incidents have not been matched. A chicken next to the bot can still be excluded or omitted by perception; inspect that before attributing every question to interpretation.

Independent review update, 2026-10-08 UTC: frozen P1ab12aa passes 849 tests, both read-only doctors and the real subscription isolation/cancellation probe. Five ordinary owner examples with actual Codex/Jev produce no questions; one/multiple chicken selection, absent rabbit and stop pass. Floating-tree O3 fails: replan req-b0f8de72d9e9 admits a fresh group alongside birch_leaves/original removal identity, then mines three unrelated oak logs. **N1-R3** requires code-enforced target/key constraints and original lineage across windows; named targets cannot bypass registry constraints or union conflicting destructive authority. **N1-H2** corrects the happy-path tree's unreachable canopy geometry while retaining a separate bounded unreachable-target case and all unrelated-tree assertions. **N1-H1** requires clearing/verifying owned player inventory/effects before CLI logout. Full material gathering/house acceptance remains open. [Exact review and retained trial evidence](reviews/mb-gameplay-fixes-coordinator.md).

Scripted handoff on the same source/26.2 passes eight of nine gates. **N1-H3** updates its old death oracle: the pending well instruction is discarded, while the original follow goal legitimately continues with its logical ID and a fresh epoch. Bind assertions to the discarded intent and separately verify continuation semantics/process cleanup, rather than forbidding every later admission. This is partial scripted evidence, not complete C12 or provider acceptance. P/W Claude workers reported a subscription session limit until 11 p.m. Arizona; native drafts and pending corrections remain preserved.

### Desired behavior and coordinator defaults

Interpret open-ended instructions using fresh visible targets, supplied constraints and available knowledge. State a short useful assumption only when it affects the result, then act. The owner may refine the task by sending a new instruction; Chunkbot does not solicit that refinement.

| Example / condition | Default and verified result |
| --- | --- |
| One nearby visible matching chicken | Bind that entity, approach if necessary, attack through the registered bounded capability, and report defeat only from server evidence. Never attack a player or owner. |
| Several matching ordinary targets with no supplied distinguishing constraint | Prefer the closest reachable match; break equivalent ties deterministically. State the chosen target briefly and proceed. Preserve explicit names, handles, locations and exclusions. |
| “That floating tree” | Ground one local observed tree/remnant, bind its bounded work area, remove the requested remaining logs/canopy as supported, and collect useful drops. Removing the target is the outcome; collecting an arbitrary number of birch logs cannot silently replace it. |
| “Set up your house here” | Bind a fresh visible owner location or an explicit supplied site, select a nearby vacant bounded footprint, and use the practical home default with supported material prerequisites. [Home placement details](autonomous-progression-plan.md#owner-directed-home-placement-without-questions). |
| Quantity or material omitted | Choose a modest task-appropriate amount/material using observed inventory, version knowledge and the capability limits. Say the interpretation; do not ask for a number or menu selection. Exact requested outputs still bind. |
| Target absent or stale | Use a bounded useful survey/re-grounding attempt where authorized; preserve target identity. If still unavailable, state the visibility/path blocker. Do not substitute an unrelated object or wander indefinitely. |
| No safe supported action / missing authority / hidden site | State one concrete blocker without asking a question, requesting confirmation, claiming completion or inventing permission. Preserve useful verified partial progress. |

“Here” does not authorize unseen owner coordinates. Tree grouping is bounded observed geometry, not a world-wide log scan. A branch failing or becoming unreachable can produce partial removal; final success needs a supported code-evaluable target-area outcome. If existing selectors/predicates cannot express it, add the necessary general grounding/evidence mechanism after a bounded probe, rather than hardcoding these phrases.

### Policy, states, cancellation and persistence

- Make the no-question policy application-owned and default for this companion. Exclude clarification proposals from the gameplay output schema and instructions; enforce the same policy at runtime for malformed, legacy or stale proposals before any question event/notice or awaiting_owner state. A model cannot toggle the policy.
- Apply enforcement to admitted goals, preparation, lookahead, automatic support and continuation. A forbidden clarification may receive a counted bounded repair within existing allowances; exhaustion produces a declarative blocker. Never reopen a fresh epoch to obtain more repairs.
- Do not relay raw planner prose that asks the owner for a decision through an interpretation, cannot_execute field or progress notice. Use validated declarative summaries/app-owned notices; dropping a question mark is not enforcement. Internal knowledge queries remain allowed and do not ask Jake.
- While planning/repairing, retain existing handoff rules: safe current work may continue during preparation; unsafe work is revoked. Stop/status remain provider-independent. A failed draft cannot acquire a lease or silently discard unresolved owner intent for unrelated progression.
- Already emitted legacy qN state is handled explicitly when an accepted release is installed: retire the pending question and freshly reassess only if ownership, policy and original semantics permit. Do not emit it again or treat a stray “yes” as permission for a different destructive task. No automatic reconnect or startup replay is added here.
- Preserve original accepted outcome, admission inventory, goal anchor, verified effects and every existing limit. No-question behavior does not allow weakening visibility, target binding, property boundaries or model isolation. Empty input is still rejected before replacement; provider/quota errors remain honest blockers without fallback.

### Seams and bounded gates

Inspect src/planner/prompt.ts and wire.ts; src/contracts/planner.ts; both needs_clarification paths and checkProposal in src/goals/goal-engine.ts; command/app notices and dashboard directive projection; targetScope/admittedParameters, perception handle translation, src/skills/entities.ts, mining.ts and construction.ts; home site admission.

- **N-G1 — Target availability:** in a leased fixture place one/multiple chickens, an isolated floating tree beside another tree, and a vacant/occupied “here” site. Compare ordinary model-visible snapshots with known server fixture truth, catalog candidates and fresh execution revalidation. Resolve omission versus grounding/interpretation before changing perception bounds.
- **N-G2 — No-question boundary:** inject clarification in active/preparing/lookahead/support outputs and questions embedded in other text. Observe chat, terminal, journal and dashboard. Decide the schema migration and declarative notice path from actual wiring; all paths must honor the policy without raw question publication.
- **N-G3 — Target outcome:** run removal and home goals through generic predicates. Identify any missing reusable grouping/site/completion seam, with positive and stale/hidden/unrelated-target probes. Preserve immutable target meaning across replans.

### Milestones and acceptance

| ID | Observable acceptance |
| --- | --- |
| N1 | Fault proposals and embedded questions never produce owner-facing follow-ups or an answer wait. Bounded counted repair/blocker, cancellation and quota handling are verified on both command surfaces and preparation. |
| N2 | Real ordinary chicken/tree/home commands with actual Codex/Jev act from reasonable defaults without answers. Assert server-confirmed target defeat/removal/finished shelter, or precise partial/blocker where deliberately unavailable. Gather missing house materials in the full acceptance trial. |
| N3 | Repeat with multiple, moved, hidden, missing and unreachable targets; include a new unseen-at-development composition. Correct target binding, no hidden-coordinate shortcut, no unrelated destruction and unchanged outcomes/counters are proven. |
| N4 | Stop/replacement/death/disconnect during planning and execution revoke owned work; stale drafts and legacy questions cannot revive it. Loaded accepted release later proves the same behavior without an operator answer. |

Future checks: applicable AGENTS.md typecheck/build/test, planner diagnostic/isolation and fault checks, handoff regression, skills/identity checks on both fixtures, then coordinator-run real planner/Jev ordinary-goal acceptance within the existing cap. Update previous clarification-based acceptance scenarios to test this policy, preserving historical reports. Implementation and these applicable checks are now authorized by Jake's 2026-10-07 start instruction. Shared-writer review target: docs/reviews/mb-gameplay-planner-integration.md.

## Offline assignment authorization — 2026-10-13 Arizona

Status: **authorized / preparing; not accepted; no worker launched.** Jake starts only the scopes below using native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. The current CLI 0.162.1 read-only native gate passed; gameplay planner configuration and all historical evidence remain unchanged. Source implementation/entry-point wiring is authorized for the later coordinator-launched workers, while this preparation performs coordination documents/worktrees/dependency installs only. No live deployment/join is authorized; all fixture leases are **ABSENT**. World/provider/vault/key/live-control work is coordinator-only and requires a later explicit grant.

| Prepared lane | Existing scope | Ownership / dependency |
| --- | --- | --- |
| home | MB-FLOW-001 A3/A6; MB-PLAN-006 full-house gathering | `src/autonomy/blueprint.ts`, `src/autonomy/home.ts`, `src/autonomy/store.ts`; HOME owns the canonical blueprint/HomeProjectService/project-store modules; extend these rather than duplicate them. Progression exclusively owns supervisor/scope/control/context/status-text/barrier.ts. ALL common contracts and shared predicates/catalog/composition go to integration; propose exact typed seam changes to the coordinator. |

Complete outcomes/exclusions, exact owned tests/paths and source/build/live boundaries are in [the preparation checkpoint](agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona) and the ignored per-lane briefs. No shared schema/predicate/CLI/composition edit is accepted by proposal alone. Dedicated local role review: `docs/reviews/mb-20261013-<suffix>-worker.md`; acceptance instead owns `docs/reviews/mb-v1-05-20261013.md`. Coordinator approval of exact contract/companion commits precedes cross-branch imports.

This assignment adds the full-house gathering/construction slice only; accepted gameplay planner source, model, effort, CLI pin, tools and isolation are outside the new workers' ownership.
