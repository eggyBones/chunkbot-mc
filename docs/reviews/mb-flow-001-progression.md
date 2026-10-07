# MB-FLOW-001 progression — worker delivery evidence

Worker: native Claude Code (Opus 5.5) progression worker. This worker is also the single writer of existing shared files for batch 002.

- Branch: `chunkbot/mb-flow-001`
- Base: `f05628f8d92499a7a8ea847992a8960e51d9300f`

**Status: source and harness reviewable; NO live evidence yet.** No fixture lease or provider lease has been granted. No fixture join, RCON, live harness or real inference was run. Every result below is offline: typecheck, build, unit/integration tests and the read-only doctor.

Plan: [autonomous-progression-plan.md](../autonomous-progression-plan.md), acceptance criteria A1–A9.

## Design as delivered (coordinator decisions applied)

### Supervisor and admission

- **One supervisor, one admission path.** `AutonomySupervisor` (`src/autonomy/supervisor.ts`) sits above the single `GoalEngine` and never actuates.
  - It schedules only at bounded points: ready/respawn plus a settle delay, goal terminal, explicit resume, and a finite cooldown timer. There is no tick or polling inference.
  - Automatic goals use `GoalEngine.submitAutomatic` (planner goal) or `submitSupportTask` (survival code task). Both share `admit()` with owner intake (surface `supervisor`).
  - Every goal carries a typed `GoalSource`: `owner`, `progression {sessionAttempt}`, or `support {routine, priority, proposalId, episodeId?, execution, serves, reason, sessionAttempt}`.
- **Priority:** lifecycle/stop > safety (`revokeForSafety`, terminal `safety_interrupted`) > owner intent > support > progression.
  - Owner intake always supersedes automatic work, through smooth handoff against an automatic goal.
  - Automatic admission never supersedes owner intake (`ownerIntakesInFlight`).
- **Automatic goal limits.**
  - Outcomes must be finite.
  - An automatic clarification ends the goal `cannot_execute`.
  - Each automatic planner admission is clamped to the remaining session planner turns (C2). Code tasks make no planner turn but do need Jev (spend reservation is checked).
  - Repeated blocked fingerprints wait for a state change, with backoff.

### Durable stop latch (C1 semantics)

- **Store.** Atomic, fsynced, checksummed `ControlFileStore` revisions with a writer lock and endpoint binding.
  - The scope is `autonomy.scope` or the memory scope.
  - Recovery fails closed: the latch is forced paused (`store_recovery`).
  - `stop` updates the latch synchronously (`onLatchChanged`) and persists it. Status shows `durable pending/written/failed`.
- **Resume** only clears the latch. A fresh assessment follows; nothing is replayed.
- **Owner intent.** A blocked or interrupted owner intent, including survival's durable interrupted directive after a restart, holds progression until a NEW owner instruction supersedes it.
  - Stopping the active owner goal resolves that intent.
  - There is no continuation API in this release.
- **C5 scope consistency.** `resolveAutonomyScope` requires `worldProfile`, `worldRevision` and `botProfile` to agree when both scopes exist.
  - A conflict visibly blocks automatic work (persistence `conflict`; survival is not composed).
  - Manual goals keep working, and ordinary CLI config is not rejected.

### Home (`small_shelter_v1`)

- **Blueprint and phases** (`src/autonomy/blueprint.ts`): walls → one temporary aid block → roof → remove own aid → close roof → crafting table, furnace, chest.
- **Project persistence** (`HomeProjectService`): the project is persisted in the same scope. Checkpoints are only server-confirmed own effects; verification is always a fresh inspection.
- **`ShelterInspector` truth order (C3):**
  - a pending or unloaded voxel is unknown;
  - a fact must agree with the chunk;
  - cache validity is checked.
- **Predicate.** `structure_state {home: site_approved | enclosed | complete}` is code-evaluated.
- **Skills** (`src/skills/construction.ts`): `select_home_site` and `build_home`.
  - Stand points are `near_cell` (C4); the admitted material is binding.
  - Own-aid removal needs identity proof. Restart-unproven aid removal stays blocked.
