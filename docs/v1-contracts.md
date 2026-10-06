# V1 shared contracts

Updated: 2026-10-06. Owner: Codex. Status: **Foundation, skills and Jev controller accepted; rolling gameplay planner independently accepted; final V1 delivery pending.** Read with [architecture](v1-architecture-plan.md).

These are application contracts, not upstream SDK signatures. Schemas/interfaces live in `src/contracts/`; dependent modules import that source of truth. This document describes their behavior; source defines the exact fields. Planner-related acceptance remains MB-V1-04/05. Codex reconciles material changes. Open-ended goals must not be reduced to a fixed goal/task enum.

## Module boundaries

| Boundary | Paths | Responsibility |
| --- | --- | --- |
| Config/contracts | `src/config/`, `src/contracts/` | Settings, schemas, IDs, outcomes, capability/predicate vocabulary |
| App/commands | `src/app/`, `src/commands/`, `src/cli.ts` | Lifecycle, identity, natural-language intake, clarification/control |
| Game/knowledge | `src/game/`, `src/knowledge/` | Protocol adapter, version registry, recipes, harvest/tool queries |
| Perception | `src/perception/` | Bounded live observations and labeled remembered evidence |
| Execution/skills | `src/execution/`, `src/skills/` | Capabilities, grounded candidates, one control owner, verified outcomes |
| Jev | `src/decision/` | Validated choices, provider metadata, bounded scheduling |
| Planner/goals | `src/planner/`, `src/goals/` | Subscription transport, goal contract, rolling steps, recovery |
| Evidence | `src/telemetry/`, `tests/`, `docs/reviews/` | Redacted events, meaningful fixtures, delivery results |

Only approved game/perception/skill modules may read raw world objects. Models receive filtered data. Shared manifests and real entry points require explicit launch ownership.

## IDs and states

Code creates run, connection, goal, task, snapshot, request, and action IDs plus connection/goal epochs. Models cannot create authoritative identity or ownership. Positions include dimension/time; target handles do not survive world/connection changes.

Connection: `disconnected`, `joining`, `ready`, `ended`. Goal: `idle`, `planning`, `awaiting_owner`, `executing`, `stopping`, then terminal `completed`, `cancelled`, `blocked`, or `failed`. Preserve terminal reason/progress in status until the next goal.

Completed requires verified finite-goal predicates. Persistent goals remain executing until stopped or blocked. Cancelled means stop/replacement; blocked means a known unmet prerequisite/limit/capability; failed means unexpected runtime/provider failure after bounded handling.

## Observations and knowledge

`ObservationSnapshot` includes epoch/time/dimension, bot position/health/food, inventory and equipment, observable owner/entities/blocks/drops/workstations, and labeled remembered evidence. Model context adds code-verified outcomes/progress and remaining limits separately. Bound lists/text. Do not send hidden ore, global player positions, seeds, chunk dumps, secrets, or unrelated server chat.

Remembered positions have observation time/source and remain distinct from currently visible targets. Recipes and public game mechanics are version-specific knowledge, not hidden world observations.

`KnowledgeQuery` may request bounded item/recipe/harvest/tool/capability details by validated registry key or catalog reference. Return explicit unknown/unavailable information. The planner may request more knowledge before proposing work; no game action is implied by a knowledge query.

## Capability catalog

Each `CapabilityDefinition` contains a stable ID, purpose, parameter schema, preconditions, target/candidate resolver, executor, effect/evidence description, supported outcome predicates, timeout/cancellation behavior, and limits.

Initial families cover movement/look/survey, mining/pickup, equipment/inventory, crafting, placement/use, furnace operations, item transfer/drop, and direct entity interactions. Exact skill IDs come from implemented definitions and are supplied to the planner; do not create a second hardcoded planner-only catalog.

A capability is a player mechanism, not a whole user goal. Recipe data can tell the planner what a pickaxe needs; code must not silently implement a fixed “collect stone” progression that replaces the planner's decisions.

## Planner proposals and tasks

The implemented `PlannerRequest` carries the current owner instruction and correlated answers, a fresh filtered observation, the single capability catalog, bounded knowledge, the admission inventory, accepted outcome/interpretation/status, verified feedback/prior results, owner-typed coordinates, cumulative counters and remaining limits, and the last rejected proposal. Turn kinds are initial, knowledge, repair, retry, clarification and replan; each consumes the same per-goal turn allowance. `RegistryFacts` checks the exact installed version's item/block/tag, crafting and cooking facts. A transport or model's text cannot grant coordinate or prior-result authority.

