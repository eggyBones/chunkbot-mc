# MB-V1-03 — General task-driven Jev action controller

Created/updated: 2026-10-04. Status: **Accepted — independently verified on the local fixture with real Jev.** Depends on MB-V1-02. Read [architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and G-02 in [research](v1-research.md).

## Outcome and happy path

A generic planner-created step supplies an objective, admitted capabilities/targets, completion conditions, and Jev instructions. Current observations and the capability catalog produce valid candidate actions. A real Jev decision through OpenRouter selects one, the executor runs it, and verified outcomes update the task.

Different tasks use this same loop. There is no log-specific action controller or fixed goal progression. Jev decides immediate actions; the planner owns prerequisite steps and goal strategy; code owns mechanics and completion.

Jake selected Jev through OpenRouter. Coordinator defaults: native fetch, one choice question per request, initial pin `typesafe/jev-1.13`, and actual returned model snapshot recorded.

## Ownership and wire gate

Proposed owned paths: `src/decision/`, provider/controller fixtures, and limited task-runtime wiring assigned by Codex. Shared catalog/contracts/config/telemetry/entry points require coordinated changes.

The documented route is `POST https://openrouter.ai/api/alpha/decisions`, with model, bounded state, and questions. A choice uses type, complete instructions, and a criteria map from action IDs to descriptions. The question key is bookkeeping; include the full meaning in its instruction. [OpenRouter Jev guide](https://openrouter.ai/blog/insights/what-is-jev/).

G-02 was assigned to Codex as a bounded provider prerequisite during the authorized implementation session. It passed with HTTP 200, actual `typesafe/jev-1.13-20260917`, 426 ms, and usage/cost in raw snake_case fields. [Exact wire evidence](reviews/g-02-jev-wire.md). Freeze the adapter schema from this evidence. SDK and raw-HTTP field naming/routes require separate treatment; do not silently bypass OpenRouter. This access probe does not accept controller behavior.

Jev takes finite decisions over text/structured state. It does not generate executable skills, invent coordinates, perform outcome arithmetic, or override the owner's goal.

## Loop behavior and integration

Resolve the current generic task policy against registered capabilities and filtered observations. Generate a bounded candidate set with real handles, valid preconditions, effect descriptions, and code-generated IDs. Candidate generation uses declared skill resolvers, not switches on user intent such as “collect stone.”

Freeze the set/request epochs. Supply the task objective, bounded planner instruction, relevant snapshot, verified progress/failures, and candidate criteria. Wait/inspect/survey options may be meaningful; each has a bounded code effect.

Validate returned envelope/choice/ID/probabilities/confidence/model/usage, then recheck current epoch/task/target/preconditions/limits before execution. A valid response can still be stale. Removed targets, newly missing tools, lost owner, changed inventory, or invalid recipes require regeneration or planner evidence.

If no useful candidates remain, return the precise reason: missing prerequisite/knowledge, need to explore, unavailable capability, unsafe/no path, or exhausted limits. The goal engine can ask the planner to revise steps. Do not internally synthesize resource-specific prerequisite plans or fabricate an action.

Decisions occur at useful action boundaries/material changes, with minimum interval and one in-flight call. Stable intentional waits observe locally; guard timers are not inference triggers. No calls while idle or awaiting owner clarification.

Confidence is uncertainty evidence, not execution correctness. Start without a fixed veto; log distributions and safe wait/replan outcomes. Introduce a calibrated threshold only from relevant scenario evidence, avoiding endless uncertainty/replan cycles.

## Failure, interruption, and evidence

Stop/replacement/lifecycle changes invalidate epochs and abort requests. Late replies cannot control the bot. Timeout/429/5xx may receive one bounded retry if limits allow; auth/payment/unavailable model/route/schema failures produce explicit reasons. Count attempts, retain conservative ambiguous-charge reservations, and never silently change provider/model.

Record catalog/task IDs, frozen candidates, actual choice, response model/usage/cost, latency, verified skill result, predicate result, and escalation reason. Redact keys and unrelated chat. Missing credentials allow diagnostics but no Jev execution.

## Milestones and acceptance

1. **JEV-1 — Real wire contract.** Resolve G-02, implement validation, and save a redacted response fixture.
2. **JEV-2 — Generic decision/action slice.** Real Jev choices drive mechanically different tasks, including movement, mining, and crafting/interaction. Evidence connects request, candidate, action, and observed outcome.
3. **JEV-3 — Planner feedback slice.** Missing tool/workstation/resource/target produces structured recovery evidence; the controller does not hardcode a replacement goal plan.
4. **JEV-4 — Stale/failure/limit slice.** Invalid IDs/envelopes, removed targets, changed epochs, delayed replies, quota/auth/network faults, and stop cannot trigger invalid actions. Stable waiting and idle are quiet; call/rate/cost limits hold.

Run installed build/typecheck and affected generic-controller/adapter/ownership tests. Inject provider faults rather than break live profiles. Record actual live latency instead of presenting provider dashboard numbers as local measurements.

G-02 account/alpha/model access and exact wire/billing fields are resolved by the linked probe. Still needed: application adapter validation, live choices across skills, planner feedback, cancellation, and bounded-error evidence. Mock choices or a deterministic canned goal sequence are insufficient.

## Current assignment

Assigned 2026-10-05 04:10 UTC to native Claude subscription worker `session-8a631413-f645-495a-aee7-ccff8c7051a3`, Opus 5.5/high/full. The [complete brief](reviews/mb-v1-03-worker-brief.md) assigns all four milestones and required shared integration paths. MB-V1-02 is independently accepted. Workspace membership, loaded-SDK resolution, permissions, prompt receipt, actual running state and native repository tools were verified. Controller acceptance completed 2026-10-05 05:36 UTC: [coordinator review](reviews/mb-v1-03-coordinator-review.md), 24 probes, 232 tests, foundation 16/16, skills 33/33 and real Jev controller 12/12. MB-V1-04/05 remain outstanding.

## Coordinator review findings

### MB-JEV-001 — Reserve a proven serving-context charge before dispatch

Reported 2026-10-05 during implementation. Status: **Verified fixed — independent probe, boundary tests and real request passed**; original reproduction against the adapter source, worker `session-8a631413-f645-495a-aee7-ccff8c7051a3`. Final source must be rechecked before correction assignment or acceptance.

Observed: `pricing.ts` estimates total input as serialized request bytes plus 2,048 provider-overhead tokens, with a 2x charge multiplier. The overhead bound is inferred from two small G-02 responses, not an established maximum. The public serving endpoint advertises 32,000 context tokens and prompt price USD 0.042/M; the request price ceiling constrains the per-token price, not provider-added input length. Rejecting larger usage after a response cannot prevent an already dispatched bill.

Coordinator `/tmp/chunkbot-mc-jev-spend-probe.mjs` calls the real `JevDecisionAdapter.choose` and `SpendLedger` with fake fetch (no HTTP/inference/credential/game access). Run cap is USD 0.001. The response uses the admitted model/provider/price and input tokens within the documented 32,000 context. Current result: **one dispatch**, reservation USD 0.00024192, possible/reported provider charge USD 0.001344, then `pricing_changed`. The ledger retains only the small reservation and reports USD 0.00075808 remaining. Probe exits 1. This proves the current pre-dispatch bound is insufficient for that permitted provider-usage case; it does not claim the real provider actually applied such overhead or overspent in a live run.

Expected/acceptance: reserve a proven maximum covering the serving context and price before each attempt, or provide authoritative evidence of a tighter whole-request token bound including provider overhead. Coordinator recommendation: the advertised context ceiling is a simple reversible conservative bound; keep separate serialized-body limits. A small remaining run budget must cause zero dispatches if it cannot cover that maximum. Reconcile trustworthy actual usage on success; retain the conservative full bound for ambiguous charges. Keep the same ledger across goals/tasks/retries. Preserve real small-request success and rate/cancellation behavior. The probe and maintained boundary tests must pass before acceptance.

### MB-JEV-002 — Discard a late old task before updating replacement status

Reported 2026-10-05 during implementation. Status: **Verified fixed — independent late-result probe and maintained regressions passed**; original reproduction through GoalEngine's operator-task intake, same native controller worker. This is within existing stale-output and replacement scope.

Coordinator `/tmp/chunkbot-mc-jev-late-task-probe.mjs` uses the actual `GoalEngine`, registered capabilities and maintained engine helper, with a controlled task port that deliberately resolves the old task after its bounded cleanup has elapsed and a replacement task is active. There is no provider, game connection or actuator. Before the old reply, replacement `goal-0002/task-0002` owns execution and has no last-task result. After old `task-0001` reports completion, ownership still belongs to the replacement, but **`status().lastTask` is overwritten with the old completed task**. Probe exits 1. The observation is stale status/result attribution; it does not claim the replacement actually completed or an old action moved Minecraft.

Observed source: `runTask` checks the current task ID before clearing `currentTask`, but updates the global `lastTask` after its await without rechecking active goal/epoch/signal. Guard current ownership before publishing results or progress/feedback. Rejected late results may be logged as discarded; they must not mutate the replacement's status. Preserve ordinary completion and bounded cleanup. Add a maintained delayed-result/replacement test and pass the coordinator probe before acceptance. Recheck final source before assigning corrections.

## Delivery

JEV-1 through JEV-4 accepted with real OpenRouter choices and server/predicate evidence. [Independent acceptance](reviews/mb-v1-03-coordinator-review.md) records the unchanged source digest, exact reports, spending and limitations. Controller tasks are operator fixtures; autonomous goal planning is the next assignment.
