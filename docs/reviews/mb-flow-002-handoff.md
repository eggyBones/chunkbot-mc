# MB-FLOW-002 smooth directive handoff: worker evidence

Coordinator acceptance: shared implementation `88089893` and final harness correction `45816d73` are integrated. Root handoff 9/9 passes on both fixtures; real H7 on 26.2 completes an ordinary two-window goal with actual lookahead, one immutable verified outcome, RCON confirmation and zero assistance. C4 passes the initialized real P0/P4/P5 rerun and a separate active-owner cleanup proof. [Independent batch review](mb-batch001-coordinator-review.md) accepts the selected feature and retains original navigation failures; native phase evidence below is retained.

**Status: implemented; verified offline, and on the 26.1.2 fixture (scripted fault planner + loopback Jev only) under the coordinator's lease. FINAL integrated run: source and `dist/` frozen at `88089893` (C1, C2, C3, C3a; UI `24c6744`; memory `e3d41a1`), harness at `0694bb0`. Results: handoff 9/9, live-check 16/16, skills-live-check 33/33, jev-live-check --provider fault 12/12, all exit 0. See "Final integrated runs" below. This is the native phase handoff; completed coordinator checks and retained quality limits are in the linked batch review.** Worker: native Claude Code (Opus 5.5). Branch `chunkbot/mb-flow-002`, base `d5eb2fa`. Date: 2026-10-06 UTC.

This is worker evidence. It does not change the roadmap, plan status or acceptance records; the coordinator owns those.

## Outcome

While Chunkbot runs an admitted task (for example, following Jake), a new owner instruction no longer freezes it:

1. The instruction is acknowledged at once: *"Preparing your new instruction: "…"; continuing the current task until handoff."*
2. The current task keeps running under its original limits while the planner prepares the new instruction.
3. Chunkbot switches only when the prepared plan is valid. At that point:
   - the old goal is revoked and its cleanup awaited (bounded);
   - the new goal is admitted, with its own travel anchor and a server-confirmed inventory baseline;
   - the draft is re-grounded against a fresh snapshot and rechecked;
   - the accepted outcome is bound to that admission baseline.

Stop and lifecycle events stay immediate and cancel both contexts. Failures before admission keep the old task and say so.

## Gate H-G1: decision

**A typed planning subject on the single existing `PlannerPort`, not a second port and not a fake goal.**

`PlannerRequest.goalId` is replaced by `subject: PlanningSubject`:

```ts
type PlanningSubject =
  | { kind: 'goal'; goalId; goalEpoch }
  | { kind: 'preparation'; intentId; generation; connectionEpoch; activeGoalId: GoalId | null };
```

A preparation has an `intent-…` id and no goal id. It owns no epoch, travel anchor, admission baseline, lease or interface. Every turn goes through one port and the engine's `PlannerSlot`: goal turns, preparation turns and window lookahead. That is how the single-planner-process invariant holds structurally. A second port would have let the preparation path bypass the adapter's one-turn-in-flight guard.

Preparation requests also carry `preparation: { continuingTask, inventory: 'provisional_client_model', note }`. Lookahead requests carry `lookahead: { runningTask, note }` with `turnKind: 'lookahead'`. The prompt version is now `gameplay-planner-v3`: two handoff lines (`preparing`, `lookahead`), plus the memory paragraph and the prepared-ref rule. **This needs the coordinator's real-planner acceptance.**

## Gate H-G2: what continues during preparation (offline answer, live probe pending)

- **Only the currently admitted task continues.** While a replacement is pending, the old goal *parks* before:
  - starting the next task of its window;
  - any planner turn (including after a window ends);
  - using a lookahead.

  `goal_parked_for_handoff` is recorded, and the owner is told *"The current step finished; waiting for your new instruction's plan before switching (no new work started)."*
- **The preparation is read-only towards the game.** It uses `ObservationPort.snapshot(0)`, labeled epoch 0 so it belongs to no goal, plus the catalog and version knowledge. It never calls `captureBaseline` (an inventory resync), never takes the actuator lease, opens no interface and executes no candidate. The tests assert that no baseline is captured before admission.
- **Snapshot freshness.** Perception keeps 8 snapshots. A draft's observed handles are re-grounded with `ObservationPort.translateHandle` (already implemented by `PerceptionService`). That method resolves only the SAME block position, entity id or frontier waypoint, and never falls back to another target.
  - If a handle is no longer produced, or its snapshot was evicted, the draft is *materially stale*. Nothing is executed from it, and a counted goal-level repair turn runs with the real admission inventory.
  - Registry selectors survive unchanged.
