# MB-FLOW-001 — Default survival progression and a home

Reported: 2026-10-06. Status: **Native implementation in progress in [batch002](feature-batch-002-plan.md); not yet accepted.**
Parent: [companion upgrades](companion-upgrades-plan.md). Foundations: [handoff](smooth-handoff-plan.md), [memory](gameplay-memory-plan.md).
Subplan: [MB-FLOW-003 survival routines and death recovery](survival-routines-plan.md).

## Outcome and happy path

After Jake connects Chunkbot, Chunkbot assesses inventory, nearby terrain and remembered projects, then chooses a useful survival milestone. It gathers supplies, improves tools/equipment, establishes a small home and continues with another useful milestone instead of waiting between owner commands.

Jake asks for help; that directive takes priority. A finite owner task finishes, Chunkbot reports its verified result, then returns to progression. A persistent follow directive retains priority until stopped or blocked. Stop pauses all autonomous work until an explicit resume.

## Confirmed decisions and coordinator assumptions

Jake confirmed progression as the default after connection, owner priority, return after finite completion, and the stop/resume latch.

Coordinator assumptions:
- A small practical shelter with roof, usable entrance, crafting/furnace access and storage is the initial home-building target. Elaborate architecture, settlements and every end-game mechanic are later capability extensions.
- Progression is available through normal run, not auth login, connect-check, doctor or diagnostic harnesses. A fresh world/profile starts with progression enabled; the owner stop latch is preserved across restarts until resume.
- Add !chunkbot resume (and the terminal equivalent) as an explicit control. !chunkbot status shows mode, active directive, next preparation, progress and blockers. Ordinary Minecraft goals remain open-ended.
- If an owner task blocks or needs an answer, preserve and show its unresolved intent; do not silently abandon it for unrelated progression. Finite verified completion is the automatic return trigger.
- Prefer useful verified work over artificial motion. It is acceptable to rest, await clarification, or pause on a real prerequisite/provider/safety limit.

No automatic Microsoft login, server connection/reconnect service, model billing fallback or indefinite unbudgeted calls.

## Proposed architecture and behavior

Add an application-owned progression supervisor above the existing GoalEngine. It selects goals through the same catalog-backed planner and single admission path; it never controls actuators directly. Represent source/priority (owner versus progression), persistent projects and operating mode separately from task capabilities. Do not add resource-specific command handlers or a hardcoded log-to-stone-to-iron loop.

Use durable verified milestone/project summaries plus current perception. Ask the planner for the next achievable outcome and reason, considering tools, food, shelter, known supplies and actual implemented capabilities. The result is still a bounded goal with immutable, code-verified completion.

- One active goal, one pending preparation and one actuator owner. Owner intake cancels autonomous preparation and uses the handoff protocol.
- Look ahead while a valid task executes. Commit a prepared milestone only with fresh observation, baseline and reference validation.
- Keep goal turn/task/deadline/replan limits. Add a session-level scheduling/attempt bound and cooldown so repeated blocked goals cannot reset limits and spin forever.
- Preserve the existing per-run SpendLedger and USD 1 cap across all milestones. Empty or ambiguous outcomes never trigger a fresh ledger. Subscription quota/auth/provider drift pauses the supervisor with a clear reason.
- Productive completion uses actual inventory/equipment/world predicates, not elapsed time, goal text or “I built it” messages.
- Missing mechanics get a precise blocker. Do not repeatedly choose the same impossible upgrade, poll a clarification with inference, or hide limitations behind endless wandering.
- Death, disconnect and dimension change revoke active work and preparation. Low health stops unsafe work before a narrowly admitted restorative action can run. [MB-FLOW-003](survival-routines-plan.md) adds fresh-state survival upkeep and bounded death recovery, preserving the interrupted owner's intent without replaying old actions. Explicit reconnect uses memory and operating preference, not old action IDs.
- Stop cancels active work, preparations and scheduling, and latches paused. Resume performs a fresh assessment. Logout/shutdown disconnects; a session supervisor cannot override it.

## Survival routines subplan

Jake requested routine player upkeep and recovery of dropped belongings after death. [MB-FLOW-003](survival-routines-plan.md) specifies death coordinates and loss records, bounded retrieval, food/health, equipment/tool replacement, inventory space, resupply and safe home/spawn preparation. Approved replanting and specialized mechanics are staged behind capability gates.

These routines support the current directive through the same supervisor, goal admission, catalog and single actuator owner. Recovery precedes unrelated progression, preserves unresolved owner intent and stops on unsafe/repeated failures. Stop/logout still govern all automatic action. Define shared interfaces with handoff and memory before assigning the child work; integrate the first accepted routines before claiming a self-sufficient progression loop.

