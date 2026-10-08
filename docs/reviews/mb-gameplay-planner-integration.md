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
| `56cb906` | C12 shared continuation API proposal r2 (declarations only). |
| `82c93a5` | N-G3 review corrections: trunk segmentation, bounded lineage for re-grounding and removal growth, line-of-sight-only support; regressions for touching canopies, incremental reveal and support evidence. |
| `4409ba1` | Approved C12 shared continuation contract (declarations) — the commit S/L import. |
| `79a53ef` | C12 shared continuation wiring (engine, predicates, app scheduler, execution hooks, Jev budget retention) + tests. |
| `0599f19` | Owner-goal home construction with an explicit durable scope (central rule shared by CLI and harness catalog). |
| `d1ea8ea` | Shared structural safety seams (safety owner/lease fence, preemption, actuation port, authority host). |

Checks at `d1ea8ea` (Node 24.21.0 first in PATH, own `npm ci`): `npm run typecheck` exit 0; `npm run build` exit 0; `npm test` exit 0, 846/846. No installed live diagnostic was run (no lease; planner diagnostics would use inference).

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
- **Block groups (corrected after review of `f506acc`; commit `82c93a5`).** A group is segmented by TRUNK: one 26-connected component of SEEN trunk voxels. A SEEN non-trunk voxel (e.g. leaves) joins only its UNIQUE nearest trunk within 4 blocks; ties join nothing. Touching canopies therefore never merge two trees. Only seen voxels are reported; groups and members are bounded (8 groups, 256 members, `truncated` per group, snapshot `truncated` when groups are cut).
  - **Support** uses line-of-sight evidence only. `grounded`: the voxel below a lowest visible trunk voxel is SEEN, solid and not a member. `floating`: every lowest trunk voxel's bottom face is visible. Otherwise `unknown` — an ordinary tree whose soil is hidden is `unknown`, never proven grounded from hidden data. The supporting block's type is never surfaced.
  - **Lineage** (`groupLineageScore`, shared by re-grounding and removal growth). A candidate continues a bound identity only if:
    - its trunk touches an anchor (originally observed members, including leaves, or trunks already admitted; removed positions stay anchors);
    - its whole trunk stays inside the original trunk bbox ±2 horizontally / ±8 vertically;
    - it contains no trunk of another group observed with the identity.

  A neighbouring tree is never pulled in, even when its leaf touches ours.
- **Outcome.** New predicate `blocks_removed {target: observed grp-/blk-, selector}`:
  - binds the target's matching positions plus the semantic component identity;
  - growth admits groups of the latest observation in the lineage and adds their trunks as anchors, so logs revealed after the originally seen ones are removed join instead of being omitted;
  - satisfied only when server world state (no pending prediction) shows no matching block at every bound position;
  - unknown after a lifecycle interruption.

  Honest limit: logs that never become visible during the work cannot be proven present or absent. Re-grounding for mining scope recomputes lineage from the original identity each round (no chaining across rounds), which is conservative: a log reachable only through a chain of later reveals yields a stale target and a replan, never another tree. Wire, proposal checks (shown handle required), candidate hints and dashboard text are updated.
- **Scoped work.** A named group handle admits exactly its member blocks for `mine_block` (unrelated tree stays out of scope); `move_near` approaches a group's nearest observed member.
- **"Here".** `select_home_site` accepts `near: owner` (fresh visible owner position from the snapshot); owner not visible is a declarative `owner_not_visible` blocker. An existing home project elsewhere remains the existing `home_project_exists` blocker — explicit replacement-site semantics (retire previous project) are not implemented (decision for Codex below).

## Immediate safety — shared wiring (P side, partial)

Implemented against W's draft (`gameplay-safety` `804e61d`, not imported):