- **InterfaceGate, lease and outcome verification are unchanged.**

The fixture probe (follow plus an inventory-changing gathering task) is scenarios L1 and L2 of the live harness. It needs a lease.

## Implementation map

| Path | Change |
| --- | --- |
| `src/contracts/handoff.ts` (new) | `PlanningSubject`, `PreparationContext`, `LookaheadContext`, `PendingInstructionStatus`, `PendingClarification`, `PreparationDiscardReason`, `HandoffTotals`, `ControlLatch`, `WindowGap` |
| `src/contracts/planner.ts`, `ids.ts`, `goal.ts`, `ports.ts` | request `subject`, `PlannerTurnKind` (with `lookahead`), `subjectRef`; `intent` ids; counters `preparationTurns`, `lookaheads`; optional `ObservationPort.translateHandle` |
| `src/goals/goal-engine.ts` | pending lifecycle (`startPreparation`, `prepare`, `handoff`, `discardPending`), parking, admission transfer, draft revalidation, lookahead, latch, status |
| `src/goals/planner-slot.ts` (new) | single planner process: each turn starts after the previous process settled (bounded wait); owner preparation preempts lookahead |
| `src/goals/reground.ts` (new) | pure draft re-grounding into a fresh snapshot |
| `src/planner/prompt.ts`, `codex-planner.ts`, `planner-check.ts` | subject rendering and evidence (`goalId` or `intentId`); memory view rendering; instructions v3 |
| `src/config/schema.ts` | optional `flow: { handoff: 'smooth' \| 'immediate', lookahead: boolean, preparationTurnsPerRun }` (defaults `smooth`, `true`, `40`) |
| `src/app/app.ts`, `status.ts`, `doctor.ts` | flow and connection-epoch wiring; status lines for pending instruction, parking, totals, window gap and latch; `resume`; doctor `flow` line |
| `src/commands/parse.ts`, `router.ts` | bare `resume` command (any longer text stays an instruction) |
| `scripts/handoff-live-check.ts` (new), `package.json` | `npm run handoff-live-check` fixture harness |
| `tests/handoff-*.test.ts` (new), existing planner tests | behavior tests; counter expectations; `subject` |

## Behavior and invariants

**Intake.** Validation (closed, empty, length, connection) happens before anything is touched. Smooth preparation applies only when an owner goal is `executing`, or an instruction is already pending. Planning, clarification and idle states have no task to continue, so they use the existing direct admission. `flow.handoff: immediate` restores the old behavior everywhere.

**One pending instruction.** It is identified by intent id, intake generation and connection epoch. A newer instruction supersedes it:
- its planner turn is aborted;
- the slot waits (bounded) for that process to settle before the next turn;
- late replies are fenced by generation and pending identity;
- the active task is never stopped by supersession.

**One planner process (MB-FLOW-002-C1 fixed in `2a6aaae`).** `PlannerSlot` chains its tail on the ACTUAL settlement of every earlier turn.
- A waiter that exceeds `cleanupTimeoutMs`, or whose owner is revoked while waiting, gets a bounded failure and starts nothing. The engine maps the timeout to `process_error` ("no second planner process was started"), recorded as `planner_slot_wait_timeout`.
- A skipped or timed-out ticket never releases later work past a still-running turn.
- Regression tests use a non-cooperative planner (it ignores abort): rapid replacements keep `maxInFlight` 1, and stop stays under 250 ms (`tests/handoff-slot.test.ts`).
- The shared `ScriptedPlanner` fake now honors abort, as `PlannerPort` requires.

**C2 (outcome references).** A prepared draft's OUTCOME references are re-grounded with its tasks against the fresh admission snapshot BEFORE the initial binding: both snapshot handles and prepared memory refs. A disappeared target is a counted repair, with nothing bound or run. A lookahead never rewrites the accepted, bound outcome; it must repeat it exactly, and only its new tasks are re-grounded. Covered in `tests/handoff-corrections.test.ts` (`9686b69`).

