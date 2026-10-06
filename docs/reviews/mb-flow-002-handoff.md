# MB-FLOW-002 smooth directive handoff: worker evidence

**Status: implemented; verified offline, and on the 26.1.2 fixture with the scripted fault planner and loopback Jev under the coordinator's lease (all harness scenarios L0–L7 passed across bounded reruns; see below). Real-planner/Jev acceptance and combined integrated live checks are pending (coordinator).** Worker: native Claude Code (Opus 5.5). Branch `chunkbot/mb-flow-002`, base `d5eb2fa`. Date: 2026-10-06 UTC.

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

Preparation requests also carry `preparation: { continuingTask, inventory: 'provisional_client_model', note }`. Lookahead requests carry `lookahead: { runningTask, note }` with `turnKind: 'lookahead'`. The prompt version is `gameplay-planner-v2`, with two added instruction lines. **This needs the coordinator's real-planner acceptance.**

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
| `src/planner/prompt.ts`, `codex-planner.ts`, `planner-check.ts` | subject rendering and evidence (`goalId` or `intentId`); instructions v2 |
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
| `08-03-23` (`live-run-1-interrupted`) | L0–L7 | **Invalid run.** Chunkbot was disconnected at 01:03:32 local by **"You logged in from another location"**: a foreign `Chunkbot` login from 127.0.0.1:60266 that lasted about 2 s. It was not from my processes or tests, which all use fakes. The harness was later terminated by SIGTERM (not from me) during L7. Reported to Codex. |
| `08-07-33` (`live-run-2`) | L0–L7 | 8/9 passed. L1 failed only on an evidence assertion (a follow action emits no `task_action` inside its 30 s window). |
| `08-09-38` | L0, L1 | L1 failed on a revised assertion (revocation-at-switch counted as "ended before admission"). |
| `08-10-38` (`live-run-4-L1`) | L0, L1 | **2/2 passed.** |

Evidence highlights:
- **L1 (H1/H2).** The owner's chat was received and acknowledged within 1 ms of send. The switch (goal accepted) came 3.95 s after send, with a 3.5 s scripted planner delay. During preparation the bot moved 4.95 blocks (RCON server positions sampled while the owner walked). The old follow task ended only by revocation, 307 ms after handoff start (`cancelled (ownership_revoked)`). The late old result was discarded. One planner turn, no overlap.
- **L2 (H3).** The old goal had 1 oak log at send. The admission baseline of the new goal was **2** (a log gained during preparation). The outcome was bound to 2, and the new goal completed with **3**. No baseline or server resync happened before admission.
- **L3 (H4).** A and B were killed mid-turn, then C and D were sent back-to-back.
  - Only "instruction D" was admitted. 3 supersessions.
  - Killed planner process groups were fully cleaned (`remaining: []`, SIGTERM).
  - tellraw/say spoofs were rejected (`system_message`, `profileless_message`).
  - 3 planner turns, 0 overlaps. The follow was still running when D arrived.
- **L4 (H5).** Stop led to goal cancelled in 20 ms. The pending instruction was discarded. 0.00 blocks of drift while the owner walked away. "Automatic work paused" status, then chat `resume`. **Gap:** at the stop moment the follow was holding (no lease held), so the 250 ms clear target was not exercised with a held lease. The harness was tightened in `8ab6fcc` to stop during a lease-holding follow action and assert the revoke; that needs a rerun under the next lease.
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
- **Dashboard and memory integration** is done locally (`2c8ed06`, merging the reviewed `df775d0`, which includes `e218b15`, and `16684a5`). Combined live checks have not been run. Open requests to Codex:
  - The dashboard contract has no latch/handoff/window-gap fields, so the viewer cannot yet show "Automatic work paused". That is a dashboard-owned change.
  - `renderMemoryView` omits `prepRef`. `prompt.ts` adds it for preparation subjects; the memory worker may want to own that.
  - The `EngineStatus` flow fields are optional in the type so the dashboard's existing fixtures compile.
- **Inherited:** the real Jev J1 240 s timeout (MB-NAME-001-C1) is unchanged and not addressed here.
