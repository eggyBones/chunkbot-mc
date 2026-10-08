# MB-PLAN-006 — P shared gameplay integration review

Updated 2026-10-07 Arizona, native DSH implementation session. **Development source is composed and offline-verified; ordinary provider/world acceptance is pending.** This is not a release or deployment. The latest owner instruction identifies the accepted live artifact as `d348d58`, logged out; this worker performed no live operation.

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
| `891caa5` / `aac6708` | Merge stable W through `6dd53ee` (including `6f3f5df`) and S through `b87e213` (including `c4ae9b5`/`1046ebf`). |
| `909acc8` | Mandatory logout after cleanup rejection, stop/new-manual safety and owner-direction tests; retire stale CLI answer invitation. |
| `bafd110` | Ordinary application harness water/mobs/C12, gather prerequisites and adversarial continuation oracle. |
| `23416f1` | Packet-frozen RC1 count oracle and interim online effect cleanup proof. |

The final followup also makes RC1 use the packet-frozen held count (a last pickup can race its earlier RCON sample), and verifies interim online effects before replacing a harness CLI. Companion source/review changes arrived only through committed merges; no evolving drafts were imported. Only this P review was authored here.

## Critical corrections

**N1-R3 destructive authority.** GoalEngine derives destructive scope from the immutable accepted `blocks_removed` outcome and its captured bounded positions/component identity. AdmittedTask, candidate regeneration and ExecutionOwner carry that code-owned scope. `mine_block` checks explicit registry keys even for named targets. Completion/target handles intersect; they cannot union unrelated groups into authority. Candidate generation and the final executor refuse conflicts before commands. A discriminating test offers oak to the unfenced resolver, then proves zero writes under the original birch-removal scope; conflicting registry/target hints are refused too. No phrase handler, intent enum or goal whitelist was added.

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

- **Safety:** normal CLI `run` enables the reviewed service independently of memory/autonomy. App authority reflects current engine/lifecycle state. Tracker attaches before login; safety lifecycle revocation precedes shared lease/ledger invalidation. W skills use `SkillExecutorImpl` and the one `ActuatorLeases`, with the service's grant checker. TaskRuntime holds before decisions/dispatch and freshly observes after preemption. Navigation uses W's deep-water exclusion with the authoritative session world. P added no duplicate water/combat policy.
- **Stop/logout:** stop synchronously revokes normal and safety controls. A new manual goal may authorize a new finite episode while automatic work stays paused. `closeSafety()` records actual executor settlement. Rejection/timeout is recorded and returns nonzero while connection teardown/evidence close still run. Cleanup failure cannot skip logout.
- **L:** `RouteCarry = RouteLineage`; capture calls `revokeWithCarry(reason, epoch)` and admission calls `admitContinuation(lineage, admission)`. No reflection/carryOut fallback, second grant, old-leg replay or re-anchoring. Shared tests retain route identity, usage, ceilings, absolute time and original anchor, and reject repeated carry. Visible owner outside ordinary bounds uses counted seeking; owner-directed outcomes fence undirected exploration at candidate and executor seams.
- **S:** CLI passes `store.runId` and uses typed `continuationPort`. Incident returns use exact-version selectors and refuse unknown attribution. Imported corrections emit unknown collects, account at the first respawn sync and require full server inventory plus positive server health for readiness. Durable checkpoints remain display-only across restart.
- **Catalog/status:** all features share the existing registry. Profile expectations derive actual optional capabilities, correcting the combined count false negative. CLI exposes safety state/counters; engine status exposes held/continued jobs. Dashboard held/continuation data uses its existing projection. A dedicated immediate-safety dashboard card is outside P's listed ownership and is not claimed.

## Ordinary harness and cleanup

[Ordinary harness](../../scripts/ordinary-goal-live-check.ts) runs the actual built CLI through ordinary owner chat, the real subscription planner and real or loopback Jev. `--jev fault` is harness validation, not real Jev acceptance. Workers leave it unexecuted. The lease guard precedes every secret read, report/config write, RCON and join. Setup/interventions and cleanup failures are recorded.

