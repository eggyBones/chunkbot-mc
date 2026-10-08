# MB-LOC-001 — Locator-assisted following: worker handoff evidence

## Native L continuation — L-H10 stable origin and truthful restoration (2026-10-08 UTC)

Status: **dedicated ordinary harness correction implemented and verified offline; new world/provider acceptance remains ROOT-owned and pending.** The registered `chunkbot/gameplay-follow` checkout `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-follow` was clean at reviewed `0b66543fca348e10b4447e32f0613f95e1fed651`. Focused source commit: **`d43047e9232f7fff3bba185269079ed331a02dc8`**, four paths, 315 additions/15 deletions; this role handoff is committed separately. Full review diff: `git diff 0b66543fca348e10b4447e32f0613f95e1fed651..HEAD` on this branch. Only those dedicated harness/helper/test paths and this existing role review change. Shared product source, coordinator documents, frozen acceptance copies, packages, vendor and installed dependencies are untouched.

The supplied ROOT native gate `var/gameplay-fixes/codex/L-H10-native-model-verification.json` was read; a copy is retained in this checkout's ignored receipts. Checked `2026-10-08T16:48:53.005Z`: installed native DSH Codex provider, CLI `0.160.0`, session route `codex:codex-default`, personal ChatGPT `prolite`, exact `gpt-6.1-sol`, supported/requested `xhigh`, `danger-full-access`, approval `never`, noninteractive full access. ROOT's prompt receipt is accepted at `16:52:48.777991Z`. This is supplied coordinator verification for the same L session; no account/model/route/settings change or worker launch occurred.

### Preserved actual failures and diagnosis

ROOT's complete current coordinator review and L-H10 intake recorded at **16:55 UTC before correction** were read. Frozen `a0ae3f8` trials remain **direct exit 1**, each with all thirteen behavior gates positive, no privacy findings, both actual CLI processes exit 0, and thirteen of fourteen cleanup steps positive. Failed RESTORE is retained. Leases 33/34 and independent original Peaceful/rules/twelve-forceload/empty-backup/zero-player audits are ROOT evidence; they do not make the original cleanup gate pass.

| Exact fixture | Preserved ROOT-relative report | SHA256 |
| --- | --- | --- |
| 26.1.2 | `var/gameplay-fixes/acceptance-native/var/live-check/2026-10-08T16-29-13-690Z-locator-ordinary/report.json` | `747f92e663d6a5eefaa20757271c40e098b05c6303ffc9307acacfc97517b5ba` |
| 26.2 | `var/gameplay-fixes/acceptance-planner/var/live-check/2026-10-08T16-29-13-689Z-26.2-locator-ordinary/report.json` | `0e39aa4353ce6476206d180253f42af19b4821725cbd23c6764c3cba79f52001` |

Both complete reports and all **188/190 command-journal rows**, full CLI logs, run events and summaries were read locally. Each report contains 409 samples, 123 diagnostic observations, 11 privacy scans, 11 planner prompt records and 13 Jev choices. Reconstruction and hashes are retained in `var/locator-ordinary-worker-review/lh10/retained-lh10-analysis.json`; original artifacts remain unchanged.

The old code samples `Pos` immediately after CLI readiness, takes one dimension read with an overworld fallback, and stores neither raw initial read in the journal. It does not prove grounded or stationary origin before staging. Its finalizer teleports to that transient point, waits one second, then checks full 3D distance <= 1.5 and dimension. Both successful final teleport replies target the reported airborne origins: `(264.5,-50.42467038393728,195.5)` / `(264.5,-48.22350670217752,195.5)`. Recorded final dimension replies match `minecraft:overworld`. Therefore the failing compound assertion concerns position. The actual failing final `Pos` reply was read with recording disabled and discarded before `finalPositions` was populated; neither report proves its value or the eventual landing height. Gravity settling remains a plausible mechanism, not a retrospectively established final coordinate.

### Dedicated source and evidence APIs

- `scripts/locator-ordinary-live-check.ts`: uses the new evidence helper before owner join or scenario staging and again after the existing exact-origin restoration teleport. Rejects gameplay work before/during baseline capture. All server reads are independent of application/model input. Records raw command intent/reply, `position-reads.jsonl`, report `botOrigin` and `positionChecks`, including errors/readbacks on failure. New report `retainedLH10Failures` preserves both original failures/hashes alongside L-H7/H8/H9.
- `scripts/lib/locator-ordinary-origin.ts`: new dedicated fixture-free helper. Exports `parsePlayerPositionRead`, `stationaryPositionProof`, `captureStationaryPosition`, `originalPositionTarget`, `POSITION_SETTLE`, and the `PositionScope`, `PlayerPositionRead`, `StationaryPositionProof`, `PositionTarget` types. No world/app I/O or new actuator.
- `tests/locator-ordinary-origin.test.ts`: 32 meaningful offline controls for actual falling-origin shapes, independent grounded/stationary proof, drift, named UUID/dimension/run/connection ownership, missing/error/foreign readbacks, time bounds, proof tampering, and exact restoration on the later CLI connection. Tests preserve all falling/failed reads and reject teleport-success text, airborne exact coordinates, wrong dimension, a grounded different height even 0.1 block off, gaps/future samples/deadline overrun.
- `tests/locator-ordinary-harness-guard.test.ts`: existing lease/profile/import/footprint/privacy/arrival controls plus actual harness wiring/order and durable failure evidence checks.
- This role review preserves all prior failure and delivery history.

Before staging, the real harness polls only `data get entity Chunkbot` fields. Each read brackets **Pos and Dimension**, checks the named server UUID against the trusted offline Chunkbot identity, requires server `OnGround:1b`, and fences both ends to the current ready run/connection. A bounded interval needs at least three agreeing grounded reads spanning >= 1,000 ms, each <= 1,500 ms, inter-read gaps <= 1,000 ms and full 3D agreement <= 0.000001 block. Falling/moving samples reset the interval and are retained. Polling is 250 ms with a 10,000 ms deadline; field requests receive the remaining read/deadline allowance. Missing/unreadable identity, dimension, grounding or connection evidence fails; no guessed dimension or pre-capture teleport supplies the baseline.

Restoration revalidates the detached original raw proof, uses its **exact existing original-position exception**, and then requires a fresh grounded stationary interval at that same full point and dimension on the current owned CLI run/connection. The original origin run may differ from the final O7 CLI run; both retain their exact named identity and scope independently. The old 1.5-block comparison is tightened to 0.000001, never widened. A success teleport reply alone cannot pass. Timeout, wrong coordinates or incomplete evidence remain cleanup failures, with raw readback and error retained before graceful shutdown continues.

All thirteen behavior cases, within 3 finite completion, O4/O7's 240-second bounds, first-option loopback Jev, capability order, strict historical/current-hidden privacy oracle, reconnect/ready-no-op controls, graceful CLI exit 0/callback settlement and zero-player gate remain unchanged. Footprint stays overworld x1700..2400/y-60/z1700..2300, nether(0.5,128,0.5), bot envelope x1600..2500/z1600..2400, plus only the proven exact original bot origin. No block/settings/clock/bed/respawn/forceload or foreign-entity mutation is added. Origin capture invokes no application diagnostic or snapshot and cannot refresh handles/history or supply coordinates to planner/goals.

