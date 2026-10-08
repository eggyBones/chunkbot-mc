# MB-FLOW-003 recovery correctness (C8/C9/C10) and C12 continuation seam: worker handoff

Worker S: native DSH Codex, personal ChatGPT account, `gpt-6.1-sol` / `xhigh`, `danger-full-access` / approval `never`, per the coordinator's 2026-10-07 Arizona handoff. Earlier Claude sessions/commits remain preserved. Worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-recovery`, branch `chunkbot/gameplay-recovery`, common base `37c4c170199b4c9d867f720e64561a63a816d14c`; native handoff `9f15b55` over application source `5a4b560`. Plans: [survival-routines-plan.md](../survival-routines-plan.md) (C7–C12, R1–R10) and [live-gameplay-fixes-plan.md](../live-gameplay-fixes-plan.md).

**Delivery state:** C8/C9/C10 module checks pass on both supported fixtures, independently reviewed by the coordinator (`ac5da9b` on 26.1.2; `5a4b560` on 26.2, five executed gates plus eight restoration checks). The first `8e87ec3` 26.1.2 trial's G3 failure remains preserved below. C12 service support is implemented; the native correction below resolves S-C12-R3 offline. Shared semantic continuation and ordinary Codex/Jev acceptance remain incomplete. No new fixture lease, gameplay inference, live reconnect or deployment was used by this native turn; accepted live artifact remains `d348d58`, logged out.

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
| (native correction, this commit) | S-C12-R3: unknown own collect reaches incident lineage, including during recovery; exact positive/unknown/non-item packet and executor controls |

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
