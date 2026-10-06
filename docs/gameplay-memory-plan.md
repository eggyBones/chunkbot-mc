# MB-MEM-001 — Persistent gameplay memory

Reported: 2026-10-06. Status: **Implemented by native Opus 5.5, integrated and accepted in [batch001](feature-batch-001-plan.md).** See the [independent review](reviews/mb-batch001-coordinator-review.md) for measured acceptance and retained runtime quality limits.
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

## Review finding MB-MEM-001-C1 — reference ownership and changed facts

At milestone521cf10, MemoryRefRegistry stores goal/epoch/request metadata but resolve validates only connection, dimension and active fact presence. It does not compare the calling owner/epoch or a changed fact revision/coordinates; the counter also wraps at999,999. An old ref must not resolve for another owner or silently alias/misdirect after a fact moves. Require explicit current owner/epoch correlation (or a mandatory equivalent verifier), fact identity/revision/location checks, non-aliasing issuance and fresh re-grounding during preparation-to-admission. Add negative tests for cross-goal access and an owner-corrected location. The worker received the ownership concern and is revising its interface; no acceptance is claimed.

## Accepted delivery

Storage/world identity, durable facts, fresh references and bounded retrieval are installed in the real CLI. Module seed/restart checks pass 13/13 on each version; real M6 passes on 26.1.2 and 26.2 with zero assistance, no action replay and fresh container inspection. C1–C3 are closed, including durable forget and complete memory views at or below 8,000 serialized characters. [Independent integration review](reviews/mb-batch001-coordinator-review.md) records acceptance and retained limits. Full M7 recovery depends on unassigned MB-FLOW-003; memory-side death persistence is delivered.

### MB-MEM-001-C2 — Forget completion requires durable absence

Reported2026-10-06; native correction assigned. On16684a5, evaluateMemoryState(expect forgotten) checks the mutable book's active facts without verifying the forget is durable. A zero-provider coordinator probe created a durable home, faulted the store before rename, and called forget: predicate was satisfied while the write was pending and remained satisfied after forget returned memory_write_failed. The previous durable revision still contained home. Expected: pending/failed deletion is unknown or unsatisfied until durable absence is confirmed; an already absent label may satisfy only from the last complete durable state. Add service-level pending-write/failure/restart and already-absent regressions. Evidence: ignored var/batch001/memory-forget-review-proof.json. Shared API can remain stable.

### Memory bounded-context correction — 2026-10-06T08:32:58.048150+00:00

Root reviewed final module retrieval and reproduced **MB-MEM-001-C3** without inference/fixture contact: 8 project facts serialize to 8,087 characters, exceeding the promised 8,000 limit. The pre-issuance placeholder undercounts actual/non-executable references, project checkpoint refs, and final omission metadata. The existing bound test allows an unexplained extra 2,000 characters. Proof: `var/batch001/memory-view-bound-review-proof.json`. Memory worker is resumed only to enforce the complete serialized view bound, preserve home and usable shown references, tighten regression coverage and report exact commit. H remains frozen at `88089893` for its 26.1.2 gates; this correction will be integrated and checked separately by root.

### Real memory/browser acceptance (2026-10-06 08:48 UTC)

Final isolated-copy build at `a8b47cfbcac9e6922939586712744402b9379bc0`: check 483/483, exit 0. Real M6 on 26.1.2 passed: two actual CLI processes, durable home/chest recall, no replay, a shown memory_ref accepted, fresh inspect before withdrawal, four planks consumed, crafted table server-confirmed at205,-60,206 beside home; code verified3/3 conditions, zero assistance. Three memory views, max3,887chars. Recorded setup includes fixture max-health24 and XP level4/12points for browser observation; original health cap read/restored in teardown. `var/batch001/real-m6-26-1-2/report.json`.

T3 actual browser screenshot `/Users/jakewilcox/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-muwfr7d9-d6125e71.png`: live24/24health (12 hearts), hunger20, level4, XP80%; DOM fill228.60/286px equals80%; returned quota58% fill195.9/338px, exact charge$0.000229992 readable, no console CSP errors. T3 recording still fails generically (no video claimed). **MB-UI-001-C7**: the Memory panel uses a global max-content label column; long natural-language milestone labels leave metadata only~36px at1280px. UI owner will make memory rows responsive/readable without changing data or runtime hooks; root retests real state at desktop/mobile widths.