### Direct checks, source versus build and dependencies

Prescribed Node 24.21.0 PATH; direct command exit codes/logs are retained under ignored `var/locator-ordinary-worker-review/lh10/receipts.json`. Typecheck and own build exit 0; all 90 dedicated tests exit 0. Both `npm run doctor -- --config config/examples/fixture.json` and `config/examples/fixture-26.2.json` exit 0. Initial full `npm test` exits 1, 1208/1209: unchanged `tests/safety-defense.test.ts:130` times out waiting for hold release/defeat at 10,077 ms. Its unchanged isolated 9/9 run exits0. The unchanged complete `npm test` rerun exits **0, 1209/1209** at `17:08:53.009632Z` (`full-tests-rerun.log`). The initial failure remains in `full-tests.log`; no shared source, test, concurrency or timeout was changed. `git diff --check` exits0.

Only this checkout's `dist/` is built; `tsconfig.build.json` emits application `src/`, while the ordinary harness/new helper execute as Node TypeScript source and are covered by typecheck and offline tests. `source-build-manifest.json` records all four source hashes and own `dist/cli.js` SHA256 `51cd32722449550212fb445df07021bb8e64b0937d961d31fd7f2459da04f687`. These are local evidence, not proof of a gameplay process loading the correction. Neither frozen ROOT source/build is mutated. No worker world join, RCON call, fixture start/stop, provider inference, credential operation or live control occurred.

Outstanding: ROOT complete source review/integration, immutable full ordinary runs on both exact fixtures proving new initial grounding/stability and final exact restoration, all behavior/privacy/exit gates and independent original-state audits. Actual ordinary Codex/Jev acceptance and shared water/mechanics/provider/UI gates remain ROOT-owned. Do not treat these helper/module/source checks as ordinary real-provider proof or accept far-water follow early. Pending S-owned own-death recovery route guard consumption is **untouched**: wait for ROOT's exact approved commit and typed seam, with P binding composition, before any locator product integration. No source import or product edit for that dependency occurred. Live `d348d58` remains logged out; no deployment/push/PR.

## Native L continuation — L-H9 bounded historical-owner proof (2026-10-08 UTC)

Status: **actual ordinary harness correction implemented and verified offline; coordinator world/provider acceptance remains pending.** Incoming branch `chunkbot/gameplay-follow` was clean at `2c4524ca09fbb0cb6d04c1e381b178059912bc84` in the original `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-follow` checkout/workspace `1160d1e5-e344-4f92-b78b-a1ccf5ea3e88`. The earlier L-H7/H8 delivery was approved and imported by P as `d9b2652`; this continuation changes only the same five dedicated harness/helper/test/review paths. No shared product source, coordinator file, package, vendor or installed dependency is edited.

Native-route proof: ROOT `var/gameplay-fixes/codex/LH9-model-verification.json`, checked `2026-10-08T07:58:57.257Z`, reports the installed DSH native provider, CLI `0.160.0`, `codex:codex-default`, personal ChatGPT `prolite`, exact `gpt-6.1-sol` with supported/requested `xhigh`, and effective `danger-full-access` / approval `never` / noninteractive full access. Jake's current instruction supersedes historical Claude rules. The same L session/preset `relay-codex` remains in use; no account, route, model or settings change, worker launch, coordination, credential/vault operation, inference, fixture/world operation, live control or deployment occurs in this continuation. A read-only copy of the supplied verification is retained in this checkout's ignored receipts directory.

### Retained failure and actual chronology

The complete current ROOT [coordinator review](mb-gameplay-fixes-coordinator.md) was read, including L-H9 recorded before correction at 07:56 UTC. The frozen `17d0c08` ordinary 26.1.2 trial remains **exit 1, 7/14**, report SHA256 `3c76d9f6d18036dc802e1f9f46170d07247793857aa668a7de246a1d368074c3`. ROOT-relative artifact: `var/gameplay-fixes/acceptance-planner/var/live-check/2026-10-08T07-37-15-110Z-locator-ordinary/`. Both actual CLI exits are 0 without forced kill; all 14 cleanup steps pass. ROOT's independent exact settings/forceload/backup/zero-player audit and released lease24 are coordinator evidence. The original report and every artifact remain read-only and unchanged; new reports retain its exact pointer/hash alongside the older L-H7/H8 failure.

Local investigation reads the complete report, 632 server samples, all 15 diagnostic observations, 13 complete planner prompts, 10 exact structured Jev bodies, 404 ordinary plus 60 exhaustion events, 42 ordinary planner records, both complete CLI logs, 154 command-journal rows and 68 setup/readback records. Every retained diagnostic snapshot matches its actual CLI JSON exactly. Reconstruction, original paths and input hashes are saved in ignored `var/locator-ordinary-worker-review/lh9/retained-lh9-analysis.json`.

The eight findings are historical entries matching earlier actual visible-owner snapshots and named server positions, not demonstrated current-hidden coordinate leaks. O3 shows `1821.5,-60,2121.5` in eight visible snapshots on run `run-b91b8bf5d579`, connection1/overworld, goal epochs5 then6. Anchor1's final diagnostic starts at `1791445358069`, calls `remember()` at `1791445358088`, and its actual CLI response is received at `1791445358088`. O4 similarly shows `2017.5,-60,1737.5` in six visible snapshots, epochs9 then10; final start `1791445428451`, remember/response `1791445428472`. Actual visible owner handles and full server points agree. The old helper required `remember.observedAtMs <= snapshot.takenAtMs`, but perception records snapshot start before its LOS work and timestamps `remember()` during that same read. All 15 current-point timestamps therefore fail that ordering by 18–31 ms. Later planner ages agree with the retained anchors: anchor1 ages4/7 seconds in O4,75 in O5,106 in O6,131 in O8; anchor2 ages4/35/61 in O5/O6/O8. Their complete points differ from the hidden current owner. This diagnoses the faulty capture/correlation boundary; it does not retroactively certify the old artifact under the new stricter proof, which lacks retained UUID and immediate post-read server brackets.

### Actual harness correction and APIs

`scripts/locator-ordinary-live-check.ts` still takes exactly the existing read-only `/diag observe` at the existing bounded scenario polling points. Each read now records request time and actual `CliProcess` response time, current run and connection epochs before/after, and independent named-owner `Pos`, `UUID`, `Dimension` readbacks on both sides. Their raw replies and times stay in `observations.jsonl`/the report; server coordinates and identity never enter the application, goals, planner or Jev. No extra perception turn, actuator action, provider choice or staging movement is introduced. The existing one-second polling and case bounds remain intact; taking a diagnostic still has the existing normal snapshot/observed-anchor/handle-history effect.

`scripts/lib/locator-ordinary-oracles.ts` adds `OwnerIdentity`, `OwnerServerRead` and `parseOwnerServerRead(name, replies, fromMs, toMs)`. The parser admits only successful exact named-player replies, finite complete coordinates, the four signed UUID words and a declared dimension; errors/absence/foreign names are refused. `verifiedHistory(observations, ownerIdentity)` now requires the full ordered server-before/request/snapshot-start/response/server-after interval to be at most1,500ms, stable exact server owner point on both sides, expected name-derived trusted-fixture UUID, matching dimension, run and connection, and an actual filtered visible owner/player handle at that point. The anchor timestamp must fall **inside that actual read**, with a one-millisecond timestamp beyond response still rejected. Snapshot start/ID, goal epoch, owner handle, full point, raw server evidence, identity and complete capture interval are retained in `HistoryProof`. Missing new-format corroboration stays unverified.