**C3 (owned preparation process).** Discarding a preparation aborts its planner process synchronously. Its owned process cleanup is then awaited within `cleanupTimeoutMs` and recorded as `preparation_cleanup` settled/timeout.
- `stop`, `endOwnership` and `shutdown` await it together with the active goal's revocation; control invalidation stays synchronous.
- The intent settles, letting a parked old goal resume, only after that cleanup.
- Supersession acknowledgement stays prompt, and the next turn is serialized behind the real cleanup.
- Tested with abort-honoring (120 ms) and non-cooperative processes: bounded at 150 ms.

**C3a (superseded preparations).** The engine tracks EVERY outstanding discarded-preparation cleanup in a set, superseded ones included. `stop`, `endOwnership` and repeated `shutdown` await them all, bounded, together with the active goal's revocation. Actuation invalidation stays synchronous, and supersession acknowledgement stays prompt (`2c363c8`; regressions: supersede then immediate stop or lifecycle, and a repeated shutdown).

**Switch order.**
1. Revoke the old goal: `replaced`. The epoch is invalidated, the task is aborted and cleanup is awaited.
2. Admit the new goal (new epoch, anchor hook).
3. `captureBaseline`: the server inventory AFTER the old task released the actuator.
4. Take a fresh snapshot and re-ground the draft.
5. `checkProposal` against the fresh shown context.
6. Bind the outcome to the admission baseline, then run the window.

Pre-admission gains are therefore part of the baseline, so they are never counted as newly collected.

**Counting.**
- Preparation turns (initial, knowledge, repair, retry, clarification) transfer into the admitted goal's counters: `plannerTurns` and `preparationTurns`.
- Turns of discarded preparations add to `handoff.discardedTurns`. Once `preparationTurnsPerRun` is used up, intake falls back to direct replacement with an explicit notice. Totals are shown in status.

**Failures before admission** (`planner_not_ready`, `planner_error`, `invalid_proposal`, `cannot_execute`, `limit_exhausted`, `not_connected`):
- The notice reads: *"Your new instruction was not started (reason): detail. Continuing goal goal-N."*
- Auth and quota failures carry the existing advice and never fall back.
- Timeout and process errors get one counted retry; malformed output gets at most 2 repairs.
- A prohibited event or reroute disables the planner for the run (unchanged adapter behavior).

**Pending clarification.** The question is stored on the pending instruction, not on the active goal. Status shows both. Waiting makes no planner calls. `answer qN` is routed to the pending instruction first, and stale refs are rejected.

**Wording (coordinator decision).** Status and chat say **"Automatic work paused"** while the latch is set, and add "the current goal is owner-commanded and runs normally" when an owner goal is active. An executing manual goal is never labeled stopped or paused. Bare `resume` (case-insensitive; no arguments) answers "Resumed: automatic work is allowed again. Nothing earlier is replayed and nothing new was started."

**Stop.** The synchronous prefix discards the pending instruction (its process is aborted) and revokes the active goal (the lease is revoked through the abort chain) before anything is awaited. `stop` sets the pause latch.
- `autonomyAllowed()` is false until a bare `resume`. This is the seam for the unassigned MB-FLOW-001 scheduler.
- Explicit owner instructions are still accepted while paused and do not clear the latch.

**Lifecycle.** `endOwnership` discards the pending instruction (`lifecycle`) and revokes the active goal. The pending instruction also records its connection epoch, and the handoff refuses `not_connected` if it changed.

**Restart.** Pending instructions, drafts, lookaheads and timelines live only in memory. Nothing is persisted or replayed.

**Lookahead (H7).**
- **When it starts.** When a finite window's last task starts and the proposal has `morePlanningNeeded`, one speculative turn starts. Conditions: lookahead enabled, no pending instruction, at least 2 turns left, replans left.
- **When it is dropped.** If the last task does not complete, the outcome is already verified, the replan limit is hit, or owner preparation arrives (owner preparation preempts it even while it waits for the slot).
- **When it is used.** Its plan replaces the replan turn (counted as the replan). It is re-grounded and checked like a draft, including the immutable-outcome check.
- **Waste is counted.** A discarded lookahead is a counted, wasted turn (`lookaheadsDiscarded`). It is not hidden.
- **Measured gaps.** `goal_window_gap` records `gapMs` (last task end to next first task), `source` and `revalidationMs`. These are measurements, never assumed zero.

## Evidence (offline, worker-run)

Commands were run from the worktree with the Node 24 path. Logs are under `var/batch001/`.