A versioned `PlannerProposal` has a disposition: `plan`, `needs_information`, `needs_clarification`, or `cannot_execute`.

- Plan: interpreted goal summary, declarative goal outcome contract, bounded ordered task window, and whether more planning will be needed after that window.
- Needs information: bounded catalog/knowledge queries, no executable tasks.
- Needs clarification: one useful question tied to a material ambiguity, no executable tasks.
- Cannot execute: exact missing capability or prerequisite and verified partial progress; never just “this goal is not on the list.”

Each generic `TaskSpec` has an objective, bounded Jev decision instruction, allowed capability IDs, target/item selectors, validated parameters, and declarative completion conditions. There is no `collect_logs | return | follow` task enum. Code assigns task IDs and resolves selectors to actual targets at execution time. Execution metadata selects `TaskMode` (`complete` or `maintain`); it is not a user-goal classification. `TaskExecutionPort` returns a bounded `TaskResult` with status, reason, counters and `TaskFeedback` built from resolver exclusions, verified action results and predicate evaluations. Healthy sustained actions and already-satisfied maintenance conditions continue locally without another Jev call.

A selector can refer to registry items/tags, visible entities/blocks, a remembered observed anchor, a validated owner-supplied destination, or a verified prior skill result. It cannot invent entity IDs or hidden coordinates. Owner-supplied coordinates are explicit destination evidence, not claimed live world visibility, and remain subject to navigation/goal limits. Future prerequisites may refer to a workstation/item that will be created; resolution must wait for actual observed result evidence.

Illustrative step, not a fixed goal template or provider payload:

```json
{
  "objective": "Obtain enough wood for the currently planned tool prerequisites.",
  "decisionInstruction": "Choose an admitted visible log or dropped log and acquire it.",
  "allowedCapabilities": ["move_near", "mine_block", "pickup_item"],
  "targetSelectors": [{ "kind": "registry", "key": "#minecraft:logs" }],
  "parameters": {},
  "completion": { "predicate": "inventory_delta", "selector": "#minecraft:logs", "atLeast": 3, "mayBeConsumedLater": true }
}
```

The planner chooses this step, quantity, prerequisites, and later steps from the current goal/context. They are not compiled into a resource-specific handler.

Production wire output uses closed `anyOf` variants generated from the same catalog. Before execution, code checks forbidden code/limit fields, schema, admitted capabilities and declared parameters, version registry/recipe facts, shown handles/anchors, ledger-verified prior results, coordinates actually typed by the owner, and the maintaining task for a persistent outcome. Rejected proposals receive at most two consecutive counted repair turns; eligible transport failures receive one counted retry. Auth/quota/model failures block without fallback, while rerouting or a prohibited tool event fails and disables the planner for the run.

Strict schema validation is followed by reference/capability/semantic validation against the accepted goal contract. Reject unknown executable capabilities, invalid selectors/recipes, excessive plan sizes, contradictory outcomes, and generated executable code. The schema guarantees an interpretable form; it does not prove that an LLM understood arbitrary natural language. Show the interpretation, clarify important uncertainty, and test the required varied scenarios.

Replanning preserves accepted outcomes, baselines, verified progress, and limits. Exhausting a planning window is a request for further planning, not goal completion. A changed desired outcome requires a new owner instruction or explicit clarification, not a silent replan edit.

## Predicates and completion evidence

Provide an extensible code-owned vocabulary: inventory amount/delta, equipped item/slot, near an observable target or remembered waypoint, verified visited location, observed block state/placement, accessible container state, verified crafting/smelting result, and entity outcome where the protocol provides reliable evidence. Support bounded combinations and persistent-goal conditions.

At admission, the synchronous `onGoalAdmitted` hook captures the travel anchor before planning. `captureBaseline` then takes a server-confirmed ALL-item inventory baseline before the first planner turn. A failed resync is explicitly unknown. The first accepted goal outcome binds to that admission baseline, is immutable across windows, and is evaluated by application code after each window. Goal counters never reset across replans. Task predicates keep their own appropriate task baseline; a task completing never completes the goal by itself.

