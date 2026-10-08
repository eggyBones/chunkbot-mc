# MB-FLOW-003 recovery correctness (C8/C9/C10) and C12 continuation seam: worker handoff

Worker S: native DSH Codex, personal ChatGPT account, `gpt-6.1-sol` / `xhigh`, `danger-full-access` / approval `never`, per the coordinator's 2026-10-07 Arizona handoff. Earlier Claude sessions/commits remain preserved. Worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-recovery`, branch `chunkbot/gameplay-recovery`, common base `37c4c170199b4c9d867f720e64561a63a816d14c`; native handoff `9f15b55` over application source `5a4b560`. Plans: [survival-routines-plan.md](../survival-routines-plan.md) (C7–C12, R1–R10) and [live-gameplay-fixes-plan.md](../live-gameplay-fixes-plan.md).

**Delivery state:** ROOT approved S through `18dfdc662a9b59d19c75b10e58889b76bf6d44bc` and documentation-only R7 diagnosis `98883c31e5f200e49911d9fa2f33c0775c696d80`; its supplied private P/L composition was `dde21d6f5226464fc2d334a121aef95c711c0ca9`. Real RC1 passes on both releases and 26.1.2 RC2C passes with exact full recovery; 26.2 RC2C fails after three conservative route pickup vetoes with zero returns. Exact veto entity/cause remains UNKNOWN. Subsequently authorized S-R14 is implemented in focused source commit `11a299c5d84f7989d4cc3ddf3f36566aa0c7ffac`, awaiting ROOT review/import and a new frozen capture trial. No behavioral defect or contamination cause is proved and no guard is relaxed. All historical failures remain unchanged. S has no world lease and ran no gameplay inference, reconnect or deployment. Accepted live `d348d58` remains logged out.

## Native handoff S-R14: first pickup-veto evidence

Reviewed clean parent `98883c31e5f200e49911d9fa2f33c0775c696d80`, whose application source was `18dfdc6`. Same registered session `session-cd2c0bb0-accc-422b-bb20-b5a6b43d25a9` / workspace `7644839f-cfc9-419c-998e-f3f139ff4ac6`, personal native `gpt-6.1-sol` / `xhigh` / full access / never. Worker workflow, ownership, staged/unstaged state, assigned plans and ROOT's current recorded finding were inspected before implementation. ROOT explicitly authorized the minimal evidence seam after accepting R7's diagnosis limit. Dependencies, native drafts, shared source/contracts and old failed reports are preserved.

### Source, receipt and unchanged API

Source commit **`11a299c5d84f7989d4cc3ddf3f36566aa0c7ffac`**, three owned paths: `src/skills/survival.ts`, `tests/survival-motion.test.ts`, `tests/survival-incidental.test.ts`. The latter adds the required clock to an older direct-skill test double. This role review is a separate documentation commit.

Each recovery action captures its first item refusal through **`ctx.progress({ recoveryPickupVeto: receipt }, 'local')`**, at the existing classifier/frozen-target refusal. A local latch permits one receipt; later events, inventory awaits and packet/position changes cannot overwrite it. Registered `go_to_death_site`, `recover_lost_items` and approved `navigateRecoveryTravel` all use it. Resolvers/catalog/model prompts gain no payload fields. Classification order/reasons, pickup reach, entity iteration order, reservations, path/control revocation, passive settlement and credit rules remain unchanged.

The bounded object contains only:

| Field | Meaning/provenance |
| --- | --- |
| `provenance`, `entityId`, `reason` | Local refusal receipt, exact rejected entity and actual classifier reason or `target_changed`; public action reason remains unchanged. |
| `goalId`, `goalEpoch`, `connectionEpoch`, `dimension`, `atMs` | Current action/session context and local sample time. |
| `region`, `reference` | Bot/site-side check; reference distinguishes bot, incident site and scoped pickup target's neighborhood. |
| `serverStack` | Nullable current key/count/incarnation/digest/`packetAtMs`. Metadata is server-stated; incarnation is explicitly `tracker_spawn_sequence`, digest `derived_from_server_stack`, packet time `local_packet_receipt`. Missing current facts leave every field null, even when old frozen facts exist. |
| `firstOrigin` | Nullable current incarnation's first server-spawn proof, distance derived from that origin/incident site and existing search-radius comparison. |
| `localDistances` | Explicitly local horizontal/absolute-vertical samples to bot, incident site and checked point. Missing position/non-finite measurements remain null. |
| `remainingCountUsed`, `remainingIdentityCountUsed` | Only room actually consulted by the rejecting classifier, after existing frozen reservations. Unconsulted room is null; consulted zero stays zero. Frozen-change checks consult neither. |

No raw NBT/components/labels/entity dump, new persistent store, timer or framework is introduced. Normal results retain `evidence.recoveryPickupVeto`; existing executor cancellation retains it under `evidence.localProgress.recoveryPickupVeto`, explicitly local. A diagnostic alone never confirms a partial effect or enters the ledger/incident-return book.

The unchanged local executor can check its frozen target after a legitimate collect/destroy, recording `target_changed` with null current facts/distances. This is an approach fence, not a claim about earlier collections: existing exact settlement still succeeds and credits four once. Read outcome and packet settlement together; old frozen facts are never fabricated as current.

**Shared dependency:** approved `navigateRecoveryTravel(service, ctx, options)` signature, returned `navigation`/`pickup`/`veto` shape and optional P/L recoveryTravel callback are unchanged. P remains sole app binder, L sole locator consumer. ROOT can import this exact dependency atop the approved source chain while retaining current composition. Existing outcome evidence carries the receipt; no shared source/contract/harness edit or companion import is required from S. Canonical P continuation declarations and original accounting remain untouched.

### Discriminating offline evidence

Production tracker/service, `SkillExecutorImpl`, `Actuator`, lease, server journal/resync and navigation run unchanged; server transport/pathfinder physics alone are simulated. Eight new controls prove:

- Announced item without stack versus loaded item without server-origin proof: distinct `stack_facts_unknown`/`foreign_drop_origin`, null stack/unconsulted room, zero path/collect/credit.
- Matching bread first announced outside the incident then moved next to the bot versus unsought dirt: truthful packet facts, original spawn distance distinct from current local distance, no identity-room consultation.
- Component mismatch, oversized whole stack and neighboring stacks exhausting their identity allowance: exact reasons and consulted key/identity room of 8/4 or 4/0, no borrowed identity credit or raw names/components in evidence.
- First bread64 refusal followed by dirt1 metadata/movement away during resync: one unchanged receipt at original distances/time, zero path/collect/credit.
- Frozen metadata gap, identical stated replacement incarnation and merged64 stack: truthful current facts/nulls; event guard stops before another movement/collect; original attempts/budget unchanged.
- Cancellation after refusal: receipt remains local; confirmation/confirmed partial effects stay `none`; zero commands after revocation.
- Legitimate own bread4: one path/collect/ledger effect/return with original attribution/authority; post-collect local fence preserves settlement. Ordinary forwarding-route positive path has no veto receipt.
- Moving foreign destination pile: first refusal is captured by the production event guard before the next physics movement or pickup.

Existing controls retain keyless incidental/unknown/no-credit semantics for unavoidable metadata-gap collections, exact collect/destroy settlement, known foreign keys, orb exclusion, cancellation and strict whole-pile/component/first-origin guards. The forwarding route is seam evidence, not actual locator or ordinary-world acceptance.

Exact new controls against preserved parent skill source fail **direct exit 1, 0/8** because the first-veto receipt did not exist; preceding movement/credit checks still show the original conservative behavior. Source/current controls/failed log remain `var/native-recovery-review/r14-parent-{survival.ts,controls.test.ts,controls.log}`. This proves missing observability, not unsafe classification or the historical R7 entity.

### Direct checks, build and remaining acceptance

