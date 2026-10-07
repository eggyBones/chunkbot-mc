# MB-FLOW-001 progression — worker delivery evidence

Worker: native Claude Code (Opus 5.5) progression worker, branch `chunkbot/mb-flow-001`, base `f05628f8d92499a7a8ea847992a8960e51d9300f`.
Status: **in progress** — shared-port proposals sent to Codex; implementation continuing.

## Proposed shared ports (sent to Codex for design approval)

Source of truth for the types: [`src/contracts/autonomy.ts`](../../src/contracts/autonomy.ts). Everything below is a proposal until Codex approves; progression is the single writer of the existing shared files that apply it.

### P1 — Supervisor and goal source (progression-owned)

- `AutonomySupervisor` (new `src/autonomy/`) sits above the single `GoalEngine`. It never actuates and never calls a model itself; it decides, by code, *whether* and *what kind* of automatic goal to submit at bounded scheduling points (connection ready/respawn + settle delay, goal terminal, explicit resume, finite cooldown timer). No physics-tick or polling inference.
- Typed `GoalSource` on every admitted goal: `owner` (optionally `continuationOf` an interrupted owner goal), `progression {sessionAttempt}`, `support {routine, priority: safety|support, serves, reason, episodeId?, sessionAttempt}`. It is code-owned context on `GoalRecord` and the planner request; it is not a goal/task enum and does not change `TaskSpec`.
- New engine intake `GoalEngine.submitAutomatic(instruction, source, context)` sharing `admit()` with `submit`. It refuses synchronously (no side effects) when: closed, not connected, paused latch set, an active goal/pending instruction exists, an owner admission is in flight, or the source is `owner`. Owner intake always supersedes an in-flight automatic admission (existing intake-generation fencing); an automatic admission can never supersede owner intake.
- Priority: lifecycle/stop > immediate verified safety > owner intent > support > progression. The supervisor never preempts an active owner goal. A `support`/`safety` need may replace an active *progression* goal; owner instructions use the existing smooth handoff against any automatic goal (the current safe task may continue while the owner instruction is prepared).

### P2 — Durable pause latch and scope (progression-owned file, engine hook)

- Scope = `autonomy.scope` or, by default, the configured memory scope (`worldProfile`, `worldRevision`, `botProfile`). No scope → mode `scope_blocked`; manual owner goals stay usable.
- One atomic, fsynced, checksummed control file per scope: `<dataDir>/autonomy/<world>@r<rev>/<bot>/control.json` (+ previous revisions, `O_EXCL` writer lock with pid/start-time liveness, endpoint binding like memory). Corrupt/unreadable/locked → fail closed: `paused`-equivalent `scope_blocked` with the reason; never silently unpaused.
- Engine latch hooks: `GoalEngine` gains `onLatchChanged(latch)` (called synchronously inside `stop()` before any await and inside `resume()`), and `restoreLatch(latch)` at startup. The supervisor cancels its timers synchronously in the hook and persists asynchronously; status shows `durable: pending|written|failed`.
- Resume: clears the latch durably, dismisses an unresolved owner intent (explicit owner acknowledgement), then one fresh bounded assessment. Nothing old is replayed; no reconnect/login.

### P3 — Config / CLI

- `autonomy` config section (`AutonomyConfigSchema`): `enabled` (default true), optional `scope`, `dir`, `rebindEndpoint`, `startDelayMs` 5 s, `afterCompletionMs` 3 s, `afterBlockedMs` 60 s doubling to `maxBackoffMs` 15 min, `session` limits (16 progression goals, 16 support goals, 200 automatic planner turns per run, 3 consecutive unproductive goals, 2 attempts per blocked fingerprint), `home` (`enabled`, `interior` 3, `maxSiteDistance` 16).
- `run --no-autonomy` suppresses scheduling. `models.planner.mode: "disabled"` (inference-free profiles), `connect-check`, `doctor`, `auth`, diagnostics and all existing harnesses never schedule. Existing harnesses get explicit `--no-autonomy` opt-outs.

### P4 — Typed low-health exception (survival grants, progression applies)

- `LowHealthException {purpose: restore_health|escape, allowedCapabilities, abortAtOrBelowHealth, verified[]}` is attached by code to a `support` goal's admission only when the support policy returns it. `AdmittedTask` carries it; at/below `limits.lowHealth` the task runtime offers only candidates of the intersection of the exception and the task's allowed capabilities, and blocks `low_health` at/below `abortAtOrBelowHealth`. The threshold is unchanged; owner/progression goals never get it; the planner cannot request it.