Bind acquisition baselines at the appropriate goal/task admission point and record them. Distinguish new collection, existing possession, ingredients consumed by later steps, task milestone evidence, and final goal conditions. A completed ingredient-gathering task need not hold its inventory count after legitimate crafting consumes it; a final requested item quantity still must hold.

Do not claim death from an entity merely leaving view, transfer from an item merely disappearing, stone items from cobblestone, or crafting from a submitted request. If a requested predicate cannot be evaluated with available evidence, report that specific limitation or ask for an acceptable interpretation.

## Candidates, execution, and interruption

`ActionCandidate` contains code-generated ID, capability, grounded target/parameters, source snapshot/epochs, descriptive criteria, preconditions, and timeout. Generate from the current task policy and observations. Jev returns an ID; code owns coordinates, counts, mechanics, and permissions. Empty actionable sets produce knowledge/replan/blocked evidence rather than fabricated actions.

`DecisionRequest` binds a request to goal/task/connection epochs, a filtered snapshot, task objective/instruction, and frozen candidates. `DecisionChoice` carries the admitted ID plus model/provider, probabilities/confidence, usage/cost, latency and attempt count. Neither confidence nor a chosen ID proves a world effect. The task runtime regenerates current candidates before dispatch and checks action/goal/task/epoch ownership on results.

`SkillOutcome` identifies owning epochs/action, actual status, elapsed time, observable effect, progress, and typed reason. One actuator lease owns game interaction at a time. Crafting/furnace/container operations must release interfaces and track partial effects on cancellation.

Stop, replacement, death, disconnect, dimension change, guard, or limit invalidates ownership first; then abort model work, cancel the path/dig, close owned interfaces, and clear controls. Await bounded cleanup before replacement control. Recheck epochs/preconditions after every await.

A task result returning after goal ownership changed is discarded before publishing status, progress or planner feedback. Planner process cleanup is registered with goal ownership, so replacement waits for bounded cleanup of the app-owned process group and proven descendants. Actual cleanup evidence distinguishes remaining owned processes from unrelated processes.

Old replies cannot execute and old cleanup cannot clear a new lease. AbortSignal alone does not prove game cleanup. Target controls cleared within 250 ms of accepted stop in the supported local fixture; do not promise physical freezing or instantaneous server rollback.

Intentional waits listen for relevant observations, cancellation, and deadlines. Stable follow, verified processing, planning, and clarification do not trip the active-attempt no-progress guard or trigger repeated inference.

## Ports and evidence

Ports: `GamePort`, `ObservationPort`, `KnowledgePort`, `CapabilityRegistry`, `SkillExecutor`, `TaskExecutionPort`, `DecisionPort`, `PlannerPort`, and `RunStore`. Inject clocks/providers for meaningful fault fixtures. Keep Minecraft objects out of model interfaces.

Use [architecture limits](v1-architecture-plan.md) as initial config values. Every planner turn, information query round, retry, replan, and Jev request counts toward its allowance. Code controls limits and conservative cost reservations.

Log bounded redacted goal interpretation, catalog version, proposed/revised tasks, knowledge/clarification, snapshots, candidates, choices, actual model/usage/cost, action results, predicate evidence, and cleanup. Unknown usage is unknown, not zero. Store local JSONL and summaries; omit auth secrets, personal account identifiers, unrelated chat, and private reasoning.

## Implemented subscription boundary

`CodexPlanner` uses the pinned0.160.0 CLI and selected `gpt-6.1-sol`/low in an app-owned neutral directory, outside development instructions. Startup and every turn verify the managed ChatGPT login mode with read-only `codex login status`; status and execution pin the same file credential store. API-key, absent, other or unrecognized modes are refused using mode-only evidence. No credentials are copied and no billing fallback is configured. The gate verifies the restricted bundled model catalog and all40 feature states, disables agents/MCP/memories/skills/project instructions, and strips billing secrets from its environment. The JSONL transport rejects tool/agent/reroute events rather than executing them. Exact controls, selected-versus-resolved identity limits and live evidence are in [the planner handoff](reviews/mb-v1-04-planner.md); [Independent planner acceptance](reviews/mb-v1-04-coordinator-review.md) verifies this boundary; final V1 delivery remains MB-V1-05.