Own checkout only, `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH; verified dependencies reused. Settled receipts:

| Check | Direct exit/result | Own retained log |
| --- | --- | --- |
| Affected motion/route/incidental tests | 0, 40/40 | `var/native-recovery-review/r14-affected-final.log` |
| `npm run typecheck` | 0 | `var/native-recovery-review/r14-typecheck-final.log` |
| `npm run build` | 0 | `var/native-recovery-review/r14-build.log` |
| `npm test` | 0, 851/851, 206 suites | `var/native-recovery-review/r14-test-final.log` |
| Read-only doctor 26.1.2 | 0 | `var/native-recovery-review/r14-doctor-261.log` |
| Read-only doctor 26.2 | 0 | `var/native-recovery-review/r14-doctor-262.log` |
| `git diff --check` | 0 | Direct tool receipt |

Intermediate failures remain: affected direct exit 1 (25/29) from wrong test expectations for block-centered site/post-collect fence; affected direct exit 1 (29/30) from synchronously cancelling inside a fake transport write before its actuator log completed (corrected to microtask revocation after that issued write returns); first full suite direct exit 1 (849/851) from two older direct-skill doubles omitting the required service clock. No production behavior changed to satisfy these fixture corrections. Logs: `r14-affected-initial.log`, `r14-affected-second.log`, `r14-test.log`. Final affected/full gates pass; prior R3–R7 failures remain.

Own development dist: 152 JavaScript files, sorted relative `path + NUL + bytes + NUL` SHA256 **`1659cef7c23a9c361278365ffff9cd8e0e2c5f9d8411217e4d05018b1ea5160e`**, from `11a299c`'s exact application source. Artifact/report-hash receipt: `var/native-recovery-review/r14-artifact-receipt.json`. Doctors only read readiness; 26.2's missing own JRE/server remain warnings. No setup/start/stop/join/RCON, auth refresh, provider inference/key/vault, live control or deployment occurred. Account/model/global DSH and dependencies are unchanged.

Retained 26.2 failure report SHA reverified `63cf05be25215eeabae15cd7458b135fa35d1b5c5055f83654c24c3e81b7bb1e`; 26.1.2 comparator SHA `c432f7f0e4104709e37c464459c811adf1b688819fc7ae1b9f8ad0b0504c6a09`. Exact R7 veto entity/cause remains UNKNOWN; this cannot reconstruct absent historical facts. ROOT owns review/import, next immutable capture with owned-spawn baseline, ordinary RC2C and both-release original/full-feature/provider/restoration gates. S-R14 authorized observability work is complete; full original acceptance remains open. Accepted live `d348d58` stays logged out.

## Native review S-C12-R7: faithful route-veto diagnosis

Reviewed clean parent `18dfdc662a9b59d19c75b10e58889b76bf6d44bc`, same branch/native session/workspace/route. Read AGENTS/worker workflow/assigned plans, ROOT's pre-diagnosis R7 record, both complete relevant reports, CLI/event/model journals and retained survival/memory revisions. No source/dependency/shared-file edit or companion import is warranted by the evidence. ROOT's frozen private skill/tracker/service/incident-ledger bytes exactly match this S source. All leases1–43 are released; no worker world or provider operation was run.

### Actual evidence and precise attribution limit

26.2: `/Users/jakewilcox/code/repos/minecraft-buddy/var/gameplay-fixes/acceptance-planner/var/live-check/2026-10-08T18-32-06-343Z-26.2-ordinary-goals/report.json`, unchanged SHA256 `63cf05be25215eeabae15cd7458b135fa35d1b5c5055f83654c24c3e81b7bb1e`, frozen `dde21d6`. RC1 passes, RC2C fails the original compound outcome. All3 CLI exits0 and14 cleanup steps pass. RC2C journal `data/runs/run-b15bc3920005/events.jsonl` has233 records; it retains no raw item spawn/stack/position packet journal, observation snapshots, vetoing entity id or classifier receipt. Planner request telemetry records snapshot ids/counters, not the full input observation; planner.jsonl retains the model's proposals/terminal feedback, not missing drop facts. No RC2C `survival_own_collect`, regained or incidental event exists. No other packet journal is present in this supplied run directory.

The server-backed durable incident is exact: site `(205.5,-60,205.5)` in overworld; last-alive planks16 digest `3caf343e254da941`, bread8 digest `61b6386c6ecbf0e1`, logs2 digest `df010a8c8819bbe2`; all metadata `server_slot`. Revisions8–10 retain all26 missing, no retained/regained/incidental entries, no searched-site claim, attempt1 ended `cannot_execute`, and budget3 planner turns/1 task/1 replan/1 admission/30581ms. This inventory evidence identifies the lost kit, not the unknown vetoing entity.

Support `goal-1d44c1c9e966` epoch3 anchors at `(-2.5,-60,-9.5)`, radius128. Action `act-f02818815fee` issues one path command, navigates2855ms/pathUpdates1 and stops at `(7.3,-60,-4.5)` with `unrelated_loot_nearby`, navigation distance11.95/stuck. Next `act-493b0fbde93b` and `act-e08842ab9cb6` have no path command, elapsed navigation0, and preserve that position/refusal. All three receipts have counted0/incidental[]/nonItem[]/byKey{}. Retries exhaust; support and continued original owner goal truthfully block. The first endpoint is11.0 horizontal blocks from the unchanged support admission anchor, and no `route_leg_started` event exists. Zero expanded legs/distance is consistent with initial admission-bound motion; it is not proof of uncharged expanded authority. Read-only L source review shows its callback throws after a veto receipt before route-runner post-await accounting; L owns any exceptional-return bookkeeping diagnosis, and S changes no route allowance.

26.1.2 comparator: `/Users/jakewilcox/code/repos/minecraft-buddy/var/gameplay-fixes/acceptance-native/var/live-check/2026-10-08T18-32-06-301Z-ordinary-goals/report.json`, unchanged SHA256 `c432f7f0e4104709e37c464459c811adf1b688819fc7ae1b9f8ad0b0504c6a09`. Its RC2C also has one generic pickup veto at `(147.5,-60,129.5)` before the next route action arrives2.2 from the site. The veto's exact drop is likewise absent from retained facts. Actual own collects then prove planks24 entity3043/incarnation6/digest `3caf343e254da941`, first server position `(204.7416391404649,-60,205.96809115755264)`, and bread8 entity3042/incarnation5/digest `61b6386c6ecbf0e1`, first position `(199.67471281712545,-60,206.04668511061794)`. Scoped settlement and revisions11–13 credit exactly32 with no incidental items, status recovered; the original historical craft/current equipment outcome passes. This excludes a blanket inability to use the shared guard. It does not establish either veto's cause or make the 26.2 failure a version defect.

### Production control findings

Source trace narrows the recorded `unrelated_loot_nearby` to an unfrozen item rejected by `classify`: missing/outside first-server origin, unstated stack, unsought key, wrong/unproven component identity, or a whole pile/per-identity count exceeding remaining room. A frozen id whose facts disappear/change takes the distinct R6 `target_changed` path. Loaded pickup guards still use horizontal2.5/vertical2.5 reach at the bot and own site, with entity/physics checks, latched refusal and fenced path/control cleanup. The existing callback forwards those refusals correctly. No retained record distinguishes the listed classification causes.

Credential-free production tracker/service/SkillExecutor/Actuator/navigation controls demonstrate four different causes with the same generic receipt: server-announced item68 at the site with no stack metadata; plain bread4 with matching digest but first announced at `(0,64,0)` and later present near the bot; stated bread64 where only4 are missing; named bread4 with changed digest `95a90d4b6b64e089`. Each refuses before a path command, collects nothing, credits nothing, revokes controls and preserves attempt/budget snapshots. These are controlled fixtures, not reconstructed actual R7 entities. The first probe's test oracle incorrectly expected `customName` text where the contract intentionally stores a boolean; its direct1 log/source is preserved, the oracle is corrected totrue, and final direct0 covers all four cases. No product code was changed to pass that probe.

### Minimal diagnostic and staging proposal for ROOT

Propose one first-veto object per action through the existing `ctx.progress({ recoveryPickupVeto: ... }, 'local')` outcome-evidence seam. Include goal/connection epoch/dimension/sample time, entity id, bot-versus-site pickup-check region, exact classifier reason, nullable server facts `{key,count,incarnation,digest,packetAtMs}`, origin-present/nullable distance from the incident, current horizontal/vertical pickup distances, frozen facts if any, and the remaining key/identity room used by classification. Capture at refusal before later mutation; retain null for unstated facts. One bounded object, no raw components/labels/entity dump or new store/framework. Mixed client position/server packet facts remain labeled local and never change confirmation, ledger effects, return credit or permissions. The callback signature stays unchanged. This is a proposal for subsequent ROOT-directed work, not an implemented diagnostic or an inferred cause.

Current setup only proves absence of scene entities inside x196..224/z190..224. It contains no clean item baseline around actual respawn `(-2.5,-60,-9.5)` or the first stopped pickup area. Recommend ROOT/P establish a server-stated owned-spawn standing/item baseline before a future owner-goal admission and collect the first-veto object. If an unrelated entity is present, record its packet identity/position and refuse the staging case; do not delete/move it or permit passive collection. If ROOT chooses a player-local spawn inside the already approved scene, that needs a separately authorized bounded setup with complete original player spawn-field capture/restoration; no global spawnpoint/rule change, in-trial teleport/restored gear, footprint expansion or current worker authority is implied. No actual contamination or lost-item fate is claimed.

### Checks, source/build and remaining work

Own checkout/Node24 PATH only. Affected motion/packet tests direct0 (**22/22**); final four-case diagnostic probe direct0 (**1/1**). Logs/source: `var/native-recovery-review/r7-affected.log`, `r7-guard-controls.test.ts`, `r7-guard-controls.log`; initial oracle failure remains `r7-guard-controls-initial.{test.ts,log}`. Both supplied report hashes were reverified unchanged after inspection; structured receipts are in `r7-evidence.json`.

This handoff changes only this role review. Application source remains18dfdc6; development dist remains152 JavaScript files with digest `24a9507a59c71b51ea59a78dc81deb6698b9eb939196dabfbe8699449ffcde81`. Its last required full gates remain R6's direct typecheck0/build0/tests843/843/doctors0/0; no unchanged whole suite/build was repeated for a documentation-only diagnosis. ROOT's combined frozen dde21d6 independently has1415/type/build/doctors/real-probe0 per the coordinator. ROOT owns capture of the missing veto facts, any staging permission, L accounting follow-up and newly frozen real RC2C/full-feature acceptance. S did not weaken any refusal, edit shared harness/source, run inference/world operations or deploy; accepted live d348d58 stays logged out.

## Native review S-C12-R6: missing live stack revokes frozen approach

Reviewed parent: clean `d24a78c923d9ae53f2b2666dafc192bc92b7a3d0`, branch `chunkbot/gameplay-recovery`, same registered native session/workspace/route as R5. Read staged and unstaged state, worker instructions and the coordinator's new narrow finding before edits. No unrelated work/draft, dependency, shared contract, app, locator or navigation file changed. All fixture leases1–34 are released; this review uses no world/provider operation.

**Reproduction:** added fixture-free controls through the production tracker/service, `SkillExecutorImpl`, `Actuator`, leases, navigation and server evidence. Server/pathfinder physics alone are simulated. The action freezes own bread4 entity25; after its first path dispatch, real-shaped destroy/new spawn packets reuse25 with no stack metadata, keep the replacement physically present, and emit entitySpawn/entityUpdate/physics events before any collect. On unchanged parent source, the prospective route consumer makes16 further simulated movement ticks from x24.5 to30.5 and collects the unknown replacement. It gives zero own-return/evidence-ledger credit, but retains intentional approach authority. The local pickup executor separately stops via its existing destroyed-without-collect journal check. Parent reproduction direct exit1: two gap controls fail, the legitimate collect/destroy control passes (1/3). This is a code-path reproduction, not attribution of any prior live trial failure.

**Correction:** `pickupPlan.admit` now returns `target_changed` whenever a frozen entity lacks current server-stated drop facts, as well as when its incarnation/key/count/components changed. Destroy/reused-spawn or empty stack metadata can no longer leave old frozen facts as movement authority. Frozen facts remain available to the separate packet settlement code; an already-confirmed own collect is not discarded by this approach veto. No new authority, counters, timestamps, budget reset or shared API is introduced.

The discriminating controls pass for both the local pickup executor and the forwarding route consumer: zero intentional movement after the gap, unchanged x/controls revoked, no collect/no credit when no collect packet arrives; an unavoidable packet during post-stop correlated inventory settlement stays keyless incidental4 with unknown incident attribution and zero return/ledger credit; and exact own bread4 collected/destroyed before an entity event still settles once as succeeded with server attribution and no incidental effect. Original attempt/budget snapshots remain identical, and guard listeners are removed. Existing R4/R5 adverse controls remain passing. The forwarding test skill is not the actual locator consumer or world acceptance.

**API/integration:** the approved `navigateRecoveryTravel(service, ctx, options)` signature and optional recoveryTravel callback are unchanged. ROOT should import this focused follow-up after `d24a78c`; P remains sole app binder and L sole locator consumer, restricted to existing verified own-death routes with original route/leg/cumulative/cancellation limits. No shared-file edit is required by R6. Ordinary RC2C/full-feature acceptance remains ROOT-owned and open.

**Direct settled checks:** own checkout with `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH; motion controls0 (16/16), typecheck0, build0, full tests0 (**843/843**,206 suites), read-only doctor26.1.2=0, doctor26.2=0. Doctors only observed fixture readiness; no setup/start/stop/join/RCON occurred. Logs are `var/native-recovery-review/r6-{motion,typecheck,build,test,doctor-261,doctor-262}.log`. Unchanged parent source, exact reproduction tests and failed log remain at `r6-parent-survival.ts`, `r6-parent-reproduction-tests.ts` and `r6-parent-reproduction.log` in that directory. Parent survival source SHA256: `6dd01c8648d8e26e181846dcf35375e5a09fa012c03edd3daaf46f59c38b3978`.

