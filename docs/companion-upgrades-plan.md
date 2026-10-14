# Companion upgrades — feature roadmap and implementation boundaries

Reported: 2026-10-06 UTC (2026-10-05 in Arizona). Owner: Codex. Status: **Batch001 accepted; MB-FLOW-001, MB-FLOW-003 and MB-LOC-001 authorized in [batch002](feature-batch-002-plan.md). MB-OPS-001/002 remain unassigned.** The [independent batch review](reviews/mb-batch001-coordinator-review.md) records measured outcomes and retained navigation quality limits.
Read [workflow](../agent-workflow.md), [repository instructions](../AGENTS.md), [current architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and [supervision](agent-supervision.md).

## Product outcome

Chunkbot feels like a companion with ongoing interests: gathering supplies, improving equipment, establishing a home, remembering useful places, and responding to Jake without a full planning pause on every instruction. Jake can watch the bot's actual state on a second monitor.

These plans describe new behavior, not capabilities already delivered. Existing V1 ownership, perception and restart rules remain the baseline until a scoped implementation changes them. MB-V1-05 remains its separate final acceptance assignment.

## Confirmed decisions

Latest refinement, 2026-10-06 Arizona: **Chunkbot must never ask Jake follow-up questions.** Use reasonable grounded defaults and act; state a concrete blocker when execution is unsupported or unsafe. [Gameplay-fix intake](live-gameplay-fixes-plan.md) links no-question grounding, direction/distance following, water safety and safe work continuation plans. This refinement is recorded, not implemented in the accepted live application.

- **MB-FLOW-001:** after Jake connects Chunkbot, progression is the default activity. Owner instructions take priority. After a finite owner task completes, Chunkbot returns to progression.
- **MB-FLOW-003:** within progression, remember death coordinates and attempt to recover Chunkbot's belongings. Jake also requested other ordinary player habits be specified; the child plan labels proposed upkeep defaults and recovery limits.
- **Stop is deliberate:** after !chunkbot stop, Chunkbot stays paused until explicitly resumed. It must not silently restart progression.
- **MB-FLOW-002:** keep useful current work going while the next task is being planned.
- **MB-LOC-001:** use ordinary Minecraft locator-bar information to find Jake's general direction, including relative height when available.
- **MB-UI-001:** a locally launched dashboard shows health, inventory, levels, the current task/directive, token usage and OpenRouter spend; include remaining Codex subscription usage when a straightforward supported adapter is available.
- **MB-MEM-001:** persistent gameplay memory includes Chunkbot's base and important locations.
- **MB-OPS-001:** develop and verify changes separately while Chunkbot plays, then apply them with a brief automatic Chunkbot-only reconnect and a truthful in-game update notice. Jake confirmed the reconnect tradeoff; deployment instructions belong in the workflow once accepted.
- **MB-OPS-002:** use vanilla /trigger commands to bring eggyBot69 online or log him out while Jake stays connected. Jake chose the vanilla route rather than a server mod.
- Development and gameplay agents remain separate; development uses the repository's Claude Code subscription workflow.

No priority among these features has been confirmed. Coordinator recommendation: treat progression as the main outcome, implement handoff and memory foundations before it, and deliver locator tracking, the dashboard and release-manager foundations as separable features.

## Plans and dependencies

| ID | Plan | Dependency / important boundary |
| --- | --- | --- |
| MB-FLOW-001 | [Default progression and home building](autonomous-progression-plan.md) | Memory and handoff foundations; shared capabilities and existing bounded goal engine |
| MB-FLOW-002 | [Continue work while planning](smooth-handoff-plan.md) | Goal/planner ownership redesign; never two actuator owners |
| MB-FLOW-003 | [Survival routines and death recovery](survival-routines-plan.md) | Child of MB-FLOW-001; shared supervisor, handoff and memory seams; bounded route support required for distant recovery |
| MB-LOC-001 | [Locator-assisted following and travel](locator-follow-plan.md) | Typed locator observations and bounded route policy; independent of persistent memory |
| MB-MEM-001 | [Persistent gameplay memory](gameplay-memory-plan.md) | World identity and evidence-backed facts; no old action/handle replay |
| MB-UI-001 | [Local Chunkbot dashboard and usage/spend](chunkbot-dashboard-plan.md) | Read-only status/usage contracts; optional Codex quota read requires pinned-CLI/account compatibility |
| MB-OPS-001 | [Verified live updates and reconnect](live-update-plan.md) | Immutable releases, manager-owned session/checkpoint and conservative budgets; integrates accepted handoff/memory for compatible task continuation |
| MB-OPS-002 | [Vanilla slash-command connection controls](server-control-plan.md) | Server control bridge plus shared minimal application manager; independent of the bot chat listener and full live updates |

Recommended implementation sequence:
1. Define coordinator-owned shared contracts for active/pending directives, operating mode, memory references, locator hints and dashboard status.
2. Implement MB-FLOW-002 and MB-MEM-001 as bounded assignments, with their own acceptance.
3. Implement MB-FLOW-001 through basic supplies, upgrades and a verified small home; integrate MB-FLOW-003's first survival/recovery slice before accepting the ongoing progression loop.
4. Implement MB-LOC-001 independently; integrate its travel policy before claiming long-distance following.
5. Complete MB-UI-001; a basic status viewer can be delivered earlier once its contract is stable.
6. Verify the combined experience: remember home, progress, accept an owner command without a planning freeze, return to progression, stop and remain paused.

MB-OPS-001 packaging and manager work can proceed separately once release/checkpoint interfaces are defined. Coordinate its lifecycle, budget and resume seams with MB-FLOW-002/001 and MB-MEM-001; assign one writer for each shared integration path. A basic verified reconnect does not require the full progression, memory or dashboard features. It must not advertise transparent continuation before that path is proved.

MB-OPS-002's datapack/bridge adapter can be a parallel assignment after the shared manager's on/off/status and identity/request contracts are defined. One manager owns starts, shutdowns and update reconnect intent. Dashboard usage projection is separate ready work; optional quota access must not block core token/spend delivery. No new runtime/remote-server setup is authorized by these proposed documents.

MB-FLOW-003 shares progression/lifecycle ownership with MB-FLOW-001/002. Define its incident, interruption and routine-status contracts first; a disjoint recorder/metadata module may then be assigned separately. Recovery cannot compete with the progression supervisor for goal admission or silently reset session budgets. Memory stores historical deaths/hazards; the dashboard shows the current routine and recovery result.

Jake's standing preference is parallel Opus 5.5 implementation for independent ready features. After shared contracts are established, handoff, memory, locator and dashboard modules can be assigned to separate workers with disjoint ownership; default progression integrates the accepted handoff/memory foundations. Codex retains shared contracts, composition, manifests, CLI/config, integration and acceptance. Use separate branches/worktrees once Git is set up, and lease shared fixture/live-check windows. Handoff and progression overlap goal scheduling and need an explicit dependency boundary. Follow [the parallel workflow](../agent-workflow.md#parallel-assignments-and-git-isolation); these feature documents remain proposals, not worker launch receipts.

## Baseline evidence and gaps

The following paragraphs describe the initial pre-batch001 baseline. Current accepted batch001 includes optional memory, dashboard and smooth handoff. Batch002 progression/survival/locator source is integrated in development but unaccepted and absent from the last live artifact. Memory remains unconfigured in the real profile. Use [the current release/evidence table](live-gameplay-fixes-plan.md#what-exists-versus-what-jake-was-playing) for present delivery status; initial gaps below are historical, not claims that development has never started.

Live Java 26.2 session run-8a0b31de06a5 connected successfully. Jake reported freezing on a new command and losing Chunkbot during following. GoalEngine currently revokes the old owner before planning the new instruction. The recorded follow task stopped when Jake left the 128-block admission travel radius and later lacked visible owner evidence. This is distinct from its 32-block observation radius.

Current remembered anchors are bounded, connection-scoped in-memory observations. There is no durable gameplay memory or dashboard. The installed 26.2 codec defines tracked_waypoint packets; neither the current perception contract nor Mineflayer plugins inspected here supply a gameplay locator abstraction.

Current death handling revokes work and respawns idle; no automatic gear retrieval or survival-upkeep policy exists. Eating, equipment changes, visible item pickup and storage are existing primitives. Durable incidents, recovery priorities, low-health restorative admission and missing upkeep metadata need the MB-FLOW-003 gates and acceptance, rather than an assumption that primitives already provide the behavior.

See [live evidence](live-server-connection-plan.md). Do not infer precise latency, continuous autonomy, finished housing, or long-distance navigation from that session.

## Shared acceptance and checks

Every worker brief selects the relevant checks from AGENTS.md, captures exit codes directly, and adds tests for its own behavioral changes. Existing installed commands include:

    export PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH
    npm run typecheck
    npm run build
    npm test
    npm run doctor -- --config config/examples/fixture.json
    npm run doctor -- --config config/examples/fixture-26.2.json

Use separate loopback fixtures. Existing live checks support --fixture 26.2:
- Connection/identity/commands/lifecycle: npm run live-check -- --fixture 26.2.
- Perception/skills/execution: npm run skills-live-check -- --fixture 26.2.
- Controller: npm run jev-live-check -- --fixture 26.2 --provider fault.
- Planner/goal changes: node dist/cli.js planner-check --config config/examples/fixture-26.2.json --probe, and npm run planner-live-check -- --fixture 26.2 --jev fault.
- Real gameplay acceptance: coordinator-injected Jev key, real Codex subscription and npm run planner-live-check -- --fixture 26.2, plus the assigned new scenarios. Existing scripts alone do not cover these new features.

Retain appropriate 26.1.2 regression coverage. Fault-provider tests establish harness behavior, not real Jev acceptance. Workers never access the vault; Codex runs paid-provider checks within the existing cap. No live-world fault setup or automatic server modifications.

For each feature, save a review under docs/reviews/ with criterion IDs, actual entry points, final source/build/run provenance, exact commands, interventions, measured timing, and remaining gaps. Update roadmap and architecture only when behavior is actually accepted.

## Product assumptions still open to refinement

Coordinator defaults in the detailed plans: a small practical home rather than elaborate buildings; local read-only dashboard first; direction-only locator information even when the wire offers coordinates; one bot/world profile; stop/resume controls shared by chat and terminal. Feature plans label research gates and assumptions individually. No feature promises unattended completion of every Minecraft mechanic or end-game progression.

## Offline assignment authorization — 2026-10-13 Arizona

Status: **authorized / preparing; not accepted; no worker launched.** Jake starts only the scopes below using native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. The current CLI 0.162.1 read-only native gate passed; gameplay planner configuration and all historical evidence remain unchanged. Source implementation/entry-point wiring is authorized for the later coordinator-launched workers, while this preparation performs coordination documents/worktrees/dependency installs only. No live deployment/join is authorized; all fixture leases are **ABSENT**. World/provider/vault/key/live-control work is coordinator-only and requires a later explicit grant.

| Prepared lane | Existing scope | Ownership / dependency |
| --- | --- | --- |
| progression | MB-FLOW-001 A1/A2/A4/A5/A7/A8 | `src/autonomy/`, `tests/autonomy-supervisor.test.ts`, `tests/autonomy-scope.test.ts`; Accepted handoff/memory/survival ports; integration owns shared admissions/contracts. Existing src/autonomy/home.ts and blueprint.ts remain progression-owned: coordinate home requests rather than duplicate or concurrently edit them. |
| home | MB-FLOW-001 A3/A6; MB-PLAN-006 full-house gathering | `src/skills/construction.ts`, `src/construction/materials.ts (new, if needed)`, `src/construction/project.ts (new adjunct only, if needed)`; Existing HomeProjectService and blueprint helpers in src/autonomy/home.ts and blueprint.ts are read-only here; progression owns them. Propose needed changes to that owner through the coordinator. Shared predicate/schema/catalog/composition changes go to integration; no duplicate project service or blueprint. |
| upkeep | MB-FLOW-003 remaining Routine policies R6/R7 | `src/survival/`, `src/skills/survival.ts`, `tests/survival-upkeep.test.ts`; Canonical shared survival contracts and single admission/executor remain integration-owned; preserve accepted recovery/continuation semantics. |
| packaging | MB-OPS-001 U-G1/U1/U5 | `src/updates/artifacts/ (new)`, `scripts/package-release.ts (new)`, `tests/update-artifacts.test.ts (new)`; Propose the public manifest/API to the coordinator before stabilizing it; shared contracts are integration-owned. Manager consumes only the approved contract. |
| manager | MB-OPS-001 U-G2/U-G5/U2/U3/U5 | `src/updates/manager/ (new)`, `tests/update-manager.test.ts (new)`; Approved artifact/checkpoint/manager port contracts first. Existing app, control, CLI and connection seams are integration-owned. |
| checkpoints | MB-OPS-001 U-G3/U-G4/U4/U6 | `src/updates/checkpoints/ (new)`, `tests/update-checkpoints.test.ts (new)`, `tests/update-accounting.test.ts (new)`; Propose semantic/storage/IPC contracts first; existing memory/core/SpendLedger seams require integration/coordinator approval. Manager shares the approved contracts. |
| bridge | MB-OPS-002 vanilla bridge C1-C7 | `src/server-controls/ (new)`, `assets/datapacks/chunkbot-control/ (new; namespace chunkbot_control)`, `tests/server-controls.test.ts (new)`; Approved manager/control ports; vanilla feasibility and world proof are coordinator-only. Shared commands/CLI/config/app wiring is integration-owned. |
| integration | Single shared MB-FLOW/MB-OPS composition writer | `src/contracts/`, `src/app/`, `src/cli.ts`; Public stable contract/API commit needs coordinator approval. Independent wiring may continue; import companion commits only when the coordinator approves exact SHAs. Request any unowned path explicitly. |
| acceptance | MB-V1-05 V1-1 through V1-5 acceptance preparation | `scripts/v1-integration-live-check.ts (new)`, `scripts/lib/v1-integration/ (new dedicated helpers)`, `tests/v1-integration-harness.test.ts (new)`; Frozen integrated artifact and approved ports; real inference/world acceptance waits for a named exclusive coordinator fixture lease and coordinator key injection. |

Complete outcomes/exclusions, exact owned tests/paths and source/build/live boundaries are in [the preparation checkpoint](agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona) and the ignored per-lane briefs. No shared schema/predicate/CLI/composition edit is accepted by proposal alone. Dedicated local role review: `docs/reviews/mb-20261013-<suffix>-worker.md`; acceptance instead owns `docs/reviews/mb-v1-05-20261013.md`. Coordinator approval of exact contract/companion commits precedes cross-branch imports.