### P5 — Survival support port (MB-FLOW-003 implements)

- `SupportPolicyPort { readiness(); assess(SupportAssessmentInput): SupportNeed | null; onSupportTerminal?(end); status(): SupportStatus | null }`. Pure code from fresh server-backed state; never actuates, admits or calls a model. `SupportNeed {routine, priority, serves, reason, instruction, context? (<= 2,000 chars), episodeId?, fingerprint, lowHealth?}`.
- The supervisor admits a need as a `support` goal via `submitAutomatic`. Support goals count against the run's session limits plus the policy's own per-episode limits; death/respawn never replenish either.
- Lifecycle ordering proposal: `ChunkbotApp.onLifecycle` → `engine.endOwnership` synchronous prefix → supervisor `onLifecycle` (sync: cancel timers, record interrupted owner intent) → `SkillRuntime.onLifecycle`: memory (death capture from last-alive evidence) → **survival recorder hook** (sync, reads the same last-alive evidence) → lease/ledger/perception invalidation. After `respawn`/`ready` the supervisor waits `startDelayMs`, then assesses (support first).

### P6 — Route-leg port (MB-LOC-001 implements)

- `RouteLegPort { activeLegs(goalEpoch, connectionEpoch, dimension, nowMs): TravelLegBounds[]; status(): RouteStatus | null }`. Perception's `withinTravel`/`travelBounds` admit a position inside the immutable admission bound OR an unexpired leg of the SAME goal epoch, connection epoch and dimension. Legs are authorized only by locator code from fresh safe geometry and owner-verified coarse hints, with route ceilings (legs, distance, elapsed time) enforced in code; goal counters and the admission anchor are never reset or moved. Withdrawn/stale hints authorize nothing.

### P7 — Owner intent continuation (R9 / A4)

- The supervisor keeps the latest unresolved owner intent (`active`, `awaiting_answer`, `blocked`, `interrupted`) visible and holds unrelated progression while it is unresolved; support may still run.
- Code continues an interrupted owner intent (after a death or a low-health support routine) **only** when its accepted outcome is baseline-independent: persistent, or finite with only current-state predicates (`inventory_amount` possess, `equipped`, `near_target`, `block_state`, `container_state`, `structure_state`, `entity_outcome observed_present`). The continuation is admitted as `source {kind: owner, continuationOf}` with the ORIGINAL accepted outcome pre-bound, carried counters and the remaining original deadline. Count/time-baseline outcomes (`inventory_delta`, `collect_additional`, crafting/smelting results, visited locations, defeat, memory writes) stay visibly `interrupted` until the owner decides.

### P8 — Status / dashboard

- `AutonomyStatus` (whitelisted) is rendered by `status` (terminal + compact chat line) and published in a new optional `directive.autonomy` dashboard section; the existing `directive.survival` seam is filled from `SupportStatus`. Read-only: no controls, no inference, no account refresh.

### P9 — Construction capabilities and `structure_state` predicate (progression-owned)

- New skill file `src/skills/construction.ts` (the base has no construction file): `select_home_site` approves one small vacant footprint from the current observation (flat natural ground, every footprint ground block visible now, the whole volume air/replaceable, no foreign workstations/containers/doors/beds nearby, inside travel bounds) and records the code-generated `small_shelter_v1` blueprint durably; `build_home` offers only feasible blueprint actions of the earliest incomplete phase (walls → interior construction aid → roof → remove own aid → close the roof → workstations/storage), each a server-confirmed placement at a blueprint position or the removal of the project's own aid block. No demolition, no navigation digging/towering; foreign blocks at blueprint positions block the project with a precise reason.
- New atomic predicate `{predicate: "structure_state", structure: "home", expect: "site_approved" | "enclosed" | "complete"}` evaluated by code from server block evidence (own confirmed changes on this connection, or visible-now chunk data with no pending prediction) at every blueprint cell; unknown cells make it `unknown`, never satisfied.
- A verified complete shelter is written to memory as a trusted `verified_skill` `location`/`home` fact (an owner-designated home is never overridden); a selected site alone is never a home.

## Implementation log

(continues below as work lands)