- `GoalEngine.safetyAuthority()` → `owner_goal | unpaused | none` exactly per coordinator decision 1 (manual owner goal protected while the automatic pause latch is set; explicit stop without a newer owner goal is `none`; computed only from engine state, never from memory/autonomy configuration). `onSafetyAuthorityChanged(cause)` is synchronous at stop (after the active goal is revoked synchronously, so the hook reads `none`), resume, owner admission and goal terminal.
- `TaskRuntime` hold gate (structural subset `TaskSafetyGate` = SafetyPort `hold`/`waitClear`): no Jev request or dispatch while held; bounded inference-free waits; a hazard that begins during the Jev await defers the chosen action before any low-health allowance reservation; clear → fresh observation, preempted sustained action re-chosen; a declared blocker → `blocked/safety_blocked` → goal terminal `safety_interrupted`. Goal outcome, baseline, counters and deadline are untouched; the no-progress stall clock pauses for the waited time only.

Remaining P obligations once W's stable contract commit is approved: `ExecutionOwner {kind:'safety'}` in ports.ts and lease `ownerCurrent` → `grantCurrent`; `SafetyActuationPort` over the existing `ActuatorLeases` + `SkillExecutorImpl` (`preemptCurrent` revokes a non-safety lease with `safety_preempt` without ending the goal; executor outcome identity for safety owners); `SafetyAuthority` host function (engine basis + connection/alive/travel); `attachConnection` at bot creation, `onLifecycle` before lease/ledger invalidation in `SkillRuntime.onLifecycle`; `start/close` in CLI composition independent of memory/autonomy; status/dashboard projection lines; registering W's safety skills in the catalog and updating `scripts/lib/profile-catalog.ts` expectations (C9 rule: actual registered catalog). Locator route runner holds are L's module; generic navigation is fenced by the lease preemption.

## C12 — same-session continuation (approved seam; implemented on P side)

**Contract commit for S/L: `4409ba1`** (`src/contracts/continuation.ts`, exported; `GoalRecord.continuation`). `79a53ef` adds plain-data `ContinuationSegment`/`ContinuationCapture` and the optional `PredicateEvaluator`/`DecisionPort` methods (P-owned).

What P implemented (`79a53ef`):

- **Checkpoint creation.** An OWNER job whose ownership ENDED by `death`, `low_health` or `safety_interrupted` is held in memory. `disconnected`/`kicked`/`dimension_change` produce a held, non-executable record (`not_continuable_in_v1`). Stop, replacement and completion never produce one.
- **Capture at revocation.**
  - In the synchronous revocation prefix, before lifecycle invalidation clears the ledger: effect credit, consumption since the segment start, latches, `blocks_removed` positions and identity, the ORIGINAL anchor and the route lineage export.
  - Alive possession credit comes from a server inventory after cleanup.
  - Death possession credit comes at readiness from S's packet-frozen counts plus incident id. Without the survival service, a counted possession job is blocked `provenance_unavailable`; groundable non-count jobs still continue.
- **Readiness** (`continueHeld`) is code-owned and finite: deadline, at most 2 continuations, original caps, same connection and dimension, alive, no active/pending/in-flight intake, and the optional survival recovery gate. It never consults the automatic latch or an absent goal's safety authority.
- **Admission.**
  - SAME goal id at a fresh epoch, through the single admission path.
  - ALL cumulative counters (spread, so legacy history fields stay), original caps, admitted-task count and absolute deadline carry over; the original baseline is displayed as provenance.
  - The immutable outcome is pre-bound via `rebindContinuation`. The first turn kind is `continuation` with app-written facts, and it counts normally.
  - The continuation is counted before planning; Jev's per-goal budget is retained (never evicted).
