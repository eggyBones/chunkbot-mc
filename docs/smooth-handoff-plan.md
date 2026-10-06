# MB-FLOW-002 — Continue current work while the next directive loads

Reported: 2026-10-06. Status: **Implemented by native Opus 5.5 and integrated in [batch001](feature-batch-001-plan.md); final coordinator acceptance in progress.**
Parent: [companion upgrades](companion-upgrades-plan.md). Baseline: [goal/planner architecture](v1-architecture-plan.md), [contracts](v1-contracts.md).

## Outcome and happy path

While Chunkbot follows Jake or gathers supplies, Jake sends a new instruction. Chunkbot acknowledges it immediately, continues the currently permitted task while planning, then switches at a controlled boundary after the new plan is valid. Automatic progression also prepares its next useful milestone before the current one finishes where feasible.

Jake's observed behavior: Chunkbot froze as soon as a !chunkbot instruction arrived. Source evidence: GoalEngine.admit revokes existing ownership and waits for cleanup before the new planning turn. The report has not established an exact freeze duration.

## Decisions and scope

Jake confirmed owner priority, default progression after finite work, and a stop latch until explicit resume. This feature improves both owner replacement and progression lookahead. It does not introduce a second acting bot, simultaneous goals with actuator ownership, an unlimited command queue, or concurrent unbounded model calls.

Coordinator assumption: acknowledge “Preparing your new instruction; continuing the current task until handoff.” Only the existing admitted task may continue under its existing limits; do not advance through new old-goal windows while an owner replacement is pending. Stop, death, disconnect, dimension change, low-health guards and lost ownership remain immediate cancellation paths.

If a new instruction explicitly requires immediate control, Jake can use stop first. Ordinary natural language is not routed through a new resource/goal intent whitelist.

## Proposed operating behavior

- Validate command length, owner and connection before changing current or pending work.
- Maintain one active execution owner and at most one pending preparation, identified by a monotonically increasing intent generation and connection context.
- A newer owner instruction supersedes pending preparation. Cancel its planner process and ignore its late results without clearing the active task's lease.
- Preparation uses a bounded read-only snapshot, catalog, knowledge and provisional inventory evidence. It cannot open a container, resync an interface in conflict with execution, take an actuator lease or execute a candidate.
- Keep at most one owned planner process. Owner preparation takes priority over speculative autonomous lookahead; Jev may serve the active task within its existing single-request guard.
- On a valid draft, revoke the current owner, await bounded cleanup, admit the new goal, capture its travel anchor and server-confirmed inventory baseline, then re-ground and validate the draft against current context.
- Bind the accepted outcome only to the real admission baseline. Preparation must not freeze the baseline while old work is still changing inventory. A materially stale draft gets bounded repair/replanning; it never acts just to avoid a pause.
- A pending clarification is displayed separately from the active task. Continuing the old task is bounded by that task's original allowance; once the new goal is admitted, existing stationary clarification rules apply.
- If planning fails before admission, explain the failure and preserve the still-valid active task. Do not say the new instruction started. If old work finishes first, report waiting honestly rather than inventing filler work.
- Stop cancels active work, preparation, lookahead and the autonomy scheduler. Resume is explicit. Shutdown/logout disconnects and discards preparations.
- Restart does not replay a draft, action ID, lease or partially completed interaction.

Count all preparation/retry/repair calls. Transferred preparation turns consume the eventual goal's allowance; discarded drafts still consume a bounded session preparation allowance and actual subscription usage. Never obtain unlimited calls by repeatedly replacing drafts.

## Seams and bounded design gates

Inspect src/goals/goal-engine.ts, src/tasks/task-runtime.ts, src/planner/, src/contracts/planner.ts, src/contracts/ports.ts, src/app/app.ts, src/app/skill-runtime.ts, src/commands/parse.ts and execution lease/interface ownership.

Gate H-G1: can existing PlannerPort represent a non-admitted preparation without pretending it owns the current goal? Inspect contracts and build a delayed fake-planner test during implementation. Decide a typed preparation port/context versus a carefully extended request, before changing goal admission.

Gate H-G2: which tasks can continue while observations are captured without conflicting interface resyncs? Probe follow and one inventory-changing skill in the fixture. Specify snapshot freshness, draft invalidation and commit behavior; do not weaken InterfaceGate.

Proposed ownership: new preparation/scheduling module, targeted goal/task/planner changes and tests. Codex coordinates shared schemas, CLI/config and composition changes. Dependencies include the progression scheduler's lookahead integration.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| H1 | Delayed planner (at least 3 seconds) receives a new command during follow; server-confirmed movement continues while preparation is pending. Record receipt, acknowledgment, motion, draft-ready and switch timestamps. |
| H2 | Prepared instruction switches through the single actuator lease; old result/cleanup cannot publish feedback or stop the replacement. No actions occur under pending ownership. |
| H3 | Gathering changes inventory during preparation; accepted outcome uses post-handoff admission evidence and does not count pre-admission gains as newly collected. Consumed ingredients and container state are rechecked. |
| H4 | Rapid A/B/C commands admit only the latest pending intent; one planner process, bounded cleanup and no stale reply/action. Invalid/spoofed commands leave work intact. |
| H5 | Stop during preparation clears controls within the inherited 250-ms local-fixture target, cancels providers, and remains paused. Lifecycle interruption invalidates both contexts. |
| H6 | Timeout, quota/auth error, malformed proposal and pending clarification are honest; no repeated inference while awaiting an answer and no fallback billing route. |
| H7 | Autonomous lookahead reduces measured planner waiting between milestones; real Codex/Jev fixture trial completes both milestones with zero in-trial assistance. Revalidation gaps are measured, not advertised as zero latency. |