Final development build:152 JavaScript files; sorted `path + NUL + bytes + NUL` SHA256 `24a9507a59c71b51ea59a78dc81deb6698b9eb939196dabfbe8699449ffcde81`. No new running version or deployment. All prior failure evidence remains unchanged; live `d348d58` stays logged out.

## Native review S-C12-R5 / N1-C12-R5: route pickup accounting and guidance

Reviewed parent: clean `96074f6ca0cf6fae86cfd47e032726cf69b66afd`. Same native session `session-cd2c0bb0-accc-422b-bb20-b5a6b43d25a9`, workspace `7644839f-cfc9-419c-998e-f3f139ff4ac6`; account/model/access stay at the coordinator-verified personal native route. Read the worker workflow/plans, staged and unstaged state, and ROOT's complete 14:53 UTC finding before editing. No native draft, unrelated work, dependency, common contract, locator, planner, app, task, perception or navigation file was changed.

### Real evidence and its limits

26.1.2 report: `/Users/jakewilcox/code/repos/minecraft-buddy/var/gameplay-fixes/acceptance-planner/var/live-check/2026-10-08T14-43-27-183Z-ordinary-goals/report.json`, SHA256 `fc57a7ee8d29ecd1c3a8a05a8b9bced7fcccc207ce8a870ea415ff8177b5713a`. Read the complete report/setup/interventions, run log, event/planner journals and retained survival/memory revisions. There are no material interventions after death until cleanup. Support `goal-d63b7b1281e2` epoch3 used two route legs, reached distance2.2, then recovered8 bread. It blocked at14:46:34 with16 planks/2 logs still sought. Owner `goal-5bac1db384f6` epoch1→5 retained its baseline6 logs/8 bread and verified historical craft16; later server-confirmed table/stick/pickaxe crafts consumed planks and current equipment completed the owner outcome. Persisted revisions9–11 still record only bread regained8, no incidental effects, support `cannot_execute` and unchanged finite budgets. These artifacts do **not** persist the raw item spawn/metadata/collect or intermediate full inventory contents needed to identify those18 item returns. Later ingredient availability is not proof that all18 were returned from this incident. Their historical attribution is unresolved; no prior episode/report was relabeled.

26.2 report: `/Users/jakewilcox/code/repos/minecraft-buddy/var/gameplay-fixes/acceptance-native/var/live-check/2026-10-08T14-43-27-044Z-26.2-ordinary-goals/report.json`, SHA256 `3e617da7025d984a9266c126c7014ee5dac8f20833775cdd08e0a70bf3a8a480`. The complete log and planner journal show craft24, death, unchanged effect credit24 and support `goal-85e0d7ae2ed2` with zero task admissions/actions. After querying both route/local capabilities it declined a287-block site using the obsolete blanket local-primitive routing wording. All12 cleanup checks and both CLI exits0 remain preserved in each report; leases29/30 are released.

### Owned correction

The actual service defect is independently reproduced with production tracker/service packets: `onOwnCollect` discarded **every stated item** while death recovery was active. Only the survival skills' frozen pickup plans called `recordRegain`, so a separate route's passive collections never reached either incident-return credit or the durable episode. The new 16-plank/2-log test fails against preserved parent source (`pending` instead of `partially_recovered`). The supplied historical packet gap prevents assigning this as the proved cause of those exact18 returns.

Only entities actually frozen by an executing pickup plan now defer settlement. Every other exact own collect goes through the existing incident ledger's connection/dimension/first-announcement/whole-stack/component rules, then updates a still-sought durable episode and its memory record once with provenance `server_attributed_collect`. Unknown, wrong identity, oversized/merged and foreign-origin collections never receive own-return credit. Known incidental loot is recorded by key; unknown stays keyless. The whole server-stated pile must fit its identity remainder even when the collect packet takes only a smaller amount. Known non-items remain excluded. All own item/unknown collections now emit bounded `survival_own_collect` facts (epoch/entity/count/packet time/key/stack count/component digest/incarnation/first announcement/settlement path), making a new run's attribution inspectable without inventing missing old evidence.

Frozen plans close in `finally` and on lifecycle/support revocation. A known packet whose frozen settlement cannot finish makes lineage unknown (`frozen_plan_settlement_incomplete`), preventing phantom continuation acquisition. Tracker-local spawn incarnations fence entity-id reuse, including an identical replacement key/count. Settlement reconciles already-reported passive packets by monotonic cursor and packet order/count, rather than independently sampled tracker/journal clocks; known incidental packets are not duplicated. Existing book limits are preserved; new plan/packet buffers are bounded at16/256 entries. No admission, attempt, baseline, outcome, task/planner count, deadline, travel or spend authority is reset/refilled.

The shared pickup classifier now checks first server announcement inside the incident radius and ordinary stack components as well as valuables. Piles and neighboring piles cannot borrow the still-missing allowance of another component identity. Both local recovery entry points use these rules and retain their travel/search bounds and cancellation behavior.

N1 guidance now describes `go_to_death_site` as a local primitive and conditionally explains separate registered/authorized `route_travel(destination: own_death)` followed by scoped recovery. A far support proposal mentions that composition only after the existing code-owned `farRoute` seam supplies a route policy; an absent seam still blocks distant recovery. Arrival does not grant loot credit, widen the local radius or require the local primitive to own long-distance authority. No phrase/goal handler, forced output, action replay or follow-up question was added.

### Exact shared dependency / API

S exports the following from `src/skills/survival.ts` (no common continuation declaration changes):

```ts
navigateRecoveryTravel(service: SurvivalService, ctx: ExecuteContext, options: NavigateOptions)
  -> Promise<
       { error: string; detail: string } |
       { navigation: NavigateResult & { aborted?: string };
         pickup: { counted: number; incidental: string[];
                   nonItem: string[]; byKey: Record<string, number> };
         veto?: string }
     >
```

The helper validates the bound goal/connection/dimension, exact durable episode/fact and frozen admission; wraps **one existing navigate call** using the caller's unchanged route leg/bounds/deadline/options and existing actuator; checks bot/destination pickup areas before dispatch, after ordered resync, and before physics/entity motion; clears owned controls on a veto; settles packet-confirmed planned/passive effects after the stopped path's resync; marks arrival only inside the original recovery arrival radius; and always removes the guard/plan. It starts no second actuator or route controller and grants no route authority.

ROOT must direct the shared/dedicated writers: P owns `src/app/skill-runtime.ts` composition; L owns `src/skills/locator.ts`. Minimal proposed locator dependency is an optional callback `(ctx: ExecuteContext, options: NavigateOptions) => ReturnType<typeof navigateRecoveryTravel>`, bound by composition to the current S service and consumed **only** for a verified own-death recovery destination. Keep existing route provider verification, ownership/leg bounds, cumulative counters, deadline and navigation cancellation; propagate `error`/`veto` as structured failure and include `pickup` in route effects/evidence. Other route destinations continue their existing path. No P-owned `src/skills/navigation.ts` edit is required by this helper. Until that consumer is wired, the service accounting correction works for unwrapped exact passive packets, but the ordinary locator route lacks the S foreign-loot veto/arrival bookkeeping. This is an explicit integration blocker, not an integrated feature claim.

S-owned `DropStackFacts` adds required tracker-local `incarnation: number`; regained provenance adds `server_attributed_collect` alongside the existing value. Existing v3 revisions remain readable; v1 raw-checksum migration and original lost/regained distinctions are unchanged. `ContinuationSurvivalPort` signatures remain unchanged. P must keep its NEWER canonical `src/contracts/continuation.ts`, actual run `sessionId`, fresh connection gate, immutable semantic accounting and unknown-return holds; no arithmetic compensation belongs in S.

### Offline evidence and remaining acceptance

Node24.21.0 first in PATH, own checkout/dependencies/dist/var only. Final direct exits: typecheck0, build0, full suite0 (**840/840**), doctor26.1.2=0, doctor26.2=0. Both doctors are read-only/inference-free; existing26.1.2 fixture status was only observed,26.2's missing local JRE/server remain warnings. No setup/start/stop/join/RCON was run. Logs: `var/native-recovery-review/r5-frozen-{typecheck,build,test,doctor-261,doctor-262}.log`. Final built152 JavaScript files, digest of sorted `path + NUL + bytes + NUL`: `cdc789267f6d874254e863a6e440e11a6d58297a907433a9e99393d58255bc5d`. This is a development build; no new running/live version exists.

Production packet tests cover route-passive planks16/logs2 plus scoped bread8 exactly once, full durable pickup/reload with original lost counts and admitted budgets, unknown/known foreign/partial oversized/wrong identity/orb controls, foreign first-announcement despite later movement, absent route authority/local radius, unfinished frozen settlement and same-id/count receipt separation. Production `SkillExecutorImpl`/`Actuator`/lease/server-evidence/resync controls cover guarded route passive pickup, moving foreign pile before pickup, a refusal latched while the foreign pile moves away during resync, cancelled motion, late foreign effects, unknown/orb/merged piles, ordinary component mismatch, identical entity-id replacement and per-identity count reservations. The route consumer in these tests is a credential-free forwarding test skill, not a claim that the locator route is wired. Three selected new controls fail against preserved parent source (direct1,0/3); source and all intermediate failures remain under `var/native-recovery-review/r5-prior-source*` and distinct `r5-*` logs.

Full original outcome remains open: ROOT must review/import the focused owned correction, direct the route consumer, freeze combined source and run newly leased both-release module and real ordinary RC1–RC4/provider/restoration gates. New collect telemetry must establish the actual route-return attribution; do not infer it from later crafting or retroactively upgrade the old reports. No new worker world/provider lease is requested or implied.


## Native review S-C12-R4: foreign pickup and settlement