`privacyOracle` requires the complete bracket to precede the model request and retains the existing complete-point/anchor/connection/run/dimension/rounded-age matching. It records every allowed historical field and its evidence, including points that do not numerically collide with the hidden owner. Historical coordinates remain evidence of prior visibility only; they prove no current presence and authorize no action. The strict hidden-current numeric/text scan remains applied to all other fields, including additional/nested values inside a corroborated `at`. No remembered field or coordinate axis is whitelisted.

Dedicated regressions preserve the earlier interval, ready-no-op/genuine-reconnect and truthful shutdown controls. New controls reject missing brackets, one-millisecond future evidence, too-long or disordered reads, post-read movement, wrong/raw-forged UUID or dimension, changed connection/run, mismatched owner handle, absent/foreign/malformed server replies, model input before bracket settlement, hidden admission-anchor/target-context coordinates and unverified historical labels. An additional two-point regression uses the actual L-H9 O3/O4 point/anchor/time/age shapes across goals with **synthetic new-format** server brackets; removing those brackets keeps both old entries unproven. This is oracle discrimination, not a replayed passing world trial. The actual harness guard checks the new capture wiring after its existing pre-secret/pre-join/pre-RCON lease/profile gates.

### Separate product diagnosis and checks

O4 is also P-LOC-R2. Replacement goal `goal-abe7f0916257`/epoch9 is correctly admitted with its own route5 and unchanged finite `within:3`; old goal/route cancellation succeeds. Owned `act-7b1adb0456d7` starts `07:42:46.018Z`, returns `partial/route_window_elapsed` at `07:43:47.882Z` after61,865ms,240.7 moved blocks,239.8 net progress and13 steps, with ownerSeen/current cue/live route. At `07:43:47.954Z`, round2 correctly sees owner distance10.6 but immediately blocks `no_progress` (62s against30s). The next scripted planner turn returns `cannot_execute` at `07:43:48.215Z`. No second approach is admitted. This is the same productive-motion seam P is correcting, not a new replacement authority failure. No product edit, forced candidate, extra planner success, extended timeout or relaxed arrival oracle is made here. O1/dependent follow and O7 remain failed on the retained source for the separately recorded P findings.

All commands use Node24.21.0 from the prescribed Cellar PATH in this own checkout. Direct exit receipts:

| Check | Direct result |
| --- | --- |
| `npm run typecheck` | 0 |
| `npm run build` | 0 |
| `npm test` | 0; **1,176/1,176**, including57 dedicated ordinary-harness/oracle tests |
| `npm run doctor -- --config config/examples/fixture.json` | 0; no failures |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | 0; no failures |
| `git diff --check` | 0 |

Logs/receipts are in ignored `var/locator-ordinary-worker-review/lh9/`. Both doctors truthfully warn that the worker's independent fixture JRE/server and OpenRouter key are absent, and that this profile lacks a durable autonomy scope. No setup, connection or provider probe is run. Own built/source state is verified offline on the dedicated branch; ROOT's separate1218-test combined source acceptance is not claimed as this worker's current build.

Remaining acceptance belongs to ROOT: freeze/review/import these focused changes with P's reviewed progress correction, run the entire ordinary locator/privacy/reconnect/cleanup gate on both actual supported releases with independent settings/forceload/backup/player audit, then perform actual Codex/Jev ordinary follow/finite-reunion and required combined UI/regression/provider checks. Scripted planner plus loopback first-option Jev, source/modules and these57 tests do not prove real-provider play. No worker lease exists. Original fourteen cases/gates, finite within3/240s, first-option selection, teleports x1700..2400/y-60/z1700..2300 plus nether(0.5,128,0.5), motion envelope x1600..2500/z1600..2400 and exact recorded-origin restoration are unchanged. No block/difficulty/gamerule/time/bed/respawn/forceload write, foreign removal, scene expansion, new live join, push or PR occurs. Far-water follow awaits W's full mechanics acceptance; live artifact `d348d58` remains logged out.

## Native L continuation — L-H7/L-H8 ordinary harness correction (2026-10-08 UTC)

Status: **implemented in the actual ordinary CLI harness, offline verification complete; new world/provider acceptance remains coordinator-owned and pending.** The historical module evidence below is preserved. This correction does not approve a release or reconnect the live bot.

Checkout `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-follow`, branch `chunkbot/gameplay-follow`, clean incoming base `0365612`; workspace `1160d1e5-e344-4f92-b78b-a1ccf5ea3e88`. The coordinator supplied fresh native route verification at 06:32:31 UTC: personal ChatGPT `prolite`, `codex:codex-default`, `relay-codex`, CLI 0.160.0, exactly `gpt-6.1-sol`/`xhigh`, `danger-full-access`, approval `never`. This worker changes no route/account/settings, launches no agents and performs no credential, fixture, live-control or inference operation. Earlier Claude sessions/evidence remain preserved.

### Original failure retained

The complete [coordinator review](mb-gameplay-fixes-coordinator.md) was read before correction. Its frozen `fbee684` ordinary 26.1.2 report remains unchanged: exit 1, 10/14, SHA256 `a2d00c656945a63eb083e170668f536f44cae08b29dcf94ecebb81f1fb255e6c`. Root-relative path: `var/gameplay-fixes/acceptance-native/var/live-check/2026-10-08T06-09-31-852Z-locator-ordinary/report.json`; full `run-locator-ordinary.log` and `data-ordinary/runs/run-2c986d32dc94/events.jsonl` are read-only evidence. The new report explicitly records this original failure and hash.

Read-only reconstruction of those actual event shapes confirms `act-b0b5bd676d58`, lease 4, original goal `goal-f03a5c9a863c`/epoch 1, starts 06:11:27.948 and ends 06:12:06.877. It intersects both trips; first reunion is server-sampled at 06:11:45.969, distance 2.0, before the action completes. No planner turn occurs in either interval. This explains the completed-outcome-only oracle failure. It does **not** retroactively turn the old report into a pass: that artifact lacks the newly required simultaneous filtered-visibility/current-cue observations. Reconstruction is saved locally in ignored `var/locator-ordinary-worker-review/retained-evidence-analysis.json`.

O5/O6 parsed planner data contains `observation.remembered[0].at.z = 2042.5` with ages 390/422 seconds, plus a later remembered 2043.5. These original numeric heuristic failures remain recorded. An `observed` label alone is not new passing privacy evidence.

### Actual harness and APIs

Only these dedicated files change:

- `scripts/locator-ordinary-live-check.ts`: ordinary CLI/chat entry point, O1c/O8/privacy/finalizer corrections and durable evidence capture.
- `scripts/lib/locator-ordinary-oracles.ts`: pure dedicated evidence functions `actionIntervals`, `reacquisitionProof`, `verifiedHistory`, `parsePlannerInput`, `privacyOracle`, `reconnectProblems`, `shutdownProblems`; no I/O or gameplay entry point.
- `tests/locator-ordinary-harness-guard.test.ts`: import/lease/profile/footprint checks and actual harness wiring assertions.
- `tests/locator-ordinary-oracles.test.ts`: discriminating interval, privacy, reconnect and teardown controls.
- This existing locator role review.

