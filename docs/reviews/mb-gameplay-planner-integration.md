# MB-PLAN-006 — P shared gameplay integration review

Updated 2026-10-08 UTC, native DSH implementation session. **Approved development source is composed and the combined offline gates pass; ordinary provider/world acceptance remains pending.** An earlier parallel defense timeout is retained; its cause was not established. This is not a release or deployment. The accepted live artifact remains `d348d58`, logged out; this worker performed no live operation.

## Source and ownership

Checkout `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-planner`, branch `chunkbot/gameplay-planner`. Start: documentation handoff `f5c7549`, preserved application source `1ab12aa`, common base `37c4c17`. The staged and unstaged shared draft was inspected and completed; no reset, stash or discard was used. Own dependencies/build output were reused. Coordinator-owned manifests/vendor/AGENTS/workflow/roadmap/supervision were not edited.

Development uses the coordinator-selected personal ChatGPT native Codex route (`codex:codex-default`, `relay-codex`, CLI 0.160.0, exactly `gpt-6.1-sol`, `xhigh`, `danger-full-access`, approval policy `never`). No account/model/DSH change, subagent, API billing, gameplay inference, vault helper, auth cache or live control was used. The isolated gameplay planner retains its configured `low` effort. Older source commits/drafts/session history remain preserved.