The coordinator's unchanged report is `/Users/jakewilcox/code/repos/minecraft-buddy/var/gameplay-fixes/acceptance-recovery/var/live-check/2026-10-08T05-00-48-534Z-survival/report.json`, source `b87e213`, direct exit 1. G1/G1k passed; G2/G2b failed. The server stated entity 68 bread64 and entity 25 own bread4 before travel. After six `unrelated_loot_nearby` refusals, collection packets returned foreign64 first and own4 later. Settlement reported entity68 as stack-never-stated, incidental key null64. RCON bread68 did not equal regained4 plus known incidental0. These are product failures, independent of whether recent changes caused them; the oversized/mixed/wrong-identity and truthful-accounting oracles remain intact.

G3 separately suffered `death.attack.mob` during health/food staging: food was 18 at death, then respawn reset food20 and removed the hunger effect, leading to the food<18 timeout. That is interrupted staging, not evidence of a regeneration regression. All eight restoration checks and the coordinator's exact pre/post readback passed. Lease `gameplay-root-codex-S-261-07` is released; S has no driver lease.

First focused correction: tracker retains up to 256 packet-time own-collect stack copies across entity destruction. `SurvivalService.collectedFacts(connectionEpoch, entityId): DropStackFacts | undefined` exposes settlement history only; `dropFacts` still requires a current live entity. Reused entity ids, login, respawn and replacement connections clear old history. Unplanned collected items retain their server-stated key/count in incidental reporting but never enter the `picked_up` effect ledger or own-return credit. Unknown stacks stay unknown and known non-item controls remain ignored. Public `ContinuationSurvivalPort` is unchanged; P must keep its newer canonical shared declarations and arithmetic.

Discriminating actual tracker/service/`go_to_death_site` executor regression reproduces bread64 collect then destroy before settlement: before correction exit 1, actual `entity 68 (stack never stated) x64`; corrected `minecraft:bread x64`, incidental bread64, no ledger or regained credit, no resurrected target. Packet controls also cover copies, bounded history, id reuse, unknown stacks, other collectors, orbs and life/connection reset. Typecheck/build/full tests/both read-only doctors all exit 0, full suite 818/818. Logs: `var/native-recovery-review/r4-settlement-{test,doctor-261,doctor-262}.log`. Focused commit `332c546ee812336f4e712c5f311836b3367f6b44`.

Second focused correction `1bbc9d7da8d3cd6c51e66fb24f7d446bd9722839` protects both recovery movement entry points through the existing fenced `navigate`/`Actuator` API. The S-only wrapper checks before dispatch, latches any veto, and clears the owned path/controls immediately on entity move/spawn/update and before pathfinder's physics tick. Recovery rechecks BOTH the bot and current target's pickup area, retargets moving own drops, and retains original travel/search bounds. The guard is removed in `finally`; inactive leases cannot clear replacements. There is no second actuator owner or motion controller and no P-owned navigation edit.

Settlement now follows the stopped path's ordered inventory resync, including collections that arrive during that await. A planned entity only earns credit when the packet-time collected stack key/identity/count and total collected count remain within its frozen whole-stack plan. A changed/merged planned pile is reported as incidental and makes that incident's return attribution unknown; it does not receive a partial own-return or effect credit.

`tests/survival-motion.test.ts` uses real `SkillExecutorImpl`, `Actuator`, leases, registry, service/tracker, server evidence and correlated resync; the bot/server/pathfinder movement alone are simulated. Seven controls cover foreign movement during resync (zero path dispatch), destination movement between polls (immediate control clear before pickup), late foreign collection during settlement (known incidental64, own return4), own/unknown/orb packets, a planned pile becoming64 (zero credit, unknown), stop/cancel (no movement/collect/command after revocation), and moving own drops (fresh retarget, exact4). Re-running three controls against the preserved pre-motion skill source `332c546` exits 1: two collect both piles (delta68), the third falsely credits4 from a collected64 pile. Adverse sources/logs retained in `var/native-recovery-review/r4-before-motion*`; this is discriminating offline executor evidence, not a world trial. Corrected focused tests exit0; typecheck/build/full suite825/825 and both read-only doctors exit0, logs `r4-motion-*`. Public continuation port unchanged; only S's internal `recordIncidental` gains optional `uncertainReturn`. P needs no new shared seam for these corrections. Full acceptance stays open.

### G3 mob-isolated staging (harness correction)

G3 now builds a glass shell/roof with a sea-lantern floor at `196 -61 196` through `214 -51 214`. This 19×19 bounded station leaves exterior mobs outside the existing 8-block visible-threat guard at the unchanged center `205.5 -60 205.5`; it does not relax any product hazard check. Both fills, eight block probes, existing-occupant query and centered-bot query are recorded with their replies. Strict readback accepts only verified success and refuses existing non-player occupants or unknown replies; no mobs are removed. Transparent walls/roof keep the scene observable while stopping approach/projectiles and the lighted floor prevents new natural spawns inside. This is a planned future trial setup, not evidence that any world was changed by S.

The entire station remains inside the original scene `196 -61 190` through `224 -50 224`, covered by the SAME existing clone and verified restoration to/from backup `196 200 190` through `224 211 224`. No fixture settings/clock/bed/respawn/forceload footprint is added. G4/G4n remain skipped. Existing in-trial kit-restoration, mixed-pile, wrong-identity and exact inventory-delta oracles are unchanged. If the scene already contains a mob, the harness reports `physiology_staging_failed` rather than removing it or claiming a product result. Every food/health staging poll checks the same captured life; an intervening death, including a completed auto-respawn, immediately reports `physiology_staging_interrupted` with the actual captured cause instead of waiting on hunger erased by death.

Offline harness controls apply emitted fills to an independent voxel model and check every wall/roof/floor/interior voxel and footprint bounds; refuse positive occupant counts10/20 and unknown replies; and reproduce the actual death.attack.mob→respawn(food20) staging interruption. Missing/invalid lease guards still exit2 before any fixture secret read, join, mutation or report directory. Guard suite16/16 passes. Final Node24.21.0 direct exits: typecheck0, build0, full tests0 (828/828), doctors26.1.2/26.2 both0; `git diff --check`0. Logs `var/native-recovery-review/r4-final-{test,doctor-261,doctor-262}.log`; previous adverse logs retained. The 26.2 doctor still warns missing local fixture assets; no setup/install was attempted. Own152-JavaScript `dist` digest (sorted relative path/NUL/content/NUL SHA256): `d53b7a83bfdc170de1494afc0a8e194e31f64baa987971240f08f5a9c2288973`. No development build was deployed or run as gameplay. The original root failed report remains unchanged, SHA256 `62817d2b3fc13680c5c38f414f1f9e3c6c324a3bfd5167f24be4a10e688c7d77`.

Ready coordinator handoff: import the three focused S corrections on top of the preserved source chain through `5a4b560` and native `c4ae9b5`/`1046ebf`/`b87e213`; preserve P's newer common continuation declarations and acquisition arithmetic. No shared edit or new typed navigation seam is required. Retain actual run `sessionId`, pre-login tracker attachment, fresh-connection readiness and unknown-return holding. S has no fixture lease; coordinator must freeze the combined source and run new exclusive26.1.2 then26.2 module evidence, followed by ordinary RC1–RC4/provider acceptance. Latest actual world evidence is still the FAILED `b87e213` report; correction tests do not close full acceptance. Accepted live `d348d58` remains logged out.

## Native correction: S-C12-R3 unknown own collect

- **Reproduced before the fix:** real `SurvivalTracker`/`SurvivalService` packets record bread loss 4, own death, respawn and the first full empty inventory sync. An own `collect` for an entity never announced then leaves `incidentReturns.attribution` at `server_attributed`. Tests also reproduce the same error after a verified partial return and during the real `go_to_death_site` executor. Before correction: focused command exits 1, 22/25 pass, three attribution assertions fail (the corrected test uses the exported `continuationPort`, not a service method).
- **Cause:** the tracker records kind `unknown` then returns without emitting anything. The service also suppresses every collect while recovery runs, including unplaceable collections that its pickup plan cannot credit.
- **Correction:** the tracker emits a separate `own_unknown_collect` event with the server's collector/count/connection evidence and no invented stack or position. Known server-announced non-items remain excluded. The service delivers unstated collections to the existing conservative incident ledger even during active recovery; stated planned pickups remain exclusively credited by `recordRegain`, once. No count/baseline/outcome/epoch/allowance authority is changed.
- **Controls:** eight scoped/unscoped packet cases cover known own bread (exact regained 4), unknown entity and announced item without stack (unknown, regained empty), and known orb (attributable, regained empty). A later full inventory sync does not turn an unknown return into credit. Partial verified regained 1 is retained when another collect becomes unknown; another collector cannot taint it. Actual recovery executor controls assert unknown incidental effects provide no item ledger credit, planned cobblestone returns count once, and known orb effects provide neither credit nor ambiguity.
- **API / P integration:** `ContinuationSurvivalPort`, `IncidentReturns`, `continuationPort(service)` and `createSurvivalService({sessionId})` signatures are unchanged. `TrackerEvent` adds one internal discriminant, handled inside S. P must retain its newer canonical `src/contracts/continuation.ts`, pass the actual application run id, read returns freshly and hold lossy count atoms when attribution is unknown. P-C12-R3/R4 arithmetic remains P-owned. No shared file is changed by this correction.
- **Offline checks (Node 24.21.0, direct exits):** focused tracker/continuation/incidental tests exit 0 (37/37); `npm run typecheck` 0; `npm run build` 0; `npm test` 0 (813/813, including missing/invalid lease guards); both `npm run doctor -- --config config/examples/fixture.json` and `fixture-26.2.json` exit 0. Doctors never connect or infer. The 26.2 doctor reports missing local fixture JRE/server as warnings; no setup was attempted. Existing dependency pins were reused.
- **Source/build/runtime:** only this worktree's source and `dist/` were used. No application, fixture driver or provider process was started. All old failed reports remain unchanged. No lease is requested to repeat unchanged passing module world trials; the coordinator owns combined RC1–RC4 and any further exclusive fixture trial.

## Commits