**O1c:** reconstruct starts through the actual task choice/local continuation, admitted task, lease owner, connection-ready event and matching outcome/revocation. Both trips require real filtered owner loss with a far server sample, an overlapping owned `seek_owner` interval, a fresh current-connection dashboard cue and live original-goal route, then actual filtered owner reacquisition with server distance <=4.5. An action may start before the second trip or complete after the first reunion. Same-goal ownership and zero additional planner turns are asserted. Tests reject direct follow, wrong goal/lease/connection/visible target, missing/stale cue, revoked route, seek outside the interval and a new planner turn. No Jev option is forced: the loopback provider still picks the first offered option.

**O8:** `/reconnect` while ready must say `already ready`, retaining the connection, goal and route. Then `kick Chunkbot locator-ordinary-owned-disconnect` creates a genuine bounded owned disconnect. Exact old goal/route/locator callbacks must be revoked, a strictly newer connection epoch must attach the locator before readiness, and the owner is held sneaking during rejoin so an old cue cannot be recycled. Clearing sneak must produce a fresh actionable cue whose age fits that fresh broadcast interval. No new action, planner turn, goal admission, route authorization or route leg is allowed after disconnect/rejoin; server positions must remain settled. The cue is sampled from the application's existing published status; transition-only telemetry is not treated as a per-packet journal.

**L-H8:** parse the exact planner JSON and Jev body, preserving numeric match strength (floor/round +/-1), source, path and value. A remembered owner tuple is allowed only when its complete point, anchor ID, dimension, run, connection and age match an **earlier actual visible-owner observation** corroborated by a contemporaneous independent server sample. Future observations and source labels do not grant authority. Additional fields inside/alongside a verified `at` object remain scanned. A current local point sharing one axis is allowed only at a declared current observation path, inside the sampled bot's observation radius; self coordinates must match the sampled bot. No axis or entire remembered field is excluded. Hidden-current tuples, unverified/forged history, off-axis values and nested coordinate text are adverse controls. Requests claiming a visible owner require independent server position/radius agreement before being classified as visible. No pre-reunion time gap is omitted. Far O2/O4/O7/O8 requests are also scanned.

**Observer/provenance capture:** read-only `/diag observe` takes the application's own filtered snapshot while walking, losing/reacquiring sight and near finite/exhaustion endpoints. It may refresh normal observed anchors through `PerceptionService.take`; it grants no actuator lease and passes no RCON coordinates into the application. O4/O7 continue sampling while waiting for their existing 240-second bound, so late planner requests and historical anchors have evidence. `commands.jsonl` records setup/cleanup intent before dispatch and full reply afterward; `observations.jsonl` retains actual snapshot/server/dashboard correlations; `jev-requests.jsonl` retains exact model-visible bodies, without headers/secrets. The report includes matched/allowed field provenance, intervals, cleanup steps, final positions, every child exit/summary and the original failed artifact pointer.

**Finalizer:** stop/revoke all owned actuator leases before online cleanup, clear and verify owned dummy inventory/head/effects and controls/sneak while online (including the O5 logout path and pre-O7 CLI replacement), verify declared base positions for owned observer dummies and the bot's exact recorded origin/dimension, then request `/quit` and close stdin. Child exit 0, terminal `shutdown complete`, settled control cleanup, ended connection, complete run evidence, no active goal/lease/route/locator attachment and no exit watchdog are required. A timeout/nonzero/signal is a failure with PID/exit evidence; there is no forced kill or log-saved success flag. All owned dummy connections and loopback HTTP callbacks must settle; server `list` must report zero final players. Cleanup errors are retained and fail the report; outer runtime errors also produce a failing report after cleanup attempts.

**P-LOC-R1 stays binding:** the planner proposal still binds `near_target owner within:3`; capability order, unforced first-option Jev and finite outcome are unchanged. O4 must complete within its original 240 seconds and fails until the shared finite approach/no-progress correction is integrated. No source under `src/` is edited and no `move_near` choice is forced. Product diagnosis was read-only; P remains the shared-source writer.

### Checks and remaining evidence

Node 24.21.0 from the prescribed Cellar PATH. Direct exits are captured by the shell runner. `npm run check` exits 0: typecheck and build pass; all **1,170/1,170 tests** pass, including 51 dedicated ordinary-harness/oracle tests. The final check is after the last TypeScript/test edit. Both independent read-only doctor commands exit 0: `npm run doctor -- --config config/examples/fixture.json` and the same with `config/examples/fixture-26.2.json`. Doctors report no failures; this worker checkout has no local fixture JRE/server/runtime and no OpenRouter key, as expected. No fixture is provisioned or started. Logs are under ignored `var/locator-ordinary-worker-review/` (`final-check.log`, both `doctor-*.log`). `git diff --check` passes.

Remaining: independent immutable combined runs on vanilla 26.1.2 and exactly 26.2, including all O0–O9 cases, corrected O4 after P's source integration, both truthful CLI exits, every cleanup readback and exact original settings/force-load/player restoration. The ordinary harness is **scripted planner + loopback first-option Jev**, so even an exit-0 fixture report is harness validation; actual Codex/Jev ordinary follow/finite reunion and required combined provider/regression gates remain separate coordinator acceptance.

Before any world run, the coordinator must grant an exclusive fixture lease explicitly covering the owned Chunkbot kick/reconnect and online dummy inventory/effect cleanup, in addition to the existing owner controls/teleports. No worker lease exists. The original footprint is unchanged: overworld teleport destinations x1700..2400/y-60/z1700..2300, nether (0.5,128,0.5), bot motion x1600..2500/z1600..2400, plus only the pre-existing exact recorded bot-origin restoration. No block, difficulty, gamerule, time, bed, respawn or force-load write, foreign-entity removal, live join, deployment, push or PR is added.

Worker: native Claude Opus 5.5 (local DSH), branch `chunkbot/mb-loc-001`, base `f05628f`. Status: **new modules, contracts, tests and gate harness implemented and verified offline. Pre-integration module gates G1/G2/G3/G5 passed 19/19 on 26.2 (`batch002-locator-262-gates-01`) and 26.1.2 (`batch002-locator-261-gates-01`); the C5 observed-geometry labels (`2fb02f6`, reapplied in `ef78a84`) passed 26.2 gates 19/19 (`batch002-locator-262-gates-02`); 26.1.2 for `ef78a84` is still to be rerun.** Shared-hook integration (H1–H6), ordinary-follow regression, root gates and real Codex/Jev L7 are pending. No provider call has been made. Not accepted.

## Commits

| SHA | Content |
| --- | --- |
| `b894867` | Initial locator/route contract |
| `b323883` | C1 contract revision (integrated in root as a dependency milestone) |
| `9bd2b3c` | Codec gate, locator service, route controller, runner, skills, codec/service tests |
| `c99517b` | Route/runner/skill integration tests; destination dedupe |
| `5623f12` | C2/C3 contract additions (`RouteAdmissionProof`, `EffectiveTravel`, `FrozenOwnIncident`, `RoutePort.effectiveTravel`) |
| `05cf424` | C2/C3 fixes and reproductions |
| `c7c5c84` | Import-safe, lease-guarded gate harness + guard test |

