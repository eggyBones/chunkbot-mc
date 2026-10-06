# MB-V1-01 — Application foundation and open-ended goal intake

Created/updated: 2026-10-04. Status: **Accepted; independently verified locally and built.** Development-route dependency: MB-V1-00. Read [architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and [research](v1-research.md).

## Outcome and happy path

Jake starts the configured Java bot, completes supported Minecraft sign-in when required, and sees Chunkbot join as its own player. Arbitrary prefixed instructions reach one natural-language goal intake surface. Owner stop/status and correlated clarification replies work through Minecraft chat and terminal. The application exits cleanly.

Jake selected Java, a separate bot-library player, and open-ended LLM planning. Coordinator defaults are Node.js 24 LTS, strict TypeScript, npm, and Mineflayer. Establish compatible dependency pins and the real check commands.

## Scope, seams, and ownership

Proposed owned paths: `src/config/`, `src/contracts/`, `src/game/connection*`, `src/commands/`, `src/telemetry/`, `src/cli.ts`, foundation tests, and operator README. Codex's brief explicitly assigns shared manifests, lockfile, TypeScript/test config, examples, .gitignore, and AGENTS changes.

Establish generic goal/task, capability, knowledge-query, predicate, clarification, and action contracts. No resource-specific goal enum or intent-handler table. Later workers add actual catalog entries and adapters through these seams.

Inspect Mineflayer connection, chat identity, registry, lifecycle, and auth-cache behavior. Gate G-01 chooses the exact Java server/client/dependency profile and checks the suitable bot identity needed for simultaneous play. Do not assume Jake's current playing identity can also serve as Chunkbot.

Included: validated configuration, Java connection, owner admission, free-form goal intake, lifecycle/state, evidence, contracts, and diagnostics. Provider inference and game action implementations belong to later assignments; do not claim a foundation-only goal has run.

## Behavior and persistence

Provide checked-in examples for connection/version/auth, owner identity, storage, model route settings, and limits. Keys stay in environment variables and auth caches/logs in ignored local storage. Never echo secret values.

Use Microsoft auth online; offline auth only when explicitly configured for a trusted loopback fixture. Show supported login instructions if needed, without automatic login or auth downgrade. Joining waits for spawn and valid world state.

Route `!chunkbot <instruction>` and the explicit `!chunkbot goal <instruction>` alias to the same intake port. Reserved control verbs are stop, status, and answer. Ordinary commands such as “come here,” “collect stone,” or an unfamiliar composition are forwarded without keyword gating. Terminal uses the equivalent language.

Verify owner UUID online; exact-name matching is only for the trusted offline fixture. Other players, spoofed server chat, and ordinary unprefixed text cause no model calls/actions. Empty/oversized instructions fail before replacing a goal. A valid replacement cancels old work before planning. Correlate answers to the active clarification and reject stale replies without reviving old work.

Until the relevant adapters are installed, show an explicit capability/planner-not-ready status for admitted goals; do not implement fake results or a fixed demo command bypass. Connection diagnostics and stop/status remain usable without model credentials.

Invalid configuration fails before connecting with a specific non-secret error. Kick/disconnect/death/dimension change clears active ownership. No automatic old-goal resume on rejoin/respawn/restart. SIGINT/SIGTERM closes bot/app-owned resources. Persist settings and redacted run evidence, never active execution.

## Milestones and acceptance

1. **FOUND-1 — Connection slice.** The actual CLI joins the chosen fixture and reports version/dimension/spawn. Bad config fails before connecting; auth/identity prerequisites are recorded.
2. **FOUND-2 — General owner intake.** Different free-form instructions reach the same port without code changes. Chat/terminal controls and correlated answers work. Unauthorized, malformed, and stale inputs are handled correctly.
3. **FOUND-3 — Lifecycle/evidence.** Cancel joining, disconnect while ready, and exit. Verify clean resources/ownership and fresh idle restart. Produce bounded secret-free status/run evidence.
4. **FOUND-4 — Usable handoff.** README covers configuration, auth, launch, and control. Install actual typecheck/build/test/read-only doctor scripts and update AGENTS with verified commands.

Doctor inspects config/versions/binary/readiness without joining or spending inference unless a separately requested smoke mode explicitly does so.

## Checks and remaining evidence

Run actual build/typecheck and affected intake/identity/clarification/lifecycle tests with direct exit statuses. Live-check connection and owner controls on the chosen fixture. Use isolated fault fixtures rather than break Jake's live profile.

FOUND-1 through FOUND-4 passed independent review, 84 tests, doctor, and 16 built-CLI live scenarios against vanilla 26.1.2/protocol 775. [Coordinator acceptance](reviews/mb-v1-01-coordinator-review.md) and [worker evidence](reviews/mb-v1-01-foundation.md). Online bot-account/server details remain pending; no model-driven gameplay is accepted in this phase.

## Current assignment

Assigned 2026-10-04 to Claude Opus 5.5, high effort, full access, through the verified local subscription route. Session: `session-57f00ccc-6072-42e0-9a2a-9abb17e9f038`. Jake selected a separate local test server first. See [worker brief](reviews/mb-v1-01-worker-brief.md) and [coordinator checkpoint](agent-supervision.md). Independent review is complete; accepted foundation scope and limits are recorded above.

## Coordinator review findings

### MB-FND-001 — Late authentication completion after join timeout

Reported 2026-10-04 by independent coordinator review. Status: **Verified fixed; worker regressions and independent coordinator probes pass.** Worker: `session-57f00ccc-6072-42e0-9a2a-9abb17e9f038`. This is within authorized foundation lifecycle behavior.

Observed in `src/game/connection.ts`: timeout ends the join without changing its epoch. A delayed cached Microsoft-profile lookup can finish afterward; the post-await check only compares epoch and external abort signal, so it creates a bot after the connection has entered `ended`. Teardown then returns early because state is already ended, leaving the late-created client unclosed. No real account or network was used in reproduction.

Read-only coordinator seam probe: Node 24 imports the current source; `hasTokenCache` returns true; ping returns protocol 775 immediately; injected profile lookup waits 70 ms; join timeout is 20 ms; injected bot/client counts create/end calls. Result: join rejects with `no valid spawn within 20ms`, state `ended`, **one bot created after timeout, zero client-end calls**, assertion exit 1. Expected: no client may be created or take ownership after timeout/disconnect/stop.

Correction acceptance: fence every post-await connection transition with current joining ownership, settle cancellation without waiting for an unabortable auth operation, and ensure late callbacks/teardown cannot affect a replacement connection. Add a focused delayed-profile timeout/replacement test, preserve explicit Microsoft authentication and ordinary offline join behavior, and rerun affected lifecycle checks. Coordinator will consolidate findings after the worker handoff rather than assume an in-flight queued message was delivered.

### MB-FND-002 — New goal admitted while shutdown cleanup is pending

Reported 2026-10-04 by independent coordinator review. Status: **Verified fixed; worker regressions and independent coordinator probes pass.** Same foundation worker and authorized scope as MB-FND-001.

`GoalEngine.shutdown()` sets its closed admission flag only after awaiting stop/cleanup. A concurrent valid instruction can wait on that cleanup barrier and create new active ownership before the shutdown continuation sets the flag. Read-only coordinator seam probe uses the worker’s `makeEngine`/`ScriptedPlanner`, admits a first goal, registers a manually released cleanup promise, calls shutdown, submits a second goal while cleanup is pending, releases cleanup, and awaits both. Result: **second goal admitted, state planning after shutdown**, assertion exit 1.

Expected: shutdown closes admission synchronously before awaiting any cleanup. Pending and future submissions are rejected or superseded, no new planner/action ownership is created, and shutdown ends with no active goal. Add a targeted overlapping shutdown/admission test and preserve stop/replacement behavior.

### MB-FND-003 — Timing-sensitive abandoned-join replacement regression

Reported2026-10-05 03:30 UTC during MB-V1-02 final checks. Status: **Verified fixed; deterministic regression and independent full check passed**, handled by the current skills worker within required shared-check scope. Foundation runtime acceptance remains recorded; no live authentication regression is established.

Observed: full `npm run check` fails the maintained `a late lookup from an abandoned join cannot affect a replacement connection` test with `no valid spawn within30ms`. The test gives the replacement only30ms of real wall-clock time while polling for its fake bot; other source changes are in skills/admission/evidence, and previous full/live connection checks passed. The worker is characterizing isolated repetitions. Scheduling sensitivity is a hypothesis until that evidence and the actual failure are reviewed.

Expected/acceptance: preserve the meaningful MB-FND-001 race: the old timed-out lookup must never create a client or end the replacement; the replacement must become ready and remain the sole client. Make the test's success path deterministic or provide realistic timing margin without weakening those assertions or changing production deadlines just to pass a test. Capture direct statuses and verify the relevant connection test plus the full required check after the correction.

Characterization: the unchanged isolated regression passes15/15, and the subsequent full check passes165/165. Production connection code was unchanged. The skills observation-correction turn was explicitly delegated this hardening. It now uses a controlled abandoned lookup released after replacement readiness and a150ms fake success window, retaining all ownership assertions without changing production deadlines. Worker10 isolated and24 parallel-loaded file runs and Codex's fresh170-test full check passed. [Independent acceptance](reviews/mb-v1-02-coordinator-review.md).