| Commit | Content |
| --- | --- |
| `2ffdf10` | C8/C9/C10 corrections, harness, offline tests |
| `549ce47` | The proposed C12 typed seam (declarations only, not consumed) and this review |
| `41733b2` | The status projection enforces the declared 4,000-character bound (C10 added fields) |
| `08c9d89` | Coordinator schema review: state/count consistency invariants, v1 migration that reconstructs the original lost count from recorded regains, old-revision fallback tests |
| `eb4456b` | Review doc commit id |
| `d3b3e9f` | C12 proposal revision 2 after the joint review (declarations only) |
| `f55329a` | v1 `regained` label without a recorded regain → explicit `unknown` (no invented regains); no-recorded-regain regression |
| `8e87ec3` | Bed correction: G4/G4n removed from the leased run (always SKIPPED with the R8/respawn reason); no bed, respawn-point or clock write; guard tests. **Frozen C8/C9/C10 candidate for the 26.1.2 module lease.** |
| `07a3b65` | Docs: first leased 26.1.2 trial record and corrected build provenance |
| `ac5da9b` | G3 correction: health-support meal exempt from the ordinary eat cooldown (fresh vitals/food/threat checks kept); harness decision evidence and drift-free low-health staging; discriminating tests. **Frozen candidate for a 26.1.2 rerun.** |
| `82d7ede` | C12: P's continuation contract restored verbatim from `4409ba1`; duplicate S declarations removed; `ContinuationSurvivalPort` implemented (in-memory incident return ledger, gate, display-only checkpoint records, store schema v3) with tests |
| `266b648` | Trial findings T2/T4 corrected (collects of server-announced non-item entities such as experience orbs are never loot or incidental; the pickup effect names every counted key); `createSurvivalService` passes `sessionId` through |
| `5a4b560` | Coordinator rerun recorded; `continuationPort()` accessor with a type pin to P's contract; the gate waits (`not_alive`) while no connection is attached; exact P integration inputs |
| `c4ae9b5` | S-C12-R3: unknown own collect reaches incident lineage, including during recovery; exact positive/unknown/non-item packet and executor controls |
| `1046ebf` | C12 incident accounting starts at the first full respawn inventory sync; a pickup before positive health cannot disappear from return lineage |
| `b87e213` | C12 gate requires the attached connection's full server inventory and positive server health; detached/seeded/last-alive health cannot clear it |
| `332c546` | R4: bounded packet-time collected stacks retained through destroy; known incidental keys, no incidental effect credit |
| `1bbc9d7` | R4: moving-pile veto before dispatch/between polls, fenced path/control clear, changed whole-stack settlement validation, real executor adverse controls |
| (G3 enclosure correction, this commit) | Transparent/lighted scene-contained physiology staging, strict occupancy/position readback, immediate honest death interruption; same clone restoration |

### First-sync packet boundary correction

After `c4ae9b5`, the remaining packet-order review reproduced a known own bread return of 4 arriving after the first empty respawn inventory sync but before positive health. The service waited for `respawn_ready` to assess incident loss, so the collect found no assessed incident and vanished; a later inventory sync could not repair that attribution. The discriminating regression exits 1 before correction (expected regained 4, actual empty).

The tracker now emits an internal `respawn_inventory` event exactly at the first full sync. Only the read-only continuation incident book is assessed there. Recovery episode assessment, support admission and continuation readiness still await positive health; the later `respawn_ready` assessment is idempotent and cannot refill or replace the first-sync baseline. Four actual tracker/service packet controls cover exact own return, unannounced entity, announced item without stack, and known orb in that interval. A second full inventory sync cannot turn returned items into retained possessions. The public P port remains unchanged. Focused tests exit 0 (38/38) and typecheck exits 0; final offline checks are recorded below.

### Current connection readiness correction

The final S-owned boundary review reproduced `continuationGate: clear` on initial attachment before any inventory/health packets (test exit 1), and found that `detach()` retained the old epoch via tracker options. The gate now requires a current attached connection, a full `server_packets` inventory sync, and that connection's positive server health packet. Library seed data alone cannot clear it. The tracker exposes no current epoch after detach; its bounded death/return evidence remains historical. The existing shared `SkillRuntime.onBotCreated` hook attaches before login and must be retained by P, so join-time packets are observed rather than requiring an invented health refresh.

A second adverse packet test (exit 1 before correction) demonstrated that a lifecycle death without a zero-health packet reused last-alive health at respawn. Post-death respawn now resets the server-health gate; `respawn_ready` requires a health packet after respawn. This changes neither incident evidence nor any goal, travel, task, provider or episode allowance. Packet controls cover initial partial readiness, logout/detach, late old-source packets, a new epoch with library seed, current inventory then current health, service close, and lifecycle death with no zero-health packet. Focused tracker/continuation/incidental/wiring tests exit 0 (47/47); typecheck exits 0.

P integration remains exact: retain its newer common continuation declarations; use `continuationPort(skillRuntime.survival)`; pass `sessionId: options.store.runId` to `createSurvivalService` in `src/app/skill-runtime.ts`; retain pre-login attachment and synchronous death capture; read returns at each fresh rebind/evaluation and treat unknown lineage as held. P owns acquisition arithmetic, original immutable outcome/baseline/anchor/counters, stop/supersession and L's canonical route carry. No shared application or common continuation file was edited in this native correction chain. New world/provider acceptance requires the coordinator's named exclusive fixture lease and combined immutable build; all earlier S leases remain released.

### Final native offline evidence

All commands ran in S's own worktree with `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH; exit codes are direct tool results, without a success-hiding pipeline.

| Check | Exit / evidence |
| --- | --- |
| `node --test --test-reporter=spec tests/survival-tracker.test.ts tests/survival-continuation.test.ts tests/survival-incidental.test.ts tests/survival-wiring.test.ts` | 0, 47/47 |
| `npm run typecheck` | 0 |
| `npm run build` | 0 |
| `npm test` | 0, 816/816; complete log `var/native-recovery-review/final-npm-test-v2.log` (the earlier 815/815 pre-final-health-reset log is retained separately) |
| `npm run doctor -- --config config/examples/fixture.json` | 0; `var/native-recovery-review/final-doctor-261.log` |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | 0; `var/native-recovery-review/final-doctor-262.log`; missing local fixture JRE/jar are warnings, no setup performed |
| `git diff --check` | 0 |

The final application source is in this readiness correction commit, on top of `1046ebf` and `c4ae9b5`, over the unchanged handoff `9f15b55` / preserved source `5a4b560`. Only S-owned tracker/service, three dedicated test files and this role review changed in the native chain. `dist/` was rebuilt from that final application source before these documentation-only evidence edits. Its 152 JavaScript files have path/content sha256 `3fa13d42aa5b2817960b12656b0b1115733e15b70bdd0f3903841c696b7ef015` (sorted relative path + NUL + contents + NUL). No application was launched from it; the accepted live artifact remains `d348d58`, logged out. No native draft, unrelated work, earlier commit, failed world report or fixture was reset/discarded.

**S-owned state:** recovery/continuation service corrections implemented and verified offline, ready for combined coordinator review. **Remaining external dependencies:** P's common GoalEngine/accounting/wiring corrections and combined ordinary RC1–RC4 world/provider acceptance. This is not integrated-feature acceptance. No new world harness, real gameplay Codex/Jev turn, vault helper, controls, online account/config/cache or server/client/world operation ran during the native handoff.

Owned paths changed:
- `src/contracts/survival.ts`
- `src/survival/{episodes,policy,service,store,tracker}.ts`
- `src/skills/survival.ts`
- `tests/survival-{helpers,harness-guard,persistence,incidental}.test.ts`
- `scripts/survival-live-check.ts`
- this review

No shared or companion file was edited.

## Reproduced failures (trial batch002-2472442, report `2026-10-07T03-16-10-804Z-survival`)

The failed report was read without changes from `/Users/jakewilcox/code/reviews/chunkbot-mc/batch002-2472442/var/live-check/…/report.json`, along with that run's durable survival revisions. Nothing there was overwritten.

### C9: invalid stored record after a server-confirmed pickup

- **Evidence:**
  - `recover_lost_items` collected `cobblestone x20` (one `collect` packet, confirmed delta 20).
  - The next write failed with `invalid survival body: Too small: expected number to be >0` (versions 7 and 8).
  - Authority was then revoked as `attempt_write_failed`.
  - The last durable revision (`survival-00000005.json`) held the attempt at `regained: 0` and cobblestone `count: 20, state: missing`.
- **Cause, from the source:** `EpisodeBook.regain` decremented `ManifestItem.count` (`m.count -= counted`). A whole-key regain therefore left `count: 0, state: 'regained'`, while `ManifestItemSchema.count` is `positive()`.
  - The in-memory book stayed invalid, so every later write, including the 30 s retries, failed the same way.
  - The attempt counters and budgets never reached disk after that point.
- **Offline reproduction:** `tests/survival-persistence.test.ts` uses the real service and the real atomic store. On the base source it fails with exactly that message (`version 6`). On the corrected source it passes.

### C10: mixed-pile inventory exceeding the manifest (bread 5 vs lost 4; cobblestone 84)

Evidence in the report's packet log and durable files:
- **Respawn:** `respawn > window_items (empty, the authoritative respawn inventory) > update_health 20 > set_slot slot36 > set_slot slot37`. The two `set_slot` packets came 36–44 ms after the sync, before the harness teleported the bot, and with **no `collect` packet**.
- **Attempt start:** the durable attempt-start preparation signature (`foodItems: 5`) shows the bot already held 5 bread before any recovery action.
- **Recovery:** made exactly one collect (`cobblestone x20`, counted 20, confirmed delta 20). The final `clear` removed 89 items from slots 36, 37 and 38: 5 bread, plus 64 and 20 cobblestone.
- **Cleanup:**
  - The tagged-pile kill removed 3 entities (the foreign bread 64, dirt 3 and the wrong sword, all still on the ground).
  - The final scene kill removed 3 more: the never-collected own bread, pickaxe and sword.
  - The pickaxe, sword and bread were not recovered because the C9 failure revoked authority after the first pickup.

Attribution: bread 5 and cobblestone 64 were inventory gains **at the respawn point**, outside any recovery action. They were not foreign scene piles and were not oversized recovery collections.
- **Hypothesis, not proven:** the source is loose items near the world respawn point left by earlier harnesses. For example, `dashboard-live-check.ts` gives this bot `bread 5` and `cobblestone 70`.
- **What was proven:**
  - The summoned piles' server stack facts were not recorded, so their packet-level identity was not proven in that trial. The corrected harness now records them.
  - No foreign or unrelated loot was counted as regained; the regained count was cobblestone 20 only.
  - The harness's absolute-count oracle (`bread <= 4`, `bread === 4`) attributed the respawn-point gains to the recovery.
- **Latent defect:**
  - The loss assessment ran at `update_health`, which here came 8 ms after the empty sync.
  - A pickup arriving between the sync and the health packet would have been counted as **retained**.
  - `go_to_death_site` neither counted nor reported passive pickups while walking.

