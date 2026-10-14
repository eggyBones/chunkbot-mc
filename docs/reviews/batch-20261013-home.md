# Oct 13 home construction worker review

Status: owned offline implementation and checks prepared for coordinator review. **A3/A6/N2/N3 real-world/provider acceptance is open.** Explicit replacement-site integration remains open; this is not an accepted or deployed full-house gathering result.

## Provenance and ownership

- Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-home`.
- Branch: `chunkbot/batch-20261013-home`.
- Recorded common/initial base: `2b9255c25e75519c06c94602d5ac60224a3c0521`; initial staged/unstaged/untracked Git status was clean.
- An external docs-only fast-forward to `9ca70cbaba438033fbfd35d4097ab69339ba612d` occurred at 19:41:12 Arizona, before the first owned commit (Git reflog). Its subject is “Narrow parallel ownership and cap local checks with two shared slots”; it changes only seven coordinator planning/supervision documents. No merge/cherry-pick command was issued by this worker. It is the effective parent of the first owned source commit, and is preserved/excluded from the owned diff. Application source is unchanged between the recorded base and that parent.
- First API milestone: `0a6bf86358ea1ab676bace5d81eafb544bcaf553` (fresh prerequisite accounting, registered inspector, project fences, canonical storage validation, serialized writes).
- Final implementation commit: `bdc9bce4478827ba81f32eea2dccf9ae9843cbbb` (complete construction, current ownership/access verification, fresh receipt feedback and durable-write fault gate).
- Native thread/session: `01a13845-005c-7492-9e77-186b214b97c9`; rollout turn `01a13845-00e7-7aa1-929c-994d33929f5d` records `dsh_provider_codex`, CLI `0.162.1`, this cwd, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`.
- Coordinator-supplied current App Server gate: `initialize`, read-only `account/read(refreshToken:false)` -> ChatGPT/prolite, exact model-list/xhigh; executable `/opt/homebrew/Caskroom/codex/0.162.1/bin/codex`, home `/Users/jakewilcox/.codex`, preset `relay-codex`, account route `codex:codex-default`. No worker account probe, refresh, credential inspection or route/configuration change was performed.
- The separately isolated gameplay planner's model/effort/CLI pin/tools remain unchanged. No companion commit was imported by this worker and no shared path was edited by this worker. The separately observed docs-only fast-forward is distinguished above.

Changed paths: `src/autonomy/blueprint.ts`, `src/autonomy/home.ts`, `src/autonomy/store.ts`, `src/skills/construction.ts`, `tests/construction-inspector.test.ts`, `tests/batch20261013-home.test.ts`, and this report. The latest prompt's exclusive ownership and report name supersede the older preparation tables/briefs.

## Behavior and actual entry points

The existing `SkillRuntime` composition imports `constructionSkills` and registers every returned definition alongside the generic foundation skills (`src/app/skill-runtime.ts:194` and `:209`). This owned entry point now returns `select_home_site`, `inspect_home`, and `build_home`; no duplicate registry, scheduler, project service, goal handler or acquisition loop was added. The existing predicate composition calls the owned `evaluateStructure` entry point.

The complete supported capability path is: admit the original home outcome; approve the observed vacant site; inspect full deficits against server-confirmed inventory; use the existing generic mine/pickup/craft capabilities for materials, tools and recipes; place the crafting table early; continue the same project through walls, roof, aid cleanup and furnishings; verify the actual structure. There is no materials-provided-only production entry point or concealed acquisition script. The gameplay planner still owns prerequisite planning and ordinary task admission.

`inspect_home` performs a fenced inventory resync, freshly inspects the project, and reports exact-version normalized recipe facts. Its next resolver pass returns a bounded `home_inspection_ready` receipt as unavailable evidence. **This is necessary because `TaskOutcomeSummary` omits raw action evidence.** The existing `TaskFeedback.unavailable` -> planner seam therefore receives the full deficits/recipes, without repeated inspector inference or a synthetic task/goal completion. The read receipt expires after five seconds, is tied to project/connection/lifecycle/material and a fresh server inventory reading, and is consumed once. A newer predicate resync recomputes current deficits rather than invalidating the receipt or reusing old stock. A blocked inspection task uses the ordinary counted replan path; it does not admit a new goal or replenish limits.