| Scenario | Oracle |
| --- | --- |
| O1/O2/O5/O6 | Exact chicken/server defeat, no player/substitute attack, absent-target blocker, owner stop, zero questions. |
| O3/O3u | Still-floating reachable complete birch shifted down one: every log and canopy removed, unrelated oak intact. Original-height remnant separately blocks without substitute cutting or false completion. |
| O4 gather | Six reachable natural trunks (30 logs), exposed stone, no initial materials/tools/furnishings, ordinary mining/crafting, no rescue. Provided-material mode is labeled construction-only. |
| O7W | No memory/autonomy/locator/survival, ordinary radius 8: out-of-anchor water, finite safety, stop revoke, fresh manual grant, dry server bank, no persistent-job completion. |
| O8M/O8D | Ordinary follow with unarmed retreat/equipped adult-zombie defense; server survival/separation/defeat. No difficulty mutation; mob fire resistance is labeled daylight setup. |
| RC1 | Eight old logs baseline, verified partial new logs, death, actual own recovery and same-job remaining acquisition without double credit/gear restoration. |
| RC2/RC2H/RC2C | Persistent follow, original partial home placement, historical craft credit and fresh current equipment. Fresh task identities and immutable outcome/baseline/caps/deadline/anchor. |
| RC3/RC3N/RC3D | Stop/resume/real CLI restart fences, new owner intake superseding held work, another death during recovery without owner allowance refill. |
| RC4 | Fresh scope/process with no owner checkpoint: actual recovery then fresh progression performs verified work. |

Recovery uses the unchanged fixture respawn point and explicitly configured finite own-death/support route; no bed/spawnpoint/world-spawn mutation, teleport rescue or restored gear. Profiles/data/scopes are independent; reports include every CLI process. Block/entity writes remain in x196..224,z190..224,y-63..-50 (entity box y-64..-24); recovery player travel includes the existing respawn-to-site path. Only owned children are signalled and awaited. Cleanup stops work, retains online dummy players for server-proven inventory/effect clear, removes delayed drops, restores/verifies standard blocks and original forceload, then quits and verifies zero players.

[Handoff harness](../../scripts/handoff-live-check.ts) now guards its former top-level password read, is import-safe, uses independent run data and owns its child before startup awaits. L5 binds the exact discarded intent/instruction; only the original same logical follow may re-admit at a fresh epoch, preserving semantics/counters without tasks/handles. Planner/lifecycle cleanup gates remain. Online clears, scene restoration, original forceload and zero-player proof are journaled and failures fail the run.

## Offline evidence and remaining acceptance

All commands ran in this checkout with `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH; direct exit codes were captured. No fixture lease was granted and no fixture/provider/world/live trial ran.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; own dist rebuilt from final application source |
| `npm test` | exit 0; 1,074/1,074 |
| `npm run doctor -- --config config/examples/fixture.json` | exit 0, read-only |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | exit 0, read-only |
| Focused composition/oracle/lease-guard checks | exit 0, credential-free/inference-free |

Logs: `var/native-checks/frozen-test.log`, `frozen-doctor-261.log`, `frozen-doctor-262.log`, `final-harness-guard.log`. Doctors report missing local JRE/server assets and stopped fixtures; setup was not attempted. Earlier failed build-race doctor logs and an overly broad settings guard failure remain preserved. Doctor reruns followed builds; the guard now permits read-only difficulty/gamerule preconditions while rejecting writes. Root failed continuation/O3/cleanup/handoff reports remain untouched under `var/gameplay-fixes/`; root code/harnesses were never executed or imported.

Remaining delivery evidence belongs to the coordinator: new named exclusive leases, W complete mechanics on both releases (stop/reauthorization and finite out-of-anchor escape), ordinary L P-L1..P-L8, corrected ordinary/gather/safety/C12 trials on both releases, real planner isolation/cancellation and real Codex/Jev multi-window acceptance, and verified final world/process cleanup. Module/scripted passes cannot substitute. Do not accept far-water following before W's mechanics gate. No new release, reconnect, deployment or fallback is authorized.

For a dedicated dashboard safety display, the separate writer would add a bounded read-only `runtime.safety.status(now)` dependency to `src/dashboard/runtime.ts`/`publisher.ts`, a whitelisted contract/viewmodel projection and display; keep freshness/epoch labels and add no control route. P has not edited these unassigned files.