| Check | Result |
| --- | --- |
| `npm run check` before changes (baseline) | exit 0, 297/297 |
| `npm run check` at `b5dd7a7` | exit 0, 321/321 |
| `npm run check` at `2c8ed06` (with the integrated dashboard and memory) | exit 0, 430/430 |
| doctor on `fixture.json`, `fixture-26.2.json` and `fixture-memory.json` at `2c8ed06` | exit 0 each |
| `node dist/cli.js doctor --config config/examples/fixture.json` | exit 0 (`flow` line shown) |
| `node dist/cli.js doctor --config config/examples/fixture-26.2.json` | exit 0 |

New behavior tests (fake ports; no inference):

- `tests/handoff-engine.test.ts` (17):
  - **H1:** a 3 s delayed planner; acknowledgement under 100 ms; the follow task is not aborted at 1.5 s; no task or baseline under pending ownership; an ordered timeline; one process.
  - **H2:** the old task's late non-cancelled result is discarded (`task_result_discarded`) and never published.
  - **H3:** inventory 3 → 5 during preparation; admission baselines `[3, 5]`; the outcome is bound to 5; the new task must add 2 more.
  - **H4:** A late / B hang / C reply. Only C is admitted, two supersessions, `maxInFlight` 1, and C's turn starts after the earlier processes settled. Empty, oversized and unconnected intake leave both contexts untouched.
  - **H5:** a stop under 250 ms aborts both and sets the latch; a later instruction is accepted; `resume`. Death, disconnect and dimension change each discard both.
  - **H6:**
    - quota: no retry, honest text, never "accepted";
    - auth: advice mentions `codex login`;
    - timeout: one retry, discarded turns counted;
    - malformed output: 2 repairs;
    - clarification: separate from the goal, no calls for 200 ms, stale ref rejected, the answer completes the handoff with transferred counters;
    - `cannot_execute`.
  - **Drafts:** a successful re-grounding to the fresh snapshot; a stale draft leads to a counted repair turn with the admission inventory and no action on the stale target; allowance exhaustion leads to direct replacement; `immediate` mode.
- `tests/handoff-lookahead.test.ts` (3):
  - **H7:** with planner turns of 300 ms and tasks of 500 ms, the window gap is ≥ 280 ms without lookahead and < 150 ms with it. Revalidation time is measured, and the turn count is the same.
  - A failed last task discards the lookahead, and a replan follows with its feedback.
  - Owner preparation preempts an in-flight lookahead (`maxInFlight` 1).
- `tests/handoff-app.test.ts` (4): through `ChunkbotApp`:
  - chat acknowledgement and status lines for both contexts;
  - chat stop and the latch line;
  - `resume` parsing (bare word only) with no replay;
  - `flow` config defaults and strictness.

## Live fixture evidence (26.1.2, coordinator lease, fault planner + loopback Jev only)

Reports are under `var/live-check/<stamp>-handoff/report.json`; logs are under `var/batch001/live-run-*.log`. Build `dist/` was from source `4877443` (C1 fix plus usage fixes). Only harness assertions changed between reruns.

| Run | Scenarios | Result |
| --- | --- | --- |
| `08-03-23` (`live-run-1-interrupted`) | L0–L7 | **INVALID, not evidence** (coordinator MB-BATCH001-I1). At 08:03:29Z the memory worker accidentally imported its executable live check without a lease: it reset this scene and joined as `Chunkbot`, which disconnected my bot ("logged in from another location"). It detected this and stopped at 08:03:34Z. The coordinator then stopped the remaining harness process at 08:06:15Z. |
| `08-07-33` (`live-run-2`) | L0–L7 | 8/9 passed. L1 failed only on an evidence assertion (a follow action emits no `task_action` inside its 30 s window). |
| `08-09-38` | L0, L1 | L1 failed on a revised assertion (revocation-at-switch counted as "ended before admission"). |
| `08-10-38` (`live-run-4-L1`) | L0, L1 | **2/2 passed.** |
| **`08-24-47` (`live-run-5-revised`)** | L0–L7 | **9/9 passed, exit 0.** Frozen revised source `2276a45` (C1+C2+C3, UI `235a727`, memory `bc785f3`, dashboard/memory wiring), with `dist/` built by `npm run check` (exit 0, 457/457) on the identical tree. The fixture was idle with 0 online before the start, no connection losses, and no leftover processes afterwards. |

### Final integrated runs (frozen `88089893` source and `dist/`; 26.1.2 only; fault and loopback providers only)

