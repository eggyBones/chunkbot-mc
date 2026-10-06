# MB-V1-03 Jev controller: worker evidence

**Status: independently accepted (JEV-1 through JEV-4) on 2026-10-05.** See the [coordinator acceptance](mb-v1-03-coordinator-review.md).

The real-provider evidence below was produced by the coordinator: a real `jev-check` and a real 12/12 controller fixture run, with the key injected by the authorized helper. The worker never received the key. The worker's own fixture runs used a loopback **fault-fixture provider**. Those are harness and controller validation, **not** Jev acceptance, and they keep that label below. This acceptance covers the generic task controller only. Natural-language planning and autonomous V1 delivery remain MB-V1-04/05.

## Real-provider evidence (coordinator-run, resolved)

The former [credential-dependent request](#credential-dependent-evidence-request-to-codex-resolved) is resolved. The coordinator ran both commands on the corrected source; the aggregate is `var/coordinator-review/2026-10-05T05-28-27Z-jev/report.json`. All 30 commands exited 0, including:

- 24 probes, among them both unmodified MB-JEV reproductions;
- a fresh `npm run check` (232 tests) and doctor;
- foundation 16/16 (`var/live-check/2026-10-05T05-28-46-377Z/report.json`) and skills 33/33 (`var/live-check/2026-10-05T05-29-25-998Z-skills/report.json`).

The coordinator's digest method differs from the one used below. Its digest was unchanged before and after the review: `193ad16ffcbb320ab13799c97c92a6379038ff3d9e0d61274fe355ae0a0a152c`.

### Real `jev-check`

Redacted output: `var/coordinator-review/2026-10-05T05-28-27Z-jev/jev-check-real.log`.

- Exit 0.
- Requested `typesafe/jev-1.13`; received `typesafe/jev-1.13-20260917` from TypeSafe.
- Selected `wait` with confidence 1.
- Usage: 469 input / 47 output tokens; reported cost USD 0.000019698; latency 605 ms.
- The reservation reconciled to the actual cost, with nothing retained or outstanding.

### Real controller fixture run

Report: `var/live-check/2026-10-05T05-32-47-773Z-jev-real/report.json`. Exit 0, **12/12**, built CLI, vanilla 26.1.2 / protocol 775, fixture PID 31385.

- **Provider.** 27 attempts and 26 validated responses, all from the same model snapshot and provider. Latencies were 167–934 ms.
- **Spend.** Reported charges reconciled to USD 0.001446648. One request was aborted by stop; its charge is **unknown**, so the full USD 0.001344 maximum stays retained. Outstanding was 0, and USD 0.997209352 remained under the USD 1 run cap.
- **J1 movement.** Reached the visible chest, verified by code and RCON, using **8 Jev choices, including exploratory moves**. Success does not imply optimal navigation.
- **J2–J6 mining, crafting and interaction.** Three new logs by hand. Twelve planks, a table, four sticks and a wooden pickaxe, with server-synced results. An actual table at a Jev-chosen generated site.
- **J7 tool mining.** Two server-confirmed stone breaks and two new cobblestone items. RCON shows cobblestone, not stone items.
- **J3/J5/J8 planner feedback.** Missing tool, missing table and hidden ore each produced structured resolver feedback with **zero** Jev calls.
- **J9 interruption.** Stop during a recorded request cancelled the goal in 2 ms. Provider I/O was aborted and the reply produced no action.
- **J10 persistent follow.** About 32 s of following a moving visible owner used **one** Jev request and two local continuations. The replacement cancelled the old goal and captured a fresh admission anchor.
- **J11 quiet states.** Natural-language intake stayed `planner_not_ready`; it and 10 s of idle made zero Jev calls.
- **Setup and interventions** were recorded separately: 41 pretrial setup commands and 8 in-trial owner-movement interventions. The trials use operator-authored task specs. They are not autonomous natural-language trials.

Worker: native Claude Code session (Opus 5.5). Date: 2026-10-05 UTC (2026-10-04 local).

## Coordinator review corrections (MB-JEV-001/002, independently verified)

Both findings recorded in [the controller plan](../v1-jev-controller-plan.md) are fixed. Their coordinator probes pass unmodified (`node /tmp/chunkbot-mc-jev-spend-probe.mjs`: exit 0; `node /tmp/chunkbot-mc-jev-late-task-probe.mjs`: exit 0). Before the fixes, both probes reproduced their failure (exit 1).

### MB-JEV-001: proven pre-dispatch charge bound

`src/decision/pricing.ts` now holds a **verified route profile** (`VERIFIED_DECISION_PROFILES`). It has one entry: `typesafe/jev-1.13`, provider `TypeSafe`, serving context 32,000 tokens, `max_price {prompt 0.042, completion 0, request 0}`, with the G-02/price-probe/public-endpoint evidence. The changes:

- **Reservation.** Before every attempt, including a retry, the adapter reserves `contextTokens × admitted prompt price + request price`, which is USD **0.001344**. As long as the verified context and price profile holds, that is the most one attempt can bill on this route, whatever the provider's templating adds. The earlier bytes + 2,048 × 2 estimate is removed.
- **Refusal before dispatch.** The call is refused (`spend_cap`, zero HTTP) when the remaining **run** budget cannot cover it. Readiness also reports not-ready below that amount.
- **Settlement.** The ledger is shared across goals, tasks and retries (one per application run). Trustworthy usage is reconciled to the actual cost. Ambiguous charges retain the full maximum.
- **Unverified routes are refused.** A configured model without a profile, or an `expectedProvider` different from the profile's provider, is refused before any dispatch (`not_configured`: "no verified pricing/context profile"). Doctor warns for it, and the bound is never applied to such a route.
- **Unchanged:** the price ceiling and no fallback on every request (`max_price` now comes from the profile), the separate 16 KiB serialized-body bound, the one retry, attempt counting, cancellation, and the post-response checks (usage above the context or cost above tokens × ceiling is `pricing_changed`, sticky). The post-response check is evidence only; the reservation is what guarantees the cap.
- **Maintained tests** (`tests/jev-adapter.test.ts`, "MB-JEV-001 …"):
  - the reservation equals 32,000 × 4.2e-8;
  - a small real-sized request reconciles to its actual cost;
  - a cap just below the maximum produces zero dispatches;
  - a cap exactly equal to the maximum allows one attempt even at full-context usage, then refuses the next goal before dispatch;
  - a transient retry needs its own full reservation (with a cap of 1.5 × the maximum, the retry is not dispatched);
  - ambiguous timeouts retain 2 × the maximum;
  - an unverified model, unverified provider or no provider sends nothing.

  The earlier per-run cap test is kept. In it, goal A's ambiguous retained charges block goal B before dispatch.

### MB-JEV-002: late task results are discarded

`GoalEngine.runTask` now rechecks the active goal, epoch and abort signal after the task port returns, **before** publishing anything. If ownership was lost (stop, replacement, lifecycle or deadline), it records `task_result_discarded` (old and current goal IDs, the old task's status) and returns a `cancelled/ownership_revoked` result to its caller. It changes no `lastTask`, `currentTask`, progress, feedback or terminal state.

Ordinary completion and the bounded cleanup are unchanged. The plan seam's own `assertCurrent` after each task still applies. Maintained regression `tests/mb-jev-corrections.test.ts`, through the actual `GoalEngine` operator-task intake and registered catalog:

- An old task that resolves after cleanup and a replacement leaves the replacement's goal, task, `lastTask` and progress untouched, and exactly one discard is recorded. The replacement's own result then publishes normally and completes.
- A result that arrives after stop cannot revive or complete the stopped goal. An ordinary current task still publishes `lastTask`.

### Harness hardening

In the fault run `05-18-15-939Z-jev-fault` (11/12), J7 mined both scene stones (server-confirmed), but the cobblestone drops vanished: one pickup reported `item_vanished`, and 0 were acquired. That stone sat directly under the table J6 had placed on top of it. J7 now gets its own unobstructed stone pair, recorded as setup (`setblock 211/212 -60 196 stone` plus a teleport). The next full run passed 12/12.

## What was built

### Jev adapter (`src/decision/`)

`JevDecisionAdapter` implements `DecisionPort` as raw HTTP `POST https://openrouter.ai/api/alpha/decisions`. The wire contract is frozen from G-02 in `wire.ts`:

- **Request:** `{model, state, questions: {next_action: {type: "choice", instructions, criteria}}, provider: {allow_fallbacks: false, max_price: {prompt: 0.042, completion: 0, request: 0}}}`.
  - Criteria are keyed by code-generated candidate IDs.
  - `instructions` carries the complete question (objective, planner instruction, code-checked condition, "which one option…"). The question key is bookkeeping only.
  - There is no SDK wrapper.
- **Validation:**
  - The envelope (model, provider, answers.next_action, usage).
  - The choice must be an offered ID.
  - Probabilities must be finite in [0, 1], name only offered IDs, and sum to 1 ± 0.01. Omitted options count as 0 and are recorded.
  - Confidence must be finite in [0, 1].
  - The model must be the requested `typesafe/jev-1.13` or a dated snapshot `-YYYYMMDD`.
  - The provider must be `TypeSafe` (config `expectedProvider`).
  - Usage must contain integer `input_tokens`/`output_tokens` and a finite cost.
  - Reported input tokens must be within the verified serving context (32,000), and the cost within tokens × ceiling.
- **Size bounds:** request body ≤ 16 KiB, checked before dispatch; response body ≤ 64 KiB, cancelled when exceeded.
- **Failures:** every failure is an explicit typed `DecisionError` kind: `not_configured`, `auth`, `payment`, `model_unavailable`, `request_rejected`, `request_too_large`, `rate_limited`, `transient`, `timeout`, `invalid_response`, `model_mismatch`, `route_changed`, `pricing_changed`, `spend_cap`, `attempt_limit`, `busy`, `aborted`.
  - HTTP 401/403 map to auth, 402 to payment, 404 (no endpoint within the price ceiling, or the route is gone) to model_unavailable, 400/422 to request_rejected, 408 to timeout, 429 to rate_limited, and 5xx to transient.
  - Model mismatch, route change, pricing change, auth and payment are **sticky**: Jev is disabled for the rest of the run, with no fallback.
- **Scheduling:**
  - One request in flight (`busy` otherwise).
  - A minimum interval between attempt starts (`decisionMinIntervalMs`, 1000).
  - Each attempt is abortable and has a timeout (`decisionTimeoutMs`, 5000), linked to the owning goal's abort signal.
  - At most **one** retry, only for timeout/429/5xx, honoring Retry-After ≤ 5 s, and only if the allowance and spend still permit it.
  - Every attempt, including the retry and ambiguous ones, counts toward `decisionRequestsPerGoal`.
- **Spend:** one `SpendLedger` per **application run** (created once in `buildApp`, not per goal).
  - Before each attempt it reserves the verified route's full serving-context maximum, `32,000 × USD 0.042/M = USD 0.001344` (MB-JEV-001; evidence in `pricing.ts`).
  - The call is refused (`spend_cap`) when the cap cannot cover the reservation.
  - Settlement:
    - **Reconciled** with the reported cost when usage is trustworthy.
    - **Released** on an explicit 4xx routing/validation rejection.
    - **Retained** in full when the charge is ambiguous: timeout, abort after dispatch, network error, 5xx, an unreadable or invalid response without trusted usage.
  - Credits are never purchased.
- **Evidence:** `jev_request` (IDs, epochs, offered options, bytes, token bound, reservation), `jev_response` (requested and actual model, provider, generation ID, choice, probabilities, confidence, argmax flag, usage/cost, latency, spend snapshot), `jev_failure` (kind, detail, status, retry, spend) and `jev_disabled_for_run`. The key is read from `models.decision.apiKeyEnv` per call and never logged; a test asserts it never appears in evidence.
- **Live diagnostic:** `chunkbot jev-check` (`jev-check.ts`) sends ONE minimal decision through the same adapter. Exit codes: 0 valid, 6 key not set (nothing sent), 7 provider failure.

**Price and context evidence.** G-02 and the price probe (zero prompt ceiling → 404; ceiling 0.042 → 200). The public endpoint listing `GET https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints`, read without auth on 2026-10-05, shows one endpoint (TypeSafe `typesafe/jev-1.13-20260917`): prompt USD 0.000000042/token, completion 0, context 32,000 tokens.

- The reservation per attempt is USD 0.001344, the serving-context maximum.
- The 16 KiB body bound stays far inside the context; a module-load assertion enforces this.
- A real-sized decision is about 1,000 input tokens, reported at about USD 0.00004. The difference is released on reconciliation.
- With the USD 1 cap, the run guarantee holds for at least 744 attempts even if every one were ambiguous.

### Generic task runtime (`src/tasks/task-runtime.ts`)

`TaskRuntime` implements the new `TaskExecutionPort`. Each round:

1. Takes the current filtered snapshot first, so selector-based predicates see current visibility.
2. Evaluates the completion predicate in code.
3. Applies guards: no-progress window, low health.
4. Generates candidates with the accepted `TaskCandidateGenerator`, i.e. the **registered resolvers of the task's allowed capabilities only**.
5. Freezes up to `decisionMaxOptions` options. Identical options are merged, then options are taken round-robin across capabilities in task order.
6. Makes one Jev decision.
7. After the await, rechecks goal/task ownership and the connection epoch. A late reply is recorded as `task_reply_discarded` and never actuates.
8. Revalidates the choice: a fresh snapshot is run through the same resolvers, and an equivalent option (same capability, same world identity of block/entity targets) must still exist. Otherwise it emits `task_choice_stale` and nothing is executed.
9. Executes the frozen candidate through the accepted `SkillExecutor` with the goal owner.
10. Validates the outcome identity (action, owner `goal`, goal, task, goal epoch, connection epoch, capability). A mismatched or diagnostic result fails the task and is never credited.

Progress and guards:

- **Progress:** an improved predicate fact (acquired/current/confirmed/count/satisfied) or a new evidenced success counts. Repeated successes do not.
- **Per-target retries:** a capability/target that failed more than `perTargetRetries` times is excluded.
- **Repeats:** an option repeated more than `perTargetRetries` times without verified progress is also excluded. This bounds ping-pong loops, for example two equips undoing each other.

Outcomes:

| Result | When |
| --- | --- |
| `completed` | Only when the predicate is verified. |
| `blocked` | `no_candidates`, carrying the resolvers' structured `unavailable` reasons as `TaskFeedback`; `per_target_retries_exhausted`; `repeated_without_progress`; `no_progress`; `low_health`; `decision_not_ready`; `decision_limit`; `round_limit`. |
| `failed` | `decision_error`, `runtime_error`, `not_connected`. |
| `cancelled` | Ownership revoked. |

**Stable waiting.** `SkillDefinition.sustained` is a skill-owned `windowElapsed(outcome)` policy. It is not part of the catalog descriptor, so the catalog version is unchanged.

- `follow_entity`: the window elapsed and the target stayed visible.
- `furnace_wait`: `wait_limit` was reached while processing.

A healthy sustained window continues **locally** with an equivalent fresh candidate. There is no inference and no stall count. A `maintain` task whose condition currently holds, with nothing sustained running, **holds locally** on a 1 s observation guard. The guard is never an inference trigger. Only a violation asks Jev. Owner loss ends a follow window (`target_lost`); if no follow option is grounded, the task blocks with `owner_not_visible` evidence.

**Model-visible context** (`context.ts`) is built only from contract data:

- catalog version and mechanics version (26.1.2);
- task mode, round and completion rendering;
- verified progress, the last four results, and the "not offered" resolver reasons;
- remaining decisions and spend;
- a bounded summary of the **perception snapshot**: self, inventory, equipment, owner visibility, ≤ 8 entities/drops, visible block kinds, remembered anchors labeled as remembered, frontier count, travel distance.

It reads no game objects, so pending client predictions stay opaque as in `sessionWorld`, and hidden data cannot enter. Compaction levels keep the request ≤ 16 KiB.

### Goal engine seams (`src/goals/goal-engine.ts`)

- **Shared admission (`admit`).** Replacement revocation, epoch, record, and the synchronous `onGoalAdmitted` hook (travel anchor) are shared by every intake. The MB-SKL-007 anchor is therefore captured at admission, **before** any planner, knowledge, clarification or Jev wait, and before the first task.
- **`submitOperatorTask(spec, mode, origin)`.** This is the terminal-only `/task` diagnostic (`kind: operator_task_diagnostic`).
  - Validated before replacement: TaskSpec schema, registered capabilities, predicate depth.
  - Runs through the task runtime under the goal's ownership.
  - A cleanup is registered, so stop/replacement waits (bounded) until the task released the actuator.
  - The diagnostic's declared outcome is the task completion predicate, so `completed (outcome_verified)` means that predicate was verified by code.
- **Plan-window seam**, for MB-V1-04; the planner is still not ready:
  - Accepted plan tasks run in order.
  - The goal outcome contract is bound once at the first plan. A later plan that changes it is rejected.
  - `persistent` contracts run a task whose completion equals the maintained predicate in `maintain` mode.
  - After the window, finite outcomes are evaluated by code: satisfied leads to `completed (outcome_verified)`. Otherwise the goal returns to planning with `PlannerRequest.feedback`.
  - A task completing is never goal completion.
- **Status.** It shows the current or last task and tasks readiness. New terminal reasons are mapped (`decision_not_ready`, `no_progress`, `low_health`, `decision_error`).

### Application and CLI

- **Lifecycle ordering.** `ChunkbotApp.onLifecycle` now ends goal ownership **first**: epoch invalidation, then abort of provider I/O and the action signal (the lease is revoked by the executor's abort listener). Only then does the skill layer handle the lifecycle event (lease/ledger/perception/interface invalidation). The log text is unchanged.
- **`/task [maintain] <TaskSpec json>`.** Terminal-only. It prints `[task-json]` events: `task_started/baseline/completion/round/choice/choice_stale/choice_rejected/decision_failed/action/local_continuation/holding/sustain_ended/terminal`, each with goal and task IDs.
- **Terminal-only notices.** Operator-diagnostic notices are no longer whispered in game. The first built run was **"Kicked for spamming"** by vanilla after rapid diagnostic notices; this was the fix.
- **`cli.ts`.** It builds one `SpendLedger` and the adapter per run, prints decision readiness, and adds `jev-check`.
- **Doctor and config.** Doctor reports the adapter, the route (official or LOOPBACK fault fixture), the price ceiling, the expected provider, spend/attempt/interval/timeout limits, and key presence (never the value). Config gains `models.decision.endpoint` (only the OpenRouter route or a loopback URL) and `expectedProvider` (default `TypeSafe`).

### Minimal skill correction

The `equip_item` resolver no longer offers equipping an item that the current snapshot already shows in that slot. It reports `already_equipped` instead. This is needed so a no-op is not offered as an option.

## Contract changes (for Codex reconciliation)

| File | Change |
| --- | --- |
| `contracts/ports.ts` | `DecisionRequest` became a frozen round: requestId, goal, epochs, task, snapshot, objective, instruction, condition, mode, bounded `state`, candidates. New `DecisionChoice` (choice plus probabilities, confidence, requested and actual model, provider, generation ID, usage/cost, latency, attempts). New `DECISION_FAILURE_KINDS`/`DecisionFailure`. `DecisionPort.choose` returns `DecisionChoice` and throws a `DecisionError`. New `AdmittedTask` and `TaskExecutionPort`. |
| `contracts/task.ts` | New `TaskMode` (`complete`/`maintain`), `TaskResult`, `TaskFeedback`, `TaskOutcomeSummary`. |
| `contracts/planner.ts` | Optional `PlannerRequest.feedback: TaskFeedback[]`. |
| `contracts/goal.ts` | Optional `GoalRecord.kind` (`owner_goal` / `operator_task_diagnostic`). |
| `contracts/states.ts` | Terminal reasons `decision_not_ready`, `no_progress`, `low_health` (blocked) and `decision_error` (failed). |
| `skills/definition.ts` | Optional `SkillDefinition.sustained`. This is not in the descriptor; catalog `skills-20-16f587b80d7a` is unchanged. |
| `config/schema.ts` | `models.decision.endpoint`, `models.decision.expectedProvider`. |

There is no goal or task enum, no intent switch, and no resource-specific loop. Capability coverage still comes only from the registered definitions.

## Checks (final source)

All commands ran from the repository root with `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`. Exit codes were captured directly.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` | 0 | typecheck, clean build, **232 tests / 60 suites, 232 pass**. New suites: `jev-adapter` 35, `task-runtime` 18, `controller-integration` 7, `mb-jev-corrections` 2. The accepted 170 still pass. |
| `node /tmp/chunkbot-mc-jev-spend-probe.mjs` (unmodified) | 0 | `fetchCalls 0`, `spend_cap` under the USD 0.001 cap, ledger untouched (exit 1 before the fix) |
| `node /tmp/chunkbot-mc-jev-late-task-probe.mjs` (unmodified) | 0 | replacement `goal-0002`/`task-0002` kept; `lastTaskAfterLateReply: null` (exit 1 before the fix) |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | Jev adapter PASS (official route, fallbacks off, ceiling); "each attempt first reserves the full serving-context maximum USD 0.001344"; WARN that the key is not set |
| `npm run doctor -- --config config/examples/microsoft.json` | 0 | no failures |
| `node dist/cli.js jev-check --config config/examples/fixture.json` (no key) | **6** | `not_configured`; no request sent |
| `npm run live-check` | 0 | **16/16**, `var/live-check/2026-10-05T05-17-35-950Z/report.json` |
| `npm run jev-live-check -- --provider fault` | 0 | **12/12**, `var/live-check/2026-10-05T05-20-31-226Z-jev-fault/report.json` (fault provider; not Jev acceptance). Preceding run `05-18-15-939Z-jev-fault` was 11/12; see "Harness hardening" above. |
| `npm run skills-live-check` | 0 | **33/33**, `var/live-check/2026-10-05T05-22-21-705Z-skills/report.json` |

Previous-turn runs on the earlier source (`05-01-40` jev-fault 12/12, `05-03-30` foundation 16/16, `05-07-47` skills 33/33) are superseded by these.

Source digest (`find src tests scripts config package.json package-lock.json tsconfig.json tsconfig.build.json -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`): **`ea572648b8b44b0c2921f630b9b295bba08f5c1f11435a75ebc7b93b57685afb`** (116 files).

- `dist/` was rebuilt by the final `npm run check` (05:17 UTC) and used by every live run above.
- The later change to the J7 setup touched only `scripts/jev-live-check.ts`. Scripts run from source and are not part of `dist/`, and `npm run typecheck` passed afterward.
- No Chunkbot process is running.
- The fixture is vanilla 26.1.2 / protocol 775, PID **31385**, unchanged, 0 online.
- Jake's PrismLauncher client, worlds and accounts, and DSH, were not touched.

### Maintained regressions (new)

- **Adapter** (loopback `node:http` fault fixture):
  - exact raw wire shape and headers, with the key absent from evidence;
  - accepted model forms;
  - 11 fail-closed validation cases (invented choice, missing usage, wrong type, incomplete or foreign or non-finite distribution, confidence out of range, model drift, provider drift, cost above the ceiling, tokens above the bound), with sticky disablement verified by "no further HTTP";
  - oversized response;
  - 401/403/402/404/400 explicit with no retry and released charge;
  - 429→200 single retry with both attempts counted;
  - 5xx×2 giving transient after exactly 2 attempts with retained charges;
  - Retry-After above the bound giving no retry;
  - timeouts aborting HTTP and retaining 2 reservations;
  - revocation aborting in-flight I/O promptly with a retained reservation;
  - missing key or oversized request refused before dispatch;
  - **spend cap per application run**: ambiguous reservations from goal A block goal B before any HTTP;
  - a cap below the bound refuses the first call;
  - per-goal allowance including the retry;
  - minimum interval;
  - one in flight.
- **Runtime:**
  - completion only from predicates; already-satisfied completion means no inference;
  - structured feedback with no Jev call;
  - ownership lost during the decision; a delayed reply that ignores abort; a connection epoch change; a choice that was not offered;
  - a target removed between choice and execution (revalidated away, then the valid target is used);
  - four mismatched/diagnostic outcome identities;
  - per-target retries; repeated unevidenced success leading to no_progress; ping-pong bounded to ≤ 8 decisions; low health;
  - seven decision-failure mappings;
  - sustained follow: **one** decision across 6 windows (3 min), with no false no-progress;
  - owner loss leading to blocked `owner_not_visible`;
  - maintain hold: 40 guard intervals with 0 decisions, then one decision on violation;
  - idle silence.
- **Controller integration** (real `SkillRuntime` over the Mineflayer-shaped bot plus the real adapter talking to a loopback provider):
  - **MB-SKL-007:** the anchor exists when the first Jev request is made. A server correction moves Chunkbot to x=129.5 during the 150 ms decision. The delayed first `move_near` then stops at the travel guard (`outside_travel_bounds`) because the admission anchor 0.5 was kept. A replacement admission installs a fresh anchor at 129.5. The old goal ends `replaced`.
  - Stop during an in-flight request: returned in under 1 s; the late reply produced no `skill_started`; `jev_failure: aborted`.
  - Plan seam: a completed task is not goal completion (the next planner turn receives feedback); a verified outcome gives `outcome_verified`; a blocked task returns `missing_ingredients`/`workstation_required` feedback with no Jev call.
  - Idle and awaiting-owner states made 0 requests.
  - `/task` from chat is rejected; an invalid spec never replaces the active goal.

## Built-artifact fixture evidence (fault provider)

The table below describes run `05-01-40-253Z-jev-fault`, made before this turn's corrections. The final run `05-20-31-226Z-jev-fault` reproduces the same 12/12 scenarios on the corrected source, with J7 using its own stone pair. The built CLI ran as a child process against vanilla 26.1.2 with loopback RCON truth. Setup was 38 RCON commands (scene reset plus teleports), recorded separately from 8 in-trial interventions (the owner moving during the follow). The deterministic fault provider picks the first option not among its last three picks. It made 18 requests, reconciled 17 and retained 1 (the stop-aborted request). Reported cost was USD 0.0007 against a cap of 1.

| ID | Scenario | Result (RCON or server truth) |
| --- | --- | --- |
| J0 | join; decision ready; status | ready, decision ready, tasks ready |
| J1 | movement: `move_near` and `explore_frontier` options | 2 decisions (explore, then approach the chest); `near_target` verified 0.7 from the chest; RCON position near the chest |
| J2 | mining by hand: mine/move/pickup | 5 decisions; `inventory_delta` 3/3 logs; server-confirmed breaks; RCON 3 oak logs, log blocks air |
| J3 | missing tool | blocked `cannot_execute`; `harvest_tool_missing` with valid tools; 0 decisions; RCON stone intact |
| J4 | crafting planks, table, sticks | `crafting_result` verified each time (server_sync); RCON table 1, sticks 4 |
| J5 | missing workstation | `workstation_required` evidence; 0 decisions |
| J6 | place the table (6 generated sites), then craft a pickaxe at it | `block_state` from a server block update at 202,-59,203 (RCON confirms); pickaxe crafted (RCON 1) |
| J7 | tool mining | 3 decisions; both stones mined `server_packet`; RCON cobblestone 2, no stone item |
| J8 | hidden target | `no_visible_target` / `no_grounded_destination`; hidden ore position absent from feedback |
| J9 | stop during an in-flight request | goal cancelled in 2 ms; `jev_failure: aborted`; no action |
| J10 | persistent follow (`maintain`), then replacement | 32 s of following with the owner moving: **1** Jev request, 2 local continuations, Chunkbot 3.1 from the owner (RCON). Replacement: old goal `cancelled (replaced)`; anchors 207.5,199.5 then 213.4,202.6; replacement task completed |
| J11 | natural-language goal and 10 s idle | `blocked (planner_not_ready)`; **0** Jev requests |

Development runs fixed real defects:

- The completion check read the previous snapshot, so a just-placed table was not yet "visible". The runtime now observes before evaluating.
- The bot was spam-kicked because diagnostic notices were whispered in game. They are now terminal-only.
- Identical move options were offered twice; options are now deduplicated.
- The equip resolver offered no-ops; it now reports `already_equipped`.
- Equip ping-pong ran until the no-progress window; it is now bounded by the repeat guard.
- One run lost a cobblestone drop in vanilla, and the guard bounded the loop correctly (`05-01-40` passed after the guard).

Earlier reports `04-33`, `04-36`, `04-39` and `04-42` are superseded.

## Credential-dependent evidence (request to Codex, resolved)

**Resolved by the coordinator on 2026-10-05; see [Real-provider evidence](#real-provider-evidence-coordinator-run-resolved).** The original request is kept below as a historical record.


This needs a key injected into the environment (`OPENROUTER_API_KEY`) through the authorized credentials helper. Do not paste it anywhere. cwd: `.`. `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`. The fixture must be running (`npm run fixture -- status`), `dist/` must be built from the corrected source digest `ea572648…` (the current `dist/` is), and no other Chunkbot process may be running. Each attempt reserves USD 0.001344 against the USD 1 run cap, and reconciliation releases the difference.

1. `node dist/cli.js jev-check --config config/examples/fixture.json --json`
   - Expected: exit 0; `ok: true`; model `typesafe/jev-1.13-2026xxxx`; provider `TypeSafe`; choice `wait` (`choseExpected` true is expected but not required); usage with about 300–400 input tokens; cost about USD 0.00002.
   - A `jev_*` evidence run appears under `var/runs/`.
   - Exit 7 would carry an explicit kind: `auth`, `payment`, `model_unavailable` (price/route change, fail-closed) or `model_mismatch`/`route_changed`.
2. `npm run jev-live-check` (real provider is the default)
   - Expected: exit 0 with **12/12** and report `var/live-check/<stamp>-jev-real/report.json`.
   - The report must show `providerMode: real`, real model/provider/latency per request, and every executed Jev action linked to its validated choice. The harness asserts the model pattern and TypeSafe.
   - Expected spend is about 30–60 decisions × about USD 0.00005 = **USD 0.002–0.005**. The cap is USD 1 per run.
   - Real Jev may choose differently from the fault provider, so round counts will differ. Completion still requires code-verified predicates and RCON truth.
   - If a scenario fails, the report and `run-jev-real.log` contain the exact request/choice/action/result chain needed for diagnosis.

Please return the redacted `jev-check` JSON and the `jev-live-check` report path (or its `provider` and `results` sections).

## Remaining gaps and limitations

- Real-Jev evidence covers the separate offline fixture and the verified TypeSafe route only. Online play, shared servers and the bot's Microsoft account remain untested.
- Natural-language goals still end `planner_not_ready` (MB-V1-04). `/task` specs are operator-written planner stand-ins: controller and mechanics trials, not autonomous goal acceptance.
- The plan seam is generic and tested with a scripted planner. Rolling planning, replan budgets and clarification-after-execution policy belong to MB-V1-04.
- Confidence and probabilities are logged as uncertainty evidence only. There is no veto threshold yet; one would need calibration from real scenario evidence.
- The charge bound **assumes** the verified context and price profile (serving context 32,000, prompt ceiling 0.042/M, last read 2026-10-05 05:28 UTC).
  - The price filter rejects a price above the ceiling with a 404 before inference. A **context** change on the provider's side does not necessarily cause a 404 and would not be detected before dispatch.
  - The post-response checks (`pricing_changed` for usage above the context or cost above tokens × ceiling) disable Jev for the run, but **cannot undo a charge already made**.
  - A different or changed model, provider or profile needs fresh verification and a new profile entry before use.
- An aborted request's charge stays unknown. Its full maximum is retained, not estimated.
- J1 movement and the other real trials prove only that verified outcomes were reached through Jev choices. They do not show optimal navigation or optimal choice counts.
- Revalidation compares the capability plus the world identity of block/entity/frontier targets and the other parameters. A changed derived parameter (for example a craft count after the inventory changed) is treated as stale and regenerated, which is conservative.
- Low-health and no-progress are checked between actions. A long single action is bounded by its own skill timeout and by stop.
- Sustained continuation covers `follow_entity` and `furnace_wait` only (`SkillDefinition.sustained`). Other skills always go back to Jev.

## Paths changed

- **New:**
  - `src/decision/` (`errors.ts`, `pricing.ts`, `spend.ts`, `wire.ts`, `context.ts`, `jev-adapter.ts`, `jev-check.ts`)
  - `src/tasks/task-runtime.ts`
  - `tests/jev-adapter.test.ts`, `tests/task-runtime.test.ts`, `tests/controller-integration.test.ts`, `tests/mb-jev-corrections.test.ts`
  - `scripts/jev-live-check.ts`
  - this file
- **Shared (delegated):**
  - `src/contracts/{ports,task,planner,goal,states}.ts`
  - `src/goals/{goal-engine,not-ready}.ts`
  - `src/app/{app,skill-runtime,status,doctor}.ts`
  - `src/commands/{parse,router}.ts`
  - `src/cli.ts`
  - `src/config/schema.ts`
  - `src/skills/{definition,movement,furnace,inventory}.ts`
  - `scripts/lib/cli-process.ts` (optional env)
  - `package.json` (script `jev-live-check`; no dependency changes)
  - `README.md`, `AGENTS.md`

I did not edit `agent-workflow.md`, `feature-plans.md`, `docs/agent-supervision.md` or the plans. No Git was initialized.