- **Fencing and settlement.** Stop and any new owner/operator intake fence held jobs synchronously. Finished, stopped or replaced continuations settle the checkpoint.
- **Accounting** (PredicateEngine): `restored = min(C, max(0, X − N))`, `new = max(0, now − F − ownReturnsSinceF)` (+ consumption). X is server-attributed own returns when there was an incident, else F. Effect credit survives ledger invalidation; unknown attribution makes the count unknown. Earlier ledger entries are never double-counted (`notBeforeMs`).
- **Execution layer.** The ORIGINAL anchor is installed (dimension-guarded); there is no anchor without one. Route continuation is delegated to L (`carryOut` / `admitContinuation`, structural). Without them, NO route is granted — never a refill.
- **App.** `ContinuationScheduler` (local, bounded, inference-free; nudged on respawn and goal end), status lines, respawn notice. The CLI composes it independently of memory/autonomy/survival and attaches S's port structurally when present.

Tests (`tests/c12-continuation.test.ts`, 19):
- **Lineage arithmetic:** 8+4 → recover 12 (credit 4); partial 9 → 1; nothing recovered + 3 new + second death → C = 3 (never max(0, 3 − 8)); respawn-point pickups don't count; late own returns aren't new; no-incident consumption.
- **Groundability.**
- **Real PredicateEngine across two lossy deaths:** the full lineage, unknown attribution, and effect credit plus latched milestones after ledger invalidation.
- **GoalEngine mechanics:** same id, fresh epoch, original deadline and anchor, cumulative turns; stop and new intake fence; provenance hold without S; S frozen credit plus the recovery gate; finite continuations; disconnect held-only; alive gate.

### Obligations for companions (from `4409ba1`)

- **S (survival):**
  - Implement `ContinuationSurvivalPort` on the survival service: `frozenInventory(connectionEpoch)` with incident id; `incidentReturns(incidentId)` with SERVER-ATTRIBUTED own regains from ANY collector (recovery or not) plus retained items, kept separate from incidental pickups; unknown attribution → `attribution: 'unknown'`.
  - Also `continuationGate` (necessary recovery/support first; finite) and display-only `persistCheckpoint` (restart → `restart_held`, never executed).
  - Delete the duplicate C12 r2 declarations in `survival.ts` and import `src/contracts/continuation.ts`.
  - Treat `GoalTerminalEvent.held` as held work (not an owner decision).
  - Replace the public `needs your decision` / `requires_owner_decision` wording with a declarative held-work message; historical state names may stay.
- **L (locator):** `RouteController.carryOut(goalEpoch): RouteCarry | null` (exact usage: legs used, next leg index, distance account, stalled history, blocker, absolute deadline, original anchor/radius, bound own-incident identity) before any revoke, and `admitContinuation(admission, carry)`. It keeps the routeId lineage, copies ceilings and usage and never resumes an old leg. Field names may be refined in `locator.ts` with Codex; P adapts. A repeated death/continuation route-budget regression belongs with it.
- **W (safety):** consume the structural seams below once the stable W commit is directed.

## Immediate safety — shared structural seams (`d1ea8ea`; W policy not integrated)

- `ExecutionOwner { kind: 'safety', grantId, episodeId, connectionEpoch }` runs through the single lease/executor. The lease fence calls `SkillRuntime.installSafetyGrantCheck` (fail closed when absent or expired). The executor skips goal-epoch/anchor checks for grant-fenced dispatches; outcome owner is `safety`.
- `ActuatorLeases.preemptForSafety()` revokes a non-safety lease synchronously with reason `safety_preempt`; the goal stays admitted.
- `SkillRuntime.safetyActuation()` (SafetyActuationPort shape) and `ChunkbotApp.safetyAuthority()` (W's SafetyAuthority shape: engine basis, connection, alive, travel). The TaskRuntime hold gate and engine authority hooks are from `49f14a1`.
- Tests: `tests/safety-seams.test.ts`.
- Remaining after the stable W commit: compose W's service — `attachConnection` before login, `onLifecycle` before lease/ledger invalidation, `start`/`close`, the TaskRuntime `safety` gate, `installSafetyGrantCheck(grantCurrent)`, the `onSafetyAuthorityChanged` nudge, catalog/profile expectations for W's skills, and status/dashboard lines.

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