Owned paths only: `src/contracts/locator.ts`, `src/locator/*`, `src/skills/locator.ts`, `tests/locator-*.test.ts`, `scripts/locator-live-check.ts`, this file. No shared file is edited.

## Official-source gate (static, read-only)

Codex granted read-only class parsing of the pinned official jars (`var/source-probes/server-26.1.2.jar`, `server-26.2.jar`). A throwaway disassembler outside the repository parsed the class files; nothing from the jars was executed. Findings (identical in both versions except where noted):

- **Codec.** `ClientboundTrackedWaypointPacket` uses operations track/untrack/update. Untrack is built as `TrackedWaypoint.empty(uuid)`. The pinned `packet_tracked_waypoint` definition (clientbound `0x8a`) is canonical-JSON identical in installed minecraft-data 26.1 and 26.2.
- **Variant selection** (`LivingEntity.makeWaypointConnectionWith`):
  - no connection on the source's first tick or for itself;
  - no connection when distance ≥ min(source `waypoint_transmit_range`, receiver `waypoint_receive_range`), when the source is a spectator, or when it has the receiver as an indirect passenger;
  - **azimuth** when distance > 332 (`REALLY_FAR_DISTANCE`);
  - otherwise **chunk** when the source chunk is outside the receiver's chunk-tracking view distance;
  - otherwise **vec3i** with the source's block position.
- **Azimuth convention.** The angle is `Mth.atan2(v.z, v.x)` where v = (receiver − source) rotated clockwise 90°, i.e. `atan2(dx, −dz)`. This is a Minecraft yaw of the direction from receiver to source, which is exactly `azimuthToVector` in `src/locator/geometry.ts`.
- **Updates.**
  - Block connection: update when the source block position changes; it breaks (reconnecting with a new track) when moved more than 1 Manhattan block between updates.
  - Azimuth: update when the angle changes by more than 0.5°.
  - Transmitter movement (`Entity.setPosRaw`) triggers `updateWaypoint`; receiver chunk moves trigger `updatePlayer`.
  - A stationary owner reached at block or chunk precision therefore gets no further packets. A tracked statement stays current by protocol semantics; the `hintMaxAgeMs` default (120 s) is only a safety bound.
- **Hiding.**
  - `isTransmittingWaypoint` is true only when `waypoint_transmit_range` > 0. Players default to transmit/receive range 6.0e7.
  - Crouching applies the `waypoint_transmit_range_crouch` modifier (−1 × total).
  - The invisibility effect applies `effect.waypoint_transmit_range_hide` (−1).
  - Head-slot items use `Waypoint.addHideAttribute` with modifier `waypoint_transmit_range_hide` (−1).
  - Any change to the attribute calls track/untrack.
- **Rule.** Gamerule id is `locator_bar` (default true). A change calls `MinecraftServer.onGameRuleChanged`, which runs `breakAllConnections` (untrack).
- **Lifecycle.** Entity removal or a dimension change calls `untrackWaypoint` (untrack sent to all receivers). Receiver tracking end calls `removePlayer`.
- **26.1.2 vs 26.2.** The transmitter, all connection classes and `ServerWaypointManager` are byte-identical. `LivingEntity` and `ServerPlayer` waypoint methods disassemble identically. `Waypoint.class` differs only by an extra `MAX_RANGE` field in 26.1.2.

Static evidence does not prove runtime broadcasts. Gates L-G1/L-G2 remain required.

## Design delivered

- **Codec gate and decoder** (`src/locator/codec.ts`):
  - Locator perception is admitted only when the installed protocol definition is canonical-equal to the verified one; otherwise it fails closed (`unsupported_codec`).
  - The pinned mapper passes unknown operation/variant ids through as raw numbers. The decoder rejects them, along with malformed identities and out-of-range payloads.
- **Locator service** (`src/locator/service.ts`):
  - **Owner-only.** The configured UUID requires a verified online-mode connection. The trusted offline fixture requires the exact name's derived UUID AND that exact name listed by the server. String ids, other UUIDs, icon colour and packet order never grant identity. Positions are retained only for the owner candidate; others are counts.
  - **Scoping.** Statements are scoped to the delivering client's connection epoch and to the login/respawn generation. Death, respawn, dimension change and ended lifecycle events void them; a late packet from an old client is ignored.
  - **Hint content.** The hint carries only sector, distance band (when the variant justifies it, including chunk uncertainty), elevation (block precision only), precision, age/expiry, epoch and dimension.
  - **Telemetry.** Records transitions and counts only.
- **Routes** (`src/locator/routes.ts`):
  - One frozen authorization per NEW goal epoch; repeated or older epochs are refused.
  - Ceilings are fixed at admission. The deadline is the earlier of admission + `maxRouteMs` and the goal deadline.
  - Cumulative own-movement distance (C1). Stall detection uses net progress.
  - Exact-match leg bounds, terminal revocation, and destination provenance (owner-typed coordinates recorded for the goal; own-incident provider with frozen identity).
- **Runner and skills** (`src/locator/route-runner.ts`, `terrain.ts`, `src/skills/locator.ts`):
  - `seek_owner` and `route_travel` are sustained windows.
  - A visible owner takes over from any cue: the position is read only while visible, and proximity is verified from the bot's own position.
  - Locator bearing and code-owned destinations only rank safe local frontiers. A new counted leg is used only when the bound, not the terrain, limits progress.
  - Specific blockers: `hazard_lava` (seen voxels only), `cliff_drop`, `wall`, `water_crossing`, `unloaded_terrain`, `vertical_separation`, `no_safe_frontier`.
  - A withdrawn or expired cue stops advancing. No digging, placing, towering or doors.

## Coordinator corrections

- **C1** (`b323883`): cumulative own movement with labelled sources; deadline fixed at admission; monotonic admission; exact-match legs carrying the admission anchor; `route_travel` provenance checked in both resolver and executor.
- **C2** (`05cf424`):
  - `legBounds` and the new canonical `effectiveTravel(admissionProof)` return a leg only while the route is `leg_active`, before its deadline, under the distance ceiling and with an exact proof match. Otherwise the original admission bound applies.
  - Reproduced finding: the 0→16→0→16→0 loop with max 64 leaves the route exhausted, and `legBounds` is now undefined.
  - `attachMovement` no longer reads raw journal x/z. It samples the resolved own position on Mineflayer `move`, and relabels the move that `forcedMove` synchronously follows as a server correction. The pinned physics handler applies per-axis relative flags, then emits `move` (in `sendPacketPositionAndLook`), then `forcedMove`; a test checks this order against the installed source.
  - Proven: zero-relative correction counts 0; mixed-axis correction counts its resolved delta once; a true correction counts once; detours count; runner re-sampling adds nothing; a stray `forcedMove` relabels nothing.