Inventory stacks are allocated once across structural roles. Unknown cells need inspection and never become invented missing materials. Structural material constraints bind wall/roof/aid choices and are carried in every draft; crafting table, furnace and chest keep their exact outputs. The default 3x3 needs 30 walls, 25 roof blocks, up to one aid, and one each of the three furnishings. The 2x2 shares its table with the existing approved aid position and does not request an extra aid material.

The builder tries grounded visible roof supports and useful specific standing points before using its one approved aid. The 2x2 blueprint already overlaps the table and aid position: the own table temporarily serves as that same aid, is removed only with the existing live unchanged-identity proof, then is furnished again. Generic pickup/crafting supplies the table after cleanup. No additional coordinate, aid, tower, scaffold, navigation digging or demolition permission was introduced; the canonical blueprint remains unchanged.

A failed durable write also makes structure predicates unknown: an uncommitted in-memory project cannot certify site approval or saved completion. Every candidate contains the project ID. Execution checks the current canonical project, writable scope, dimension, whole-footprint/entrance travel bounds, exact current phase and candidate parameters, and rechecks after held-item confirmation. Placements require confirmed held inventory and visible solid supports. Unexpected server blocks are recorded as actual effects and fail the action; an aid changed to a non-air block does not receive an invented air checkpoint. Issued unconfirmed/cancelled commands record an unknown effect through passive bookkeeping. Revocation produces no cleanup mining/placement.

Completion requires the canonical checklist, current voxel evidence, matching construction ownership checkpoints, enclosure, a grounded entry and a visible in-reach workstation/storage path. Correct-looking third-party blocks are foreign. Pending predictions, unloaded chunks, later server statements and lifecycle changes invalidate cached evidence. Cache generation uses the actual latest invalidation object, so the ledger's bounded invalidation-list length cannot hide later lifecycle changes. Inspection movement includes specific exterior cells after restart rather than alternating two ineffective viewpoints.

The canonical project service serializes mutations to prevent a predicate hook overwriting a concurrent confirmed placement. Project IDs use random bytes rather than a restart-local counter. Checkpoint/verification/interruption methods accept a project fence. The store validates the canonical checklist on read/write and refuses a second writer even in the same process.

Restart loads historical project identity/checkpoints only. It emits no saved action and restores no inventory claim. A partial build is inspected anew; missing cells are derived from current truth. A surviving aid whose unchanged own identity is unproven on the new connection is left in place with `aid_identity_unproven`. This is deliberately an honest blocker, not automatic mining based on a stored block key.

## Public APIs and shared dependencies

Owned additions/compatible extensions:

```ts
canonicalProject(project: Pick<HomeProject, 'blueprint' | 'origin' | 'size' | 'entranceFacing' | 'cells'>): boolean;
materialRequirements(verdicts: readonly CellVerdict[], inventory: ReadonlyMap<string, number>, inTag: (tag: string, key: string) => boolean, material?: string): MaterialRequirement[];
// MaterialRequirement: role, count, held, missing, unknownCells, accept.
HomeProjectService.current(projectId: string): boolean;
HomeProjectService.approve(site: { origin: V3; interior: 2 | 3; facing: Facing; dimension: string; checks: string[]; goalId?: string }, current?: () => boolean): Promise<{ ok: true; project: HomeProject } | { ok: false; reason: string; detail: string }>;
HomeProjectService.checkpoint({ at, to, confirmedAtMs, capability, projectId? }): Promise<boolean>;
HomeProjectService.verified(verdict, projectId?): Promise<HomeProject | undefined>;
HomeProjectService.interrupted(detail, projectId?): Promise<void>;
HomeProjectService.unknownEffect(detail, projectId?): Promise<void>;
HomeProjectService.flush(): Promise<void>;
evaluateStructure(home, inspector, session, expect, projectId?: string,
  site?: { dimension: string; at: V3; maxDistance: number }): PredicateEvaluation;
```