### C8: settings reply parsing

Trial 2 reply: `time query time -> "Clock minecraft:overworld is at 3466899 tick(s)"`. The harness expected `The time is N`, so it changed nothing and the settings gates never ran.

Official sources: the 26.1.2 and 26.2 `server.jar` files, read from the coordinator's compatibility area. Their `assets/minecraft/lang/en_us.json` and generated `commands.json` are identical in both versions:

| Key | Reply |
| --- | --- |
| `commands.time.query.absolute` | `Clock %s is at %s tick(s)` |
| `commands.time.query` | `The time is %s` |
| `commands.time.query.timeline` | `Timeline %s is at %s tick(s)` |
| `commands.time.set.absolute` | `Set %s to %s tick(s)` |
| `commands.time.set` | `Set the time to %s` |

- The command tree includes `time of <clock> set|query`, `time query <timeline>`, `time pause|resume|rate`.
- `data/minecraft/timeline/day.json` defines `minecraft:day` on clock `minecraft:overworld` with `period_ticks` 24000.

## Corrections (commit `2ffdf10`)

### C9: durable full pickup without losing budgets

- **Immutable lost count:** `ManifestItem.count` is now the immutable lost count. A separate `regained` counter (`0..count`, refined) records server-confirmed regains.
  - Helpers `manifestRemaining` and `manifestSought` replace every `state === 'missing' && count > 0` check (`episodes.ts`, `policy.ts`, `service.ts`).
  - A whole-key regain sets `state: regained` and leaves the body valid.
- **State/count consistency** is enforced by the durable schema (`ManifestItemSchema.superRefine`), so an inconsistent record can never be written:

  | State | Required counters |
  | --- | --- |
  | `missing` | `regained == 0` |
  | `partially_regained` | `0 < regained < count` (never labeled complete) |
  | `regained` | `regained == count` (a fully regained record is never sought or missing) |
  | `likely_destroyed`, `unknown` | `regained < count` (a remainder exists) |

  In every state `regained <= count` and `count > 0`. `manifestSought` (used by recovery targets, candidates, policy and the planner context) only ever selects `missing` or `partially_regained` items with a remainder. Status and planner quantities use the remaining count (`count − regained`).
- **Store schema v2:**
  - The checksum is verified on the **raw stored body**, before any zod default or migration, so old revisions load and a tampered body is rejected. A corrupt or tampered newest revision falls back to the last verified revision (state `recovered`), and nothing is replaced.
  - **v1 migration** (`migrateV1Body`, pure, applied after the raw checksum and before the v2 schema). v1 stored the REMAINING amount in `count` and listed regains in the episode's `regained` entries. So:
    - `lost = v1 remaining + recorded regains of that key`, `regained = recorded regains`, and the state is derived from those counters (a sought item with recorded regains becomes `partially_regained`);
    - `unknown` and `likely_destroyed` keep their remainder and are never re-sought;
    - a v1 `regained` label keeps its recorded regains as both lost and regained. **Without any recorded server regain** (an inconsistent legacy label; code-generated v1 whole-key regains had count 0 and never persisted) the item becomes an explicit `unknown` remainder with nothing regained, and an episode labeled `recovered` is downgraded (`partially_recovered` when some regain is recorded, else `unknown`) unless every item is regained, so there is no false full success;
    - nothing is invented. If v1's 32-entry regain list had dropped old entries, the reconstructed lost count is lower than the truth, never higher. The historical remaining count is never treated as the original lost count once regains are recorded.
  - It writes v2. A newer schema stays read-only and is never overwritten.
  - The load detail states the migration. A rejected body names the exact field (e.g. `at episodes.0.manifest.missing.0.regained: regained exceeds the lost count`).
- **Unknown effects:** a restart closes a running attempt as `restart_interrupted` (still counted) with `effectsUnknown: true`. Pickups after its last durable revision are never assumed in either direction, and status says so.
- **Proof:** attempt, budgets, regains and the store state survive an actual reload from disk.
- **Unchanged (C5):** authority still requires a complete durable revision containing the attempt, plus durable incident linking.

### C10: own-incident accounting only; incidental effects reported

- **Tracker:** `respawn_ready` now carries the **first full window-0 sync after the respawn packet** as the respawn inventory. It also carries the current inventory and the count of inventory packets in between, so a pickup before the health packet can never become `retained`.
- **Service:**
  - It keeps an in-process sync baseline per open episode.
  - Gains after that sync and before the first recovery action are recorded as `incidental: after_respawn_sync`, once each.
  - A server `collect` of an entity outside the frozen plan is recorded as `incidental: unplanned_collect`, with its key when the server stated it.
  - Incidental effects are durable, bounded (16) and never regained or retained.
- **Skills:** `go_to_death_site` and `recover_lost_items` share one frozen pickup plan.
  - While walking, an own drop that is acceptable by server stack facts joins the plan. Its passive collection counts as regained.
  - Any other item entity, including one whose stack the server never stated, stops the walk before it enters pickup range (2.5 blocks, polled every 100 ms):
    - near the site, the walk counts as arrival and the search continues from there;
    - otherwise it fails with `unrelated_loot_on_route`.
  - An unplanned collect yields `partial / incidental_pickup`.
- **Item states:** `missing`, `partially_regained`, `regained`, `likely_destroyed`, `unknown`.
  - When an episode concludes, the remainder becomes `unknown`: unaccounted for, not proof of despawn.
  - `retained` stays separate, and memory receives it as `retained`, never as `regained`.
- **Status** (additive): `missing[].count` is the remaining amount, plus `lost`, `regained`, `retained`, `incidental` and `effectsUnknown`. The existing consumers (`status-text`, CLI) keep working unchanged.

### C8: harness

- Exported, import-safe parsers cover the official forms: clock, timeline, set, gamerule and difficulty.
- Every original is read before any write. That includes two clock reads 1 s apart to measure the rate; a paused clock measures 0. A failed read changes nothing.
- `time query minecraft:day` (the day-timeline position) is read and parsed as well.
- **Since the bed review (see the lease section), the leased run never writes the clock.** The clock is only read, as C8 reply-form evidence, so it has no restoration step. The G4/G4n bed observations, the only clock writers, are always reported SKIPPED.
- **C10 oracle and evidence:**
  - G2 records an RCON inventory baseline immediately before the recovery admission.
  - G2 and G2b require each server delta to equal survival's regained count plus its reported unplanned-collect incidental count, key by key.
  - Full recovery is the exact lost kit as a **delta**, with the sword's identity digest.
  - The pre-recovery inventory must equal the reported after-respawn-sync incidental effects.
  - Recorded evidence:
    - respawn position and items within 6 blocks of it (read-only);
    - each tagged pile's RCON `Item` data;
    - the bot's packet-stated drop stacks (key, count, digest);
    - `set_slot` and window-sync item contents;
    - `collect` entity, collector and count.

## Checks (Node 24.21.0, this worktree's own `npm ci`)

Exit codes are captured directly: each command's output is redirected to a file, `$?` is read immediately, and the log is read in a separate step (no pipes). Latest run, on the P-inputs commit: typecheck 0, build 0, `npm test` 0 with 810/810, survival 0 with 153/153. Before that, on the T2/T4 + sessionId commit: typecheck 0, build 0, `npm test` 0 with 809/809, survival 0 with 152/152; adverse: T2 non-item branch removed → only the orb test fails (exit 1), restored. Previous run, on the C12 commit (G3 candidate `ac5da9b` ran the same checks: typecheck 0, build 0, `npm test` 0 with 793/793, survival 0 with 136/136):

| Command | Exit | Log summary |
| --- | --- | --- |
| `npm run typecheck` | 0 | — |
| `npm run build` | 0 | — |
| `npm test` | 1, then 0 | first run 806/807: `tests/connection.test.ts` "profile lookup … join timeout" wall-clock assertion under full-suite load (file and `src/game` unchanged since base; the file alone passes 15/15); re-run 807/807 |
| `node --test tests/survival-*.test.ts` | 0 | 150 tests, 150 pass, 0 fail |
| adverse: oversized-pile guard removed, `node --test tests/survival-continuation.test.ts` | 1 (expected) | only the unplaceable-collect test fails; source restored |
| adverse: health-support exemption removed, `node --test tests/survival-upkeep.test.ts` | 1 (expected) | only the G3 trial-state test fails; source restored |
| adverse: v1 migration disabled, `node --test tests/survival-persistence.test.ts` | 1 (expected) | only the v1 migration test fails; source restored |
| adverse: old `regained`-label promotion restored, same command | 1 (expected) | only the no-recorded-regain regression fails; source restored |

Earlier rounds (before the schema review):

- `npm ci`: 0
- `npm run typecheck`: 0. Re-run after the C12 proposal: 0.
- `npm run build`: 0
- `npm test`: 0, with 788/788 passing at `41733b2`. Some earlier survival-only runs used a pipe to `grep`; those counts are superseded by the direct runs above.
- **Adverse checks:** reverting the tracker sync fix makes the respawn-race test fail, and removing the travel guard makes three travel tests fail. Both fixes were restored afterwards.
- **Harness guard:** it spawns `scripts/survival-live-check.ts` with a missing or invalid lease (`[]`, `--fixture-lease`, `../x;rm`, `--with-settings`, `--fixture 26.2`). Every run exits 2 with no stdout and no output directory, before any password read, RCON command or join.
- **Not run:**
  - any fixture trial (no lease);
  - `doctor` (not touched by this change);
  - live, skills, Jev, planner and handoff checks (no lease, and no shared or planner code changed).

Source, build and running versions (corrected; the earlier "dist from `2ffdf10`" line was stale): `dist/` was built by `npm run build` from the working tree that was committed as `8e87ec3` (dist/cli.js 2026-10-07T19:06:52−07:00; commit 19:07:28−07:00). After the trial, compiling `8e87ec3` into a temp directory gave byte-identical JavaScript (150 `.js` files, combined sha256 `efbbed50d05df683b3eb4fd87217b46a7287a1ba02953351a246074956ed3835`); only the 150 `.js.map` files differ, by their output-directory-relative source paths. The whole `dist/` tree digest is `8e4b92f75b3f6a6e8497d007f841a0584da2a29186e0cde105717c27664605e5`. No process runs `dist/`; the survival harness imports `src` directly.

## C12: S implementation of the approved ContinuationSurvivalPort