- **C3** (`05cf424`):
  - The whole own-incident identity (id, dimension, position, recorded time) is frozen at first use. Reproduced finding: the same `mf-0001` moved from x20 to x40 is now `destination_changed`.
  - `route_travel` fixed targets carry a `recheck` that runs before every runner step and on every movement poll. A changed or missing incident stops movement at the next poll; this is tested.
  - The runner takes a goal-owned admission proof, never `perception.travelBounds` after H2. `admissionProof()` uses the requested `perception.admissionBounds()` when installed. Before that, it accepts `travelBounds()` only when the anchor is goal-owned and equals the frozen authorization anchor/radius. There is no relaxed fallback.

## Shared hooks requested (designated writer; via Codex)

| Hook | Request |
| --- | --- |
| H1 | `MineflayerConnection.onClientCreated(listener({client, connectionEpoch, version}))`, called synchronously after `createBot`, before login. Composition then calls `locator.attach(client, epoch)`. |
| H2 | `PerceptionOptions.routeTravel?: (proof: RouteAdmissionProof) => EffectiveTravel`, plus a new `PerceptionService.admissionBounds(): RouteAdmissionProof \| undefined` that returns the goal-owned admission anchor/radius/epochs and never a leg. `travelBounds()`/`withinTravel()` return `routeTravel(admissionProof)` for goal-owned anchors on every call, so all skills' navigation polls honour withdrawal on exhaustion, expiry or blocking. `locatorHint?: () => LocatorHint` fills `snapshot.locator`. `perception.travel.{admissionAnchor, route}` in observation; planner `renderObservation`; Jev `snapshotSummary`. |
| H3 | Compose `LocatorService` and `RouteController` (`ownDeath` = survival provider when present). Register `locatorSkills({locator, routes})`. On admission, call `routes.admit({... source, goalDeadlineMs, ownerCoordinates})`; on clarification answers, `routes.noteOwnerCoordinates`; on goal terminal, `routes.revoke`. Lifecycle goes to `locator.onLifecycle` + `routes.revoke`. On ready, call `routes.attachMovement(session, goalEpoch)`. Status lines in `statusExtras`. |
| H4 | `export * from './locator.ts'`; `locator: LocatorConfigSchema.optional()`; existing harnesses set `locator.routes.enabled: false`. |
| H5 | `PlannerRequest.route` / `ProposalContext.route = routes.proposalContext(ctx)`. `checkProposal` rejects `route_travel` without authorization and `destination:"own_death"` unless authorized and `ownDeathAvailable`. One planner paragraph. |
| H6 | Later: whitelisted dashboard projection of `RouteStatus`/`LocatorHint`. |

## Checks (direct exits, worktree `mb-loc-001`, Node 24.21.0)

- `npm run typecheck`: 0. `npm run build`: 0. `npm test`: 0, **562/562**. This includes 79 locator tests across 6 files:
  - `locator-codec`: pinned serializer/deserializer round trips for 26.1.2/26.2 and the fail-closed gate;
  - `locator-service`: attribution, variants, hiding, expiry, lifecycle, connection scoping, no-coordinate telemetry;
  - `locator-routes`: C1/C2/C3 ceilings, sampling, freezing, scope;
  - `locator-runner`: scripted official-variant server, reunion beyond 128 through legs, withdrawal, blockers, ceilings, revocation, provenance stops, proof mismatch;
  - `locator-skills`: real catalog/wire/proposal check/perception/candidate generator, executor provenance, admission proof;
  - `locator-harness-guard`: import safety and lease refusal.
- No doctor, live-check or fixture harness was run (no lease).

## Fixture gate request (not run)

Command, from a frozen build of this branch with an independent data directory (reports go to `var/live-check/<stamp>[-26.2]-locator/`):

- 26.2: `node scripts/locator-live-check.ts --fixture-lease <id> --fixture 26.2 --gates g1,g2,g3,g5 --approve-rules <id> --approve-scene <id>`
- 26.1.2 broadcast sanity: `node scripts/locator-live-check.ts --fixture-lease <id> --gates g1`
- Ordinary-follow regression: existing `npm run skills-live-check` (the code path is unchanged; seek defers to follow when the owner is visible).

What each gate does:

| Gate | Behaviour |
| --- | --- |
| G1 | Controlled offline `FixtureOwner` and `FixtureGuest`. Owner moved by RCON `tp` to the vec3i, chunk and azimuth distances (view distance read from the fixture properties). Above-elevation case uses slow falling. Hiding cases: crouch, invisibility effect, carved pumpkin, logout/rejoin. Dimension case: owner, then bot, to the nether bedrock roof (0.5, 128, 0.5) and back. |
| G2 | Needs `--approve-rules`. `gamerule locator_bar` false then the original value; `attribute FixtureOwner minecraft:waypoint_transmit_range base set 30` then `base reset` (receive range reset too). Restored in `finally`. |
| G3 | Owner 300 blocks east (+40 z) of base (1000.5, −60, 1000.5); `seek_owner` windows run through the real executor; reunion checked from RCON server positions. No block writes. |
| G5 | Needs `--approve-scene`. Lava, wall and >3 drop scenes, each restored. |

**Footprint (MB-LOC-001-C4; declared in `LOCATOR_FOOTPRINT`/`TELEPORTS`, enforced before every RCON teleport):**
- Overworld teleport destinations: x 600..1301, y −60..−46, z 958..1201. The named destinations are base (1000.5, −60, 1000.5); owner at east 40, south 200 (z 1200.5), west 400 (x 600.5), north-east 60 (z 958.5), elevated +14 (y −46), 24/26/28/30/60/61/62 east, G3 (+300, +40); guest west 30; scene bot/owner (1004.5 / 1038.5, −60, 1120.5).
- Nether: (0.5, 128, 0.5), standing on the bedrock roof, for the owner and then the bot.
- G3 bot envelope: seeking is aborted if the bot leaves x 900..1400, z 900..1140.
- G5 writes only x 1000..1040, y −64..−50, z 1100..1140. The read-only reference region is x 1060..1100 (same y/z). The skills scene is never touched.

**G5 baseline and restoration:**
- **Expected baseline.** `scripts/fixture.ts` sets `level-type=minecraft:flat` with no generator settings. The official 26.2 `FlatLevelGeneratorSettings.getDefault` gives 1 bedrock, 2 dirt and 1 grass_block, so bedrock −64, dirt −63..−62, grass −61, air above.
- **Check before any write.** The scene and the reference region are probed per layer at three columns, then compared with one `execute if blocks … all`. If either check fails, G5 fails without writing anything.
- **Restoration.** Every scene layer is rewritten (bedrock, dirt, grass, then air from −60 to −50) and re-verified with the same probes and comparison.
- **Failure handling.** Any restoration or verification failure fails the whole report (`restoreFailures` plus a `RESTORE` result), not just a warning.

**Pre-integration label:**
- The harness's route runner uses explicit admission-proof/leg bounds, so it can prove only its own movement.
- The production all-skill travel guard requires progression's H2 `effectiveTravel` wiring.

**Setting changes and logging:**
- Changes are limited to owner/bot effects, the owner's head item, gamerule `locator_bar`, and the waypoint range attributes, all restored in `finally`.
- Every RCON command is recorded in the report.
- Packet evidence records operation, variant and attribution class only. Setup `tp` commands for the harness-controlled fixture players necessarily carry their positions; no waypoint coordinates are logged.

## Known gaps