Coordinator/integration/progression actions required, proposed in this DSH chat and **not approved/imported here**:

1. Extend the shared bound `structure_state`/predicate port so it forwards the bound project ID and a code-grounded immutable site constraint to `evaluateStructure`. Before any project exists, bind the admission site's owner/explicit destination meaning; after selection, preserve that project identity through replans/continuation. Preserve original outcome, admission baseline, goal anchor and remaining counters. Merely adding an optional wire field without binding it is insufficient.
2. Add the bounded durable retirement-history contract and compare-and-replace control operation for an explicit new-site instruction. Distinguish same-site continuation from replacement; retire only the prior bot project identity and never mine its old house. Current `approve` correctly refuses an existing project. **A new site when another home exists is not complete in this lane.** No replacement/history schema or authority was invented locally.
3. Supply the home summary/requirements for owner planner requests as well as automatic requests. The registered inspector and build unavailable evidence already carry facts through the current generic feedback path, but owner-context/site binding is still shared work.
4. Await `runtime.home?.flush()` after the final home terminal hook and before closing `AutonomyControl`. Pass the captured project ID into the app's `home.verified` and `home.interrupted` terminal hooks. The owned service queue exposes this drain; the unowned shutdown composition has not been changed.
5. Optional later improvement: a generic inspection-receipt predicate would let the observational task finish directly. It is unnecessary for the current counted feedback/replan path and must not become a home-specific acquisition controller.

The owned inspector receipt uses the current PredicateEngine resync rather than requiring object identity with its earlier inventory read. The test also changes inventory between those reads and verifies reduced deficits.

No exact companion SHA has been approved or imported. Questions/requests were addressed only to the coordinating Codex in this DSH chat.

## Offline validation