The common contract is P's `4409ba1` (`src/contracts/continuation.ts`), restored verbatim as a read-only dependency (`git restore --source=4409ba1 -- src/contracts/continuation.ts`; byte-identical). My duplicate PROPOSED r1/r2 declarations were deleted from `src/contracts/survival.ts`; no continuation type is exported by S. No shared file (contract index, goal schema, engine, app, predicates) was edited. P implements the checkpoint, accounting helpers, engine bindings and status; L the route carry.

`SurvivalService implements ContinuationSurvivalPort`:

- **`frozenInventory(connectionEpoch)`:** the packet-frozen last-alive counts of the latest own death on that connection, `incidentId` = capture id (`dcap-<connection>-<n>`), only when the copy is server-stated (`ready_seed` → `null`).
- **`incidentReturns(incidentId)`:** an in-memory per-capture ledger (`src/survival/continuation.ts`) that works with or without the durable store and with memory disabled.
  - `retained` = min(last-alive, FIRST full respawn sync) per key; `regained` = server-attributed own returns by ANY collector: C3-planned recovery pickups (`recordRegain`), and later ordinary/passive collectors via the tracker's own `collect` packets.
  - A later collect is a return only when the item entity's own server-stated stack identity (key + component digest) matches a still-unreturned lost identity, its count fits that remainder, and the server first announced it within the recovery search radius of the incident's server site in the current dimension. Regained is never above the loss.
  - Never returns: C10 incidental gains (no collect packet), other identities, items outside every site radius, other collectors, non-item entities (orbs), other connections.
  - `attribution: 'unknown'` (P holds the count atoms) until the respawn sync, and whenever a collect cannot be placed: a stack never stated near the site, a pile larger than the remainder, a match for several incidents, a lost stack without server metadata, or a related death whose losses are merged or whose SERVER site lies near the original site (the book's merge decision uses the related death's client estimate, so the ledger re-checks after refinement).
  - While the bound recovery goal runs, its frozen C3 plan does the counting (planned stated pickups) and reporting (incidental); unstated collections still mark incident attribution unknown. Nothing is counted twice.
- **`continuationGate(nowMs)`:** finite and code-owned: `wait not_alive` before fresh respawn state; `wait support_running` while a support goal runs or health ≤ `lowHealth`; `wait recovery_open` while the recovery goal runs or an open episode can still act; `clear` with no open episode or when recovery is blocked by a non-transient condition it cannot clear (e.g. other dimension). Survival disabled → `clear`.
- **`persistCheckpoint(checkpoint)`:** stores a bounded DISPLAY-ONLY projection (`CheckpointRecordSchema`: goal id, session, clipped instruction/public outcome, state and reason, deadline, continuations, interruption reasons, three counters). No outcome contract, lineage, route carry, anchor, epochs or handles are written. The newest 4 are kept; records from another application session (or an unknown session) are shown as `restart_held`, "never continued". No durable store → no-op (P's in-memory checkpoint remains authoritative). The store schema is v3 (reads v1 with migration, v2 as-is).
- `SurvivalServiceOptions.sessionId` (new, optional) identifies the application session for that display.

**Exact inputs for P (stable at this commit; types from `src/contracts/continuation.ts` = P `4409ba1`, unchanged):**

| P needs | S provides | Semantics |
| --- | --- | --- |
| The optional port | `continuationPort(service: SurvivalService \| undefined): ContinuationSurvivalPort \| undefined` (`src/survival/wiring.ts`) | `undefined` when survival is absent/disabled (P then holds lossy count atoms for provenance). The service structurally satisfies the exact contract (type-pinned test). |
| Session identity | `createSurvivalService({ ..., sessionId })` | Records persisted by other sessions display as `restart_held`. |
| Frozen evidence at a death | `frozenInventory(connectionEpoch)` → `{ incidentId, counts, evidence: 'last_alive_server_packets' } \| null` | Latest own death on THAT connection; `incidentId` = capture id `dcap-<connection>-<n>`; `null` without a server-stated copy. Call after the death lifecycle event (capture is synchronous). |
| Own returns | `incidentReturns(incidentId)` → `IncidentReturns \| null` | `regained`/`retained` per item key (never above the loss); `attribution: 'unknown'` until the first respawn sync and whenever a return cannot be placed (P holds the count atom). `null` for an unknown id. Values only grow; read freshly at each rebind/evaluation. |
| Readiness input | `continuationGate(nowMs)` | `wait not_alive` (no connection attached, dead, awaiting fresh respawn), `wait support_running` (support goal running or health ≤ `lowHealth`), `wait recovery_open` (recovery goal running or open episode that can still act), else `clear`. Finite: a non-transiently blocked recovery clears. Disabled → `clear`. |
| Display persistence | `persistCheckpoint(checkpoint)` | Optional, idempotent upsert by goal id; bounded projection only; no-op without a durable store. |
| Evidence events (run store) | `survival_incident_return` `{incidentId, key, count, collector}`, `survival_incident_attribution_unknown` `{incidents, entityId, key, count}`, `survival_checkpoint_rejected` | Read-only diagnostics. |

P's `src/dashboard/viewmodel.ts:372` and `src/autonomy/status-text.ts:14` still print "needs your decision".

## Lease request (after review): module gate, no model calls

- **Frozen source:** the HEAD reported in the handoff, with a clean tree. The harness records `git rev-parse HEAD`, the dirty count and the imported `src`.
- **Order:** the 26.1.2 fixture first (`127.0.0.1:25566` / RCON `25576`), then exactly 26.2 (`25567` / `25577`), each under its own exclusive lease.
- **Commands:**
  - `node scripts/survival-live-check.ts --fixture-lease <id> --with-settings`
  - then the same with `--fixture 26.2`
- **Exact bounded footprint.** This is every RCON command the harness can issue. Coordinates are fixed constants and `${ITEM_AREA}` = `x=196,y=-61,z=190,dx=28,dy=11,dz=34`. The static guard test enforces that every entity kill carries `${ITEM_AREA}`, that no selector goes beyond the y range, and that the leased default contains **no bed block, no `interact_block` use, no `spawnpoint`/`setworldspawn`, no `time set`/`time of`/`time add` and no `sleeping_pos` read**.

  **Bed correction (coordinator review of `f55329a`):** my earlier statement that no `spawnpoint` command exists was wrong. Both official reports (`var/compatibility/reports-26.1.2/generated/reports/commands.json` and the 26.2 counterpart) include `spawnpoint <targets> <pos> <rotation>`, and using a bed changes the bot's respawn point without that command anyway. The G4/G4n bed observations are therefore removed from the leased run: every run reports them `SKIPPED` with the reason "bed interaction changes the fixture bot's respawn point and this harness cannot restore and verify the exact original respawn; R8 bed/respawn restoration is unassigned". There is no bed opt-in. `--with-settings` keeps only C8 parsing, G1k (`keep_inventory`) and G3 (food/health).

  | Kind | Commands | Where |
  | --- | --- | --- |
  | Blocks (writes) | `clone 196 -61 190 224 -50 224 196 200 190` (backup); `fill 196 -60 190 224 -50 224 air`; `fill 196 -61 190 224 -61 224 grass_block`; restore `clone 196 200 190 224 211 224 196 -61 190 replace force`; `fill 196 200 190 224 211 224 air` | scene x 196..224, y −61..−50, z 190..224; backup y 200..211 (verified empty first by a masked self-clone count) |
  | Entities (writes) | `kill @e[type=item,${ITEM_AREA}]`, `kill @e[type=experience_orb,${ITEM_AREA}]`, `kill @e[type=item,tag=cbsurv_<run>,${ITEM_AREA}]`; `summon item` ×3 at (215.5,−60,208.5) bread 64, (209.5,−60,208.5) dirt 3, (212.5,−60,201.5) diamond sword sharpness 1, tagged `cbsurv_<run>` + `_bread`/`_dirt`/`_sword` | inside the scene only |
  | Forceload | `forceload query`; `forceload add` only for scene chunks reported "not marked"; `forceload remove` only for those | chunks (12..14, 11..14) |
  | Fixture bot only (writes) | `clear Chunkbot`, `effect clear Chunkbot [minecraft:hunger]`, `give Chunkbot` iron_pickaxe[damage=200] 1 / bread 4 / cobblestone 20 / diamond_sword[sharpness 3] 1 / bread 12, `kill Chunkbot`, `damage Chunkbot 13` (G3 b1), one computed `damage Chunkbot <health−7>` (G3 b2) and `damage Chunkbot 4` (regen-off trial), all `minecraft:generic`, `effect give Chunkbot minecraft:hunger 30 120` and `10 60`, `tp Chunkbot` to (205.5,−60,205.5), (212.5,−60,205.5) and finally (205.5,−49,205.5) | the bot's own state; **no bed interaction and no respawn-point change** (the bot respawns at its existing respawn point, which is only read) |
  | Settings (writes, `--with-settings` only) | `difficulty easy`; `gamerule keep_inventory true` (G1k only); `gamerule natural_health_regeneration true` / `false` | world settings, each restored in `finally`; no clock/time write |
  | Restoration (writes) | `difficulty <original>`; `gamerule keep_inventory <original>`; `gamerule natural_health_regeneration <original>`; plus the block/entity/forceload/bot cleanup above | every step verified; any failure fails the report |
  | Reads only | `difficulty`; `gamerule keep_inventory` / `natural_health_regeneration`; `time query time` (twice, 1 s apart, for the clock rate); `time query minecraft:day`; `clear Chunkbot minecraft:<item> 0` (counts); `data get entity Chunkbot LastDeathLocation` / `Pos`; `execute as Chunkbot at @s if entity @e[type=item,distance=..6]` (count only, at the respawn point); `data get entity @e[type=item,tag=cbsurv_<run>_<pile>,limit=1,${ITEM_AREA}] Item`; `execute if entity @e[…]` counts; `execute if block`/`if blocks … all`; `list` | read-only anywhere listed; the respawn-point read changes nothing |

- **Settings snapshot before any write:** difficulty, both gamerules and the clock are read and parsed first. If any read fails, the trial changes nothing and fails `SETUP` with the recorded replies.
- **Expected new evidence:**
  - G2/G2b pass with C9 fixed, or fail with the exact mismatch;
  - the real respawn position and nearby loot;
  - the packet-stated pile stacks and identities;
  - incidental effects reported;
  - settings gates G1k and G3 reached after parsed original settings and clock reads; G4/G4n reported SKIPPED (R8 reason).
- **Note:** respawn-point pickups depend on loose items outside the scene, which the harness never removes. A clean respawn area is not required, because those gains are now reported and the oracle is a delta. They are recorded either way.

## Leased trial 26.1.2 (gameplay-S-261-c8910-01)

- **Lease:** `gameplay-S-261-c8910-01`, exclusive, vanilla 26.1.2 fixture only (25566 / RCON 25576), granted 2026-10-08T02:09:26Z for 30 minutes. Pre-flight: HEAD `8e87ec3`, 0 dirty paths, `var/fixture` linked to the root fixture store, lease record active. **Released** at 02:10:52Z, right after the post-trial checks.
- **Command (exactly as approved):** `node scripts/survival-live-check.ts --fixture-lease gameplay-S-261-c8910-01 --with-settings`, Node 24.21.0, output redirected to a file. **Exit 1**, read directly from `$?`. Ran 02:09:35Z–02:10:11Z.
- **Report:** `var/live-check/2026-10-08T02-09-35-290Z-survival/report.json` (sha256 `431430477fa838162521ada21526ab21f60ac308e9791f406a377dce74aaee0c`), preserved unchanged. It records source `{head: 8e87ec3…, dirty: 0}` and every RCON setup, intervention and restore command with its reply.
- **After the run:** HEAD still `8e87ec3`, 0 dirty paths; no harness, bot or `dist/cli.js` process remained.

| Gate | Result | Key evidence |
| --- | --- | --- |
| G1 | PASS | Wire order `death_combat_event > set_slot ×4 (clearing) > update_health 0 > respawn > window_items (empty) > update_health 20`. Frozen at the kill packet with server digests. The server GlobalPos 212.5,−60,205.5 overworld equals RCON `LastDeathLocation`. Memory fact `mf-0001` linked exactly. Respawned at (−9.5,−60,3.5) with no item entities within 6 blocks and an empty RCON inventory, so this run had **no respawn-point pickups**. |
| G2 | PASS | RCON pile data: bread count 64, dirt 3, sword sharpness 1. The bot's packet-stated stacks match, each with its own digest (the foreign sword's digest differs from the lost one). Authority was refused (`attempt_write_pending`) until the attempt was durable. Walking regained the lost sword passively (digest-matched). The foreign piles (3) and the wrong sword stayed on the ground. Server delta = regained, with nothing unexplained. |
| G2b | PASS | One `recover_lost_items` action collected the target pickaxe plus the planned own bread 4 and cobblestone 20 (counted 25). The server gained exactly bread 4, cobblestone 20, iron_pickaxe 1 and diamond_sword 1 since the baseline. Sword digest equal. `recovered` is satisfied and the episode is `recovered`. Durable writes passed throughout (the C9 failure did not recur). |
| G1k | PASS | `keep_inventory` set true and verified. The respawn sync held the kit, giving `no_loss`. Memory fact `mf-0002` has recovery `no_loss`, regained `[]`, retained 4 kinds. |
| G3 | **FAIL** | Ordinary eat completed at the threshold (food 10 → 15 → 20, satisfied). After `damage 13` and a hunger effect the decision was `blocked regeneration_needs_food`, not the necessary low-health eat, so the gate stopped. |
| G4 / G4n | SKIPPED | The R8 bed/respawn reason (no bed interaction, respawn mutation or clock write). |
| RESTORE | PASS | Difficulty (peaceful), `keep_inventory` (false) and `natural_health_regeneration` (true) restored and re-verified. Tagged piles and scene item/XP entities removed. Scene restored from the backup and verified identical; backup cleared and verified empty. Bot cleared. No forceload was added (`addedForceload: []`). The clock was read only: `minecraft:overworld` 3626077, rate 19.94 ticks/s; day timeline 2097. |

