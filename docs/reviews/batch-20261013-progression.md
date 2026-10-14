# Oct13 progression worker delivery

Date: 2026-10-13 Arizona. Scope: MB-FLOW-001 A1/A2/A4/A5/A7/A8. Status: owned implementation and offline source checks delivered for coordinator review; real/combined acceptance is pending. This is not an accepted or deployed release.

## Checkout and native session

- Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-progression`.
- Branch: `chunkbot/batch-20261013-progression`.
- Common base: `2b9255c25e75519c06c94602d5ac60224a3c0521`. Initial staged and unstaged diffs were empty.
- The final ancestry/reflog inspection shows an inherited preparation fast-forward to `9ca70cbaba438033fbfd35d4097ab69339ba612d` between initial inspection and the first owned commit. It changes only seven coordinator documents: supervision, autonomous progression, companion upgrades, survival routines, V1 integration, V1 planner and feature plans. The worker performed no merge/cherry-pick and preserved this commit. It is the effective owned-diff base; application source at that commit is the same as the recorded common base.
- First focused source commit: `d517f5a73241d6855f0b2ce9a8c984f7f5be0b9f` (assessment fences, readiness/accounting, useful-outcome rules and tests).
- Final source commit: `684d6bba76a92bfe2ead20c48dfbc9af5568779e` (durable pause, guard/ready coalescing, recovery admission and outcome/status regressions).
- Review commit follows the source commits. No companion commits were imported; no unapproved SHA was merged or cherry-picked.
- Actual worker transcript metadata: originator `dsh_provider_codex`, CLI `0.162.1`, thread/session `01a13844-e898-7023-8a2c-2429fb3692fc`, turn `01a13844-ec66-78e3-a136-3a0e0dce494b`, exact assigned cwd, `gpt-6.1-sol`, `xhigh`, `danger-full-access`, approval `never`. The running parent was the native Codex App Server. `CODEX_HOME` was `/Users/jakewilcox/.codex`.
- The coordinator supplied the installed integration's initialize / account-read (`refreshToken:false`, ChatGPT/prolite) / exact model-list+xhigh gate and `relay-codex` / `codex:codex-default` selection. The worker independently inspected only safe native session/turn metadata; it did not inspect credentials or refresh/login/change routes. The gameplay CLI/model/effort/tools/isolation remain unchanged.

## Owned implementation and actual entry points

The existing CLI already constructs `AutonomySupervisor` in normal run, calls `start()` before connection, passes filtered observations and the existing run SpendLedger readiness, and forwards lifecycle/admission/terminal/latch/preparation hooks. Those actual public entry points now execute the corrected supervisor path; this is not a separate scheduler or disconnected helper. No shared composition change is necessary to reach these fixes.

`SupervisorEngine`, production `SupervisorDeps`, `AutonomyControl` public methods and `recoveryAdmissionBarrier` signatures are unchanged. Canonical contracts, scope resolution, HOME/store/construction, survival, shared GoalEngine/task/planner/runtime and registries are consumed as they existed at the base.

| Changed source | Behavior |
| --- | --- |
| `src/autonomy/supervisor.ts` | One coalesced, bounded observation assessment. Epoch/connection/dimension/generation/stop fences prevent old reads from revoking new owner work or admitting stale support. Ready/completion scheduling arriving behind a guard upgrades that same assessment, so idle progression is not lost. Guard generations prevent a stopped in-flight guard from rearming itself. |
| Same supervisor | All automatic paths, including safety replacement, check provider and decision/spend readiness. Terminal planner/Jev failures hold the applicable automatic provider until explicit owner admission or resume; code-task support can still use Jev when only planning is unavailable. Blocked survival holds unrelated progression. Retry windows are finite and cannot request a zero-delay loop. |
| Same supervisor | Admission hooks count automatic goals before tasks/fast terminals can settle. Remaining planner turns include the live automatic goal before replacement; terminal accounting is idempotent by goal/epoch. Per-goal tasks/replans/deadlines, session counts/turns, survival episode ceilings and the same run spend gate remain binding. Resume, death and new milestones do not replenish them. |
| Same supervisor | Repeated verification of the same already-satisfied outcome in unchanged state enters bounded waiting. Useful additional acquisition keeps fresh admission baselines and can continue to another milestone. Finite owner completion returns to reassessment; persistent owner work retains ownership. Unresolved owner intent remains visible and holds unrelated progression. Completion copy accounts for a newer unresolved instruction or exhausted progression allowance. |
| `src/autonomy/context.ts` | The existing catalog-backed planner gets generic rules to compare admission supplies/equipment, choose appropriate prerequisites and require useful change. No resource ladder, goal/phrase whitelist, new catalog or direct actuator path was added. |
| `src/autonomy/control.ts` | Distinguishes pause operations by generation rather than equal booleans. An old pause write cannot mark a newer pause durable after intervening resume. Close fences mutations synchronously, then drains queued writes/bookkeeping before canonical store lock release. |
| `src/autonomy/barrier.ts` | Recovery durability waits use bounded monotonic time, preserve the admission connection/dimension and compare an admitted incident ID with the durable authority. A different incident/connection cannot release the recovery goal. Stop remains abortable. |
| `src/autonomy/status-text.ts` | Active owner work is rendered as active; held-continuation text is reserved for unresolved/interrupted work. Existing status schema, dashboard projection and read-only behavior are unchanged. |

Changed tests: `tests/autonomy-fakes.ts`, `tests/autonomy-scope.test.ts`, `tests/autonomy-barrier.test.ts`, and new `tests/batch20261013-progression.test.ts`. Other owned tests and `scope.ts` needed no edit. HOME's `blueprint.ts`, `home.ts`, `store.ts` and construction skill were read-only. All unlisted files remain unchanged relative to the inherited preparation commit above; its coordinator document changes are preserved.

## Offline evidence

Every install/build/test/doctor command used the coordinator's two-slot guard:

`python3 -B /Users/jakewilcox/code/repos/minecraft-buddy/var/parallel-20261013/check-slots.py --cwd /Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-progression -- <command>`

Node 24's authorized bin directory was first in PATH; OpenRouter/OpenAI keys were unset. Commands ran in this worktree with its installed dependencies and independent ignored `dist`/`var`. No dependency install or manifest/vendor change was needed.

| Command / evidence under ignored `var/worker-progression/` | Direct exit | Result |
| --- | --- | --- |
| `npm run typecheck`, `typecheck-delivery.log` | 0 | Final source/tests typecheck. |
| `npm run build`, `build-01.log` | 0 | Actual worktree application built. |
| `npm test`, `test-full-01.log` | 0 | 1687/1687 tests, 327 suites; zero failures/skips/cancellations. Includes the final active-follow rendering test. |
| `node --test tests/autonomy-supervisor.test.ts tests/autonomy-barrier.test.ts tests/autonomy-scope.test.ts tests/batch20261013-progression.test.ts`, `focused-02.log` | 0 | First milestone's 44 affected tests. |
| `node --test tests/batch20261013-progression.test.ts`, `focused-milestone.log` | 0 | Commit-level first milestone regressions. |
| `node --test tests/autonomy-supervisor.test.ts tests/autonomy-scope.test.ts tests/autonomy-barrier.test.ts tests/batch20261013-progression.test.ts`, `focused-04.log` | 0 | Subsequent 52 affected tests. |
| `node --test tests/autonomy-scope.test.ts tests/autonomy-barrier.test.ts tests/batch20261013-progression.test.ts`, `focused-final.log` | 0 | 34 focused tests before the final rendering-only correction; full suite above covers all final changes. |
| `npm run doctor -- --config config/examples/fixture.json`, `doctor-261-01.log` | 1 | Installed CLI 0.162.1 violates unchanged gameplay isolation pin 0.160.0. |
| `npm run doctor -- --config config/examples/fixture-26.2.json`, `doctor-262-01.log` | 1 | Same exact gameplay CLI pin failure. |
| `git diff --check` | 0 | Owned diffs clean before each source commit. |

Doctors are read-only and made no Minecraft connection/inference. Their absent worktree fixture/JRE/scope warnings are expected in this unprovisioned worker environment; the failing checks are the gameplay CLI version/isolation checks. No unchanged failed doctor was repeated or suppressed.

Retained initial failures: `typecheck-01.log` / `focused-01.log` both exit 1 (redundant narrowed-type comparison, missing respawn dimensions and test assumptions about acquisition mode/rendered outcome); `typecheck-03.log` / `focused-03.log` both exit 1 (the new inventory test initially used a nonexistent request field and then treated the existing counts array as a map). Corrections use existing typed contracts. Original logs remain intact. All other intermediate typecheck/focused passes are retained as well.

Scripted evidence uses the REAL GoalEngine and canonical durable control store with fake filtered observations, planner/server/task ports and manual clocks/timers. It proves admission, ownership, cancellation, accounting and waiting behavior, not actual crafting, building, model choice quality or world success. Empty/prepared cases use the same generic instruction/catalog and different server admission supplies; separate two-milestone tests verify fresh acquisition baselines and recent verified feedback. Movement/crafting/building stop cases test task capability ownership plus in-flight lookahead and restart pause, without pretending to run those mechanics in Minecraft.

## Source, build and running state

The build corresponds to final source commit `684d6bba76a92bfe2ead20c48dfbc9af5568779e`. Ignored `var/worker-progression/digests.json` records every input/output file hash. Algorithm: sort relative paths, then SHA-256 the concatenation of `relative-path + NUL + file-sha256 + LF` records.

- Application input digest (229 tracked files under `src/`, `scripts/`, `config/`, `vendor/`, plus package manifests and TypeScript configs): `3e458a987d741b83d3b1446a1f02528277d6176728e9a3a23908778097aa0c7e`.
- Build digest (348 files under this worktree's `dist/`): `90f55835294720ac949783ba392fc93aaede4acc5c6344d4ea99486b497fbf81`.
- Source/build are local worker artifacts. No application/server process was launched or adopted. The separately accepted live release `64e2609` and its profile/controls are unaffected. Idle progression was not enabled in that profile.
- Full branch diff is `git diff 2b9255c25e75519c06c94602d5ac60224a3c0521..HEAD` (includes the inherited coordinator documentation refinement). Owned delivery diff is `git diff 9ca70cbaba438033fbfd35d4097ab69339ba612d..HEAD` (nine owned source/test paths plus this review). Final tracked worktree should be clean after the review commit; ignored logs/build/digests remain for coordinator inspection.

## Shared proposals and remaining acceptance

The coordinator was sent two shared proposals in the DSH chat. Neither was approved or implemented by this worker:

1. Optional `SupervisorDeps.automaticWorkBudgetMs?: number`, wired by integration from a reviewed session config field such as `autonomy.session.maxAutomaticWorkMs`. An explicit cumulative run time clamp can use it; current source retains the already-finite automatic-goal counts multiplied by bounded per-goal deadlines and the existing planner/task/episode/spend caps. This delivery adds no new configured run time policy without review.
2. Keep `stateFingerprint: () => string`, but make its CLI implementation include server-confirmed health/food/equipment and inventory confirmation state. The existing composer hashes client inventory, coarse location and home checkpoint state. That is a remaining limitation of changed-state detection, especially health-only changes or optimistic inventory predictions. It cannot authorize actions: fresh GoalEngine baseline/planner/task/executor verification still governs execution. Integration owns this improvement.

Remaining real criteria are deliberately open: A1 actual normal-run idle initiation, A2 real planner/Jev empty/prepared prerequisites and automatic next useful milestone, A4 finite owner return/persistent follow/unresolved intent, A5 stop during real planning/movement/crafting/construction and restart, A7 unsafe/resource/provider/spend/repeated-blocker waiting with actual server state, and A8 combined memory/handoff/dashboard evidence. A3/A6 construction and companion survival acceptance belong to the other assigned owners and coordinator.

External blockers: both fixture leases are absent; no world/provider/keys/auth/live-controls authority was granted; the worker PATH gameplay executable fails the 0.160.0 isolation gate; no reviewed integrated companion artifact/SHAs or shared proposal approvals were supplied. No real provider diagnostic, fixture status/start/stop/join/RCON, live controls, deployment, DSH/global change, vault operation, worker launch, push, PR or merge was performed.

Recommended next step: coordinator reviews the exact two source commits and proposed composition improvements, integrates approved SHAs, supplies the correctly pinned isolated gameplay executable, then runs the existing applicable both-version harnesses and ordinary real multi-milestone trials under named exclusive leases/key injection. This offline delivery does not close those acceptance criteria.