`npm run check` passed (exit 0, 469/469), as did doctor on `fixture`, `fixture-26.2` and `fixture-memory` (exit 0). `src/` is unchanged from `88089893` through harness head `0694bb0`; the build includes only `src/`.

| Check | Report | Result |
| --- | --- | --- |
| `npm run handoff-live-check` (harness `0694bb0`) | `var/live-check/2026-10-06T08-39-36-205Z-handoff/report.json` | **9/9, exit 0** |
| `npm run live-check` | `var/live-check/2026-10-06T08-30-36-324Z/report.json` | **16/16, exit 0** |
| `npm run skills-live-check` | `var/live-check/2026-10-06T08-31-13-919Z-skills/report.json` | **33/33, exit 0** |
| `npm run jev-live-check -- --provider fault` | `var/live-check/2026-10-06T08-37-26-191Z-jev-fault/report.json` | **12/12, exit 0** |

Two earlier harness passes on `88089893` failed only at L7; L0–L6 passed both times:
- **`08-28-46`: 7/9**, with the harness as committed in frozen `88089893`. Window 1's "collect 1 log" task mined two logs before its completion check, so the 2-log outcome finished correctly in one window. That is **invalid two-window evidence**, not a failure to honor the goal (coordinator decision).
- **`08-35-36`: 8/9**, harness `2bbf0c4`. A "walk to the obsidian" window found no grounded `move_near` destination. The engine correctly discarded the lookahead (its premise failed) and replanned. The no-lookahead run passed.

The harness-only corrections were:
- `2bbf0c4`: two distinct predicates instead of two log windows.
- `0694bb0`: window 1 = walk to the owner (`move_near` owner, completion `near_target` owner), placed about 8 blocks away by one recorded setup `tp`; window 2 = collect 1 oak log (`inventory_delta` logs). Both windows repeat the same accepted outcome (`collect_additional` 1 log, bound to the admission baseline). Each task keeps its own capability and key scope, so window 1 cannot satisfy the outcome.

The gap and second-window assertions were not weakened. There were no other retries.

L7 was then made deterministic (window 1 walks to the owner, proven grounded; window 2 collects the log). Those were harness design issues, not engine faults. A first attempt at the Jev check did not run (exit 1, my own `npm` argument quoting); its correct rerun is the result above.

Final handoff run highlights:
- **L1.** Acknowledged 1 ms after the chat; the bot moved 4.95 blocks (RCON) during the 3.5 s preparation; switch at 3.95 s.
- **L2.** Baseline 1 at send equals the admission baseline 1; completed with 2. No pre-admission gain in this run; the gain case is in `08-07-33`.
- **L3.** Only D admitted; 3 supersessions; killed process groups cleaned; spoofs rejected; 0 overlaps.
- **L4.** The lease was revoked **3 ms** after the stop (`clearMs=1`, target 250 ms). The cancelled line came at 352 ms, including the bounded preparation-process cleanup wait. 0.00 blocks of drift; "Automatic work paused"; `resume`.
- **L5, L6.** As before.
- **L7.** Gap **69 ms** (lookahead; revalidation 24 ms; the lookahead turn ready after 1.13 s) vs **1179 ms** (replan).

No connection losses. 271 recorded setup commands and 8 recorded scripted owner moves. No foreign login on 26.1.2 after the incident. A `skills-live-check --fixture 26.2` process (not mine, targeting 26.2) was seen briefly and had exited.

Revised run (`08-24-47`) highlights:
- **L1.** Acknowledged 5 ms after send; switch at 3.95 s; the bot moved 4.31 blocks (RCON) during preparation; the old task ended by revocation 308 ms after handoff start; the late old result was discarded; 0 planner overlap.
- **L2.** This time no log was gained during preparation: 1 at send, admission baseline 1, bound to 1, completed with 3. The pre-admission-gain case was shown in run `08-07-33` (1 → baseline 2 → completed 3).
- **L3.** Only D admitted; 3 supersessions; killed process groups cleaned; `preparation_cleanup` was recorded `settled` for the real killed fault-planner processes (C3).
- **L4.** The stop landed while a follow action held the lease. The lease was revoked **3 ms** after the stop with `clearMs=0` (target 250 ms). The goal-cancelled line came at 348 ms, which now includes the bounded wait for the real preparation process cleanup (C3). 0.00 blocks of drift. "Automatic work paused" status, then `resume`.
- **L5–L6.** As before: death cleared both contexts; quota was honest and the follow kept moving 3.19 blocks; clarification made 0 planner execs while waiting and then handed off.
- **L7.** Gap **79 ms** (lookahead; revalidation 19 ms; the lookahead turn was ready after 2.64 s) vs **2690 ms** (replan).

