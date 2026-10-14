# Oct 13 shared integration worker

Status: shared-core milestone implemented and checked offline; contract review
and companion integration are externally blocked. The complete managed update/
vanilla-control outcome is unfinished. No acceptance, deployment or running
gameplay claim is made.

Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-integration`.
Branch: `chunkbot/batch-20261013-integration`.
Common base: `2b9255c25e75519c06c94602d5ac60224a3c0521`; initially clean.

Native metadata (selected fields only): thread
`01a13844-0073-7f13-b8bf-a1e2f637567e`, origin `dsh_provider_codex`, CLI
`0.162.1`, actual cwd as above, model `gpt-6.1-sol`, effort `xhigh`, sandbox
`danger-full-access`, approval `never`. Coordinator's current read-only native
App Server ChatGPT/prolite gate is retained; no account refresh, login or model
inference was performed here. Gameplay planner settings are unchanged.

## Proposed contract milestone

Canonical public types are [releases](../../src/contracts/releases.ts) and
[server controls](../../src/contracts/server-controls.ts), exported by the
[existing barrel](../../src/contracts/index.ts).

- `ReleaseArtifactPort.verify(directory): Promise<VerifiedRelease>`: complete
  regular-file inventory, source/lock/vendor/manifest digests, Node 24, supported
  versions, checkpoint compatibility and independent acceptance receipt.
- `SessionCheckpointPort.load(sessionId)` and
  `save(checkpoint, expectedRevision)`: compare-and-swap durable session intent,
  scope, control generation, pause latch, semantic directive and accounting.
- `AccountingJournalPort.commit(accounting): void`: synchronous durable write
  before dispatch. Unknown reservations restore conservatively as retained.
- `ManagedChildLauncherPort.launch(input, signal)` returns one fenced
  `ManagedChildPort`: readiness, drain, stop, termination proof and announcement.
- `ManagedChildAppPort`: application-side readiness/drain/stop/logout/announce.
- `ReleaseManagerPort`: status/start/logout/stop/offer/rollback. No gameplay,
  player-supplied artifact path, vault access or arbitrary shell hook.
- `ServerControlBridgePort.start(target, signal)/close/status`, with the single
  `ServerControlTargetPort.handle(request)` consuming UUID-verified, scoped,
  fresh, generated on/off/status requests. A typed field alone is not identity
  proof: the bridge owns authoritative server verification.

`SemanticDirectiveCheckpoint` deliberately excludes old connection/session/
interruption epochs, including route connection/goal epochs. It preserves the original outcome, admission baseline,
travel anchor, counters/caps/deadline and verified lineage as non-executable
data. Unsupported continuation stays visibly interrupted; no fresh-baseline
resubmission. Core export and startup display-only import now exist; durable
schema validation/storage/accounting and compatible executable continuation
still require the canonical companion checkpoint implementation.

Companion contracts/imports require coordinator approval of exact SHAs. No
companion commit is imported at this milestone. The core needs a reviewed
`SpendLedger` export/restore/durable-before-dispatch seam in
`src/decision/spend.ts` plus decision attempt/disabled-state restoration in
`src/decision/jev-adapter.ts`; those paths are outside this worker's narrow
ownership until the coordinator grants them or supplies accepted commits.
No replacement ledger or private companion module will be added.

## Checks and boundaries

Checks use Node `/opt/homebrew/Cellar/node@24/24.21.0/bin` first and the
coordinator's two-slot stdlib guard. Logs stay under ignored
`var/offline-integration/`.

Contract typecheck first run: **exit 1**, wrong `ControlLatch` import;
`contracts-typecheck.log` retained. Corrected typecheck: **exit 0**,
`contracts-typecheck-r2.log`. Diff whitespace check: **exit 0**.

All world/provider/live-update/control acceptance is deferred to the
coordinator: fixture leases are absent on both versions, no key injection is
authorized, no source is registered as a release and no child has been launched.
Accepted playing artifact `64e2609` is separate and untouched.

## Shared-core delivery and entry points

Initial contract commit: `bef8f471a4ecf258724aeea148fec4bb38f3eb7d`.
The follow-up source commit adds the core below and amends the proposed contract
to use the existing `MemoryScopeSchema`, retain both discarded preparation turns
and their original ceiling, and remove executable route epoch grants.
Neither proposed contract revision has coordinator approval yet.

- `GoalEngine.drainForUpdate()` closes admission synchronously when accepted,
  withdraws safety authority and revokes the existing task/planner ownership.
  Finite owner work, pending newer owner intake and non-groundable persistent
  outcomes defer with current work intact. Updates use `update_interrupted`,
  never completion or owner stop. A later stop discards the older drain's saved
  directive and retains the pause latch.
- `cleanupProof()` tracks actual cleanup tails, rejected cleanups and planner
  tickets beyond timeout wrappers. A timeout or unresolved interface/prediction
  cannot authorize replacement. A later actual settlement/server confirmation
  can prove drain without replaying work; rejected cleanup remains a blocker.
- `restoreInterruptedUpdate()` is startup-only, non-executable and clone-isolated.
  Status/chat/dashboard show the interrupted intent. Stop/resume do not silently
  replay or erase it; invalid intake cannot supersede it. Unrelated progression
  is blocked; typed necessary support may serve the retained owner intent.
- `handoffBudget()/restoreHandoffBudget()` preserve consumed discarded-turn
  allowance and its original ceiling. Restore never decreases usage or enlarges
  the cap, and cannot overwrite a running/newer session.
- `ChunkbotApp.drainForUpdate()` also cancels diagnostics and closes/waits for
  owned safety control. `SkillRuntime.releaseDrainProof()` checks the existing
  lease, clear errors, interface gate, current window, prediction journal and
  safety settlements. It sends no reconciliation action.
- The actual [CLI factory](../../src/cli.ts) is exported and import-safe on the
  pinned Node 24 runtime. `buildApp(loaded, false, { autonomy, managed: { fence,
  scope } })` constructs the existing single app, planner slot, task runtime,
  registry, executor/actuator and per-process SpendLedger, and returns a
  `ManagedChildAppPort`. It also exposes `disposed` for the existing final
  supervisor/survival/memory/dashboard teardown. Default `run` remains the same
  entry point. The managed target uses the real
  [readiness probe](../../src/app/release-readiness.ts): current scoped identity,
  distinct bot UUID, spawn, correlated inventory, same-epoch/dimension filtered
  observation, actual registered catalog and provider readiness. No model/auth
  refresh/world diagnostic is called. Notices are deduplicated and use the
  configured owner reply channel; queued is explicitly not delivery proof.
- `serverControlTarget()` is a privileged internal bridge consumer of the ONE
  proposed manager port. It checks schema, exact owner/world/bot/control scope,
  current TTL and duplicate/generation fences; off reaches the manager during
  an older pending on and wins ambiguous same-generation on/off. A late older
  receipt is rejected. This does not replace the bridge's server UUID proof or
  the manager's real process/socket ownership policy.

The current-process factory target is **not a managed restart/promotion CLI**.
Normal `buildApp` still creates its ordinary per-process SpendLedger. It must
not be used to replace a logical managed session until the approved checkpoint
host restores and durably journals that same canonical ledger, Jev attempts/
disabled state, preparation and supervisor allowances before dispatch.
No private ledger/checkpoint/manager/bridge substitute was created.

## Final offline validation

All commands used the published two-slot guard with this exact worktree and
Node24 first. The final source was unchanged throughout these checks.

| Command | Direct exit / evidence |
| --- | --- |
| `npm run typecheck` | **0**, `delivery-typecheck.log` |
| `npm run build` | **0**, `delivery-build.log` |
| `npm test` | **0**, **1,679/1,679**, `delivery-full-tests.log` |
| `node --test --test-reporter=spec tests/batch20261013-integration.test.ts` | **0**, 14/14 at the preceding source milestone; the final full suite includes all 14, `drain-recheck-focused.log` |
| `npm run doctor -- --config config/examples/fixture.json` | **1**, `doctor-26.1.2.log`; installed gameplay executable is 0.162.1, required pin is 0.160.0 |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | **1**, `doctor-26.2.log`; same version mismatch |
| `git diff --check` | **0** |

Doctors ran with `OPENROUTER_API_KEY` and `BW_SESSION` unset. They made no
Minecraft connection/model inference/login refresh. Both fail closed at the
unchanged gameplay CLI pin; `/opt/homebrew/bin/codex` resolves 0.162.1. The
coordinator must supply the authorized isolated 0.160.0 executable/environment
for a later rerun. Development's native 0.162.1 route is separate and unchanged.
Missing worktree fixture/JRE data are warnings, not permission for setup.

Retained failures: first contract typecheck **1** (wrong `ControlLatch` import),
corrected **0**; `composition-effects-focused.log` **1**, 12/13 (test harness used
`evidence.sequence` instead of actual `evidence.seq`), corrected 13/13 **0** in
`composition-effects-focused-r2.log`. Earlier core full suite **0**, 1,676/1,676,
is an intermediate-source pass in `composition-full-tests.log`, superseded by
the final source check above. No unchanged failure/pass was repeated as acceptance.

Adverse cases cover finite deferral, synchronous admission closure, uncooperative
planner settlement, rejected cleanup, late stop, uncertain server effects,
startup checkpoint supersession, unchanged preparation caps, actual production
composition without connection/inference, stale readiness/notice deduplication,
spoofed scope/session, stale/altered requests, duplicate on and on/off races.
These are offline tests, not U1–U6/C1–C6 world acceptance.

## Provenance and remaining dependency boundary

Node: `v24.21.0`; npm: `11.19.0`. Own `node_modules` remains the preparation
install. Build output is only this worktree's `dist`; no process runs that build.

Tree digests (SHA-256 of sorted relative path + NUL + hex SHA-256(file bytes) +
newline; receipt `var/offline-integration/digests.json`):

- `src/`, 179 files: `df029b30e6ff9ce94f76e88efcd4714fe9f429464f333155d3e0b49e2547098a`.
- `dist/`, 358 files: `2de053a50cfa42f8ff2e245ca4896e51c5190e5abb22afbcbcf1dfe61845b65f`.

No companion SHA is imported or approved. `src/updates/artifacts/`,
`src/updates/manager/`, `src/updates/checkpoints/` and `src/server-controls/`
are absent here. Next dependencies are the coordinator's exact contract review,
approved stable companion SHAs/APIs, and either the minimal canonical
`src/decision/spend.ts` / `src/decision/jev-adapter.ts` ownership grant or accepted
accounting commits. Supervisor/accounting restore must preserve original session
ceilings and disabled-provider state, not only current goal counters.

Still required after those arrive: actual managed launch/IPC/promotion/status/
rollback and vanilla bridge CLI/config composition; durable control races and
accounting; compatible finite-goal continuation or truthful supported deferral;
packaged loaded-version/process/socket/readiness proof; U1–U6/C1–C6 combined
tests; both-version fixture/provider gates and independently measured notice/
rollback/reconnect behavior. New catalog/skill needs from progression/home/
upkeep must come through the coordinator's reviewed proposals.

Exact future manifest script proposal (coordinator-controlled, not installed):
`"package-release": "node scripts/package-release.ts"`, contingent on the
accepted packaging commit. No other new npm alias is required for the current
owned tests. Local launchers/controllers and the real operator profile were
unchanged and never invoked. Manifests/lock/vendor, companion-owned modules,
roadmap/supervision, gameplay planner settings and accepted release were untouched.

To review the complete owned diff, use
`git diff 2b9255c25e75519c06c94602d5ac60224a3c0521 HEAD` after the focused source
commit. This report is the worker's evidence, not coordinator acceptance.
