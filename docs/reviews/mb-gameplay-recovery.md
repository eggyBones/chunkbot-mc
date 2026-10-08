# MB-FLOW-003 recovery correctness (C8/C9/C10) and C12 continuation seam: worker handoff

Worker S: native Claude Code (Opus 5.5, high effort) through local DSH. Worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-recovery`, branch `chunkbot/gameplay-recovery`, common base `37c4c170199b4c9d867f720e64561a63a816d14c`. Plans: [survival-routines-plan.md](../survival-routines-plan.md) (C7–C12, R1–R10) and [live-gameplay-fixes-plan.md](../live-gameplay-fixes-plan.md).

**Delivery state: offline corrections are complete and verified. No fixture lease was granted, so there is no new live evidence.** The bot stayed logged out. There was no join, password read, RCON command, world or settings change, provider call or model inference. Accepted C12 continuation is not delivered: this document proposes its typed seam, which waits for approval by Codex and P before implementation. The module trials and real ordinary continuation are coordinator-run acceptance, and none of them has run on this source.

## Commits

| Commit | Content |
| --- | --- |
| `2ffdf10` | C8/C9/C10 corrections, harness, offline tests |
| `549ce47` | The proposed C12 typed seam (declarations only, not consumed) and this review |
| `41733b2` | The status projection enforces the declared 4,000-character bound (C10 added fields) |
| `08c9d89` | Coordinator schema review: state/count consistency invariants, v1 migration that reconstructs the original lost count from recorded regains, old-revision fallback tests |
| `eb4456b` | Review doc commit id |
| `d3b3e9f` | C12 proposal revision 2 after the joint review (declarations only) |
| (this commit) | v1 `regained` label without a recorded regain → explicit `unknown` (no invented regains); no-recorded-regain regression. **Frozen C8/C9/C10 candidate for the 26.1.2 module lease.** |

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
- Time of day comes from `time query minecraft:day`, falling back to the absolute clock mod 24000.
- The clock is restored with `time of <clock> set <original + measured elapsed>`. That target is verified twice: by the parsed `Set … tick(s)` reply, and by a re-read within ±100 ticks. Restoration neither rewinds nor skips the trial's time.
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

Exit codes are captured directly: each command's output is redirected to a file, `$?` is read immediately, and the log is read in a separate step (no pipes). Latest run, on the frozen candidate (the commit that adds the no-recorded-regain regression):

| Command | Exit | Log summary |
| --- | --- | --- |
| `npm run typecheck` | 0 | — |
| `npm run build` | 0 | — |
| `npm test` | 0 | 791 tests, 791 pass, 0 fail |
| `node --test tests/survival-*.test.ts` | 0 | 134 tests, 134 pass, 0 fail |
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

Source, build and running versions: source is HEAD of this branch, `dist/` was built from `2ffdf10`, and no process runs it. The harness imports `src` directly.

## C12: proposed seam, revision 2 (after the joint review; awaiting P's shared API and Codex approval; not implemented)

Declarations: the end of `src/contracts/survival.ts`, `MB-FLOW-003-C12 (PROPOSED r2 — NOT CONSUMED)`. Revision 1 (`549ce47`) is superseded. Changes per review point:

1. **Same logical goal id.** Continuation re-admits the **same goal id** at a fresh epoch, so `JevDecisionAdapter.perGoal` (keyed by `goalId`, confirmed in `src/decision/jev-adapter.ts`) and every per-goal account keep one identity. The checkpoint carries the **full shared `GoalCounters`** type (imported from `planner.ts`, not a subset), the **original** ceilings (cumulative counters are compared with them; nothing is refilled or double-charged) and the **original absolute `deadlineAtMs`**. A past deadline holds the checkpoint with `deadline_passed`. Revision 1's "remaining ceilings" and "deadline minus active time" are withdrawn (old decision C is withdrawn).
2. **Immutable original evidence.** The checkpoint and admission carry the original admission baseline with its provenance `detail` (unknown counts stay unknown and make count atoms not continuable), the immutable accepted outcome, the original anchor and code-confirmed `AcquisitionEntry` accounting (labeled evidence source; never planner text). The fresh resync at continuation is **current evidence for re-binding**, not a new acquisition baseline:
   - `carried = min(V, max(0, F − B0))` (possession basis), so credit is bounded by prior verified progress and returned belongings restore at most V; incidental gains never add credit.
   - `acquired(now) = carried + max(0, now − F)` (+ consumption since continuation); a latched consumed milestone stays satisfied; effect basis (crafting/smelting) carries V.
   - Repeated interruptions recompute V against the ORIGINAL B0.

   | Case (goal: 10 beyond B0 = 8; +4 verified before death) | Fresh F | Carried | Completes at |
   | --- | --- | --- | --- |
   | full recovery | 12 | 4 | 18 |
   | partial recovery | 9 | 1 | 18 |
   | nothing recovered (originals lost too) | 0 | 0 | 10 (new acquisitions only) |
   | respawn-point pickups | 17 | 4 | 23 |
   | second death after +3 more (held 15), recovered 15 | 15 | 7 | 18 |

   Planned tests: repeated interrupts, the baseline 8 / +4 / death / recovery 12 case, partial recovery, consumed-latched progress and uncertain data (unknown baseline, no frozen inventory → last code evaluation or not continuable).
   **Residual for decision:** own drops that a NON-recovery skill picks up during the continuation would count as new (`now − F`). Option: survival reports server collects of item entities first seen inside an incident's search radius for a still-unaccounted lost key, and P subtracts them up to that remainder.
3. **No executable data; groundable subset.** Atoms whose selectors are `registry`, `owner` or `owner_destination` (and inventory/equipment/crafting/smelting/structure atoms) are re-grounded freshly. `observed` handles, `prior_result` action ids, `remembered_anchor` and memory refs are not re-grounded: the checkpoint is held with one declarative reason (`AtomGrounding.reason`); the outcome is never rewritten. Count atoms under `any`/`not`, and count atoms with an unknown admission baseline, are not continuable either.
4. **Not dependent on configured autonomy/memory/survival.** P holds the same-session checkpoint in memory. Survival supplies pure helpers (`groundOutcome`, `accountAtInterruption`, `carryAt`) usable with survival disabled, plus, when enabled: packet-frozen last-alive counts, a recovery-priority `continuationGate` (open recovery or running support → wait; absent service → clear), and OPTIONAL persistence of the plain checkpoint, loaded after a restart as `restart_held` (shown, never run). A new manual owner admission is not gated by the automatic progression latch; stop/supersession fences existing held work; nothing moves after stop.
5. **Preemption is not a checkpoint.** Immediate W water/mob holds keep the goal admitted and TaskRuntime re-observes locally after the hold clears (no end, resubmission or action replay). Only interruptions that actually ended ownership (`CHECKPOINT_INTERRUPTIONS`) produce a checkpoint.

Survival adapts its durable/service bookkeeping after P's concrete shared API is approved. Until then nothing here is consumed, and survival still holds interrupted directives as `requires_owner_decision`.

## Lease request (after review): module gate, no model calls

- **Frozen source:** the HEAD reported in the handoff, with a clean tree. The harness records `git rev-parse HEAD`, the dirty count and the imported `src`.
- **Order:** the 26.1.2 fixture first (`127.0.0.1:25566` / RCON `25576`), then exactly 26.2 (`25567` / `25577`), each under its own exclusive lease.
- **Commands:**
  - `node scripts/survival-live-check.ts --fixture-lease <id> --with-settings`
  - then the same with `--fixture 26.2`
- **Exact bounded footprint.** This is every RCON command the harness can issue. Coordinates are fixed constants and `${ITEM_AREA}` = `x=196,y=-61,z=190,dx=28,dy=11,dz=34`. The static guard test enforces that every entity kill carries `${ITEM_AREA}`, that there is no `spawnpoint` command, and that no selector goes beyond the y range.

  | Kind | Commands | Where |
  | --- | --- | --- |
  | Blocks (writes) | `clone 196 -61 190 224 -50 224 196 200 190` (backup); `fill 196 -60 190 224 -50 224 air`; `fill 196 -61 190 224 -61 224 grass_block`; `setblock 208 -60 208` / `208 -60 209 red_bed[…]` (G4/G4n); restore `clone 196 200 190 224 211 224 196 -61 190 replace force`; `fill 196 200 190 224 211 224 air` | scene x 196..224, y −61..−50, z 190..224; backup y 200..211 (verified empty first by a masked self-clone count) |
  | Entities (writes) | `kill @e[type=item,${ITEM_AREA}]`, `kill @e[type=experience_orb,${ITEM_AREA}]`, `kill @e[type=item,tag=cbsurv_<run>,${ITEM_AREA}]`; `summon item` ×3 at (215.5,−60,208.5) bread 64, (209.5,−60,208.5) dirt 3, (212.5,−60,201.5) diamond sword sharpness 1, tagged `cbsurv_<run>` + `_bread`/`_dirt`/`_sword` | inside the scene only |
  | Forceload | `forceload query`; `forceload add` only for scene chunks reported "not marked"; `forceload remove` only for those | chunks (12..14, 11..14) |
  | Fixture bot only (writes) | `clear Chunkbot`, `effect clear Chunkbot [minecraft:hunger]`, `give Chunkbot` iron_pickaxe[damage=200] 1 / bread 4 / cobblestone 20 / diamond_sword[sharpness 3] 1 / bread 12, `kill Chunkbot`, `damage Chunkbot 13` and `4 minecraft:generic`, `effect give Chunkbot minecraft:hunger 30 120` and `10 60`, `tp Chunkbot` to (205.5,−60,205.5), (212.5,−60,205.5), (208.5,−60,206.5) and finally (205.5,−49,205.5) | the bot's own state; G4/G4n may change its respawn point to the trial bed (before/after recorded; NOT restored, since there is no `spawnpoint` command; the bed itself is removed by the scene restore) |
  | Settings (writes, `--with-settings` only) | `difficulty easy`; `gamerule keep_inventory true` (G1k only); `gamerule natural_health_regeneration true` / `false`; `time set 1000` (G4); `time set 13000` (G4n) | world settings, each restored in `finally` |
  | Restoration (writes) | `difficulty <original>`; `gamerule keep_inventory <original>`; `gamerule natural_health_regeneration <original>`; `time of <clock> set <original + measured elapsed>`; plus the block/entity/forceload/bot cleanup above | every step verified; any failure fails the report |
  | Reads only | `difficulty`; `gamerule keep_inventory` / `natural_health_regeneration`; `time query time` (twice, 1 s apart, for the clock rate); `time query minecraft:day`; `clear Chunkbot minecraft:<item> 0` (counts); `data get entity Chunkbot LastDeathLocation` / `Pos` / `respawn` / `sleeping_pos`; `execute as Chunkbot at @s if entity @e[type=item,distance=..6]` (count only, at the respawn point); `data get entity @e[type=item,tag=cbsurv_<run>_<pile>,limit=1,${ITEM_AREA}] Item`; `execute if entity @e[…]` counts; `execute if block`/`if blocks … all`; `list` | read-only anywhere listed; the respawn-point read changes nothing |

- **Settings snapshot before any write:** difficulty, both gamerules and the clock are read and parsed first. If any read fails, the trial changes nothing and fails `SETUP` with the recorded replies.
- **Expected new evidence:**
  - G2/G2b pass with C9 fixed, or fail with the exact mismatch;
  - the real respawn position and nearby loot;
  - the packet-stated pile stacks and identities;
  - incidental effects reported;
  - settings gates G1k, G3 and G4/G4n reached with parsed clock replies.
- **Note:** respawn-point pickups depend on loose items outside the scene, which the harness never removes. A clean respawn area is not required, because those gains are now reported and the oracle is a delta. They are recorded either way.

## Known gaps and honest limits

- No live trial has run on this source. C9/C10 are corrected and proven offline only. The fixed packet order, real pile identity and settings parsing need the leased gates.
- Incidental detection before the first attempt is a net per-key gain against the sync. A gain hidden by an equal consumption in the same interval, for example eating then picking up the same food, is not separable without per-packet attribution.
- Stopping before foreign loot can leave the bot short of the site when foreign loot surrounds it. Near the site, the search continues from there; otherwise the result is the declarative `unrelated_loot_on_route`. The bot does not path around it.
- C12 continuation is a proposal: there is no implementation and no shared wiring. Survival still holds interrupted owner directives as `requires_owner_decision` (C1/C4 behavior), so bare `resume` replays nothing.
- Still pending:
  - real ordinary recovery and continuation through Codex/Jev (RC1–RC4, R2, R9);
  - integrated shared supervisor wiring;
  - far own-death routing (locator).