All heavy commands used `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH and this exact guard prefix:

```text
python3 -B /Users/jakewilcox/code/repos/minecraft-buddy/var/parallel-20261013/check-slots.py --cwd /Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-home --
```

| Direct command after guard | Direct exit | Evidence |
| --- | --- | --- |
| `npm run typecheck` | 0 | `var/home-offline/typecheck-durable-final.log` (final source and tests) |
| `npm run build` | 0 | `var/home-offline/build-durable-final.log` |
| `node --test --test-reporter=spec tests/construction-blueprint.test.ts tests/construction-inspector.test.ts tests/batch20261013-home.test.ts` | 0, 35/35 | `var/home-offline/focused-durable-final.log` |
| `npm test` | 0, 1,680/1,680 | `var/home-offline/full-durable-final.log`; preceding receipt correction also passed 1,679/1,679, exit 0 (`full-release.log`) |
| `npm run doctor -- --config config/examples/fixture.json` | 1 | `var/home-offline/doctor-26.1.2.log` |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | 1 | `var/home-offline/doctor-26.2.log` |
| `git diff --check` (not a heavy suite) | 0 | final formatting review |

Both doctors fail closed at the unchanged gameplay isolation pin: `/opt/homebrew/bin/codex` resolves to CLI 0.162.1, while gameplay was verified for exactly 0.160.0. These were read-only checks with the Jev key unset. Fixture/JRE files are absent in this independent checkout (warnings); no setup, world status request, server query, login refresh or inference was performed. The coordinator must provide/review the intended pinned gameplay executable rather than changing the development route or pin to make this check green. Unchanged doctor failures were not retried.

Retained initial failures: `typecheck-initial.log` (duplicate projectId, corrected); `focused-milestone.log` (fake projects lacked canonical blueprint and the fake clock made too-short historical IDs, corrected); `full-geometry-initial.log` (2x2 table/aid conflict); `full-geometry-shared-aid.log` (unnecessarily adjacent access rule plus queued-write teardown race, corrected with actual reach/visibility and project drain); `typecheck-final-initial.log` (existing fake helper's intentionally narrow block typing, corrected in the owned test). `full-final.log` retained a single unowned `tests/safety-defense.test.ts:125` timeout at its 10-second defense wait (1,678/1,679 passed); the unchanged focused defense file subsequently passed 10/10, exit 0, in `safety-defense-focused.log`. No safety source/test was edited. The full suite then passed 1,679/1,679 after the necessary inventory-resync receipt correction, and passed 1,680/1,680 with the final durable-write fault gate. No unchanged full failure/pass was repeated without a new source fix or unresolved concern. A whitespace-only EOF failure was corrected before the final direct diff check. These are offline implementation/harness failures, not fixture/provider reports.

The tests exercise production construction resolvers/executors against fake voxel, packet and inventory ports. Both sizes place every canonical cell and verify completion; 3x3 restarts after eight confirmed placements, and 2x2 restarts after confirmed aid cleanup. They also reject foreign matching blocks, blocked non-blueprint interior space, a stale project, a forged later phase, silent/aborted/unexpected placement a surviving unproven aid, and uncommitted in-memory site approval after a disk-write fault. Empty inventory produces complete deficits; the real generic craft resolver supplies the log-to-planks and inventory-grid crafting-table handoff. Gathering, other generic craft results and aid-drop pickup are simulated port results in the geometry trials. **They do not prove real material acquisition, navigation physics, provider planning, A3 or A6 acceptance.**

## Source, build and running state

The final build is local to this worktree; it has never been run in a Minecraft world or deployed. The registered accepted release `64e2609` remains separate per the coordinator brief; this worker made no live status query or control call.

Digest algorithm: SHA-256 of sorted relative path, NUL, complete file bytes, NUL. Source digest covers the four owned source modules; build digest covers all 348 files under this worktree's `dist/`. Recorded in ignored `var/home-offline/digests.json`:

- Owned source digest: `a9c90fa830fc0698196f1d6fe305e130575ae14d36b48b9b88220f83d7df3742`.
- Full local dist digest: `d51ca026ec31652e7607faba5029fd2f27b748e4a87a3e0bd25d46eba221b43a`.

The individual source hashes are retained in that JSON. No build/auth/runtime data was copied or shared. No manifests, lockfile, vendor data, other worktree, coordinator roadmap/supervision, DSH settings or account route were changed. No push/PR/merge/deployment was performed.

## Pending acceptance and recommendation

[A3/A6 and owner-site acceptance](../autonomous-progression-plan.md#home-construction-and-maintenance), [MB-PLAN-006 N2/N3](../v1-planner-plan.md#mb-plan-006--act-without-follow-up-questions), and the [companion outcome](../companion-upgrades-plan.md) remain coordinator-owned. Required real acceptance includes an ordinary no-question full-gather home from empty inventory on both supported fixtures, server-confirmed enclosure/entry/roof/workstations/storage and durable home recording with zero in-trial fixes; partial stop/restart/fresh repair; occupied/unreachable/moved/hidden sites; an existing home elsewhere and explicit replacement; original outcome/baseline/limits; uncertainty/foreign-block refusal and aid cleanup.

All fixture leases/settings grants/provider grants are absent. No model inference, fixture/server/client/world connection or manipulation, real controls, vault/key/auth-cache access, Prism operation or worker launch occurred. Recommend reviewing the owned commits, resolving the exact shared seams above and pinned doctor executable, then testing a frozen integrated artifact under coordinator-granted exclusive fixtures and coordinator-only provider injection. Do not mark full-house gathering accepted from these offline results.

The source commits above, review commit `90814c93e4e468e88c170b834936441e55d5f740`, and the final docs-only ancestry clarification are the owned commits. Final handoff reports the review commit/overall head; tracked and untracked Git status is clean after that commit. Ignored evidence remains under this worktree's own `var/home-offline/`. The full OWNED committed diff is retained there as `full-owned.diff`; reproduce it with `git diff 9ca70cbaba438033fbfd35d4097ab69339ba612d HEAD`. The separate `full-base-diff.diff` retains the complete recorded-base-to-head diff, including the external coordination document commit; reproduce it with `git diff 2b9255c25e75519c06c94602d5ac60224a3c0521 HEAD`.