### Findings from the trial (the trial source and report stay frozen; corrections are later commits)

- **T1 (G3) — diagnosed from the retained packets; corrected (see "G3 correction" below).** Timeline relative to `difficulty easy` (server `update_health` packets and recorded commands): `damage 13` at +11.87 s → health 7; with food still 20, health regenerated 8 → 9 → 10 → 10.83 → 11.33 → 11.67 by +14.86 s while the hunger effect drained food 20 → 17 by +17.21 s; the decision at ≈ +17.3 s therefore saw **health 11.67, food 17**. Two separate faults:
  - **Staging (harness):** the intended precondition (health ≤ `lowHealth` 8 at the decision) did not hold, because damage came before starvation and regeneration ran meanwhile; the harness did not record vitals at the decision.
  - **Policy (source):** health 11.67 ≤ `restAtOrBelow` 12 with food 17 < 18 means regeneration needs a meal (`evalEat` marks it `healthNeedsFood`), but the ordinary eat cooldown (60 s, from the meal completed ≈ 6 s earlier) was exempt only at health ≤ 8, so the meal was suppressed and `rest` was blocked (`regeneration_needs_food`): a bounded stall with no recovery action.
- **T2 (incidental attribution) — corrected after the trial:** the tracker now remembers what each own collect took (server-announced item / server-announced non-item / never announced); a collect of a server-announced NON-item (26.1.2 `experience_orb` = entity type 49, item = 71; orbs arrive as `spawn_entity`) is reported as `nonItemCollected` evidence, never as loot or incidental; a collect of an entity never announced stays incidental (conservative). Regression: an orb collected while walking leaves the outcome `succeeded` with no incidental entry (fails without the fix). Original finding: walking collected entity 39 "stack never stated" ×1. It was reported as incidental `unplanned_collect` with no key (never regained) and did not appear in the five tracked item counts. It is most likely an experience orb from the death; `collect` is also sent for orbs, but this is not proven. Candidate correction: count only server-announced ITEM entities as loot in the pickup plan and report orb collects separately.
- **T3 (authority gaps between pickups):** after the passive sword regain, the memory update made the death fact `pending`, so the resolver briefly offered nothing (`incident_write_pending`) and the G2 loop ended. In the integrated runtime this would be a transient no-candidate round, not a blocker. It is conservative and correct under C5, but recorded.
- **T4 (outcome text) — corrected:** the effect now reads "counted as regained prior possessions: 1 minecraft:iron_pickaxe, 4 minecraft:bread, 20 minecraft:cobblestone (planned neighbouring own drops collected in the same action)" with `countedByKey` evidence. Original finding: the G2b effect "collected iron_pickaxe x1 … counted 25" is accurate, because the planned neighbours were collected in the same action, but the text could name them.

## Coordinator rerun 26.1.2 (`ac5da9b`, gameplay-root-261-recovery-02)

Run by the coordinator in an immutable `ac5da9b` checkout (source `{head: ac5da9b…, dirty: 0}`), direct exit 0. Report (read-only): root `var/gameplay-fixes/acceptance-recovery/var/live-check/2026-10-08T02-21-02-431Z-survival/report.json`, sha256 `110eab7bbda625efac065b7eb16b6c54ea028d4a05b955f4b4b4cfd1f44b43e0`. All executed gates and RESTORE pass; G4/G4n skipped with the R8 reason; all 8 restoration checks verified; root 0 players; lease released. G3 server facts from the decision lines:

| Stage | Server state at the decision | Decision / result |
| --- | --- | --- |
| (a) ordinary hunger | health 20, food 10, no cooldown | eat (support, no allowance); food 10 → 15 → 20, satisfied |
| (b1) health-support | health 11.5, food 17, eat cooldown 54 s | eat (support, no allowance, "health 11.5 needs food to regenerate"); food 17 → 20, satisfied |
| (b2) low-health | health 7, food 17, eat cooldown 56 s | eat (safety, 4-action allowance); check allowed; reserve counted 1/4 before dispatch; food 17 → 20 |
| rest, regeneration on | health 8.833 | health → 12.000 (server) |
| rest, regeneration off | health 8.000 | `no_regeneration` after 10 058 ms, health unchanged |

The first `8e87ec3` exit-1 report stays unchanged as the failed evidence.

## G3 correction (after the first 26.1.2 trial)

- **Source (`src/survival/service.ts`, `policy.ts`):** the ordinary eat cooldown now also exempts a **health-support meal**: fresh server health ≤ `restAtOrBelow` and food < 18 (regeneration needs food). It is not deleted: an ordinary hunger meal with healthy vitals still waits it out. `evalEat` still requires fresh server vitals, a full inventory sync and owned safe food, and its visible-threat block now also covers the health-support meal (previously only ≤ `lowHealth`). The low-health allowance is unchanged (granted only at health ≤ `lowHealth`; same action/time bounds), as are the admission cap and blocked-signature rules.
- **Discriminating offline test (`tests/survival-upkeep.test.ts`):** replays the trial's exact server state (eat completed, then health 11.666666030883789, food 17): on `8e87ec3` it returns `blocked rest regeneration_needs_food` (the trial decision); corrected, it proposes `eat` (support priority, no allowance, reason "health 11.67 needs food to regenerate"). The same test proves the ordinary cooldown still suppresses a healthy hunger meal, a visible zombie blocks the meal (`eat`/`threat_nearby`), and with no owned safe food nothing is eaten (bounded `resupply` instead). Adverse: removing the exemption fails exactly this test.
- **Harness G3:** every decision line records server health, food, saturation, vitals age, `lowHealth`/`restAtOrBelow`/`eatAtOrBelow`/`eatUntil` and running cooldowns. (b1) keeps the trial's staging and now requires the health-support meal, asserting the staged precondition from server values. (b2) stages the allowance case so it cannot drift: starve to food < 18 first (stops regeneration), then ONE computed `damage` to health 7, decide immediately and assert health ≤ `lowHealth` and food < 18 from server values. No repeated or rescue damage; the oracle is unchanged.

## Known gaps and honest limits

- C12: an own item returned by a NON-recovery collector is recorded in the continuation ledger (`incidentReturns`) but not in the recovery episode book; if that episode can later act again, its bounded search may end `unknown` for items already back. The ledger, not the episode label, is the continuation truth.

- The latest native attribution correction has offline packet/executor evidence only. The preceding C8/C9/C10 source has coordinator-reviewed module world passes on both versions; neither proves ordinary continuation.
- Incidental detection before the first attempt is a net per-key gain against the sync. A gain hidden by an equal consumption in the same interval, for example eating then picking up the same food, is not separable without per-packet attribution.
- Stopping before foreign loot can leave the bot short of the site when foreign loot surrounds it. Near the site, the search continues from there; otherwise the result is the declarative `unrelated_loot_on_route`. The bot does not path around it.
- C12's S service/typed port is implemented. P owns shared checkpoint admission/accounting and combined wiring; the old held directive remains non-executable. Bare `resume` replays nothing.
- Still pending:
  - real ordinary recovery and continuation through Codex/Jev (RC1–RC4, R2, R9);
  - integrated shared supervisor wiring;
  - far own-death routing (locator).