## Home construction and maintenance

House building is a deliverable, not merely a remembered coordinate. Plan a bounded small footprint and construction objective with material prerequisites, confirmed block placements, a navigable entrance, enclosure/roof verification and named workstation/storage facts.

Select an unoccupied site; do not demolish existing structures to create room. Preserve an approved footprint and a versioned project checklist. Only known bot-built/approved blocks are repairable by the project; placement/mining outside that scope needs a new explicit plan.

Inspect whether placement, reach, doors, material acquisition and shelter verification can support the complete build. Add missing general construction/evidence capabilities where demonstrated necessary, through the shared catalog and generic task runtime. Explicit building may place blocks; navigation still must not silently dig, tower or scaffold.

A stopped build records confirmed placements and unknown effects separately. After restart, inspect the actual site and repair/replan from observed differences rather than replaying the checklist. Register “home” only with honest evidence; remember a chosen site separately from a verified usable shelter.

## Seams and bounded research gates

Inspect src/goals/goal-engine.ts, src/app/app.ts, src/app/skill-runtime.ts, src/planner/prompt.ts, shared goal/planner/capability/predicate contracts, src/tasks/task-runtime.ts, src/skills/crafting.ts, src/skills/placement.ts, src/skills/inventory.ts, src/skills/interfaces.ts, src/execution/predicates.ts and decision/spend limits.

Proposed ownership: a progression supervisor module, construction/project integration, tests and an assigned fixture harness. Codex owns shared schemas, scheduler/handoff integration, manifests and final acceptance.

Gate A-G1: catalog audit plus a separate fixture trial for eating, tool upgrades, doors and multi-block shelter construction. Identify genuinely missing primitives before promising the full milestone. The assigned outcome includes necessary scoped capabilities, not just the audit.

Gate A-G2: determine which session budget/cooldown and blocked-outcome policy prevents repeated goals without constraining ordinary user goals. Use fake clocks, failed providers and no-resource scenes; choose documented finite defaults without changing the run cap.

Gate A-G3: define code-verifiable shelter criteria from a small fixture build. Verify reach/path constraints and interrupted repair. Avoid treating an arbitrary decorative blueprint as proof of shelter.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| A1 | Normal run starts a useful bounded goal without an owner command. Disabled/inference-free profiles and diagnostics make zero model calls; no new connection is initiated by scheduling. |
| A2 | Empty-inventory and prepared-inventory survival trials choose different prerequisites, verify useful supplies/upgrades, then automatically select another attainable milestone. No per-phrase code/prompt edits. |
| A3 | Real planner/Jev gathers materials and completes a small home with verified roof/enclosure/entrance/workstations/storage. Save the home and inspect server truth; zero in-trial world fixes. |
| A4 | Owner command overrides progression; finite completion returns to progression. Persistent follow retains ownership. Unanswered clarification/blocked owner instruction stays visible. |
| A5 | Stop during planning, movement, crafting and building cancels both execution and lookahead and stays paused through a timer advance/restart. Resume freshly reassesses. |
| A6 | Partial house survives stop/restart. Fresh verification correctly continues or repairs, without duplicate placements, fabricated stored materials or changing another world's base. |
| A7 | No resources, unsafe path, low health, provider failure, run spend cap and repeated blocked goals produce bounded, meaningful waiting. They do not create inference loops or fresh budgets. |
| A8 | Combined acceptance uses memory, smooth handoff and a read-only dashboard when available; records productive work, waiting, interventions, model calls/cost and end-state facts over multiple milestones. |
| A9 | Integrate the accepted MB-FLOW-003 first slice: ordinary food/tool/inventory upkeep and a recoverable death lead back to useful work; unsafe recovery, stop/logout and unresolved owner intent remain bounded and visible. Child R criteria supply the detailed evidence. |

Required checks: affected AGENTS.md typecheck/build/test, both doctors, connection/controller/skill regressions, planner diagnostic and fault checks, then coordinator-run real-provider fixture acceptance. Retain 26.1.2 behavior. Assign new autonomous and house scenarios explicitly; current P0–P9 checks alone cannot certify this feature.

## Remaining delivery

Supervisor, pause/resume preference, bounded milestone selection, house capabilities/verification, survival-routine integration, real multi-milestone trials and delivery evidence remain unverified. MB-FLOW-003 core recovery/upkeep is assigned concurrently in batch002; later mechanics remain separately gated. Review target: docs/reviews/mb-flow-001-progression.md.
