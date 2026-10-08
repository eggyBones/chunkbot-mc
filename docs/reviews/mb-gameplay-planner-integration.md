# MB-PLAN-006 shared planner and integration — worker P review record

Worker: P (shared planner/application writer). Branch `chunkbot/gameplay-planner`, worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-planner`, base `37c4c170199b4c9d867f720e64561a63a816d14c`. Status: **in progress — module/source evidence only.** No fixture lease has been granted; nothing here is fixture, provider or ordinary-pipeline acceptance.

## Milestone commits

| Commit | Content |
| --- | --- |
| `36628a1` | N1: executable owner-question paths removed (contract, wire schema, GoalEngine goal/preparation/lookahead/automatic paths, `answer` retired); prompt v5 grounded defaults; perception entity ordering before cap; retired handle identities. |
| `f506acc` | Review corrections (no generic quote exemption; app-owned public text boundary; historical counter compatibility) and generic grounding: observation block groups, `blocks_removed` outcome, group-scoped work, `select_home_site near=owner`. |
| `49f14a1` | Harness scenarios updated to the no-question policy (planner P4, handoff L6); P-side immediate-safety seams (GoalEngine authority basis + hooks, TaskRuntime hold gate). |

Checks at `49f14a1` (Node 24.21.0 first in PATH, own `npm ci`): `npm run typecheck` exit 0; `npm run build` exit 0; `npm test` exit 0, 818/818. No installed live diagnostic was run (no lease; planner diagnostics would use inference).

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

## C12 — proposed versioned continuation admission (NOT implemented; for approval)

Scope: same application session, same connection epoch and dimension; triggers are lifecycle/safety revocations of an OWNER goal (`death`, survival `revoke_unsafe` → `safety_interrupted`, task `low_health`). In-goal safety episodes (W's hold/preempt) do not end the goal and need no continuation.

`HeldGoalCheckpointV1` (GoalEngine-owned, in memory; at most one per original goal; bounded):

```ts
{
  version: 1, checkpointId: 'hold-…', goalId, goalEpoch, instruction, source: { kind: 'owner' },
  heldAtMs, heldReason: 'death' | 'safety_interrupted' | 'low_health',
  connectionEpoch, dimension,
  outcome: { contract, canonical },               // immutable, never re-proposed
  admission: InventoryBaseline,                   // original counts (display/evidence)
  travel: { anchor, radius },                     // ORIGINAL admission anchor; never re-anchored
  counters: GoalCounters, caps, admittedTasks,    // frozen copies; continuation keeps counting
  deadlineAtMs,                                   // ORIGINAL absolute deadline (no refill)
  credits: Array<{ path, predicate, credited }>,  // last CODE-VERIFIED acquisition per counting leaf
  removal?: bound blocks_removed positions,       // world positions survive lifecycle
  knowledge, feedback (bounded, code reason codes),
  compatibility: { status: 'continuable' | 'unsupported', unsupported: string[] },
  state: 'held' | 'continuing' | 'superseded' | 'stopped' | 'expired' | 'unsupported'
}
```

Compatibility v1 (every leaf must be compatible; all/any/not by children):
- `inventory_amount possess`, `equipped`, `structure_state`, `memory_state`, `container_state` (fresh inspection after rebind), `near_target/visited_location` with owner/remembered/owner-destination targets, persistent owner-follow: **continuable** (fresh evaluation).
- `inventory_amount collect_additional`, `inventory_delta`, `crafting_result`, `smelting_result`: **continuable with carried credit**: `credited` = last code-verified acquired/produced count before the interruption (conservative: work after the last evaluation is not credited); the continuation binds a FRESH baseline after recovery, so returned old belongings never count as new acquisition and nothing is double-counted.
- `blocks_removed`: continuable (bound positions carried; fresh server state).
- Observed-handle `entity_outcome`, `block_state`, `near_target` to an observed handle, `prior_result`: **unsupported** in v1 (handles/ledger results are invalidated by the lifecycle) → held declarative blocker.

Admission `GoalEngine.continueHeld(checkpointId, cause: 'recovery_concluded' | 'safety_clear')`:
- Refused (checkpoint stays held, no question) unless: same connection epoch and dimension, game ready, no active owner goal, no pending owner instruction, no owner intake in flight, safety authority not `none`, checkpoint `continuable`, deadline not passed and caps remaining. Explicit stop marks every held checkpoint `stopped` (never continues; resume does not revive it). A new owner instruction marks it `superseded`.
- Uses the single `admit` path with a NEW goal id/epoch and `record.continuationOf = originalGoalId`; `onGoalAdmitted` receives `continuation: { anchor, radius, route ceilings }` so SkillRuntime installs the ORIGINAL anchor (not the respawn position) and L's route port keeps original ceilings. Admission baseline is captured fresh (for the carried-credit rebind only).
- Outcome pre-bound before any planner turn through a new `PredicateEvaluator.rebindContinuation(contract, { credits, removal }, freshBaseline, owner)`; the planner must repeat it exactly (existing immutability check). First turn kind `continuation` with a bounded `continuation` request field (held reason, carried credits, remaining limits). No old tasks, handles, drafts or actions are replayed; the original sentence is not resubmitted.
- Counters/caps/deadline continue from the checkpoint (no reset); the SpendLedger is unchanged.

Ownership split: P implements checkpoint capture in `finalize`, `continueHeld`, the evaluator rebind, the supervisor trigger (after S reports necessary support concluded and safety is clear) and status/dashboard projection. S owns the durable record: `InterruptedDirectiveSchema.continuation` gains `{ kind: 'continuable', checkpointId, version: 1 } | 'requires_owner_decision'` plus compatibility/unsupported list; restart keeps only this NON-executable record (never continues after restart in v1). S never admits continuation itself. Unsupported cases stay explicit held blockers without questions (S's current status wording "needs your decision" should become declarative, e.g. "held: send a new instruction to replace it").

## Coordinator decisions requested

1. Approve or amend the C12 v1 checkpoint/compatibility/carried-credit semantics above before implementation.
2. `select_home_site` with an existing project elsewhere: keep the declarative `home_project_exists` blocker, or implement explicit replacement (retire previous project identity with history, no demolition)?
3. `src/skills/memory.ts` and `src/dashboard/outcome-text.ts` received minimal necessary edits for my contract changes (owner-coordinate source and the new predicate/handle kind); please confirm.

## Remaining assigned work

Safety integration after W's approved contract commit; C12 after approval and S's schema; locator (L) integration and route/visibility safety preservation; combined ordinary-goal harness (chicken/tree/house/follow) with a declared footprint, guarded before any secret read/world mutation; then leased fixture runs on both versions and coordinator-run real-provider acceptance. Dashboard legacy question callout remains unreachable (engine never sets the fields); removing it is a dashboard-owner follow-up.