- **Fixture gates.** L-G1/L-G2/L-G3, negative routes, 26.1.2 sanity and real Codex/Jev L7 have not run.
- **Late attach.** Pre-H1, the harness attaches the locator after `ready`, so join-time tracks can be missed (reported as `late`). Each scenario moves the owner to produce fresh statements.
- **Elevation.** Only above/level are exercised live (below needs a block-changing scene).
- **Ordinary skills.** They honour route ceilings only once H2 makes perception travel bounds consult `effectiveTravel` on every call; this module cannot change their code.
- **Distance overshoot.** After distance exhaustion, a bot outside the admission radius is honestly out of bounds for ordinary skills. Cumulative distance can exceed the ceiling by at most the movement between two samples (one physics tick, or one runner poll).

## 26.2 module gate runs (lease `batch002-locator-262-gates-01`; rules `batch002-locator-262-rules-01`; scene `batch002-locator-262-scene-01`)

Run as the same driver with Node 24.21.0:

```
node scripts/locator-live-check.ts --fixture-lease batch002-locator-262-gates-01 --fixture 26.2 --gates g1,g2,g3,g5 --approve-rules batch002-locator-262-rules-01 --approve-scene batch002-locator-262-scene-01
```

Run conditions:
- Each run used a source freeze with clean HEAD, and `npm run typecheck`/`build`/`test` exited 0 at that HEAD before running.
- The harness runs from `src` (TS); the build matched the same HEAD.
- Fixture: 26.2 at 127.0.0.1:25567, view-distance 6. Fake players only (Chunkbot, FixtureOwner, FixtureGuest), all disconnected in `finally`.

| Run (report under `var/live-check/`) | Source | Exit | Result |
| --- | --- | --- | --- |
| `2026-10-07T02-11-21-880Z-26.2-locator` | `fef8ed3` | 1 | 18/19. G1, G2 and G3 passed. **G5 invalid: MB-LOC-001-C5.** Restorations verified. |
| `2026-10-07T02-15-17-487Z-26.2-locator` | `bce707f` | 1 | 13/19. G5 valid and passed (contact/damage/death monitored). **G1 oracle unproven: MB-LOC-001-C6.** Restorations verified. |
| `2026-10-07T02-19-17-753Z-26.2-locator` | `7b28c90` | **0** | **19/19.** `restoreFailures` empty. Bot placement verified on the first attempt. |

**MB-LOC-001-C5** (harness scene geometry):
- **Cause.** `SCENE_BASE` x 1004.5 put the bot inside the obstacle columns, which start at x 1003. The drop scene also removed bedrock, leaving a void hole.
- **Consequence.** Run 1's G5-lava and G5-drop passes are invalid evidence, and its G5-wall failure (`no_safe_frontier`) is not a code finding.
- **Possible death.** The bot may have died in the void. That run did not record lifecycle events, so this is unknown.
- **Fix (`bce707f`).**
  - The bot starts at x 1000.5 and the owner at x 1034.5 on intact ground.
  - The drop is a 5-high stone platform inside the scene box; bedrock is never removed.
  - Each scene monitors obstacle contact, health and death.
  - Accepted outcomes: the specific blocker or a safe detour.

**MB-LOC-001-C6** (harness oracle assumption):
- **Symptom.** Run 2 received azimuth for a 40-block owner offset, and the cue disagreed with the assumed base position. The bot's server position was therefore not at base when the oracle assumed it was. Probable cause: the run-1 void death respawned the bot after its teleport.
- **Guest attribution.** The guest UUID was registered after the guest's join, so its join-time track packet was misattributed.
- **Fix (`7b28c90`).**
  - Wait until the bot is alive.
  - Verify the bot's server AND client position at base (bounded retries).
  - Record a lifecycle log.
  - Compute expected variants and sectors from SERVER positions of both players using the official rule (border cases accept either variant).
  - Register the guest UUID before its join.

**Final run 19/19 evidence** (from the report: counts, classes and relative offsets only):

- **Variant and cue checks:**

  | Owner position relative to bot | Server statement | Cue |
  | --- | --- | --- |
  | 40 east (3 chunks) | `track:vec3i` | east, near, level, block precision |
  | 200 south (13 chunks > view distance 6) | `track:chunk` | south, far, height unknown, chunk precision |
  | 400 west (> 332) | `track:azimuth` | west, distance/height unknown, direction only |
  | north-east 59.4 | `vec3i` | north_east |
  | 13.8 above | `vec3i` | elevation above |

- **Other G1 checks:**
  - The guest's waypoint was received and counted as other. The owner cue was unaffected.
  - Crouch, invisibility and carved pumpkin each produced `untrack` (no direction), and restoring produced `track`.
  - Logout gave `untrack` (identity no longer listed); rejoin needed a fresh `track`.
  - Owner moving to the nether roof gave `untrack`. The bot moving to the nether recorded `dimension_change` and voided statements. Returning restored tracking.
- **Packets:** 43 recorded:

  | Class | Count |
  | --- | --- |
  | owner `track` vec3i / chunk / azimuth | 21 / 6 / 1 |
  | owner `update` vec3i | 1 |
  | owner `untrack` | 8 |
  | guest `track` vec3i / chunk | 3 / 1 |
  | guest `untrack` | 2 |

- **G2:**
  - `locator_bar` false gave `untrack` (no direction); the original value (`true`) was restored and gave `track`.
  - Owner `waypoint_transmit_range` 30 at 60 blocks gave `untrack` (range-limited); after reset it gave `track`.
  - The attribute was reset to its default 6.0E7 in `finally`.
- **G3:**
  - The owner was 300 blocks east and 40 south, beyond the 128 admission radius. Run through the real executor, `seek_owner` took window 0 as `route_window_elapsed` (leg 1, 110.9 route blocks), then window 1 `owner_reached` (leg 2/12, 206 of 1024 blocks, 0 corrections).
  - The server-measured bot–owner distance was 2.2. The admission anchor was unchanged. No in-trial assistance.
- **G5:**
  - **Baseline:** the scene equalled the flat baseline and the reference region before any write (probes plus `execute if blocks`).
  - **Lava:** a safe detour around the band to the owner (`owner_reached`), with no contact, no damage and no death.
  - **Wall:** the specific `wall` blocker, with the bot not moved.
  - **Drop (platform):** the specific `cliff_drop` blocker, with the bot not moved.
  - **Restoration:** after every scene, all layers were rewritten and verified. During the wall scene, 3 grass blocks under the stone turned to dirt; this is vanilla behaviour, and they were restored and verified.
- **Footprint:** all teleports went through the checked helper inside the declared footprint. Final cleanup restored the scene, the attribute, the gamerule and the owner's effects/head, and disconnected all fake players. No harness process remains.

**Scope of this evidence:**
- This is pre-integration module evidence. The harness composes the real connection, perception, executor and lease, with the locator attached late (pre-H1).
- The route runner's explicit bounds prove only its own movement. The production all-skill guard needs H2 `effectiveTravel`.
- Still open: 26.1.2 broadcast sanity plus an ordinary-follow regression, root gates after H1–H6, and real Codex/Jev L7.

## 26.1.2 broadcast sanity and module gates (lease `batch002-locator-261-gates-01`)

