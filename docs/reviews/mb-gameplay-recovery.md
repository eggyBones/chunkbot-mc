# MB-FLOW-003 recovery correctness (C8/C9/C10) and C12 continuation seam: worker handoff

Worker S: native Claude Code (Opus 5.5, high effort) through local DSH. Worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-recovery`, branch `chunkbot/gameplay-recovery`, common base `37c4c170199b4c9d867f720e64561a63a816d14c`. Plans: [survival-routines-plan.md](../survival-routines-plan.md) (C7–C12, R1–R10) and [live-gameplay-fixes-plan.md](../live-gameplay-fixes-plan.md).

**Delivery state: offline corrections are complete and verified. No fixture lease was granted, so there is no new live evidence.** The bot stayed logged out. There was no join, password read, RCON command, world or settings change, provider call or model inference. Accepted C12 continuation is not delivered: this document proposes its typed seam, which waits for approval by Codex and P before implementation. The module trials and real ordinary continuation are coordinator-run acceptance, and none of them has run on this source.

## Commits

| Commit | Content |
| --- | --- |
| `2ffdf10` | C8/C9/C10 corrections, harness, offline tests |
| `549ce47` | The proposed C12 typed seam (declarations only, not consumed) and this review |
| `41733b2` | The status projection enforces the declared 4,000-character bound (C10 added fields) |
| (this commit) | Coordinator schema review: state/count consistency invariants, v1 migration that reconstructs the original lost count from recorded regains, old-revision fallback tests |

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
    - a v1 `regained` label keeps its recorded regains as both lost and regained;
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

Exit codes are captured directly: each command's output is redirected to a file, `$?` is read immediately, and the log is read in a separate step (no pipes). Latest run, on the schema-review commit:

| Command | Exit | Log summary |
| --- | --- | --- |
| `npm run typecheck` | 0 | — |
| `npm run build` | 0 | — |
| `npm test` | 0 | 790 tests, 790 pass, 0 fail |
| `node --test tests/survival-*.test.ts` | 0 | 133 tests, 133 pass, 0 fail |
| adverse: v1 migration disabled, `node --test tests/survival-persistence.test.ts` | 1 (expected) | only the v1 migration test fails; source restored |

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

## C12: proposed minimum typed seam (awaiting Codex/P approval; not implemented)

Declarations live at the end of `src/contracts/survival.ts` under `MB-FLOW-003-C12 (PROPOSED — NOT CONSUMED)`. Survival implements them only after approval.

### Survival responsibilities (S)

- `holdCheckpoint(capture)` replaces `onOwnerGoalEnd` for `CHECKPOINT_INTERRUPTIONS`: `death`, `low_health`, `safety_interrupted`, `dimension_change`, `disconnected`, `kicked`.
  - It stores a durable, non-executable `ContinuationCheckpoint` containing:
    - the original instruction and interpretation;
    - the **immutable accepted outcome**;
    - the original admission baseline;
    - the original **travel anchor** (dimension, point, radius);
    - verified effects as historical labels;
    - counters;
    - remaining allowances, computed as caps minus counters and `goalDeadlineMs − activeMsUsed`;
    - compatibility;
    - a durable continuation counter (max 2);
    - interruptions;
    - `sessionId`, `holdUntilMs` and state.
  - It never awaits I/O on the lifecycle path.
- **Acquisition accounting:** survival computes `AcquisitionEntry` for each count atom.
  - Possession basis uses `inventory_delta` or `inventory_amount collect_additional`. The verified amount comes from **survival's packet-frozen last-alive inventory** at death, or the current server inventory for other interruptions. Survival subtracts the original admission count and adds ledger-confirmed consumption.
  - Effect basis uses `crafting_result` or `smelting_result` and counts skill-confirmed outputs.
  - Latches from the last code evaluation are kept.
- **Carry at continuation:** `credit = min(verifiedAcquired, max(0, freshCount − admissionCount))` for the possession basis, and `verifiedAcquired` for the effect basis.
  - Recovered prior possessions can only restore previously verified credit, capped by what is actually held. They never add new credit.
  - Example: lost and unrecovered logs must be gathered again. A finished craft stays done.
- **Compatibility:**
  - Compatible:
    - finite outcomes made of `all` and atoms, where count atoms are not under `any`/`not` and their admission count is known;
    - fresh-truth atoms: `inventory_amount possess`, `equipped`, `near_target`, `block_state`, `container_state`, `structure_state`, `entity_outcome`, plus `memory_state` with its original baseline;
    - persistent `maintain` outcomes. Follow resumes seeking and maintaining; recovery never completes it.
  - Otherwise the checkpoint is `unsupported`, a held declarative blocker.
  - A checkpoint without an accepted outcome is unsupported unless P/Codex choose the option under Decisions.
- `continuationReadiness()` returns one of four results:

  | Result | When |
  | --- | --- |
  | `wait` | The recovery episode is still open, support is running, a durable write is pending, the bot is not alive, autonomy is paused, or owner intake is live. Wait is silent and makes no inference calls. |
  | `blocked` | One declarative reason, no question: unsupported outcome, another session (`restart_held`), exhausted, expired, outside the original anchor radius or dimension, or store failure. |
  | `ready` | Returns a `ContinuationTicket` for this connection epoch only, with a short expiry. |
  | `none` | No checkpoint is held. |

- `beginContinuation(ticketId, admission, freshBaseline)`:
  - durably counts the continuation **before** any action. `continuationAuthority()` returns durable, pending or failed, mirroring the C5 recovery attempt;
  - returns the carry;
  - refuses stale, expired or other-connection tickets.
- `onContinuationTerminal(end)` maps the end state:

  | End | Checkpoint state |
  | --- | --- |
  | `outcome_verified` | `completed` |
  | `owner_stop` | `stopped_by_owner`, the same as an ordinary owner stop ending the job |
  | `replaced` | `superseded_by_owner` |
  | another checkpoint interruption | re-held with accumulated counters, active time and accounting (`recheckpoint`) |
  | anything else | `blocked` |

- `onOwnerInstruction` supersedes the checkpoint and `dismissInterrupted` dismisses it. Bare `resume` only clears the latch. The next fresh assessment may then continue a **compatible** held checkpoint, but never an unsupported one.
- A restart loads other-session checkpoints as `restart_held`: visible, never run.

### Shared integration requested from P (exact semantics; P is the writer)

1. **`src/autonomy/supervisor.ts` `ownerTerminal`:** for `CHECKPOINT_INTERRUPTIONS`, call `survival.holdCheckpoint(capture)` with:
   - the accepted outcome contract object;
   - the admission baseline;
   - the admission anchor proof, from `SkillRuntime.routeView(...).admission` or the perception travel anchor (dimension, point, radius);
   - the last outcome evaluation's latched paths;
   - ledger consumed, crafted and smelted counts since admission;
   - verified prior-result labels;
   - the counters and caps;
   - active ms used and `goalDeadlineMs`;
   - connection and dimension;
   - a `matches(itemKey, selector)` function backed by the exact-version knowledge (tags).

   P must capture the ledger summary before lifecycle invalidation. That needs a synchronous snapshot in the revocation prefix, or a ledger read before `invalidate`.
2. **Supervisor scheduling:** after survival's `assess` returns `none` (no necessary support), call `continuationReadiness`.
   - On `ready`, admit through a new **GoalEngine continuation admission**.
   - On `blocked`, show the declarative blocker once and hold unrelated progression, as the C4 held intent does today.
   - On `wait`, reschedule bounded.
3. **`GoalEngine.admitContinuation(ticket)`** (new; same `admit` path):
   - new goal id and epoch;
   - `GoalSource` variant `{kind:'owner_continuation', checkpointId, originalGoalId, continuation}`, with owner priority;
   - instruction = the original text (display and planner context);
   - counters initialized from `ticket.counters`, so nothing resets;
   - caps and deadline from `ticket.ceilings`;
   - the accepted outcome **pre-bound**: no new outcome acceptance, and the existing `acceptedOutcome` rule makes the planner repeat it exactly;
   - the fresh admission inventory captured as usual, then `survival.beginContinuation` (refusal terminates the goal blocked);
   - a bound predicate with `carry` per path;
   - task/action gating on `continuationAuthority === 'durable'`.

   The single PlannerSlot, actuator lease and SpendLedger are unchanged.
4. **`src/execution/predicates.ts`:** add an optional `carry` to `bind`, so `acquired = credit + (current − continuationBaseline)`.
   - Consumed-since-continuation credit applies only with `mayBeConsumedLater`.
   - A latched carry stays satisfied.
   - Effect-basis atoms count ledger outputs since the continuation bind, plus credit.
5. **`SkillRuntime.onGoalAdmitted`:** accept an explicit anchor for continuation goals, the **original** anchor, instead of capturing the current position. Survival's readiness already refuses when the bot is outside it or in another dimension.
6. **Terminal routing:** source `owner_continuation` goes to `survival.onContinuationTerminal`, never `onOwnerGoalEnd`. Stop, replacement and lifecycle revocation keep their existing precedence.
7. **Status and dashboard:** show `survival.checkpoints()`, kept distinct from supporting recovery and from automatic progression (RC4).
8. **Config:** `survival.continuation.{maxContinuations (default 2, ceiling 2), holdMs (default 30 min)}` and the application `sessionId` passed to `createSurvivalService`.

### Decisions requested (coordinator assumptions until answered)

- **A:** a continuation goal stopped by the owner ends the job (`stopped_by_owner`). It is not held for resume.
- **B:** a checkpoint without an accepted outcome (interrupted during planning) is `unsupported` in the first slice.
  - Alternative: allow it only when `tasksAdmitted === 0`, planning from the held instruction with the original counters and anchor. No progress existed, so there is nothing to double-count.
- **C:** continuation deadline = configured goal deadline minus active time already used. Held time during recovery does not consume it, but `holdUntilMs` bounds the hold.

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
