# MB-PLAN-006 shared planner and integration — worker P review record

Worker: P (shared planner/application writer). Branch `chunkbot/gameplay-planner`, worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-planner`, base `37c4c170199b4c9d867f720e64561a63a816d14c`. Status: **in progress — module/source evidence only.** No fixture lease has been granted; nothing here is fixture, provider or ordinary-pipeline acceptance.

## Milestone commits

| Commit | Content |
| --- | --- |
| `36628a1` | N1: executable owner-question paths removed (contract, wire schema, GoalEngine goal/preparation/lookahead/automatic paths, `answer` retired); prompt v5 grounded defaults; perception entity ordering before cap; retired handle identities. |
| `f506acc` | Review corrections (no generic quote exemption; app-owned public text boundary; historical counter compatibility) and generic grounding: observation block groups, `blocks_removed` outcome, group-scoped work, `select_home_site near=owner`. |
| `49f14a1` | Harness scenarios updated to the no-question policy (planner P4, handoff L6); P-side immediate-safety seams (GoalEngine authority basis + hooks, TaskRuntime hold gate). |
| `cfbd609` | This review record. |
| `78bb0fe` | Combined ordinary-goal live harness `scripts/ordinary-goal-live-check.ts` (O1–O6), lease guard test. |

Checks at `78bb0fe` (Node 24.21.0 first in PATH, own `npm ci`): `npm run typecheck` exit 0; `npm test` exit 0, 822/822; `npm run build` exit 0 at `49f14a1` (later commits touch scripts/tests only). No installed live diagnostic was run (no lease; planner diagnostics would use inference).

## N1 — no follow-up questions (implemented, unit evidence)

- **Schema/contract.** `PlannerProposalSchema` has no `needs_clarification` variant; the generated output schema has no question disposition or `question` field. A legacy/off-schema question (wire or carried draft/lookahead) is a counted `policy` repair (`owner_question_refused`), counted in `GoalCounters.questionRefusals` and `repairs`; exhaustion ends the goal/preparation with an app-owned blocker (`questionBlockerText`) that never contains the planner's wording.
- **Engine.** No `awaiting_owner` state, question notice, `qN` or answer wait for owner goals, preparation, lookahead, automatic progression/support. `answer ...` is retired: it records `answer_retired`, replies "Reply not applied: no question is pending…", never applies, revives, replaces or authorizes work.
- **Hard owner-visible boundary (review item 3/5).** `src/goals/public-text.ts` renders every owner-visible planner-derived text from structured data only: goal interpretation notice/record (`publicOutcome` from the accepted contract), cannot_execute blockers (`publicBlocker`: validated capability ids + code reason codes of the last verified task), step labels in status/dashboard/terminal/`task_started` (`publicTaskLabel`: capabilities + code completion). Planner prose stays internal (planner requests incl. preparation `continuingTask`, run store, planner journal).
- **Detector (defense in depth).** `src/goals/declarative.ts` checks interpretation, blocker, progress and task objectives. Quotes are NOT exempt unless the quoted text is an exact (normalized) substring of the code-known owner/automatic instruction; regressions include `"Would you like stone or cobblestone?"` and `"Please provide a location"`.
- **Historical evidence (review item 6).** `GoalRecord.counters.questionRefusals` defaults to 0 for old records; legacy `clarifications` is retained history-only (never relabeled). Regression parses a pre-MB-PLAN-006 record with `clarifications: 2` and `pendingClarification`.
- Legacy-only fields kept for old evidence: `GoalState 'awaiting_owner'`, `pendingClarification`, `PendingInstructionState 'awaiting_owner'`. The engine never produces them (tests assert no `awaiting_owner` goal_state events).

## Grounding (N-G1/N-G3; implemented, unit evidence)

- **Snapshot ordering.** Visible entities/drops are ordered by distance (ties: key, x, z, y, id) BEFORE the 32 cap; the visible owner is always reported. Previously the cap applied in client-table order, so a nearby chicken could be omitted when >32 entities were visible.
- **Bound target survives snapshot eviction.** Only 8 snapshots are kept; a task bound to an observed handle lost its target after ~8 rounds (`named_target_not_visible`) and `entity_outcome observed_defeated` became `unknown`. Perception now retains the IDENTITY of evicted handles (bounded 4096, same connection/dimension, cleared on lifecycle) for re-grounding and predicate identity only; expired handles remain non-executable. This is a source-mechanism finding consistent with the chicken report, not a matched incident trace.
- **Block groups.** Observations carry bounded `groups` of connected visible blocks of a code-owned class (`tree`: logs/stems/wood/hyphae + leaves, wart blocks, roots), with nearest member, bbox, counts and `support` (`grounded`/`floating`/`unknown` from loaded collision data directly beneath visible trunk members only). Group handles re-ground only to the same group (maximum member overlap), never to another.
- **Outcome.** New predicate `blocks_removed {target: observed grp-/blk-, selector}` binds the target's member positions; bounded growth adds newly seen members of the same group near the bound area; satisfied only when the server world state (no pending prediction) shows no matching block at every bound position; unknown after lifecycle interruption. Wire, proposal checks (shown handle required), candidate hints, dashboard text updated.
- **Scoped work.** A named group handle admits exactly its member blocks for `mine_block` (unrelated tree stays out of scope); `move_near` approaches a group's nearest observed member.
- **"Here".** `select_home_site` accepts `near: owner` (fresh visible owner position from the snapshot); owner not visible is a declarative `owner_not_visible` blocker. An existing home project elsewhere remains the existing `home_project_exists` blocker — explicit replacement-site semantics (retire previous project) are not implemented (decision for Codex below).

## Immediate safety — shared wiring (P side, partial)

Implemented against W's draft (`gameplay-safety` `804e61d`, not imported):

- `GoalEngine.safetyAuthority()` → `owner_goal | unpaused | none` exactly per coordinator decision 1 (manual owner goal protected while the automatic pause latch is set; explicit stop without a newer owner goal is `none`; computed only from engine state, never from memory/autonomy configuration). `onSafetyAuthorityChanged(cause)` is synchronous at stop (after the active goal is revoked synchronously, so the hook reads `none`), resume, owner admission and goal terminal.
- `TaskRuntime` hold gate (structural subset `TaskSafetyGate` = SafetyPort `hold`/`waitClear`): no Jev request or dispatch while held; bounded inference-free waits; a hazard that begins during the Jev await defers the chosen action before any low-health allowance reservation; clear → fresh observation, preempted sustained action re-chosen; a declared blocker → `blocked/safety_blocked` → goal terminal `safety_interrupted`. Goal outcome, baseline, counters and deadline are untouched; the no-progress stall clock pauses for the waited time only.

Remaining P obligations once W's stable contract commit is approved: `ExecutionOwner {kind:'safety'}` in ports.ts and lease `ownerCurrent` → `grantCurrent`; `SafetyActuationPort` over the existing `ActuatorLeases` + `SkillExecutorImpl` (`preemptCurrent` revokes a non-safety lease with `safety_preempt` without ending the goal; executor outcome identity for safety owners); `SafetyAuthority` host function (engine basis + connection/alive/travel); `attachConnection` at bot creation, `onLifecycle` before lease/ledger invalidation in `SkillRuntime.onLifecycle`; `start/close` in CLI composition independent of memory/autonomy; status/dashboard projection lines; registering W's safety skills in the catalog and updating `scripts/lib/profile-catalog.ts` expectations (C9 rule: actual registered catalog). Locator route runner holds are L's module; generic navigation is fenced by the lease preemption.

## C12 — shared continuation API, P proposal r2 (declarations only; NOT implemented; for approval)

Declarations: `src/contracts/continuation.ts` (not exported from `contracts/index.ts` and not consumed). It supersedes my r1 above (new goal id, "remaining" ceilings) and adopts S's r2 semantics (`gameplay-recovery` `d3b3e9f`), with the shared types moved to a P-owned common contract so continuation works with survival/memory/autonomy disabled. After approval S imports these types and deletes its duplicate declarations.

| Review point | API answer |
| --- | --- |
| 1 Budget identity | The SAME `goalId` is re-admitted at a fresh epoch, so Jev `perGoal` attempts, memory, journal and status keep one identity. `counters: CarriedCounters` is the full `GoalRecord.counters` type, including `questionRefusals`, the inert legacy `clarifications`, `preparationTurns` and `lookaheads`. It is carried as the SAME cumulative object, checked against the ORIGINAL `caps`; `admittedTasks` is carried too. `deadlineAtMs` is the original absolute deadline. **Obligation (decision adapter owner):** `JevDecisionAdapter.perGoal` evicts FIFO after 32 entries; support/recovery goals could evict a held job's count and refill it. It needs `retainGoalBudget(goalId, retain)` (or no eviction of held ids). P calls it at hold and release. |
| 2 Immutable evidence | `admissionBaseline` (counts or null, with `detail`), `outcome` + `outcomeCanonical`, `anchor` and `accounting: AcquisitionEntry[]` (V recomputed against the original B0 at every interruption, evidence labeled). At admission a fresh resync gives F only for re-binding: possession `carried = min(V, max(0, F − B0))` and `acquired = carried + max(0, now − F)` (+ consumption since); effect `carried = V`; latched stays satisfied. |
| 3 No executable data | Plain data only. Groundable: inventory_amount/delta, crafting/smelting_result, equipped, structure_state, memory_state, survival_state, and near_target/visited_location/block_state/container_state with registry/owner/owner_destination targets. `blocks_removed` is also groundable: its bound world positions are carried as `RemovalCarry` (semantic identity, not a handle). Not groundable, so the job stays held with one declarative reason: observed handles in other predicates, prior_result, remembered_anchor, memory_ref, count atoms under any/not, unknown B0. |
| 4 Independence | P holds checkpoints in memory (`ContinuationEnginePort`). `ContinuationSurvivalPort` is optional (frozen last-alive counts, recovery-priority gate, display-only persistence). Readiness never reads the automatic latch. Explicit stop marks held checkpoints `stopped_by_owner`; any owner or operator intake marks them `superseded_by_owner` synchronously before admission. No motion after stop. |
| 5 Preemption | W holds keep the goal admitted (TaskRuntime gate, `49f14a1`). A checkpoint is created only when ownership ENDED: `death`, `low_health` or `safety_interrupted` (continuable in v1, same connection epoch and dimension). `disconnected`, `kicked` and `dimension_change` are held only (`not_continuable_in_v1`). |
| 6 Route lineage | `RouteCarry` copies the ORIGINAL frozen ceilings (absolute `routeDeadlineMs`), destinations, legs/distance/stalled used and any blocker. **Obligation (L):** `RoutePort.carryOut(goalEpoch): RouteCarry` before revoke, and `admit(a, { continuation: RouteCarry })`. That grant keeps `routeId`, copies the ceilings, pre-consumes the usage and never recomputes from `admittedAtMs`; an exhausted route stays exhausted. The continuation's travel anchor is the original anchor (`admitTravelAnchor(epoch, original.at)`), never the respawn position. |

P implementation plan after approval (single shared writer):
- `GoalEngine.finalize` builds the checkpoint for owner goals ending with a checkpoint interruption, synchronously and with no I/O. `GoalTerminalEvent` gains `held?: { version: 1 }`, so the supervisor and survival know the job is not finished.
- `continueHeld()` admits through `admit()` with `extras.continuation`:
  - original anchor and route carry go through `onGoalAdmitted`;
  - a pre-bound outcome via a new `PredicateEvaluator.rebindContinuation(contract, { carry, removal, latched }, freshResync)`;
  - the first planner turn kind is `continuation`, with a bounded request field (app-owned facts: carried credit, verified effects, remaining limits);
  - the planner must repeat the accepted outcome exactly (existing check).
- An app-owned `ContinuationScheduler` (respawn/ready/safety-clear events plus a bounded local timer, no inference) calls `continueHeld`, so manual-only profiles continue too.
- Status shows held, continuing and blocked states with app-owned text.

Regressions planned:
- B0 8 + 4 verified, then death and recovery to 12 → credit 4 (completes at 18);
- partial recovery to 9 → 1;
- nothing recovered → 0;
- respawn-point pickups to 17 → still 4;
- a second death after +3 → V 7 against the original B0;
- latched consumed milestone;
- unknown B0 → held;
- an observed-handle atom → held with one reason;
- repeated death/continuation never refills Jev attempts, planner/task/replan counters, deadline, route legs/distance/time or continuations;
- stop/new owner instruction while held → never continues;
- disconnect → held only.

Residual for decision: own drops picked up during a continuation by a NON-recovery skill count as new (`now − F`). Option: survival reports server collects of lost keys inside the incident radius and P subtracts them up to the unaccounted remainder.

## Combined ordinary-goal harness (not run; needs a lease and coordinator-run real planner)

`node scripts/ordinary-goal-live-check.ts --fixture-lease <id> [--fixture 26.2] [--jev real|fault] [--only O1,…] [--house-materials provided|gather]`. Real subscription planner always (coordinator only); `--jev fault` is harness validation only. Generated config from `config/examples/fixture[-26.2]-autonomy.json` with an independent data dir and fresh scope (home construction registered); the pause latch is set right after ready, so only ordinary owner goals act. Scenarios O1–O6 (one chicken; closest chicken among chicken/cow; floating birch beside grounded oaks; house "here" near the visible owner; absent target; stop during work), each asserting the no-question boundary and RCON truth. Footprint: the standard scene area (x 196..224, z 190..224, y -63..-50; entity box y -64..-24); forceload recorded before change and only additions removed; cleanup re-applies the standard reset and verifies sample positions; unreconciled cleanup fails the report. Follow/water scenarios are deliberately excluded until W's mechanics gate passes.

## Coordinator decisions requested

1. Approve or amend the C12 v1 checkpoint/compatibility/carried-credit semantics above before implementation.
2. `select_home_site` with an existing project elsewhere: keep the declarative `home_project_exists` blocker, or implement explicit replacement (retire previous project identity with history, no demolition)?
3. `src/skills/memory.ts` and `src/dashboard/outcome-text.ts` received minimal necessary edits for my contract changes (owner-coordinate source and the new predicate/handle kind); please confirm.
4. Home construction capabilities are registered only when autonomy runs with a durable scope. Jake's live profile has no scope, so "set up your house here" there can only end in a declarative blocker (no `select_home_site/build_home` in the catalog). Should owner goals get home construction with an explicit configured scope independent of automatic progression, or stay scope-gated (current)?
5. S's status wording for interrupted directives ("needs your decision") reads as an owner request; propose declarative "held — a new instruction replaces it; nothing is replayed" (S-owned file).

## Remaining assigned work

Safety integration after W's approved contract commit; C12 after approval and S's schema; locator (L) integration and route/visibility safety preservation; combined ordinary-goal harness (chicken/tree/house/follow) with a declared footprint, guarded before any secret read/world mutation; then leased fixture runs on both versions and coordinator-run real-provider acceptance. Dashboard legacy question callout remains unreachable (engine never sets the fields); removing it is a dashboard-owner follow-up.