| Commit | Focus |
| --- | --- |
| `8b18694` | Complete preserved shared draft with W's reviewed safety types. |
| `3b1bb33` | Fix P-C12-R3/R4 in the helper and actual PredicateEngine evaluation/capture. |
| `848cfab` | Immutable destructive scope, binding registry hints, target intersection and final executor refusal. |
| `62d6bc6` / `3302a18` / `aafe0c4` | Merge approved L through `5028438`, S through `5a4b560` (preserve P's canonical continuation), W through `fd8ce13`. |
| `75a6631` | Compose actual L/S/W APIs, one safety executor/lease, navigation policy, application session ID, dynamic catalog expectations. |
| `3ce6c43` | N1-H1/H2/H3 geometry, exact discarded-intent oracle, owned cleanup and continuation evidence. |
| `891caa5` / `aac6708` | Merge W through `6dd53ee` (including `6f3f5df`, now explicitly approved) and approved S through `b87e213` (including `c4ae9b5`/`1046ebf`). |
| `909acc8` | Mandatory logout after cleanup rejection, stop/new-manual safety and owner-direction tests; retire stale CLI answer invitation. |
| `bafd110` | Ordinary application harness water/mobs/C12, gather prerequisites and adversarial continuation oracle. |
| `23416f1` | Packet-frozen RC1 count oracle and interim online effect cleanup proof. |
| `e3855f9` | P-C11-R6: ordinary navigation installs W's complete existing instance wrapper; discriminating installed-library tests. |
| `cf0bfe4` | P-H4 defense staging/control, settled dry-bank oracle, fail-closed entity replies, positive cleanup proof/zero CLI exit, both-release gather prerequisite audit. |
| `4033b84` | P-L1/L4/L6/L8: owner-targeted seeking normalization, unchanged-guidance blocker, manual navigation status and truthful foundation-catalog label. |
| `de8850c` | Import approved W `0656e47`: retain the full configured repeated-hazard history. |
| `8a237d7` | Import the complete coordinator-approved W chain through `e18a3ae`, including `9f49497`'s corrected vanilla parser, durable journal and shore/support fixes. |
| `3f0917a` | Import the complete coordinator-approved S chain through `96074f6`: collected-stack accounting, moving mixed-pile veto and isolated physiology staging. |
| `af82050` | N1-R4: exact accepted outcome survives shown-history eviction; fresh tasks and destructive scope remain fenced. |
| `2c230cc` | Coordinator-assigned P integration correction to the pathing test: explicit legacy step-cost-only adverse control, safe production expectation. |
| `e982c48` | Ordinary O7W requires server ground, dry feet/eyes, full air and at least three seconds of settled support after release. |

RC1 uses the packet-frozen held count (a last pickup can race its earlier RCON sample), and interim online effects are verified before replacing a harness CLI. Companion source/review changes arrived only through committed merges; no evolving drafts were imported. Only this P review was authored here.

The latest direct coordinator instruction explicitly approves W `6f3f5df`/`6dd53ee`/`0656e47`. The latest complete coordinator review additionally approves S's complete correction chain through `96074f6` and W's surface/oracle chain through `e18a3ae`, and assigns P the pathing-test correction. Imports use those committed endpoints, including the published W-H2 parser correction; the superseded parser is not handed off as final. No evolving draft was imported. W's first two stable corrections were prematurely imported in `891caa5` before full approval; that history is preserved and their source is now approved. All exact S readiness/return corrections remain ancestors through `aac6708`; duplicate cherry-picks were unnecessary. The new dependency diffs change neither P's `src/contracts/continuation.ts` nor the typed public `src/survival/wiring.ts`; P's canonical declarations remain. W's later `b1154a8` refinement is not part of this composed endpoint; the review describes it as independently source-reviewed without the explicit integration approval given to the preceding chain.

## Critical corrections

**N1-R3 destructive authority.** GoalEngine derives destructive scope from the immutable accepted `blocks_removed` outcome and its captured bounded positions/component identity. AdmittedTask, candidate regeneration and ExecutionOwner carry that code-owned scope. `mine_block` checks explicit registry keys even for named targets. Completion/target handles intersect; they cannot union unrelated groups into authority. Candidate generation and the final executor refuse conflicts before commands. A discriminating test offers oak to the unfenced resolver, then proves zero writes under the original birch-removal scope; conflicting registry/target hints are refused too. No phrase handler, intent enum or goal whitelist was added.

**N1-R4 accepted outcome retention.** The unchanged code-bound `GoalOutcomeContract` has a separate internal `ProposalContext.acceptedOutcome`, populated only from the active goal's bound outcome. `checkProposal` compares its full canonical identity before reference validation and rejects edits. Only that exact outcome bypasses the evictable shown-history check. New task selectors, completion predicates, parameters and route destinations still require their original validation; preparation has no accepted outcome authority. Six actual GoalEngine windows demonstrate eviction without repair or rebinding. The real perception/predicate/candidate test removes the original trunk, evicts history, admits fresh remaining-canopy targets under the original outcome, refuses stale task targets/completions and rejects unrelated oak candidates under the original captured destructive scope. Uncleared canopy remains unsatisfied. Root's original failing report/journal is preserved and was read only; no world rerun occurred here.

**P-C12-R3/R4 accounting.** For carried credit C, non-credit N, fresh inventory F and own returns X:

```
Q = current possession + verified permitted consumption since rebind
R = F + own returns since F
eligible = min(C, max(0, X - N))       # X = F for no-loss interruption
restored = max(0, eligible - max(0, R - Q))
new = max(0, Q - R)
progress = restored + new
```

Consumption offsets decline inside the clamp. Eight returned old supplies consumed to zero yield zero new acquisition. C=4/N=8/full return F=12 declining to 8 with consumption disallowed yields zero credit. Positive new-resource, late own-return, effect/latch and unknown-lineage controls remain covered. B0/outcome/logical goal ID/absolute deadline/anchor/caps remain immutable and all counters cumulative; continuation has a fresh epoch and fresh tasks/references.

## Actual production composition

- **Safety:** normal CLI `run` enables the service independently of memory/autonomy. App authority reflects current engine/lifecycle state. Tracker attaches before login; safety lifecycle revocation precedes shared lease/ledger invalidation. W skills use `SkillExecutorImpl` and the one `ActuatorLeases`, with the service's grant checker. TaskRuntime holds before decisions/dispatch and freshly observes after preemption. P-C11-R6 now installs the complete `applyDeepWaterAvoidance` from the earlier approved W source with the authoritative session world. Step costs alone admitted the actual installed diagonal landings `[-2,-1,-1]`/`[-2,-1,1]`; the real ordinary factory refuses both, retains dry detours/wading and returns no route across a deep channel. P added no duplicate water/combat policy.
- **Stop/logout:** stop synchronously revokes normal and safety controls. A new manual goal may authorize a new finite episode while automatic work stays paused. `closeSafety()` records actual executor settlement. Rejection/timeout is recorded and returns nonzero while connection teardown/evidence close still run. Cleanup failure cannot skip logout.
- **L:** `RouteCarry = RouteLineage`; capture calls `revokeWithCarry(reason, epoch)` and admission calls `admitContinuation(lineage, admission)`. No reflection/carryOut fallback, second grant, old-leg replay or re-anchoring. Shared tests retain route identity, usage, ceilings, absolute time and original anchor, and reject repeated carry. Visible owner outside ordinary bounds uses counted seeking; owner-directed outcomes fence undirected exploration at candidate and executor seams.
- **S:** CLI passes `store.runId` and uses typed `continuationPort`. Incident returns use exact-version selectors and refuse unknown attribution. Imported corrections emit unknown collects, account at the first respawn sync and require full server inventory plus positive server health for readiness. The latest corrections cache packet-confirmed collected stack identity and stop an approach when a moving foreign pile makes recovery unsafe; unknown attribution cannot manufacture own-return credit. Durable checkpoints remain display-only across restart.
- **Catalog/status:** all features share the existing registry. Profile expectations derive actual optional capabilities, correcting the combined count false negative. CLI exposes safety state/counters; engine status exposes held/continued jobs. Dashboard held/continuation data uses its existing projection. A dedicated immediate-safety dashboard card is outside P's listed ownership and is not claimed.

The final shared L audit found omitted P-L1/L4/L6/L8 application seams and completed them in `4033b84`:

| Shared seam | Current source behavior / evidence |
| --- | --- |
| P-L1 | Central `checkProposal` adds registered `seek_owner` when typed owner-target semantics and an allowed movement descriptor targeting owner match. Preparation/lookahead use the same check. No instruction phrase matching, target replacement, route grant or limit change. A full capability list gets bounded semantic repair rather than exceeding the task schema. Actual SkillRuntime-catalog validation tests retain the raw draft/outcome and prove no route admission. |
| P-L2/P-L3 | Existing candidate/final fences reject undirected owner seeking; visible owner beyond ordinary bounds offers no doomed follow/move draft and requires a counted seek leg. |
| P-L4 | A blocked owner-directed window with missing/withdrawn/actionless seeking guidance gets a fresh observation/hint check, then one code-owned `cannot_execute` blocker without another unchanged replan. The original outcome/counters stay intact. A fresh actionable cue remains a counted replan (positive control). |
| P-L5 | Safety shares the real actuator and uses its own finite grant; ordinary paths install complete deep-water policy. Approved W surface/settled-shore mechanics are imported. Complete combined world acceptance remains open. |
| P-L6 | Shared navigation renderer is called by normal CLI status independently of autonomy; supervisor output filters duplicate route/locator lines. Coarse cue labels and immutable admission anchor/counters remain visible. |
| P-L7/P-L8 | Profile-based harness capability expectations are retained. The standalone `catalog` command is explicitly labeled foundation-only in text and JSON stderr, as permitted by the reviewed P-L8 requirement; `/diag catalog` reports the configured run's actual single registry. Offline CLI catalog exits 0. |

The imported L ordinary harness and the extended P harness still require coordinator-owned frozen ordinary entrypoint trials; these source checks do not establish P-L world acceptance.

## Ordinary harness and cleanup

[Ordinary harness](../../scripts/ordinary-goal-live-check.ts) runs the actual built CLI through ordinary owner chat, the real subscription planner and real or loopback Jev. `--jev fault` is harness validation, not real Jev acceptance. Workers leave it unexecuted. The lease guard precedes every secret read, report/config write, RCON and join. Setup/interventions and cleanup failures are recorded.

| Scenario | Oracle |
| --- | --- |
| O1/O2/O5/O6 | Exact chicken/server defeat, no player/substitute attack, absent-target blocker, owner stop, zero questions. |
| O3/O3u | Still-floating reachable complete birch shifted down one: every log and canopy removed, unrelated oak intact. Original-height remnant separately blocks without substitute cutting or false completion. |
| O4 gather | Six reachable natural trunks (30 logs), exposed stone, no initial materials/tools/furnishings, ordinary mining/crafting, no rescue. Both exact recipe/harvest datasets prove feasibility for a working bench plus furnishing bench, pickaxe, furnace, chest and every current shelter material placement including its aid. This audit does not execute gathering. Provided-material mode is labeled construction-only. |
| O7W | No memory/autonomy/locator/survival, ordinary radius 8: out-of-anchor water, finite safety, stop revoke, fresh manual grant. The first ending must already be on the dry bank with server `OnGround`, dirt support, dry feet/eyes and Air300. W's approved independent support oracle validates those RCON facts at least four times across three seconds, without rescue episodes. A surface bob, unknown air or missing ground fails. No persistent-job completion. |
| O8M/O8A/O8D | Unarmed retreat, equipped non-engaging NoAI adult avoidance, equipped already-engaging defense. O8D listens only during bounded pre-admission staging to the owned observer's actual damage packets, binds victim/attacker to the tagged server UUID, then verifies current server distance/health and admits immediately. No goal/safety authority during staging. Server survival/separation/defeat remain required. No difficulty mutation; fire resistance is labeled daylight setup. |
| RC1 | Eight old logs baseline, verified partial new logs, death, actual own recovery and same-job remaining acquisition without double credit/gear restoration. |
| RC2/RC2H/RC2C | Persistent follow, original partial home placement, historical craft credit and fresh current equipment. Fresh task identities and immutable outcome/baseline/caps/deadline/anchor. |
| RC3/RC3N/RC3D | Stop/resume/real CLI restart fences, new owner intake superseding held work, another death during recovery without owner allowance refill. |
| RC4 | Fresh scope/process with no owner checkpoint: actual recovery then fresh progression performs verified work. |

Recovery uses the unchanged fixture respawn point and explicitly configured finite own-death/support route; no bed/spawnpoint/world-spawn mutation, teleport rescue or restored gear. Profiles/data/scopes are independent; reports include every CLI process. Block/entity writes remain in x196..224,z190..224,y-63..-50 (entity box y-64..-24); recovery player travel includes the existing respawn-to-site path. Only owned children are signalled and awaited. Cleanup stops work, retains online dummy players for server-proven inventory/effect clear, removes delayed drops, restores/verifies standard blocks and original forceload, then quits and verifies zero players.

Ordinary entity absence now requires a readable `Test failed` reply; unreadable/error replies cannot credit defeat. Both harnesses require direct CLI exit 0 for cleanup success. Ordinary cleanup awaits its stop acknowledgement, and handoff cleanup uses a positive `execute unless entity` proof rather than treating an unknown reply as absence. Original failing reports remain unchanged.

[Handoff harness](../../scripts/handoff-live-check.ts) now guards its former top-level password read, is import-safe, uses independent run data and owns its child before startup awaits. L5 binds the exact discarded intent/instruction; only the original same logical follow may re-admit at a fresh epoch, preserving semantics/counters without tasks/handles. Planner/lifecycle cleanup gates remain. Online clears, scene restoration, original forceload and zero-player proof are journaled and failures fail the run.

## Offline evidence and remaining acceptance

All commands ran in this checkout with `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH; direct exit codes were captured. No fixture lease was granted and no fixture/provider/world/live trial ran.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0; final harness followup included |
| `npm run build` | exit 0; own dist includes N1-R4 and approved W/S corrections |
| Prior `npm test` at `b4859c0` | exit 0; 1,074/1,074, historical evidence |
| Historical `npm test` at `4033b84` | exit 1; 1,089/1,090: old pathing baseline expectation, now corrected |
| Combined `npm test` after N1-R4/pathing correction | exit 0; 1,130/1,130 |
| Final `npm test` at `e982c48` including the ordinary settled-shore followup | exit 0; 1,131/1,131 |
| `npm run doctor -- --config config/examples/fixture.json` | exit 0, read-only |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | exit 0, read-only |
| Navigation/composition | exit 0; 9/9, credential-free/inference-free |
| Latest harness/oracle/prerequisite audit | exit 0; 15/15, credential-free/inference-free |
| Latest approved dependency focused checks | exit 0; 90/90, credential-free/inference-free |
| N1-R4/window/destructive/pathing focused checks | exit 0; 34/34, credential-free/inference-free |
| Focused defense/navigation after full-suite timeout | exit 0; 14/14; three confirmed hits/defeat, cause of suite timeout not established |
| Final owner navigation/proposal/window tests | exit 0; 18/18 |
| Serial full-suite diagnostic before owner-seam followup | exit 1; 1,084/1,085: only W pathing baseline; defense passes |
| Offline foundation-catalog label check | exit 0; JSON remains catalog-shaped and stderr explicitly labels its scope |

Logs: `var/native-checks/frozen-test.log`, `frozen-doctor-261.log`, `frozen-doctor-262.log`, `final-harness-guard.log`. Doctors report missing local JRE/server assets and stopped fixtures; setup was not attempted. Earlier failed build-race doctor logs and an overly broad settings guard failure remain preserved. Doctor reruns followed builds; the guard now permits read-only difficulty/gamerule preconditions while rejecting writes. Root failed continuation/O3/cleanup/handoff reports remain untouched under `var/gameplay-fixes/`; root code/harnesses were never executed or imported.

Followup logs: `native-followup-typecheck.log`, `native-harness-followup-typecheck-fixed.log`, `native-followup-build.log`, `p-c11-r6-focused.log`, `native-followup-harness-audit.log`, `native-followup-doctor261.log`, `native-followup-doctor262.log`, `native-harness-final-full-tests.log`, `native-defense-followup-focused.log`, `native-followup-full-serial-diagnostic.log`. The first followup full run was 1,081/1,082 (only the W baseline); the later 1,083/1,085 run preserves the additional defense timeout. Serial and final parallel runs pass defense, which indicates scheduling sensitivity but does not prove its cause. Initial audit/owner-test typecheck mistakes are retained separately and were corrected before commit.

Historical owner gates/logs: `native-owner-final-typecheck.log` (0), `native-owner-final-build.log` (0), `native-owner-final-focused.log` (0), `native-owner-final-full-tests.log` (1), `native-owner-final-doctor261.log` (0), `native-owner-final-doctor262.log` (0), `native-owner-catalog.stdout.json` plus `catalog-owner-final.stderr.log` (0). All direct tool exit codes were captured; no pipeline concealed failures.

Current direct evidence: `native-approved-dependencies-focused.log` (90/90, 0), `native-n1r4-typecheck.log` (0), `native-n1r4-pathing-focused.log` (34/34, 0), `native-combined-reviewed-build.log` (0), `native-combined-reviewed-full-tests.log` (1,130/1,130, 0), `native-combined-reviewed-doctor261.log` (0), `native-combined-reviewed-doctor262.log` (0), `native-combined-shore-typecheck.log` (0), `native-combined-shore-harness-focused.log` (15/15, 0), `native-combined-shore-full-tests.log` (1,131/1,131, 0), all under `var/native-checks/`. Original failures remain. Exact approved W `6f3f5df`/`6dd53ee`/`0656e47`/`e18a3ae` and S `b87e213`/`96074f6` ancestor checks return direct exit 0. Dependency and source corrections are separate focused commits; no manifest, lock or vendor change required installation. Both doctors remain read-only and disclose this worktree's absent server/JRE assets.

The obsolete W pathing baseline is corrected under the coordinator's explicit assignment to P. The two precise legacy diagonal entries remain an adverse control, and production water refusal/dry detour/no-route/wading assertions pass. Apart from that assigned integration test, P authored no changes to W/S/L-owned modules or reviews. The earlier full-suite defense timeout is retained; the current combined full run passes defense without increasing timeouts, but its earlier cause remains unknown. W-H4 mob staging/neutral/repeated-hazard mechanics gaps remain with W/coordinator; no worker fixture trial is permitted.

Application source endpoint `2c230cc`, harness endpoint `e982c48`; clean after focused commits before this role-review update. Own built application matches that source (the later harness is run directly as TypeScript). Own built `dist/cli.js` SHA256 `51cd32722449550212fb445df07021bb8e64b0937d961d31fd7f2459da04f687`, `dist/goals/proposal.js` SHA256 `9ea93007ecaceacfa44ba1bea1bbd13e5ac9035f0f6328eb02d9376a55a1ca77`, `dist/skills/navigation.js` SHA256 `5008f81970c7afce246375ede18b770f7beb806b0031bec75f2a4c0929a8afb6`. CLI digest alone does not identify all imported modules. No development build is running or deployed.

Remaining delivery evidence belongs to the coordinator: new named exclusive leases, W complete mechanics on both releases (stop/reauthorization and finite out-of-anchor escape), ordinary L P-L1..P-L8, corrected ordinary/gather/safety/C12 trials on both releases, real planner isolation/cancellation and real Codex/Jev multi-window acceptance, and verified final world/process cleanup. Module/scripted passes cannot substitute. Do not accept far-water following before W's mechanics gate. No new release, reconnect, deployment or fallback is authorized.

For a dedicated dashboard safety display, the separate writer would add a bounded read-only `runtime.safety.status(now)` dependency to `src/dashboard/runtime.ts`/`publisher.ts`, a whitelisted contract/viewmodel projection and display; keep freshness/epoch labels and add no control route. P has not edited these unassigned files.