Evidence highlights:
- **L1 (H1/H2).** The owner's chat was received and acknowledged within 1 ms of send. The switch (goal accepted) came 3.95 s after send, with a 3.5 s scripted planner delay. During preparation the bot moved 4.95 blocks (RCON server positions sampled while the owner walked). The old follow task ended only by revocation, 307 ms after handoff start (`cancelled (ownership_revoked)`). The late old result was discarded. One planner turn, no overlap.
- **L2 (H3).** The old goal had 1 oak log at send. The admission baseline of the new goal was **2** (a log gained during preparation). The outcome was bound to 2, and the new goal completed with **3**. No baseline or server resync happened before admission.
- **L3 (H4).** A and B were killed mid-turn, then C and D were sent back-to-back.
  - Only "instruction D" was admitted. 3 supersessions.
  - Killed planner process groups were fully cleaned (`remaining: []`, SIGTERM).
  - tellraw/say spoofs were rejected (`system_message`, `profileless_message`).
  - 3 planner turns, 0 overlaps. The follow was still running when D arrived.
- **L4 (H5).** Stop led to goal cancelled in 20 ms. The pending instruction was discarded. 0.00 blocks of drift while the owner walked away. "Automatic work paused" status, then chat `resume`. In this pre-correction run the follow was holding at the stop, so no lease was held. The harness was tightened in `8ab6fcc`, and the revised run exercised a held lease (revoked 3 ms after the stop).
- **L5.** `kill Chunkbot` during preparation: goal ended `death`, the pending instruction was discarded (`lifecycle`), and nothing was admitted afterwards.
- **L6 (H6).** Quota produced *"Your new instruction was not started (planner_not_ready): quota … no paid or alternative planner … Continuing goal …"*, and the follow moved 2.98 blocks afterwards. A pending clarification (`q1`) made 0 planner execs in 5 s, and status showed `awaiting_owner` separately. The answer handed off, and the old goal was `replaced`.
- **L7 (H7).** The same two-window oak-log goal (both completed `outcome_verified`) had a window gap of **84 ms** with lookahead (source `lookahead`, revalidation 32 ms; the lookahead turn was ready after 2.64 s while window 1 ran), against **2712 ms** without (source `replan`).

## Live harness

`scripts/handoff-live-check.ts` drives the built CLI through owner chat against the fixture. It uses the **planner fault fixture** with scripted delays (the installed codex CLI answers only the read-only isolation-gate commands; `login status` is scripted as ChatGPT mode) and the **loopback Jev fault provider**. World truth comes from RCON positions and inventory, plus run evidence. Scenarios:

- **L1 (H1/H2):** a delayed 3.5 s preparation while following. The owner walks via RCON, and server positions are sampled. Records the acknowledgement, receipt, switch and timeline; asserts no task under pending ownership, the old goal `replaced`, and no planner overlap.
- **L2 (H3):** the old goal collects oak logs; the replacement is sent after the first log. Checks the admission baseline against RCON counts, the outcome bound to it, and no baseline before admission.
- **L3 (H4):** A and B are killed mid-turn, then C and D are sent back-to-back. Only D is admitted, three supersessions, killed process groups cleaned, tellraw/say spoofs rejected, and the follow still running.
- **L4 (H5):** a stop while preparing during movement. Measures the lease revoke against the 250 ms target, the pending instruction discarded, no drift afterwards, the status latch and the chat `resume`.
- **L5 (H5):** `kill Chunkbot` during preparation. Both contexts end; nothing is admitted afterwards.
- **L6 (H6):** quota keeps the follow moving, with honest text. A pending clarification makes no fault-planner execs for 5 s; `answer` hands off.
- **L7 (H7):** the same two-window log goal with and without lookahead (separate CLI processes); compares `goal_window_gap`.

Requested invocation (exclusive 26.1.2 fixture lease, fixture already running):

```
npm run build && npm run handoff-live-check
npm run handoff-live-check -- --fixture 26.2        # with the 26.2 fixture lease
```

## Not delivered / open items