Use fake clocks/delayed providers for races, then real packet/world evidence for movement and inventory. Required checks: typecheck/build/test, doctors, connection and controller regressions, planner isolation/cancel diagnostic and planner fault/real checks from the parent plan. Extend existing tests/goal-engine.test.ts, tests/planner-engine.test.ts and tests/app.test.ts with behavior-driven cases.

## Remaining delivery

Preparation ownership, one settled planner tail, all-discarded cleanup, admission re-grounding, pause/resume and measured lookahead are implemented. Root handoff checks pass9/9 on each fixture; actual H7 on26.2 passes with real Codex/Jev and zero assistance. [Independent integration review](reviews/mb-batch001-coordinator-review.md) records final regression/publication steps. Automatic progression remains unassigned.

## Coordinator review findings

### MB-FLOW-002-C4 — Regression harness must isolate failed scenarios

Reported 2026-10-06 09:20 UTC. Root real planner regression passes19/19 on26.1.2. On26.2 P4's actual controller repeatedly chose valid frontier exploration, never collected the occluded bread, and exceeded the harness's10-minute wait. The goal remained active. Existing `resetScene` then changed the scene without stopping that active owner, and `submit` waited only15 seconds for immediate goal admission although smooth handoff first prepares a draft. P5 consequently missed its admission wait and later scenarios risked the same contamination. These are observed harness assumptions; the original P4 gameplay failure is not reclassified as a harness pass or an inherited bug.

Expected: between distinct scenario trials, revoke active/pending work and wait for bounded owned cleanup before ANY RCON scene reset. Preserve deliberate in-scenario stop/replacement/correction assertions. A fresh trial must still enforce its own real gameplay criteria, including acquisition/exploration, immutable outcomes and zero unrecorded assistance. Native shared writer owns a bounded correction to `scripts/planner-live-check.ts` and its review only, with no production behavior change, provider call or fixture lease. Root reruns affected cases in isolated runtime storage and retains the original failures.

### MB-FLOW-002-C1 — Planner slot timeout must keep serialization

Reported2026-10-06; native correction assigned. At local checkpoint c333457, PlannerSlot.acquire hands out a ticket after a bounded wait times out, even though the previous turn has not settled. A no-provider coordinator probe held the first turn beyond25ms and started the second: maxRunning2, expected1. The real Codex adapter has a second in-flight guard, but the engine slot must itself preserve its stated single-process contract for every PlannerPort. A timeout must fail the waiting turn honestly without advancing the serialization tail past the unresolved process. Aborted queued tickets must not release later tickets past it. Retain bounded caller return/cleanup; add a delayed/non-cooperative fake-planner regression and verify owner-preparation priority. Evidence is ignored var/batch001/planner-slot-review-proof.json (zero inference calls).

### MB-FLOW-002-C2 — Re-ground outcome references as well as tasks

Reported2026-10-06; native correction assigned. On2a6aaae, regroundProposal walks only tasks. A no-provider probe with the same observed target in a task and finite near_target outcome translated the task to obs-fresh, left the outcome at obs-old and returned no problems. checkProposal validates outcome handles too, so an unchanged target creates an avoidable repair; a stale outcome reference must fail closed. Re-ground both task and outcome references (including prepared memory refs) before first binding. Preserve an already accepted outcome's immutable identity during later lookahead: use owned grounded binding/appropriate retained reference validation rather than changing the accepted contract. Add preparation and lookahead tests. Proof: ignored var/batch001/handoff-outcome-reground-proof.json.

### MB-FLOW-002-C3 — Await pending preparation process cleanup on stop/lifecycle

Reported2026-10-06; native correction assigned. Pending plannerTurn registers cleanup in pending.cleanups, but discardPending only aborts and settles the intent; stop/endOwnership await only active-goal cleanup. A no-provider GoalEngine probe used an abort-honoring planner with100ms cleanup: stop returned in1ms while one preparation turn remained in flight; it settled later. Control revocation must remain synchronous, while stop/lifecycle/shutdown completion awaits pending process cleanup within the existing bound. Supersession must retain its serialization barrier without stalling acknowledgment or advancing old tasks. Add stop/lifecycle/shutdown and orphan-free process regressions. Proof: ignored var/batch001/handoff-preparation-cleanup-proof.json.

Coordinator review MB-FLOW-002-C3a: the stop/lifecycle cleanup guarantee also covers preparations already discarded by a rapid supersession. The current pending object alone is insufficient. Root reproduced a 0 ms stop with one superseded turn still cleaning up (150 ms); no inference/fixture contact. Keep a bounded barrier/set for every outstanding preparation cleanup. Evidence: `var/batch001/superseded-preparation-review-proof.json`.