- **Memory.** A verified complete shelter is recorded in memory. It never overrides an owner-designated home; otherwise it is a separate location labelled `chunkbot shelter`.

### Companion integration (canonical ports, cherry-picked)

- **Survival:**
  - `SurvivalPolicyPort` (none / revoke_unsafe / propose / blocked);
  - `LowHealthAllowancePort` (check → recheck → reserve before both Jev and local dispatch; `consumed` in `finally`);
  - the `survival_state` predicate;
  - durable recovery authority behind the owned `recoveryAdmissionBarrier`. The barrier is bounded and abortable, runs only before recovery's planner/task start, and never on revocation or capture; stop stays immediate.
- **Memory seam:** the canonical string `factDurability(factId)`.
- **Locator:**
  - `RouteController.admit/effectiveTravel/proposalContext/revoke` and `LocatorService`;
  - perception polls `effectiveTravel(RouteAdmissionProof)` every time;
  - the proposal checker enforces route authorization.
- **Lifecycle order:**
  1. engine sync revoke;
  2. `survival.onLifecycle` capture;
  3. `memory.onLifecycle(event, deathContext)` returns the fact;
  4. `survival.linkIncident(captureId, factId)`;
  5. locator/routes/inspector;
  6. lease/ledger/perception invalidation.

### Planner input (fixed in this delivery, `4a28142`)

The generated output schema had no `structure_state` or `survival_state` variants, and their enum words would have been namespaced. The real planner therefore could not state a home or survival outcome. The prompt also never rendered `autonomy`, `route` or `locator`.

Both are fixed:

- **Schema:** each predicate is offered only when its capabilities are in the catalog, and their enum words are not namespaced.
- **Labelling:** automatic goals are labelled `goal.origin: automatic_progression | automatic_support` with `automaticInstruction`, never as owner words.
- **Bounded rendering:** the autonomy, route and locator blocks are rendered with bounds. The instructions version is now `gameplay-planner-v4`.

### Operator surfaces

- **CLI:** `run --no-autonomy` opts out. Diagnostics, inference-free profiles (`models.planner.mode: "disabled"`) and every existing harness never schedule automatic work.
- **Status:** status and in-game replies include autonomy, home, survival, route and locator lines.
- **Replies:** idle stop and resume replies state what the latch means when automatic work is installed.
- **Doctor and dashboard** (read-only): the dashboard shows an "Automatic work" block, mode labels `automatic_progression` / `automatic_support`, and the support/route/home status.
- **P-C7 correction (`fecdfcc`).** The dashboard survival callout used to append "(your directive stays queued)" unconditionally. That was false when there is no owner directive, or when a held/interrupted intent needs an owner decision.
  - The callout now names only the survival routine.
  - Whether an owner instruction is held, interrupted or absent comes only from the canonical autonomy owner-intent line ("Your … instruction: … — needs your decision").
  - There is no new UI flow or control. `tests/autonomy-dashboard.test.ts` asserts the wording.

## Commits (base..HEAD, oldest first)

The progression-owned and shared-writer commits are listed first. The companion cherry-picks are authorized copies from the survival (MB-FLOW-003) and locator (MB-LOC-001) workers.

- `ce214b0` autonomy contracts.
- `56de4af` C1 contract revision.
- `ea5903d` engine/task hooks and supervisor.
- `9a9244d` C2 contract.
- `8b427af` C2 planner-turn clamp, allowance recheck and route guard.
- `4dcfc48` home construction modules.
- `c704ad4` app/CLI composition.
- `0b48e4c` C3/C4, S311 reserve, survival C4 flags, C5 memory seam and code-task Jev truthfulness.
- `74cb055` C5 integration (factDurability, barrier, scope).
- `e6b6698` dashboard/doctor status, `--no-autonomy` opt-outs and config examples.
- `4a28142` planner wire/prompt fix.
- `bb3594a` autonomy-live-check and truthful stop/resume replies.
- `5503827` harness A4/A5 extensions and this review.
- `09ded35` review update for the survival C6/C1 picks.
- `fecdfcc` P-C7 dashboard survival wording.

Companion cherry-picks:

- **Survival:** `1307958`, `6370ed5`, `f0841dc`, `29c6c0a`, `7d63bdb`, `31779ca`, `14577e2`, `80c3995`, then the authorized C6 and C1-retained picks `9f876b4` (from `8ca45c3f9e0479b4f4a558bdd468dd8fcdce0120`) and `ff8d043` (from `8c756b101a9caac0212d4bbe0fe135bc1402bf3c`).
  - The C6 pick conflicted only in `scripts/survival-live-check.ts`. This branch's copy of that survival-owned harness had drifted from survival's lineage (it lacked the G4 bed-mechanics gate present at `9af4ef3`), while every other survival path matched `9af4ef3` exactly.
  - The conflict was resolved by taking survival's own `8ca45c3` file unchanged. No manual edit was made.
  - After both picks, all survival paths (`src/survival/`, `src/skills/survival.ts`, `src/contracts/survival.ts`, `tests/survival-*`, the survival harness and review) are byte-identical to `8c756b1`.
- **Survival (latest harness only):** `98dbc69` (from `07853e24676f832f5f4f612fd6a831b5ac4ad1fe`). It applied cleanly and touches only survival's harness assertions, guard test and review. All survival paths are byte-identical to `07853e2`.
- **Locator:** `940d7bc`, `2d6d178`, `393148a`, `4bc7ea6`, `97504cf`, `d3a98e3`, then the authorized final picks `df89c80` (from `2fb02f69ef522425a32ecd49f1ab2424c32cced5`) and `bd23f13` (from `a87b07aaeb765b55955a45294c88c9fce11b6536`).
  - Locator's own history is `2fb02f6` → `52687a0` → `96ed4ad` (revert of `2fb02f6`) → `a87b07a`. This branch's locator source matched the reverted state, so the two picks give exactly the observed-only blocker source plus the H2 admission-proof test adaptation.
  - `src/locator/`, `src/skills/locator.ts`, `tests/locator-runner.test.ts` and `tests/locator-terrain.test.ts` are byte-identical to `2fb02f6`. `tests/locator-skills.test.ts` is byte-identical to `a87b07a`.
  - The only conflict was locator's review `docs/reviews/mb-loc-001-locator.md`, which never existed on this branch (delete/modify). It was left absent: root carries it through locator's own history, and copying it would have imported records of locator commits not picked here. No companion source was edited.

## Changed paths (excluding companion-owned modules)

**Owned (new):**

- `src/autonomy/`: `store`, `control`, `supervisor`, `context`, `blueprint`, `home`, `status-text`, `barrier`, `scope`.
- `src/contracts/autonomy.ts`.
- `src/skills/construction.ts`.
- `scripts/autonomy-live-check.ts`.
- Tests:
  - `tests/autonomy-supervisor`, `-allowance`, `-barrier`, `-scope`, `-dashboard`, `-memory-seams`, `-wire`, `-harness-guard`, plus `autonomy-fakes.ts`;
  - `tests/construction-blueprint`, `tests/construction-inspector`.
- `config/examples/fixture-autonomy.json`, `fixture-26.2-autonomy.json`.
- This review.

**Shared (single writer):**

- Contracts: `src/contracts/{goal,states,planner,predicate,index,dashboard,memory}.ts`.
- Goals and tasks: `src/goals/{goal-engine,proposal}.ts`, `src/tasks/task-runtime.ts`.
- Perception and execution: `src/perception/perception.ts`, `src/execution/{ledger,predicates}.ts`.
- Memory: `src/memory/{service,book,world}.ts`.
- Game and config: `src/game/connection.ts`, `src/config/schema.ts`.
- App and CLI: `src/app/{app,skill-runtime,doctor}.ts`, `src/cli.ts`.
- Planner: `src/planner/{wire,prompt}.ts`.
- Dashboard: `src/dashboard/{directive,publisher,runtime,viewmodel,outcome-text,assets/page}.ts`.
- Scripts:
  - `scripts/{live-check,skills-live-check,jev-live-check,planner-live-check,handoff-live-check,compat-live-check}.ts` (`--no-autonomy`);
  - `scripts/lib/fault-codex.ts` (records structural planner-input metadata only, never content).
- `tests/app.test.ts`.

