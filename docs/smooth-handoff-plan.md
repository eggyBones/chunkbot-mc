# MB-FLOW-002 — Continue current work while the next directive loads

Reported: 2026-10-06. Status: **Assigned in [batch001](feature-batch-001-plan.md); native Opus5.5 implementation in progress in an isolated worktree.**
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

Preparation ownership design, implementation, instrumentation, races, real-provider acceptance and operator wording remain unverified. Publish docs/reviews/mb-flow-002-handoff.md when evidence exists.