- **Live and real-provider evidence for H1–H7** is not collected yet. All of the following need a coordinator lease or credentials:
  - `handoff-live-check`;
  - the AGENTS regressions (`live-check`, `skills-live-check`, `jev-live-check --provider fault`, `planner-live-check --jev fault`);
  - `planner-check --probe`;
  - the real `planner-live-check`.
- **H7's "real Codex/Jev trial completes both milestones with zero assistance"** is a coordinator real-provider run. There is no autonomous progression scheduler (MB-FLOW-001 is unassigned). Lookahead applies only within an owner goal's windows.
- **Prompt v2 wording** for `preparing`/`lookahead` needs real-planner acceptance.
- **Dashboard and memory integration** is done locally (`2c8ed06`, merging the reviewed `df775d0`, which includes `e218b15`, and `16684a5`). Later merges: UI `235a727` (`73ac777`) and memory `bc785f3` (`823fec9`). The closures (pause with `manualGoalsAllowed: true`, memory scope and remembered home, planner getter) are in `2276a45`. Combined live checks have not been run. Open requests to Codex:
  - The pause latch is now published through the UI's `pause` DTO (`235a727`). Handoff totals and window gaps are still not part of the dashboard contract.
  - `renderMemoryView` omits `prepRef`. `prompt.ts` adds it for preparation subjects; the memory worker may want to own that.
  - The `EngineStatus` flow fields are optional in the type so the dashboard's existing fixtures compile.
- **Inherited:** the real Jev J1 240 s timeout (MB-NAME-001-C1) is unchanged and not addressed here.

## MB-FLOW-002-C4: planner-live-check inter-scenario quiescence (harness only)

Recorded by root before the work: real 26.2 P4 exceeded the 10-minute harness wait while its goal was still active. The next `resetScene()` then sent world-changing RCON with that goal still running, and P5's `submit` expected "Goal … accepted" within 15 s, although smooth handoff first *prepares* an instruction that arrives while a goal is executing. That lets one real failure cascade. The original P4 failure remains real gameplay evidence; this change does not reclassify it.

The change touches only `scripts/planner-live-check.ts`. There is no production, config, manifest, unit-test or fixture change; `src/` is identical to the accepted `88089893`.

- **`quiesce()`, a completed-stop seam before any world change.** It is called at the start of EVERY scenario (`check`) and at the start of `resetScene()`.
  - It reads `status` to find an active goal (`planning`/`awaiting_owner`/`executing`/`stopping`) and/or a pending instruction.
  - If either exists it sends an ordinary owner `stop`, which revokes active AND pending work.
  - It then waits for the application's own completion evidence:
    - the goal's terminal line, which the engine writes only after its bounded cleanup;
    - the pending instruction's `preparation_discarded`;
    - every `planner_turn_started` matched by a `planner_turn_completed`/`planner_turn_failed`, meaning no planner process is still running.
  - It confirms idle with a second `status`, then clears the stop latch with an explicit bare `resume` so the next scenario starts from the default idle state.
  - All waits are bounded by the run's configured `plannerTimeoutMs` + 4 × `cleanupTimeoutMs` + 10 s. There are no arbitrary sleeps.
  - If quiescence fails, the scenario FAILS with "could not reach an idle start". There is never a silent proceed or skip.
  - Each step is recorded in `report.json` → `interScenarioQuiescence` (prior goal or intent, stop time, terminal line, discard, resume, idle time).
- **`submit()` is consistent with pending preparation.**
  - Direct admission: still "Goal … accepted" within 15 s.
  - "Preparing your new instruction …": admission is then awaited up to the configured preparation budget, `plannerTurnsPerGoal` × (`plannerTimeoutMs` + `cleanupTimeoutMs`) + 10 s. Every preparation turn counts against the turn limit.
  - A preparation that ends without admission fails the scenario: "Your new instruction was not started …", a discard, or a hung preparation, which the engine fails after its bounded timeout and retry. A rejected instruction fails too.
  - Sent, preparing and accepted times are recorded in `report.json` → `submissions`.
- **Unchanged:**
  - in-scenario stop, replacement and death assertions (P6, P7, P11), which run after the idle start;
  - P4's question, stationary, exploration, acquisition and assistance validation, and every real outcome criterion and timeout;
  - the zero-model unit/fault tests and the exact CLI fixtures.

Checks: `npm run typecheck`, then `npm run check`: exit 0, 469/469. Not run live: I have no fixture lease, and root reruns the affected cases in an isolated copy.