The `src/contracts/survival.ts` and `src/contracts/locator.ts` changes are cherry-picked companion contracts.

## Offline checks (Node 24 PATH, run from the worktree root)

| Check | Exit | Result |
| --- | --- | --- |
All results below are at `98dbc69`, the source and build freeze.

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npm run build` | 0 | |
| `npm test` | 0 | 743 of 743 pass. The obsolete locator `pre-H2` test is gone with `a87b07a`. |
| `npm run doctor -- --config config/examples/{fixture,fixture-autonomy,fixture-26.2,fixture-26.2-autonomy,fixture-inference-free,fixture-memory}.json` | 0 each | read-only |
| `node --test tests/survival-*.test.ts tests/autonomy-*.test.ts tests/construction-*.test.ts tests/locator-*.test.ts` | 0 | 259 of 259 pass. |
| `node --test tests/autonomy-harness-guard.test.ts` | 0 | Import-safe. Refuses exit 2 with no lease, an empty lease, an invalid lease, or `--fixture 26.2` alone; creates no output directory. |

## Acceptance status (A1–A9)

| | Offline evidence | Live evidence needed |
| --- | --- | --- |
| A1 | Supervisor tests: ready + settle → one progression goal. Disabled/inference-free profiles make zero planner calls. No scheduling-initiated connection. | autonomy-live-check U0/U1; Codex real-provider run |
| A2 | Generic instruction (no milestone ladder); planner chooses. | Codex real-provider empty vs prepared trials |
| A3 | Blueprint/inspector/construction tests; `structure_state` reachable on the wire. | autonomy-live-check U4 (scripted planner); Codex real-provider A3 with gathering |
| A4 | Supervisor tests: owner preempts; completion returns to progression; persistent follow keeps priority; blocked/interrupted intent visible and held. | U2 |
| A5 | Supervisor test: stop during automatic planning, restart, fresh resume. Timers make no calls. | U3 (stop during an in-flight planner turn, restart, resume); stop during movement/crafting/building in the Codex combined run |
| A6 | Inspector truth order; checkpoints only from server-confirmed own effects; never-override-owner-home memory test. | U4/U5 (restart, offline damage, fresh inspection repair) |
| A7 | Provider-not-ready, session clamp, unchanged-state wait, spend/Jev gating tests. | Codex combined run |
| A8 | Read-only dashboard projection test. | Codex combined acceptance with memory, handoff and dashboard |
| A9 | Survival integration tests (allowance, code tasks, safety revocation, durable interrupted intent, barrier). The survival gate harness is MB-FLOW-003's. | Survival R-gates plus Codex combined run |

## Live harness (`scripts/autonomy-live-check.ts`) — lease request

**What it drives.** The REAL built CLI `run`, with autonomy enabled. Providers are stand-ins, so no inference happens:

- the planner fault fixture (scripted turns; the real CLI answers only the read-only gate commands; login mode is scripted);
- loopback Jev, which always picks the first code-ranked option.

This is harness validation, not planner or Jev quality evidence. Each scenario runs only if the previous ones passed.

| Scenario | What it checks |
| --- | --- |
| U0 | An operator stop before the first assessment latches; no automatic goal starts while paused. |
| U1 | Resume → fresh assessment → progression admitted on the `supervisor` surface with a `progression` source. The planner input is labelled automatic and carries autonomy context. The outcome is code-verified, and the log is confirmed over RCON. |
| U2 | An owner instruction during an automatic task replaces it; no automatic task runs after the switch. The owner goal completes, and progression returns. |
| U3 | An owner stop during an in-flight automatic planner turn cancels it. The latch is durable on disk (read-only store inspection between processes) and is restored at restart with no automatic goal. Resume starts a fresh assessment. |
| U4 | The automatic goal approves a site and builds `small_shelter_v1` (interior 2, cobblestone plus table, furnace and chest). `structure_state complete` is verified by code. Every blueprint cell is confirmed by `execute if block`, the status shows the home complete, and the project is on disk. |
| U5 | The verified home is in memory (read-only inspection). A wall block is removed while the bot is offline (recorded intervention). After restart, the planner sees the stored historical state; `build_home` inspects afresh and re-places the cell; code re-verifies; RCON confirms. |

**Safety.**

- The script refuses before any password read, RCON call, join, config write or output.
- It uses an independent data directory under the report directory, with a fresh scope per run.
- It records the source freeze: HEAD, dirty count, and the `dist/cli.js` sha256 and mtime.
- Every setup command and intervention is recorded.
- It never signals anything except its own child CLI process, and only after `/quit` has failed for 20 s.

**Footprint:**

- Area: x 196..224, z 190..224, y -63..-50 (the existing scene area). It is reset to flat grass with one oak trunk at 208,-60..-58,202, and forceloaded like the other scene harnesses.
- Inventories: Chunkbot's and FixtureOwner's. Chunkbot gets 8 bread (above the default safe-food reserve), then 64 cobblestone, a crafting table, a furnace and a chest.
- Teleports: Chunkbot and FixtureOwner, inside the area.
- No difficulty, gamerule or time change.

**Requested:** an exclusive driver lease on the 26.2 fixture (`127.0.0.1:25567` / RCON 25577, `--fixture 26.2`, base config `config/examples/fixture-26.2-autonomy.json`), and later on 26.1.2 (`127.0.0.1:25566` / RCON 25576). No provider lease is needed; there is no inference.

**One point for the coordinator's decision before the run.** As in `handoff-live-check`, the planner fault fixture passes three read-only gate commands to the real installed `codex` CLI: `--version`, `debug models --bundled` and `features list`. Per AGENTS.md, `features list` loads the account's cloud config.
- No model turn, quota RPC or login change happens: `login status` is scripted, and `exec` never reaches the real CLI.
- Please confirm this is covered by the granted lease, or run the harness yourself. This worker has not invoked it.

Commands (build first; never rebuild while it runs):

```sh
npm run build
npm run fixture -- status
node scripts/autonomy-live-check.ts --fixture-lease <granted id>
# optional, with the 26.2 fixture leased:
node scripts/autonomy-live-check.ts --fixture-lease <granted id> --fixture 26.2
```

The report is written to `var/live-check/<stamp>[-26.2]-autonomy/report.json`. It includes the results, setup, interventions, per-run admissions by source, planner-input metadata and Jev call count.

## Known gaps / notes for Codex

- **Live evidence.** All live and real-provider evidence is pending a lease: A2, A3 with gathering, A5 stop during movement/crafting/building, A7, A8 and the combined run.
- **Memory acceptance.** `config/examples/fixture-memory.json` has a memory scope, so a normal `run` with it now starts automatic progression (`autonomy.enabled` defaults to true). Memory CLI acceptance that wants isolation should pass `run --no-autonomy`.
- **Catalog.** The locator is composed by default, so the catalog has 22 capabilities in the fixture profiles.
- **Aid removal.** Restart-unproven own-aid removal stays blocked (strict identity). An aid left by an interrupted build is reported as a partial effect and needs a fresh decision.
- **Stop semantics** are as approved (C1).
- **Harness limitation.** The harness's Jev stand-in picks the first code-ranked option. A build that needs non-first choices would show up as a harness failure, not as a Jev quality result.

## Proposed AGENTS.md / README.md additions (for Codex; not edited by this worker)

- **Required checks table, new row.** "Autonomy supervisor, durable latch, home construction, `src/autonomy/`, construction skills or the autonomy planner seams" → run `npm run build && node scripts/autonomy-live-check.ts --fixture-lease <granted id>` with the fixture running and exclusively leased. It uses a scripted planner and loopback Jev, with no inference. Real acceptance is the A3/combined run with real Codex and Jev.
- **Runtime constraints:**
  - a normal `run` starts automatic progression when a durable scope exists;
  - `run --no-autonomy` opts out;
  - the inference-free profiles and all diagnostics never schedule;
  - the autonomy state lives in `<dataDir>/autonomy/<world>/r<rev>/<bot>/`.
- **README operator guide:**
  - `stop` pauses automatic work durably (across restarts);
  - bare `resume` clears only the latch and starts a fresh assessment;
  - a blocked owner instruction holds progression until a new instruction;
  - config examples `config/examples/fixture-autonomy.json` and `fixture-26.2-autonomy.json`.
