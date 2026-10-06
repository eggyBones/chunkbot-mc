# MB-MEM-001 — Persistent gameplay memory

Reported: 2026-10-06. Status: **Authorized in [batch001](feature-batch-001-plan.md); waiting for the initial public rebrand push; unassigned.**
Parent: [companion upgrades](companion-upgrades-plan.md). Consumer: [default progression](autonomous-progression-plan.md).
Related consumer: [MB-FLOW-003 survival routines/death recovery](survival-routines-plan.md).

## Outcome and happy path

Chunkbot establishes a base and finds a useful resource location. After an application restart, on the next authorized connection it remembers those places and its verified progress, checks what is still true, and plans accordingly. Jake can identify a location in ordinary language, for example “remember this as home,” through the same owner intake.

Jake specifically requested base location and important map locations. Coordinator assumption: include useful workstations, historical storage contents, hazards, incomplete building projects, milestone outcomes and brief decision notes. This is structured gameplay memory, not training model weights or keeping an unlimited chat transcript.

Jake subsequently requested remembered death coordinates and gear recovery. MB-FLOW-003 defines scoped historical death incidents, loss/recovery evidence and bounded recovery behavior; memory supplies persistence rather than running the recovery policy itself.

## Current evidence

PerceptionService.remember stores at most 32 anchors in memory, with connection epoch, dimension, source and timestamp. Those are not a durable store. RunStore keeps redacted, pruned run evidence and deliberately does not resume active goals. Recent logs cannot be the sole memory source because retention removes old runs.

## Scope and data model

A durable, bounded store under ignored var/memory/ belongs to application code. The gameplay planner receives selected facts through its request, not filesystem tools, a vault, repository access or a connector.

Record:
- Explicit world profile ID, dimension and bot profile scope; endpoint is connection metadata, not proof of the same world.
- Stable fact/project IDs, type, label, typed location or region when justified, source, evidence reference, first/last observation time, revision and stale/invalid status.
- Sources distinguished as direct observation, verified skill outcome, owner-supplied statement, and unverified planner proposal/decision note.
- A designated home, known route legs, verified construction checkpoints and bounded milestone summaries.
- Historical container contents with timestamp and provenance, never a claim of current inventory.
- Bounded death incidents with own location/dimension, source accuracy, last-alive inventory freshness, observed/unknown cause, related recovery deaths, and verified regained versus still missing/unknown items. New deaths cannot overwrite an unresolved original gear location. Keep historical records distinct from current inventory and executable targets.

Coordinator defaults: one named world profile configured by the operator; switching server/profile isolates memory. A reset or replacement world under the same endpoint needs a new profile/revision or explicit operator confirmation. Do not infer world identity from host alone. Store no login tokens, API keys, private reasoning, unrelated player chat or exact hidden-player locations.

No all-seeing map, automatic discovery of hidden resources, persistent entity handles, active goal/lease serialization, or arbitrary planner assertions as verified facts.

## Behavior and persistence

- Empty memory produces a fresh assessment; imported memories are labeled with provenance and checked before use.
- Only application-validated facts become trusted records. A planner can suggest remembering something; code validates its basis or stores it as an explicitly unverified note.
- Writes are atomic and versioned. Crash recovery preserves the last complete store and reports corruption honestly; never silently replace a readable older revision with empty memory.
- Bound retention and retrieval independently from the run log. Keep designated home and active project facts; merge duplicates, retain contradictions and allow superseding stale facts. Store a bounded supporting evidence summary with durable verified facts so pruning a run journal does not erase their provenance; that summary remains historical, not proof of current state.
- Query a bounded subset relevant to current world, dimension, objective and observed location. Recommended initial cap: 20 retrieved facts, with a separate serialized-size/token bound selected against PlannerRequest limits.
- Generate fresh typed memory references for each request. Old snapshot handles, action IDs, container bindings and epochs cannot become executable targets.
- A remembered location can justify travel; current interaction and completion still require fresh observations/server evidence. A remembered home does not prove its house still exists.
- Recheck storage before deciding ingredients are available. Preserve the existing container freshness/ownership rules.
- Stop cancels action and preparation, not already committed memory. Interrupted construction records only confirmed placements and unknown effects separately.
- On death, disconnect or dimension change, invalidate transient references. A new connection can retrieve durable facts, but cannot replay unfinished network commands.
- Capture the bounded death record without delaying revocation, then persist it atomically. Recovery status may survive restart, but cannot reconnect a logged-out bot, clear the pause latch or authorize replay. Preserve compatible semantic interruption facts under the child plan's outcome/baseline rules.
- Owner correction/forgetting of a fact is supported through the general goal/capability path; the exact UI wording is an implementation detail. Forgetting home does not erase other worlds or auth caches.

## Seams and bounded research gates

Inspect src/perception/perception.ts, src/contracts/observation.ts, src/contracts/planner.ts, src/planner/prompt.ts, src/goals/goal-engine.ts, src/execution/ledger.ts, src/execution/predicates.ts, src/telemetry/run-store.ts and storage config.

Proposed ownership: src/memory/ and focused persistence/retrieval tests; typed memory ports/facts in shared contracts. Codex coordinates schema migrations, planner wire/context and app composition.

Gate M-G1: choose an atomic-file store or SQLite based on migration, crash consistency, bounded queries and the existing Node 24 environment. Review actual supported APIs/pins and test an interrupted write; do not add a database/vector service by default.

Gate M-G2: specify reliable world scoping and reset handling without operator-only server APIs. Probe profile switching/reset fixtures during implementation. If the client cannot detect a same-endpoint world reset reliably, require explicit world profile revision rather than guessing.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| M1 | Store a verified home and resource location; restart the app, explicitly reconnect, retrieve the same correctly scoped facts. Another world/dimension cannot use them as local targets. |
| M2 | Owner-supplied, historical and observed facts remain distinguishable; invented locations and unsupported planner claims do not gain verified status. |
| M3 | Destroy/move a fixture workstation or empty its chest between sessions. Chunkbot rechecks and revises memory instead of asserting current contents or success. |
| M4 | Interrupted write, corrupt newest revision and schema migration preserve recoverable data with visible status; bounded retrieval excludes irrelevant/untrusted notes. |
| M5 | Stop midway through construction persists only server-confirmed checkpoints. Restart rebuilds fresh handles and verifies partial state; no duplicate action replay. |
| M6 | A real planner uses retrieved base/ingredient facts in a materially appropriate new plan, then code verifies the result with zero in-trial assistance. All model context is bounded. |
| M7 | With MB-FLOW-003 integrated, death/respawn and a later recovery death preserve separately scoped historical incidents through restart. Stale inventory is labeled, the original valuable gear location remains retrievable, and pause/logout state authorizes no action. |

Run typecheck/build/test and relevant doctor/config checks. Changes to perception/predicates require skill checks; planner/goal context changes require isolation, planner fault and real integration checks from the parent plan. Use temporary stores for persistence faults and loopback worlds for reset/staleness. No live-world fault test.

## Remaining delivery

Storage/world identity decisions, durable facts, retrieval, fresh-reference integration and restart acceptance remain unverified. Review target: docs/reviews/mb-mem-001-memory.md.
