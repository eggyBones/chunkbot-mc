# MB-V1-04 Codex subscription planner: worker evidence

**Status: implemented and verified locally by the worker; real-Jev acceptance run and independent coordinator acceptance pending.** Worker: native Claude Code session `session-5cc2f441-1967-43ee-adf0-efb89a014e6c` (Opus 5.5). Dates: 2026-10-05 UTC; MB-PLAN-004 and MB-PLAN-005 harness corrections on 2026-10-06 UTC.

This document is worker evidence. It does not change the roadmap, status or acceptance records, which the coordinator owns.

Every live planner run below used the **real Codex subscription planner** on Chunkbot's normal goal intake. Unless a run is labeled otherwise, Jev was the **loopback fault provider**: it always returns the first offered option it has not just used. Those runs validate the planner, controller and harness integration. They are **not** Jev acceptance and **not** autonomous V1 delivery. The real-Jev run needs the coordinator's credential-helper injection. Its exact command is in [Real-provider run](#real-provider-run-for-the-coordinator).

## What was built

### Normal goal intake → planner → rolling task windows

`src/goals/goal-engine.ts` (`plan()`) now runs one loop for each owner goal, whether it arrives by chat or terminal.

**Admission**
- The epoch and the synchronous travel-anchor hook run first. This preserves MB-SKL-007.
- A server-confirmed inventory baseline covering **all** items is then captured (`PredicateEngine.captureBaseline`). This happens before the first planner turn, before any outcome selector is known.

**Planner turns.** Each turn sends a fresh, bounded `PlannerRequest` containing:
- the instruction and the correlated clarification answers;
- the filtered observation, the single implemented catalog and the version mechanics;
- the knowledge results so far;
- the admission inventory, plus the accepted outcome and its latest code evaluation;
- verified task feedback and ledger-verified prior results;
- the coordinates the owner typed, parsed by code;
- counters, remaining limits, and the last rejection's problems.

**Validation.** `src/goals/proposal.ts` (`checkProposal`) runs before any action and checks:
- forbidden code, limit, provider, model or config fields, and code-bearing text;
- the schema, and that every capability is implemented;
- that every parameter is declared by an allowed capability and matches its type, range and enum;
- registry items, blocks and tags, and the recipe family of the exact version (26.1.2);
- that observed handles come from snapshots shown for this goal, and remembered anchors were shown;
- that prior results are verified by the ledger;
- that each `owner_destination` matches coordinates the owner typed. An echoed `ownerText` label is rejected on its own.
- that a persistent outcome has a maintaining task.

**Dispositions**
- `needs_information`: answered by version knowledge, then another counted turn.
- `needs_clarification`: one question, correlated by `qN`. Chunkbot stays stationary and makes no calls until the answer arrives.
- `cannot_execute`: the exact missing mechanic.
- `plan`: the first accepted outcome is bound to the **admission** baseline and is immutable afterwards. A later plan that changes it is rejected and gets a repair turn. Tasks run in order through the accepted generic task runtime, and a persistent outcome's maintaining task runs in `maintain` mode. After each window, code evaluates the outcome. Only a verified outcome completes the goal; otherwise the engine replans.

**Bounds and failure handling**
- Every turn counts toward `plannerTurnsPerGoal` (20): initial, knowledge, repair, retry, clarification and replan turns.
- At most 2 consecutive repairs.
- 1 retry for a transport timeout or process error.
- 8 replans, 64 tasks in total, 8 tasks per window, a 20-minute deadline and a 45 s timeout per turn.
- Auth, quota and model errors end the goal as `planner_not_ready`, with actionable text and no fallback.
- Reroute and prohibited events end it as `planner_error` and disable the planner.

**Ownership and evidence**
- `GoalRecord.counters` is a single live object that is never reset.
- Status shows the counters, the interpretation and the planner's readiness.
- Planner-process cleanup is registered as a goal cleanup. Stop, replacement and lifecycle revocation therefore wait, within a bound, for the owned process group to finish.

Contracts extended: `PlannerRequest` fields, `PlannerFailure` kinds, `GoalCounters`, `OwnerCoordinate`, `PriorResultRef`, `AdmissionInventory`, `InventoryBaseline`, `RegistryFacts`, `GoalRecord.counters` and `outcome`, and the optional `PredicateEvaluator.captureBaseline` plus a `bind(…, baseline)` overload.

### `src/planner/`, the Codex subscription adapter

**`codex-cli.ts`: the isolation profile.** The gate fails closed unless every check below passes.

- **CLI version** must be exactly **0.160.0**.
- **Model and effort:** `gpt-6.1-sol` is selected explicitly, at effort `low`. No other planner model is accepted.
- **Managed authentication (MB-PLAN-002).** `codex login status` runs with `cli_auth_credentials_store="file"`, the same store pinned for exec.
  - This command is read-only. The pinned source `cli/src/login.rs` loads the stored auth without refreshing it and prints one line naming the mode. In this check it took 23 ms and left `auth.json` unchanged.
  - Only `Logged in using ChatGPT` is accepted. `api_key`, `absent`, `other` (access token, personal token, Bedrock, workload identity) and `unrecognized` are refused before any inference, each with actionable text.
  - Only the **mode** is kept; the raw status text is never kept, and an API key is printed masked by the CLI anyway.
  - The check runs at startup and again before **every** turn, so a login changed mid-run is caught before the next inference. A changed login is not sticky: once the ChatGPT login returns, turns work again.
  - Nothing is mutated: no logout, token copy, account switch or settings change.
- **Catalog:** the bundled entry from `codex debug models --bundled`. Only the tool-exposure metadata is restricted (`shell_type` disabled, `apply_patch_tool_type` null, `experimental_supported_tools` [], `supports_search_tool` false, `tool_mode` direct). The field types are checked, and a missing or retyped field fails the gate.
- **Features:** 40 states are set and verified with `codex features list`.
  - `skip_host_skill_discovery=true` is an under-development flag; its stage is part of the gate.
  - `unified_exec` cannot be disabled by config in 0.160.0. The source comment reads: "Managed requirements are the only configuration path that can keep unified exec disabled." It is accepted only because `add_shell_tools` returns early while `shell_tool` is off **or** the model `shell_type` is disabled, and both hold here.
- **`agents.enabled=false`.** This control is a finding of this assignment and was missing from the original G-03 set. With G-03's exact controls, the catalog's `multi_agent_version: "v2"` still registered six `collaboration.*` tools: the input was 1,592 tokens and the model listed `collaboration.spawn_agent`, among others. With this switch the input was 102 tokens and the self-reported tool list was `[]`.
- **Instructions and context:** no MCP servers, memories, skills, apps, project docs, or environment, permissions or collaboration blocks; `web_search="disabled"`.
- **Sandbox and session:** read-only sandbox, approval never, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `--no-daemon`.
- **Working directory and state:** `$TMPDIR/chunkbot-mc-planner-<uid>`, which is app-owned with mode 0700. The gate rejects it if `AGENTS.md`, `CLAUDE.md`, `.codex` or `.git` exists above it. The sqlite state also lives there.
- **Environment:** an **allowlist** of HOME, USER, LOGNAME, PATH, SHELL, TMPDIR, LANG/LC_*, TZ, TERM, CODEX_HOME, SSL and proxy variables. A deny pattern and the configured Jev key name are always removed.
- **Doctor:** runs only the read-only part of the gate (version, auth mode, bundled catalog, neutral directory). It skips `features list` because that command loads the account's cloud configuration.

**`process.ts`: owned process groups (MB-PLAN-001).**
- Each turn runs in a new process group.
- The process tree is observed every 250 ms while the turn runs, and again when it terminates.
- Each proven descendant is retained by identity (pid + `lstart` start time), including after it is reparented.
- Signals and verification use only identities proven this way. A reused pid, or an older process in a recycled group number, is never adopted.
- Cleanup sends TERM, waits a grace period, sends KILL, then polls to verify; the reported `remaining` lists actual survivors.
- `exited` resolves on the root's exit plus a stdio drain of at most 250 ms. A descendant that inherited stdout can no longer hold a turn open; `terminate` cleans it up instead.

**`transport.ts`: JSONL event validation.**
- Only `agent_message` items are accepted as output. `reasoning` items are allowed but never read or stored, and `error` items become warnings.
- A `model rerouted` error rejects the turn as `model_mismatch`.
- Any other item type rejects the turn as `prohibited_event`, even when a valid final answer follows. This covers command_execution, file_change, MCP or collab calls, web_search, todo_list and unknown types.
- Output is bounded. An abort or timeout terminates the process group.

**`wire.ts`: the output schema.**
- A strict output schema is generated from the implemented catalog.
- Predicates and selectors are `anyOf` variants, one closed object per kind. This replaced a flat format with every field nullable, which made the model fill irrelevant fields and pushed plan turns to 60–79 s.
- Bare registry names are normalized to `minecraft:` before the registry check.
- Fields that belong only to plans are ignored on non-plan dispositions.
- Descriptive entries in `missingCapabilities` are folded into the `missing` text.

**`prompt.ts`.** Holds the gameplay-only base instructions, with no goal phrases or templates, and renders the bounded JSON input from contract data only.

**`codex-planner.ts`.** Implements the `PlannerPort`: the per-turn auth re-check, usage totals and journal. `planner-check.ts` is the live diagnostic: the gate, one turn, a tool-exposure self-report and an in-flight cancellation.

### Other changes
- **Perception, MB-PLAN-003.** `translateHandle` now re-grounds a **frontier** handle to the frontier at exactly the same waypoint, and only if the newer snapshot's own frontier search produced it again: still visible, safe and inside the travel bounds. It never falls back to another frontier.
- **Candidates.** `move_near`'s `{kind:"handle"}` target parameters are re-grounded by the same rule.
- **Predicates.** `captureBaseline`, and `bind` against an admission baseline. With a baseline, `boundAtMs` is the capture time and the lifecycle mark and connection epoch are taken from admission.
- **Knowledge.** `RegistryFacts` is implemented on `VersionKnowledge`.
- **Config.** `models.planner.{mode,model,reasoningEffort}`. `config/examples/fixture-inference-free.json` sets `mode: "disabled"`.
- **CLI, app and doctor.** These compose the real planner, the per-run `planner.jsonl` journal, status lines and the `planner-check` command.
- **Inference-free profiles.** The foundation, skills and Jev-controller harnesses use `fixture-inference-free.json`. Their `planner_not_ready` and control assertions are unchanged.

## Coordinator issues: evidence of the fixes

The coordinator's independent probe scripts were run directly from `/tmp`, without modification.

| Issue | Mechanism fix | Independent probe | Maintained regression |
| --- | --- | --- | --- |
| MB-PLAN-001 | Proven descendants are retained by pid and start time across reparenting; cleanup polls and verifies; reports are accurate. | `node /tmp/chunkbot-mc-planner-child-probe.mjs` → **exit 0**. `ownedBefore [7018, 7020]`, signals `[SIGTERM]`, 68 ms, `remaining []`, `aliveAfterCleanup false`. | `tests/planner-process.test.ts` uses real python processes: cancellation, plus normal exit with a reparented child. An unrelated sentinel `sleep` survives both. A pid/start-identity reuse case is included. |
| MB-PLAN-002 | Read-only, mode-only verification of the ChatGPT login at startup and before every turn, with the credential store pinned. | `node /tmp/chunkbot-mc-planner-auth-probe.mjs` → **exit 0**. The CLI recognized `api_key`; the gate failed at `auth` after binary, neutral_dir and version, and before any catalog, feature or exec step. | `tests/planner-codex-cli.test.ts`: api_key, absent, PAT, Bedrock and unrecognized are refused with mode-only text and no key fragments; the positive ChatGPT case passes. `tests/planner-adapter.test.ts`: a login switched to API-key or signed out mid-run is caught before exec, then works again. Live F7 covers the same case. |
| MB-PLAN-003 | Frontier re-grounding only to the same waypoint produced again; `{kind:"handle"}` move targets re-grounded. | `node /tmp/chunkbot-mc-frontier-reference-probe.mjs` → **exit 0**. `frt-5` → `frt-17` at (-14.5, 0, 5.5). | `tests/perception-frontier.test.ts` exercises the actual `PerceptionService` and `TaskCandidateGenerator`: the same-waypoint candidate, the move_near parameter, refusal of a blocked (unsafe) waypoint with no fallback, a waypoint not produced again, lifecycle invalidation, and a new connection. |

### P4 diagnosis: a separate setup fact, not a second defect

The interrupted run `07-01-50-208Z` (goal `goal-32aa15b19d1b`) showed two different things:

- **The confirmed mechanism defect.** Planner-pinned frontiers became `stale:` and failed the handle schema (`explore_frontier: invalid_task_parameter`), and observed-frontier move targets became `named_target_not_visible`. This is MB-PLAN-003, now fixed.
- **A separate pretrial fact about the scene.**
  - The pickable bread is summoned at 203.5, -60, 208.5. An RCON check after the summon confirmed its position, confirmed it was still there 3 s later and resting on grass, and the diagnostic copy was then removed.
  - From Chunkbot's start position (205.5, -60, 205.5), the chest at (203, -60, 207) lies on the line of sight to this low item. Honest line-of-sight perception therefore reports 0 drops until Chunkbot moves.
  - With exploration broken, the planner's second question, which asked where the bread was, was a reasonable consequence.
  - The harness now handles up to two questions with **truthful** owner answers only. The second answer names a landmark ("on the ground just behind the chest") and gives no coordinates.

The P4 retrial after the fix completed in a single question: `goal-1c86ec2fb44b`, report `07-26-48-961Z`, real planner with fault Jev.
- The planner chose a task that allowed `survey_surroundings, explore_frontier, move_near, pickup_item`.
- A **planner-window `explore_frontier` action executed** ("arrived within 2 of frontier frt-173").
- The bread was collected by vanilla auto-pickup while walking. No `pickup_item` action ran, and the report says so.
- Delivery to the owner was verified by code: outcome `2/2 satisfied`.
- RCON: inventory `{"minecraft:bread":1}`, 1.53 blocks from the owner, and the bread entity gone.

That run's harness assertion wrongly required a `pickup_item` action. It now requires a successful exploration action plus server-held bread. A dangling poll in the harness was also removed.

## MB-PLAN-004: interface live checks inherited an occluded chest position

**Failure.** Root's independent skills run, `var/live-check/2026-10-06T01-17-34-036Z-skills/report.json`, passed 31/33 and the harness exited 1.
- X4 and I1 both failed at their first chest-handle lookup, before any interface action ran: "no minecraft:chest at 203,-60,207 in snapshot …".
- The scenarios did not position Chunkbot themselves. They inherited where X2 (obsidian dig) and X3 (crafting) had left him: 201.5,-60,204.5.
- From that spot, the furnace at 201,-60,205 and the wool at 201,-59,205 hid the chest. Line-of-sight perception correctly left it out.
- T1 had used the same chest successfully earlier in that run.

**Cause.** The cause is a missing precondition in the harness, not an application defect. The application source, perception, reach rules and handle translation are all unchanged.

**Correction.** Only `scripts/skills-live-check.ts` changed. A new `stageVisibleChest(ev, scenario)` helper runs before X4 and before I1:
1. Asserts over RCON that the scene chest exists at 203,-60,207.
2. Clears the standing cell and the cell between Chunkbot and the chest (203,-60/-59,205 and 203,-60/-59,206), only if occupied, with recorded `setblock … air`.
3. Asserts a solid floor under that position.
4. Teleports Chunkbot to the recorded position 203.5,-60,205.5, facing the chest, with a recorded `tp`.
5. Records Chunkbot's position as reported by RCON.
6. Takes a real `/diag observe` snapshot and asserts that the chest at the exact position is in it and `inReach`.

X4 and I1 then run their **original, unchanged** steps and assertions: approach, the cancellation race, the ≤250 ms control clear, no commands after revocation, server state, late-window attribution, and reuse of the next interface. Nothing hidden is used, and no rule was relaxed. This is diagnostic setup, not a gameplay trial.

**Checks.**
- `npm run typecheck` → exit 0.
- `npm run skills-live-check` → **exit 0, 33/33**, `var/live-check/2026-10-06T01-25-19-079Z-skills/report.json`. The run used the unchanged build: `src` digest `d164ea2074735aca63454fefc2a21e92b4e44f07325b293053c441b6602b6a24`, `dist` digest `c7a76aae3d6f26f66415f970767f9d3a5af19283f3f8d24f90c83be579362e7e`. Nothing was rebuilt because no application source changed.

**X4 result.**
- Staging: RCON position 203.50,-60.00,205.50; chest `blk-2492`, distance 2.3, `inReach true`.
- Stop: lease revoked with `clearMs` 1; the outcome was `cancelled` with controls cleared in 0 ms.
- Effects: the 10 cobblestone deposited before the stop stayed in the chest. The next `inspect_container` succeeded, server-synced, showing `{"minecraft:stone":1,"minecraft:cobblestone":10}`.

**I1 result.**
- Staging: same position; chest `blk-2567`, `inReach true`.
- Stops at delays of 0, 5, 10, 20, 35 and 50 ms were all `cancelled`, with `clearMs` 0–1, `windowAfterSettle null`, and no pending requests.
- **All 6 stops landed after the use packet was written.** Late windows were attributed and closed ("late window … closed (owner inactive)").
- Each following interface action succeeded.

**Setup recorded.** The run logged 92 setup commands, of which the X4/I1 staging is two `tp Chunkbot 203.5 -60 205.5 0 30` commands. No clearing `setblock` was needed, because the cells were already air. Jake's client and world were untouched.

**Scope.** The three earlier planner fixes and their source are unchanged. All other 31 skill scenarios still pass.

## MB-PLAN-005: P4 assertion scope was limited to the first task (false negative)

**Original false negative (kept as recorded).** Root's real-provider suite, `var/live-check/2026-10-06T01-34-50-901Z-planner-jev-real/report.json`, scored **18/19**. The only failure was P4, with goal `goal-373819d2603c` in app run `run-48cf0828b719`.
- The assertion "a planner-selected exploration action executed" failed.
- The harness looked only at actions of the goal's **first** task (`firstTask = first task_started`). The planner ran its exploration in a **later** window.

Root's real P4 run, reconstructed from the goal-correlated events in `var/runs/run-48cf0828b719/events.jsonl` and `planner.jsonl`:

| Step | Evidence |
| --- | --- |
| Admission | `goal_admission_baseline` 01:36:47.560, "server-synced player inventory at admission (0 item types)" |
| Clarification | `q1` 01:36:52.473; the correlated answer at 01:37:00.493; a counted `clarification` turn |
| Window 1, task `task-b5fbe61c4eb9` | Allowed `survey_surroundings, explore_frontier, pickup_item`. Real Jev chose `survey_surroundings` 30 times; every survey reported `drops: 0`, which is truthful occlusion. The task ended `blocked (no_progress)` at 01:37:42.406, with the last check "acquired 0/1 minecraft:bread since admission". Outcome: `0/2 satisfied`. |
| Window 2 (replan), task `task-dac6d6364a21` | The planner wrote "repeated surveys from here found none" and chose `explore_frontier` only. **`explore_frontier` succeeded at 01:37:58.819** ("arrived within 2 of frontier frt-5253 … 1 drops"). The task completed `completion_verified`. Outcome: `1/2 satisfied`. |
| Window 3 (replan), task `task-0300084dd01a` | The planner wrote "The bread is now in inventory". `move_near` to the owner succeeded with a final distance of 1.4. |
| Outcome | `goal_final_evidence` 01:38:11.911: `inventory_amount` "acquired 1/1 minecraft:bread since admission" (`server_sync`, baseline 0) and `near_target` 1.4. `outcome_verified` at 01:38:11.912. Counters: 4 turns (1 clarification, 2 replans), 3 windows. |
| RCON | Bread 1, 1.40 blocks from the owner, 0 interventions |

No `pickup_item` action ran; vanilla auto-pickup collected the bread. The application behaved correctly. The defect was in the harness only.

**Exact correction.** Only the P4 evaluation block in `scripts/planner-live-check.ts` changed.
- **Removed:** the `firstTask`/`findActions` filter.
- **Added:** evaluation over every event correlated to the goal, across all windows and tasks, ordered by time.
- **Logged:**
  - The admission baseline.
  - One line per task: its window, allowed capabilities, objective, terminal status and reason, and its actions run-length-compressed (for example `survey_surroundings:succeeded x30`).
  - The goal-wide count of `survey_surroundings` actions, labeled "observation only, no movement or collection", and the most drops any pre-exploration survey saw.
  - The first successful `explore_frontier`, with its window, task and effect.
  - Bread acquisition from code-verified evidence relative to the admission baseline:
    - the last "not held" evidence before the exploration (the admission baseline or a bread completion check with `acquired 0`);
    - the first "held" evidence (a successful `pickup_item` action, a bread completion check with `acquired ≥ 1`, or the bread node of `goal_final_evidence`);
    - the goal actions between the two.
  - The collection mode: a `pickup_item` action, or vanilla auto-pickup while moving.
- **Added assertions:**
  - the admission baseline exists;
  - a successful planner-selected `explore_frontier` exists for this goal in any window;
  - code-verified bread evidence exists both before the exploration (not held) and after it (held);
  - **the successful exploration came before every code-verified acquisition.**
- **Unchanged assertions:**
  - one or more questions, and stationary with 0 Jev calls while awaiting the owner;
  - each answer correlated to its own question;
  - a counted `clarification` turn;
  - `completed (outcome_verified)`;
  - RCON bread held.
- **Unchanged evidence lines:** the RCON proximity and bread-entity lines.
- **Unchanged setup and inputs:** world setup, answers and phrase.

The exploration requirement is stricter than before: it must now also come before acquisition.

**Replay against root's evidence.** An offline replay, not a test, ran the new block against `goal-373819d2603c`'s recorded events and journal and passed all assertions:
- It logged window 1 `survey_surroundings:succeeded x30` → `blocked (no_progress)`, window 2 `explore_frontier:succeeded` → `completed`, and window 3 `move_near:succeeded` → `completed`.
- 30 surveys, max drops 0.
- Exploration in window 2 at 01:37:58.819.
- Last not-held evidence at 01:37:42.406; first held evidence was the final outcome at 01:38:11.911. Actions in between: `explore_frontier` (window 2), `move_near` (window 3).
- Collection: vanilla auto-pickup.

The goal events show only that acquisition happened between those two points. The window-2 outcome (`1/2`) and the planner's window-3 interpretation are consistent with pickup during the exploration walk, but the harness does not assert that.

**Source and build correspondence.**
- No application source, prompt, model profile, limit, perception rule or world setup changed.
- `src/**` digest `d164ea2074735aca63454fefc2a21e92b4e44f07325b293053c441b6602b6a24` and `dist/**/*.js` digest `c7a76aae3d6f26f66415f970767f9d3a5af19283f3f8d24f90c83be579362e7e` are unchanged, so no rebuild was needed.
- `scripts/planner-live-check.ts` sha256 is `b1292482b5c65dd9441a22f30dcd995114ef47dff808732b3b96f6df163795f1`. The harness runs from source.
- The combined digest of every `.ts`/`.json` under src, tests, scripts and config, plus `package.json`, `package-lock.json` and `tsconfig*.json`, is `5a65b054d5f6e0fa3fa6eabbac340a710fa324ec3c23abb2f3b11b68582ac79f`. It differs from root's `711c46a0…` only by this harness edit, and possibly by file-list method.
- No mirror test was added.

**Checks.**
- `npm run typecheck` → **exit 0**.
- **Harness validation only (real planner, FAULT Jev, not Jev acceptance):** `node scripts/planner-live-check.ts --jev fault --only P0,P4` → **exit 0, 2/2**, `var/live-check/2026-10-06T01-49-53-465Z-planner-jev-fault/report.json`. The goal was `goal-4fb375551d28`, and the main CLI exited 0.
  - The planner asked `q1`. Chunkbot stayed stationary for 8 s, moving 0.00 blocks, with 0 Jev requests. The correlated answer `q1` led to a counted clarification turn.
  - Window 1, task `task-feb16e3b46c7`, ran `survey_surroundings` (drops 0), then `explore_frontier`, which succeeded at 01:50:36.210.
  - The last not-held check was at 01:50:29.769 and the first held check at 01:50:36.267 ("acquired 1/1 minecraft:bread"). Collection was by vanilla auto-pickup. `move_near` then completed.
  - The goal ended `completed (outcome_verified) 2/2`. RCON: bread 1, 1.53 blocks from the owner, the bread entity gone.
  - This run shows the new evaluation also handles a plan with a single window.
- Afterwards, no Chunkbot, harness, owner-bot or planner process from this worker was left running. The fixture is still Java PID 31385 with 0 players online, and is released.

## Live evidence

Fixture: separate vanilla **26.1.2 / protocol 775** server at 127.0.0.1:25566, Java PID 31385, survival. The built CLI was `node dist/cli.js run`, driven through owner chat and the terminal.

### Final-source planner suite (real planner, fault Jev)

`var/live-check/2026-10-05T07-29-40-503Z-planner-jev-fault/report.json`: **19/19 passed**, harness exit 0. Build `build_exit=0` came right before the run. The main CLI and both fault-fixture CLI processes exited 0. The report records 372 RCON setup commands. It also records 11 in-trial interventions: 8 owner moves (P6), 1 tool removal (P8), 1 position correction (P7) and 1 kill (P11).

**Real-planner scenarios.** These ran on normal intake with the real Codex subscription planner, `gpt-6.1-sol` at effort `low`. Planner turns took 7–44 s, with input of 7.6–9.7k tokens and output of 77–1013 tokens.

- **P1 "come here" (owner chat).** Outcome: `near_target owner ≤2`; one `move_near` task; completed `outcome_verified`. RCON distance 1.14.
- **P2, the same request from an EMPTY inventory ("get me two cobblestone").**
  - The planner first asked for knowledge (harvest and recipe rules), then planned one 7-task window: 3 logs → 12 planks → crafting table → 4 sticks → place the table → wooden pickaxe → 2 cobblestone.
  - Outcome: `inventory_amount cobblestone ≥2 collect_additional`, bound to the admission inventory, which was empty.
  - Code verified "acquired 2/2 since admission". RCON: 2 cobblestone and a pickaxe. 23 Jev calls.
- **P3, the same goal with a PREPARED inventory (a wooden pickaxe given first).** After one harvest query, the planner chose a single mining task: no crafting and no workstation. Completed; RCON shows 2 cobblestone. This plan is materially different from P2's 7 tasks.
- **P4 "bring it to me" (owner chat).**
  - The planner asked `q1` ("What would you like me to bring to you?"). For 8 s Chunkbot stayed stationary, moving 0.00 blocks, with 0 Jev requests.
  - The correlated answer led to a clarification-continuation turn.
  - The planner noted that no bread was visible and chose `survey_surroundings, explore_frontier, pickup_item`. **`explore_frontier` succeeded**, and the bread was collected by auto-pickup.
  - Delivery followed, with `2/2 satisfied`. RCON: bread held, 1.53 blocks from the owner, the bread entity gone.
- **P5, a NOVEL COMPOSITION chosen at acceptance time with no code or prompt edit for the phrase: "make four oak planks and put them in the chest".**
  - Knowledge query, then 1 log → planks → `container_transfer` into the chest, which the planner referenced as a **remembered anchor**.
  - Outcome: `crafting_result oak_planks ≥4` AND `container_state` (a fresh server-synced read after binding).
  - RCON chest: `[{count:4, id:"minecraft:oak_planks"}]`.
- **P6 "follow me".**
  - Outcome: persistent `near_target owner ≤3`. The `follow_entity` task ran in maintain mode.
  - About 32 s of owner movement (8 interventions) used **0 further planner turns, 1 Jev request and local continuations**. No false no-progress fired.
  - Stop: `lease_revoked` came **1 ms** after `stop_requested` (clearMs 0). The goal showed cancelled 308 ms later, after the follow action returned.
- **P8, a removed prerequisite (INTERVENED recovery, not an autonomous trial).** The pickaxe was cleared when window 1 started.
  - 9 turns: 3 knowledge rounds and 5 replans, over 6 windows and 15 tasks.
  - The planner's sequence: it verified the inventory, learned the pickaxe was gone, crafted materials, found that a remembered crafting table had been removed, then crafted and placed a new table, made the pickaxe and mined.
  - **The outcome was identical across all 6 plans.** Code verified "acquired 2/2 cobblestone since admission".
- **P9 "make me two stone", with 10 cobblestone, 2 logs and a table already held.**
  - The planner made two knowledge rounds and stated "ordinary stone blocks … not smooth stone".
  - Outcome: `smelting_result stone ≥2` AND `inventory_amount stone ≥2 collect_additional`.
  - It placed the table, crafted a furnace, placed it, fuelled it, loaded 2 cobblestone, waited, and took the result.
  - RCON: `{"minecraft:stone":2}`, and the cobblestone was consumed.
- **P10 "enchant your pickaxe with efficiency".** Ended `cannot_execute`. The planner said the available skills cannot operate an enchanting table or anvil interface, and predicates cannot verify enchantments. There were 0 tasks and 0 Jev calls. This is evidence-based, not a keyword rejection.
- **P7, stop and replacement during planning.**
  - Stop while a planner turn was in flight cancelled the goal in **85 ms**.
  - The owned group `[13141, 13146, 13160, 13161]` included the CLI's own children. It received SIGTERM, was cleaned in 84 ms, and left `remaining []`. No proposal or task followed.
  - In a separate goal, Chunkbot was teleported during planning. That goal's anchor stayed at its admission position (205.5). A replacement chat goal cancelled it with reason `replaced`, its planner process was cleaned, and the replacement captured a fresh anchor at 211.5.
  - The replacement completed with "come here", and its anchor was unchanged after its first action.
- **P11, death during planning.** The goal failed with reason `death`. The planner process was cleaned in 95 ms with `remaining []`, no task was admitted, and Chunkbot respawned idle; status shows the failed goal.

**Planner fault fixture.** A separate CLI process ran the real gate against the real installed CLI, with scripted exec output.

- **F1:** code-bearing text, an invented handle and invented coordinates (with an `ownerText` label) were rejected in that order: `invalid_output`, `reference`, `reference`. After 2 repairs the goal ended `invalid_proposal`. 3 turns were counted, there were 0 tasks, and Chunkbot moved 0.00 blocks.
- **F2:** quota and 401 auth both ended `planner_not_ready` with actionable text and no fallback.
- **F3:** a hanging turn with an attributable child timed out at the **experimental 4 s timeout** set by the fault config, and was retried once. Each attempt's group was cleaned with `ownedBefore` holding 2 PIDs and `remaining []`, and the child was dead. The goal ended `planner_error`.
- **F4:** five knowledge rounds exhausted the **experimental turn limit of 5** set by the fault config; the goal ended `limit_exhausted` with the counters preserved.
- **F7:** a login switched to a persisted API key was refused **before any exec** with `auth mode api_key`; the fixture exec counter stayed at 0. Once the login was back on the subscription, the planner ran again.
- **F5:** a model reroute ended `planner_error model_mismatch`, and status then showed the planner disabled for the run.
- **F6:** a prohibited `command_execution` item ended `planner_error prohibited_event` with no task.

### Earlier iteration evidence (valid only as iteration, not final source)

- `06-41-55-331Z`: P4/P6/F2.
- `06-44-36-453Z`: P8, recovery from a pickaxe removed on purpose. It took 6 planner turns and 4 windows, and the outcome was identical across all four plans. **This was an intervened recovery, not an autonomous resource trial.**
- `06-52-54-369Z`: P9 stone versus cobblestone, P10 an unsupported mechanic, P11 death during planning.

The following runs came before MB-PLAN-001/002/003 were fixed and are superseded:
- `06-33-30-451Z`: P0–P7 passed; the F checks failed on a fixture pass-through flush bug, since fixed.
- The interrupted run `07-01-50-208Z`.

### Timeout experiment (labeled)

`06-21-19-633Z` and `06-30-46-449Z` ran P2 with `--planner-timeout-ms 240000`, an **experimental override and not the default**.

- With the old flat schema, plan turns took 60–79 s for 1.8–2.5k output tokens.
- One knowledge turn stalled past 240 s; the identical retry then took 60 s.
- After the `anyOf` schema change, plan turns took 8–29 s. The default stays **45 s** and the retry policy absorbs stalls.
- No acceptance claim relies on the override.

### Regression checks on the inference-free profile

All of these were run before the corrections: foundation 16/16 (`06-55-41-090Z`), skills 33/33 (`06-56-25-318Z-skills`) and the Jev controller fault run 12/12 (`06-59-39-117Z-jev-fault`). Their fresh reruns on the final source are listed in [Checks](#checks-final-source).

## Checks (final source)

All commands ran from the repository root with `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`, and exit codes were captured directly.

| Command | Result |
| --- | --- |
| `npm run check` (typecheck, clean build, tests) | **exit 0, 286/286** tests, including the new suites: planner-wire, planner-validation, planner-codex-cli, planner-transport, planner-process, planner-adapter, planner-engine, perception-frontier, and the predicate admission-baseline tests |
| `node /tmp/chunkbot-mc-planner-child-probe.mjs` (independent, unmodified) | **exit 0** |
| `node /tmp/chunkbot-mc-planner-auth-probe.mjs` (independent, unmodified) | **exit 0** |
| `node /tmp/chunkbot-mc-frontier-reference-probe.mjs` (independent, unmodified) | **exit 0** |
| `node dist/cli.js doctor --config config/examples/fixture.json` | **exit 0**; all planner checks pass, including the auth mode |
| `node dist/cli.js doctor --config config/examples/fixture-inference-free.json` | **exit 0**; planner shown as disabled |
| `node dist/cli.js planner-check --config config/examples/fixture.json --probe` | **exit 0**. The full gate passed. The real subscription turn took 11.3 s. Tool probe `[]` with 1,416 input tokens. Cancellation after `turn.started` cleaned up in 70 ms with `remaining []` |
| `npm run live-check` (inference-free profile) | **exit 0, 16/16**, `var/live-check/2026-10-05T07-42-45-768Z/report.json` |
| `npm run skills-live-check` (inference-free profile) | **exit 0, 33/33**, `var/live-check/2026-10-05T07-43-24-575Z-skills/report.json`. Root's later independent run hit MB-PLAN-004 (31/33). After the harness-only correction: **exit 0, 33/33**, `var/live-check/2026-10-06T01-25-19-079Z-skills/report.json` |
| `npm run jev-live-check -- --provider fault` (inference-free profile) | **exit 0, 12/12**, `var/live-check/2026-10-05T07-46-40-371Z-jev-fault/report.json` (fault provider; not Jev acceptance) |
| `npm run planner-live-check -- --jev fault` | **exit 0, 19/19**, `var/live-check/2026-10-05T07-29-40-503Z-planner-jev-fault/report.json` (real planner, fault Jev) |

**Source, built and running state.**

- **Source digest:** `3630bde7a0b7a543b5d87ff4bfdad7cbd9f44ef892902ce03a0955aeef2c1fef`. This is the sha256 of the sorted sha256 list of every `.ts`/`.json` file under src, tests, scripts and config, plus the package and tsconfig files. The `src/**/*.ts` digest alone is `d164ea2074735aca63454fefc2a21e92b4e44f07325b293053c441b6602b6a24`. The source did not change during the final checks; only Markdown documents were edited afterwards.
- **Built `dist/**/*.js` digest:** `c7a76aae3d6f26f66415f970767f9d3a5af19283f3f8d24f90c83be579362e7e`. It is identical for the build used by the 19/19 suite and the rebuild done by `npm run check`.
- **Running:** no Chunkbot application is running. The fixture server is still Java PID 31385 with 0 players online.

**Process cleanup.** Every Chunkbot CLI, harness, owner bot, fault fixture and planner turn this worker started has exited. A process listing after the checks showed none left. One harness was kept alive by a stray poll timer; I terminated that process myself, and the harness bug is now fixed. The ChatGPT desktop app's `codex exec-server` process is unrelated and was not touched.

## Real-provider run for the coordinator

The worker has no OpenRouter key, so this run is for the coordinator. It covers the real Codex subscription planner, real OpenRouter Jev and real Minecraft, through the built normal entry point. The worker is idle and has released the fixture.

- **cwd:** `.`
- **env:** `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`, plus `OPENROUTER_API_KEY` injected by the credential helper. The planner never receives it; its environment is an allowlist.
- **Optional provider smoke test:** `["node","dist/cli.js","jev-check","--config","config/examples/fixture.json","--json"]`
- **Planner gate and probes (no key needed):** `["node","dist/cli.js","planner-check","--config","config/examples/fixture.json","--probe"]`
- **Integration run:** `["node","scripts/planner-live-check.ts","--jev","real"]`. It uses the current `dist/cli.js`; do not rebuild, or rebuild with `npm run build` from unchanged source, which reproduces the digest above.
  - Config: the harness writes `var/live-check/<stamp>-planner-jev-real/fixture-planner.json`, derived from `config/examples/fixture.json`. That file sets planner mode `codex`, command `/opt/homebrew/bin/codex`, model `gpt-6.1-sol` at effort `low`, the official Jev route `typesafe/jev-1.13`/TypeSafe, `apiKeyEnv` `OPENROUTER_API_KEY`, the absolute `var/` data directory, and the default limits (planner timeout 45 s, 20 turns).
  - The F-series scenarios use their own fault-fixture config with an experimental 4 s timeout and 5 turns, labeled as such.
  - Expected duration is about 25–30 minutes.
  - Jev cost: the fault-mode run made roughly 60–80 sequential decisions. Each reserves USD 0.001344 and reconciles to about USD 0.00004, all under the USD 1 per-run cap.
  - Report: `var/live-check/<stamp>-planner-jev-real/report.json`. It includes planner proposals and revisions, Jev requests and choices with model, provider, cost and latency, actions, final predicates, RCON truth, setup commands and interventions.
- **MB-PLAN-005 real P4 subset:** `["node","scripts/planner-live-check.ts","--jev","real","--only","P0,P4"]`, same cwd and env. P0 is the built-CLI readiness check: planner gate on normal intake, Jev ready, and status. Use the unchanged build; no rebuild is needed.
- **Fixture requirements:** fixture running on 127.0.0.1:25566 and no other Chunkbot connected. The harness resets only the scene area and joins `FixtureOwner`.

## Limitations

- **Model identity.** Identity is the *selected* `gpt-6.1-sol`. The CLI does not echo a server-resolved model. Only the absence of a reroute event is checked; a silent server-side substitution would not be visible.
- **Version pinning.** Isolation is verified for codex-cli 0.160.0 only. Any other version fails closed until the controls are re-verified.
  - `unified_exec` stays on, inert as described above.
  - `skip_host_skill_discovery` is under development.
  - The tool-exposure self-report is corroboration only. The supported controls and the 102-token input are the primary evidence.
- **Auth.** The check inspects the pinned file credentials store. A user whose valid ChatGPT login lives only in the keyring store is refused with actionable text rather than switched. Status and the turn are separate processes, so a login change in the milliseconds between them is not covered; the next turn's re-check catches it.
- **Descendant tracking.** It relies on observing the process tree every 250 ms while a turn runs. A descendant created and detached within one interval, after which its parent exits before the next observation, could escape attribution. The pinned Codex CLI is not known to do this. Identity uses `ps` `lstart`, which has 1 s granularity.
- **Planner judgment.** Planning quality is model behaviour, validated only by code checks. Plans can be inefficient.
  - For example, after a removed tool the planner first tried to re-equip it.
  - Fault Jev picks options mechanically, so action counts in fault runs say nothing about Jev quality.
- **Perception.** P4 depends on honest line-of-sight perception. An occluded drop requires exploration, and pickup may happen by vanilla auto-collection rather than a `pickup_item` action.
- **Scope.** No online or Microsoft-account trial took place, and no shared world was used. Final autonomous trials and independent delivery checks remain MB-V1-05 work.

## Coordinator acceptance

Accepted2026-10-06 after the retained full real run and corrected fresh real P0/P4 trial. [Independent review](mb-v1-04-coordinator-review.md) is the acceptance authority. This worker document retains its historical check states; final V1 delivery remains MB-V1-05.