Run from frozen `7b28c90` (HEAD `57ac58d` differs only in this document); default 26.1.2 fixture (127.0.0.1:25566, view-distance 6). Rules approval `batch002-locator-261-rules-01`, scene approval `batch002-locator-261-scene-01`.

```
node scripts/locator-live-check.ts --fixture-lease batch002-locator-261-gates-01 --gates g1,g2,g3,g5 --approve-rules batch002-locator-261-rules-01 --approve-scene batch002-locator-261-scene-01
```

**Result:** exit **0**, **19/19**. Report: `var/live-check/2026-10-07T02-22-35-525Z-locator/report.json`.

- **Codec:** 26.1.2 codec verified.
- **Variants:** the same official-rule variants were observed from server positions — 40 east block position, 200 south chunk, 400 west azimuth, north-east block position, above block position.
- **Withdrawals:** guest attributed as another player; crouch, invisibility, pumpkin and logout withdrawn and restored; dimension changes voided statements.
- **G2:** `locator_bar` and range behaviour matched 26.2.
- **G3:** two legs, 206.2 of 1024 route blocks, server distance 2.2.
- **G5:** lava detour, `wall`, `cliff_drop`; no contact, damage or death.
- **Packets:** 44.
- **Cleanup:** `restoreFailures` empty, every restore verified, all fake players disconnected, no harness process remaining.

This is broadcast and module evidence only. The **ordinary-follow regression** (`npm run skills-live-check`, unchanged `follow_entity`/`move_near` code) was NOT run by this worker; it needs its own lease.

## Report index

| Report | Fixture | Source | Exit | Status |
| --- | --- | --- | --- | --- |
| `var/live-check/2026-10-07T02-11-21-880Z-26.2-locator` | 26.2 | `fef8ed3` | 1 (18/19) | **Original, retained.** G5 invalid (C5 geometry); the wall label there was `no_safe_frontier`. |
| `var/live-check/2026-10-07T02-15-17-487Z-26.2-locator` | 26.2 | `bce707f` | 1 (13/19) | G5 valid; G1 oracle unproven (C6). |
| `var/live-check/2026-10-07T02-19-17-753Z-26.2-locator` | 26.2 | `7b28c90` | 0 (19/19) | Module gates passed. |
| `var/live-check/2026-10-07T02-22-35-525Z-locator` | 26.1.2 | `7b28c90` | 0 (19/19) | Module gates passed. |
| `var/live-check/2026-10-07T02-30-37-871Z-26.2-locator` | 26.2 | `ef78a84` | 0 (19/19) | Observed-geometry labels certified on 26.2 (lease `batch002-locator-262-gates-02`). |

## MB-LOC-001-C5: observed-geometry blocker labels (`2fb02f6`; reverted `96ed4ad`; reapplied `ef78a84`)

**What changed.**
- `classifyBlocker` names `wall`, `cliff_drop`, hazard and water only from voxels in the current line-of-sight observation. The world view is read only for chunk loadedness; a content-read spy test proves this.
- Columns with nothing observed are labelled `unobserved_terrain`.
- The original run-1 wall scene stays recorded as INVALID geometry, separately from this code finding.

**History.**
- The change was reverted once (`96ed4ad`) on an earlier coordinator note.
- The coordinator then reviewed it as within C5 scope and asked for it to be certified, so it was reapplied (`ef78a84`).

**Live evidence for `ef78a84`.**
- **Freeze:** clean HEAD; typecheck, build and test exit 0 (569/569).
- **26.2 gate:** lease `batch002-locator-262-gates-02`, approvals `batch002-locator-262-rules-02` / `batch002-locator-262-scene-02`. Exit 0, 19/19. Report: `var/live-check/2026-10-07T02-30-37-871Z-26.2-locator/report.json`.
- **Labels from the new code:**
  - wall scene: `wall` — "an observed wall or rise higher than one block toward east";
  - platform scene: `cliff_drop` — "an observed drop deeper than 3 blocks";
  - lava scene: a safe detour to the owner.
  - No contact, damage or death in any scene.
- **G1–G3:**
  - G1 variants, sectors and withdrawals matched the 7b runs.
  - G2 gamerule and range checks passed.
  - G3: two legs, 206.2 of 1024 route blocks, server distance 2.2, admission anchor unchanged.
- **Packets:** 43.
- **Cleanup:** `restoreFailures` empty, every restore verified, all fake players disconnected, no harness process left.

**Pending:** 26.1.2 has not been rerun for `ef78a84`. Its last 26.1.2 evidence certifies `7b28c90` only.

## LOC-C3/H2 test adaptation (`tests/locator-skills.test.ts`)

**Why it changed.** The combined build `0b48e4c` installs the REAL `PerceptionService.admissionBounds()` (P `c704ad4`). The old pre-H2 test assumed no accessor existed.

**Pre-H2 fallback test.**
- Uses a documented stub perception without the accessor.
- `travelBounds` counts as a proof only when the anchor is goal-owned AND equal to the frozen route authorization anchor and radius.
- A moved anchor, a different radius, another epoch or a diagnostic anchor gives no proof.

**H2 test.**
- Uses the real accessor when present, else a test-local stub of its documented contract.
- Proofs are scoped exactly to goal epoch, connection and dimension.
- A simulated leg in `travelBounds` never becomes the proof.
- A live leg applies only to the matching proof (`route_leg`).
- A moved anchor in the same epoch is reported by the accessor, but gets `proof_mismatch`, so there is no leg authority.
- A diagnostic anchor gives no proof.

**Verification.**
- **Own checkout:** typecheck, build and test exit 0.
- **Combined build:** the same test file was also run read-only against an exported snapshot of `0b48e4c` with the real accessor present. `locator-skills` passed 10/10 and all locator test files passed 67/67. The scratch export was removed afterwards.

## Ordinary-follow seam recommendations (for the progression writer; no shared file edited)

1. **Planner guidance (H5).** For owner-following and "come to me" instructions, the maintain/complete task should allow `seek_owner` alongside `follow_entity`/`move_near`. Jev can then switch to locator seeking when the owner leaves sight (`follow_entity` ends `target_lost`), with no planner turn. `seek_owner`'s resolver already declines (`owner_visible`) whenever the owner is visible inside the bound, so ordinary visible following is unchanged.
2. **Travel guard (H2).** `follow_entity` and `move_near` check `perception.withinTravel` on every poll. Once `travelBounds()` returns `routes.effectiveTravel(admissionBounds())`, they operate inside a live leg after `seek_owner` begins one. They fall back to the unchanged admission bound as soon as the route is exhausted, expired, blocked or revoked (C2).
3. **Persistent follow.** Keep `near_target owner` (visible-now) as the maintained predicate. A locator cue never satisfies it. A route leg does not end the persistent task, and route ceilings bound the seeking.
4. **Loss reporting.** When `seek_owner` reports `no_actionable_hint` or `hint_withdrawn`, surface the hint reason in status/feedback (untracked, expired, disabled, dimension). Do not replay old cues.
5. **26.1.2 regression.** Run the root `skills-live-check` and ordinary-follow scenarios after integrating H1–H6, so the shared wiring is proven not to alter visible following.

L7 (real Codex/Jev choosing these tasks from the shared catalog) and the production all-skill guard remain undelivered. The module harness's executor runs are not L7 evidence.
