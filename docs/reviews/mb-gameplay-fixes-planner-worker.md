# P-SAFETY-R16 — ordinary water/mob acceptance accuracy (planner/integration worker P)

Worker P (native Claude Opus 5.5 DSH), coordinator Codex. Branch `chunkbot/gameplay-planner`,
worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-planner`.

- Starting HEAD: `5c057ad3762c9cd0da73580be85884e0ed2a8e91`
- Source fix: `24c1fc477ba42c5cb80f47ecd1fa087b2104ae6a` (parent `5c057ad`)
- This role document is a separate commit on top of `24c1fc4`.

No fixture, RCON, world, provider, key, live control or Microsoft operation was used. Both R16
reports were only read. The only server-jar access was a read-only extraction of class files from
`var/fixture/downloads/server-26.1.2.jar` (SHA-256 `cd47e7c3…cb42`) and
`var/fixture-26.2/downloads/server-26.2.jar` (`cdacdfb2…3ec5`) into `/tmp`.

## Evidence read

| Report | SHA-256 |
| --- | --- |
| 261 `acceptance-native/var/live-check/2026-10-09T01-03-25-688Z-ordinary-goals/report.json` | `d4933b95f18d5a493b06b37644bdf83db0eb234efbf5a4df2b948c5f6de56b67` |
| 262 `acceptance-planner/var/live-check/2026-10-09T01-03-25-641Z-26.2-ordinary-goals/report.json` | `b474b15cda556df633a03b6b6c87f6715d9a1ab5bcbd2fd7481a70f69f72df21` |

I also read the `run-safety-ordinary`/`run-mob-o8d` `events.jsonl` that each report references,
and the retained 2026-10-06 dashboard reports for the actual `equipment` reply format. All five
owned harness/test paths were byte-identical between `5c057ad` and the canonical `dd0b5a8`. The
canonical source differs only in W/L/S-owned paths.

## Findings: harness defects, not application defects

None of the five gates shows an application defect. Each one is a harness staging or oracle
defect. The traces below come from the actual artifacts. Unless marked, the times are from 261,
and 262 has the same structure.

### O8D (both): server gear read from the wrong NBT field

- Actual reply at 1791507886717: `data get entity Chunkbot Inventory` →
  `[{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]`. The 262 reply at 886007 is identical.
- The installed `Player`/`LivingEntity` classes of both releases contain the `equipment` field.
  `EquipmentSlot` names are `mainhand/offhand/feet/legs/chest/head/body/saddle`. `Player` also
  has `SelectedItemSlot`. The retained dashboard check shows the actual reply format
  `{head: {count: 1, id: "minecraft:iron_helmet"}, offhand: {…}}`.
- The oracle searched only `Inventory` for the helmet and chestplate. On these releases worn armour
  is never in `Inventory`, so staging could never pass. The offline replay had encoded the
  pre-1.21.5 `Slot: 103b/102b` armour representation, which is why the earlier tests passed.
- Root cause: the harness representation was wrong. Gear and readiness were otherwise real: the
  client observation `equipment.head/torso` was correct.

### O7P/O7R (both): settle oracle counted legitimate follow movement as drift

O7P on 261: the episode `se-0513f935f8b3` ended at 900844. The `escape_water` lease 1 was released
with outcome `completed`.

| Server sample | Time | Position | Notes |
| --- | --- | --- | --- |
| 1 | 904383 | 211.37, 206.5 | dry and supported |
| 2 | 904636 | 211.37, 206.5 | stationary |
| 3 | 904890 | 211.84, 206.08 | — |
| 4 | 905145 | block 212,205 | dirt/air/air; dry support passed |

Between samples 2 and 3, Jev chose `act-10d1ebc4774f` (follow_entity) at 904627. A fresh lease 2
for `goal:1` was acquired and the skill started at 904647. Sample 4 moved at least 0.8 blocks under
that lease, and the stationary check threw.

The same pattern appears in the other three cases:

| Case | Fresh lease | Started | Moving sample |
| --- | --- | --- | --- |
| O7R 261 | 5 | 924947 | 925260 (block 212,206) |
| O7P 262 | 2 | 902851 | 903385 |
| O7R 262 | 5 | 920958 | 921304 |

In every case the bot stayed stationary after the safety release until the ordinary goal lease
started, and stayed on solid dry support with air 300. There was no physics drift and no water
re-entry.

O7W passes because its plain profile has radius 8 and the owner is outside the anchor, so follow
cannot move. The oracle conflated "the safety release settled" with "the bot never moves again",
and it dropped the failing sample from the evidence. This is not a W policy finding: the
`escape_water` release was stable in all four cases.

### O7F (both): staging accepted a stale cue and a stale observation

On 261, `tp FixtureOwner 350.5 -60 198.5` returned at 930359. The `locator_owner_state`
`tracked:chunk` event is also at 930359. The `waitForTruth('fresh actionable far owner cue')`
predicate was satisfied at once by a dashboard published at 930027, before the teleport, which
showed `north/close`, age 459 ms, for the nearby owner.

The snapshot was taken at 930363, 4 ms after the teleport reply. It still had the owner visible at
218.5,-56,198.5, which is `LAYOUT.water.owner`, the old visible position. It did not contain the
hidden far point. On 262 the timings were teleport 926408, snapshot 926411 and dashboard
published 926395.

So no hidden owner coordinate leaked: the client had not yet applied the departure. The defect is
that staging was not fresh relative to the owned teleport. L's separate `frt-` suffix check was
not touched.

### O8N (261): the harness itself injured the owner

Every `resetScene` ran `fill … -60..-50 air` while FixtureOwner could still be standing on the
water platform at y -56. It then teleported the owner only afterwards. On 261: the O7F `finally`
step put the owner at -56 (931236), the O8C reset filled air at 933687, and the owner was
teleported at 933693. That is a 4-block drop, and vanilla fall damage is 4 − 3 = 1.0. This
matches the observed `FixtureOwner Health 19.0f` at 941667.

The same drop happened on 262 (fill at 929732). There the owner read 20.0f at 937646. Why natural
regeneration had restored 262 but not 261 within the same ~8 s is **not established**: the owner's
hunger was never read.

### O8C (262): a foreign actor outside the scene became visible after a valid retreat

Staging was clean. The snapshot at 931317 showed no unexpected entity, and the census found only
the tagged creeper. The episode `se-ab58bf42a15d` had hazards `["creeper"]` and target entityId
11434, which is the tagged creeper. It resolved with hazardsAfter `[]` and no attacks.

The retreat moved the bot 8 blocks west to 197.5,-60,205.5. The post-response `mobIdentity`
observation at 933424 then contained `minecraft:zombie_horse` at 168.1,-60,201.1, distance 29.7.
That is outside the declared scene columns (x 196..224). It was never a hazard or target, and the
in-box census stayed empty.

The failing check was the strict staging readiness guard, reused for the post-response
verification.

## Corrections (`24c1fc4`)

Changed files:

- `scripts/ordinary-goal-live-check.ts`
- `scripts/lib/ordinary-safety-oracles.ts` (existing P path)
- `tests/ordinary-safety-staging.test.ts`
- `tests/ordinary-goal-harness-guard.test.ts`

The diff is +467/−39, and `git diff 5c057ad 24c1fc4 | sha256` is `1b8b44f5…3dc7`. No
application source, dist, contract, config, manifest, or W/L/S path changed. The dist has no
`scripts/`.

### O8D gear

`serverHeldGear` requires all of the following:

- the held item is the `Inventory` entry at `SelectedItemSlot` (0–8) and is `iron_sword`;
- `equipment.head` is `iron_helmet` and `equipment.chest` is `iron_chestplate`.

Unreadable, duplicate, legacy-slot or component-bearing (unparsed) replies give null and refuse.
This is stricter than before, because the sword must now be the actually held slot. The raw
`equipment` reply and the parsed gear are recorded in each defense proof. The client equipment,
grounding, adult, distance, health ≥ 14, 6 s damage age, 10 s wait and no-authority checks are
unchanged.

### O7P/O7R settle

The 3 s and ≥ 4 sample proof is unchanged. On every sample, dry support, OnGround, water bank and
air 300 must hold.

With the new `ordinary` option (O7P/O7R only), a step of ≥ 0.8 blocks is accepted only while a
movement action meets every condition below (`postReleaseMotion`):

- it is `follow_entity`, `move_near` or `seek_owner`, with owner `goal`;
- it belongs to the same goal and epoch, and went through `task_choice` or
  `task_local_continuation`;
- it started at or after `safety_episode_ended`;
- it runs on a lease acquired for `goal:<epoch>` that is neither a safety lease nor the preempted
  lease;
- it was active during that interval, at no more than 7.2 b/s plus 0.25.

Every other step must stay below 0.8. O7W and O7F stay strictly stationary. Every sample,
including a failing one, is retained in `safetySamples` and the evidence.

### O7F staging

`freshFarCue` waits, bounded at 15 s, for all of the following:

- a `locator_owner_state` `tracked:*` event at or after the owned teleport start;
- a dashboard published after that event with an actionable east cue;
- an observation taken after that event with `owner.visible === false`.

Only then does `verifyHiddenOwner` pass. The far point in **any** observation, including one taken
while waiting, fails immediately (`verifyNoFarPoint`). All later privacy, route and refill checks
are unchanged. Typed bot coordinates, the travel anchor and the relative direction text remain
allowed.

### O8N health

Each reset now lifts both players by 30 blocks with a 5 s slow_falling effect before any fill. It
then grounds the owner and runs `effect clear` on it. The owner is never healed or fed.

Before the actors are summoned, `fullStableHealth` waits, bounded at 12 s, for natural full
health: 20 on two reads at least 1 s apart, with any dip resetting the window. `foodLevel` is read
as a diagnostic only. The original staged `health.bot === 20 && health.owner === 20` check and the
no-damage window are unchanged.

### O8C/O8N verification

Staging identity stays strict, with no unexpected visible nonplayer. After an executed response,
`mobIdentity(…, afterResponse)` records an unexpected visible nonplayer only when:

- it is outside the scene columns;
- no safety episode since admission has a hazard outside the allowed list (`creeper` for O8C,
  none for O8N);
- no episode targeted an unrecorded entity id.

Anything inside the scene, unpositioned or involved still fails. The same tagged creeper, the
4.5 separation, effect-free state, geometry, and no-attack and no-completion checks are unchanged.
**This is a scoped oracle decision for Codex to accept or reject.** The alternative is to keep
failing whenever a foreign actor outside the scene becomes visible.

## Regression coverage (offline, actual artifacts)

Seven new tests use the exact R16 replies, events, samples and snapshots. The only exception is
the O7P fourth sample, whose position is reconstructed inside its recorded block.

- **Adverse controls:**
  - legacy armour, unreadable equipment or slot, wrong slot, missing chest, component body;
  - no, wrong-epoch, safety, preempted, pre-release, non-pipeline, non-movement or
    already-ended action;
  - teleport-speed step, water re-entry, airborne sample, pool position;
  - stale or pre-change dashboard, observation or event; owner distance present; far point while
    waiting;
  - stuck, flickering or unreadable health; heal/feed commands;
  - foreign actor inside the scene, as a hazard or as a target.
- **Guard test:** strict O7W/O7F settle, fresh O7F staging before admission, strict mob staging,
  the unchanged O8N equality, and owner protection before every fill.

A pre-fix reproduction, `tests/zz-r16-prefix-repro.test.ts`, was run against the unchanged
`5c057ad` and passed 5/5, reproducing all five failures. It was then removed. A copy is retained
as `var/native-checks/p-safety-r16/zz-r16-prefix-repro.test.ts.txt`.

## Checks (exit codes captured directly; logs under `var/native-checks/p-safety-r16/`)

Run with Node 24 PATH:

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| Pre-fix reproduction on `5c057ad` (5/5) | 0 | `2e5f59f4e23ec61733a2f83b95bd19010b7ea0e160dedbd7edd943930d7c590d` |
| Same file after the fix (3 assertions now differ, as intended) | 1 | `7eda93b7837f5bf6747b0be175ec2d4c7c1d716e4131f3e29ad40f3ea33ac909` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1421/1421) | 0 | `53f41e05b0944c768515d8ef24eaf4fc0fe30442c4925b9e56e9d927db0015a2` |
| Focused ordinary harness/oracle tests (43/43) | 0 | `9eab5f1536d860ceed4c2a640923434ff378bd4a9f228556bc9ec7c74bedec32` |
| Doctor `config/examples/fixture.json` (read-only; does not connect) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor `config/examples/fixture-26.2.json` | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Combined `dd0b5a8` + this diff (temp detached worktree, since removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Combined: focused plus `safety-*` tests (220/220) | 0 | `5cbd99501d9ee49be51731e277882ccdadcb7b142acb7bffe2435b8c99401c85` |
| Combined: full suite (1537/1537 = 1530 + 7 new) | 0 | `4d79da7c432715fa0c302f062bd4a11fb1873152a9781e7ed88ce63dab5336fb` |

The temp worktree was removed with `git worktree remove --force` followed by `git worktree prune`.
`prune` only drops registry entries whose directories no longer exist.

## Limitations and what remains for Codex

- No real probe was run. Root must rerun all coupled acceptance on both releases.
- The format of the `chest` equipment key and the `SelectedItemSlot` reply was confirmed from the
  installed class strings, not yet from a live reply. A mismatch fails closed as before.
- O7F staging needs a post-teleport owner-state change (`vec3i` → `chunk` here); without one it
  times out as unready.
- The O8N cause of the 261-only missed regeneration remains unknown. If hunger prevents natural
  regeneration, O8N will still fail honestly, now with `foodLevel` diagnostics.
- The O8C foreign-occupant scope needs Codex acceptance (see above).
- No shared/API need is outstanding and no W policy change is proposed.

## R16 oracle vs. W's proposal (read after `8f5e332`)

W's final role document (`gameplay-safety/docs/reviews/mb-gameplay-fixes-safety-worker.md`) independently proposes the same O7P/O7R boundary that `24c1fc4` implements. It found no product defect and leaves `9e9b84c` as a test-only change.

The proposal has three parts, all of which hold in `24c1fc4`:

- **Dry, grounded support for every sample:** each sample must be dry, grounded, on a solid floor, with air at feet and eyes and Air 300, for at least 3 s.
- **No new safety episode:** none may start after release.
- **Motion only with a journaled fresh goal lease:** displacement is accepted only after a journaled post-release `lease_acquired goal:<epoch>`/`skill_started owner goal` for the same goal and epoch.

`postReleaseMotion` is stricter than the proposal in three ways:

- The moving action must have come through the ordinary task pipeline (`task_choice`/`task_local_continuation`).
- It must be a movement capability.
- It must stay within ordinary ground speed.

The preempted lease and safety leases are excluded. O7W/O7F stay strictly stationary. No change was needed after reading W's document.

# P-TASK-R17 and P-PLAN-R17 — same-session continuation (worker P)

Parent `8f5e332` (R16 handoff). The source/test commits are separate:

- `ad9bb97` — P-TASK-R17.
- `2dbf3b4` — P-PLAN-R17 (HEAD before this role commit).

`git diff 8f5e332 2dbf3b4`:
- 5 files, +367/−3; SHA-256 `a62142c26496dd901bf9142b2a91561f74b05c0930e34e81fda7000b8ed76bc1`.
- Source: `src/tasks/task-runtime.ts` +22/−1, `src/goals/goal-engine.ts` +11/−1, `src/skills/movement.ts` +14/−1.
- Tests (new): `tests/task-terminal-freshness.test.ts` (+177), `tests/owner-direction-scope.test.ts` (+143).

The three source files were byte-identical between `5c057ad` and the canonical `dd0b5a8` before these changes. No fixture, RCON, world, provider, key or live-control access was used.

## P-TASK-R17 (261 J2): a terminal blocker issued on completion evidence older than the observation

### Evidence

- Report `a17de868…d502`.
- Journal `run-aaafe95f16f2/events.jsonl`, SHA-256 `47470330486a30937ab1addfcb5ad8eadd0002c9489c5b5f151d865a3fc3346b`.
- CLI log `run-jev-real.log`.

### Timeline of task-9117a8e2bdee (milliseconds since 1791509000000)

- Rounds 1–5 run normally:
  - three server-confirmed breaks: drops 4079, 4080 and 4081;
  - acquired count goes 0 → 0 → 1 → 2;
  - one pickup choice went stale at 28421 (`no_visible_drop`) because the drop had already been auto-collected — 2/3 by 28491.
- 32847 — the last `mine_block` succeeds:
  - `serverDrops: [{entityId: 4081, oak_log, 1}]`, `autoCollected: []`, "not yet picked up";
  - the skill sleeps 400 ms after the server block change, so the drop is about 450 ms old here.
- 32890 — round 6 completion (server_sync) reports "acquired 2/3". The candidate observation that follows has no drop, no log and no destination.
- 32909 — the task ends `blocked/no_candidates`, 62 ms after its own action. Total runtime was 14 s.
- No setup command gives logs; the report's `setupCommands` contain only teleports for J2/J3. Yet J4 at 01:23:55.795, about 2.9 s later, "crafted 12 minecraft:oak_planks … consumed 3 oak_log" (server_sync). **The bot did hold all three logs.**

### Why the snapshot lacked the drop

- With the real PerceptionService, the drop is visible from the actual J2 position at every plausible drop height (offline probe, translated geometry). So at observation time the drop was gone from the client's entity table, not occluded.
- Only a server destroy removes it, and the bot later held the item. That points to the bot's own pickup, roughly at the vanilla 10-tick pickup delay.
- `PredicateEngine` takes the last `window_items` before the barrier ack (`correlatedResync`). The server answers the resync and the barrier while handling packets. The pickup happens later in the same tick's entity phase, so `collect`/`entity_destroy`/`set_slot` arrive after the ack.
- Result: the evaluation said 2/3 and the later observation no longer showed the drop. The runtime then claimed "no grounded option".

The exact packet timestamps were not journaled. The mechanism above is consistent with every recorded time. The round-4 stale choice at 28421 / 2/3 at 28491 shows the same race resolving the other way.

### Classification

This is a real application ordering defect in a terminal claim. It is not a perception, predicate or selection bug, and not a hidden-lookup need. The jev-live-check J2 expectation (completed, then RCON at least 3 logs and air) is correct and unchanged.

### Correction

Before any terminal "nothing actionable" blocker (`no_candidates`, `per_target_retries_exhausted`, `repeated_without_progress`), `TaskRuntime` performs one fresh code-evaluated completion read, which is a correlated server resync.

What the read does not do:
- no action, inference or new round;
- no wait loop, timer or retry;
- no hidden lookup.

Fences after the read:
- ownership and connection epoch are re-checked; revocation is cancelled;
- a safety hold returns to the loop-top gate.

Outcomes of the read:
- satisfied in complete mode → `completed/completion_verified`;
- satisfied in maintain mode → the ordinary local hold;
- otherwise → the same honest blocker with the fresher evidence. `unknown` never completes.

It emits `task_completion {recheck: 'before_terminal'}`. The original task/goal/candidate scope, cumulative caps, deadline, no-progress, epoch, lifecycle and cancel fences are unchanged.

### Control (`tests/task-terminal-freshness.test.ts`)

The test uses actual composition: real PerceptionService, ServerEvidence, PredicateEngine (resync plus barrier ack), the registered mine/move/pickup resolvers, TaskCandidateGenerator, SkillExecutorImpl and TaskRuntime over the installed 26.1.2 registry, with the actual J2 geometry and ids. The fake server emits `window_items` and the ack, then `collect`, `entity_destroy` and `set_slot` in the same tick.

Fail-before (pre-fix source) reproduces the actual terminal detail exactly: `blocked/no_candidates … (mine_block: no_visible_target; move_near: no_grounded_destination; pickup_item: no_visible_drop)`.

Cases after the fix:

| Case | Result |
| --- | --- |
| Own drop collected in the same tick | completed 3/3; 0 decisions, 0 actions, 3 resyncs |
| Genuinely absent drop | honest blocker after exactly one extra read; still 1 round |
| Unanswered read | blocked; completion `unknown` |
| Revoked during the read | cancelled |
| Maintain mode | returns to the hold |

## P-PLAN-R17 (262 P4): owner-direction scope applied to a whole mixed resource+delivery goal

### Evidence

- Report `bf3bdb3a…5313`; goal-2617b17b932f.
- Immutable outcome `ALL(inventory_amount bread ≥3 possess, near_target owner ≤2)`.
- Window 2 task-09e0f79c75df (`explore_frontier` → `visited_location frt-3301`) ended `blocked/no_candidates` with 0 decisions.
- The final proposal reports that "code denied resource exploration because this goal has only owner-directed travel authority".

### Cause

`GoalEngine.runTask` set `requiresOwnerDirection` when **any** outcome atom targeted the owner. The candidate generator then refused `explore_frontier` (`owner_direction_required`), and the executor would do the same.

That rule, introduced at `75a6631`, protects owner seeking. But it also stripped resource exploration from every multi-condition resource+delivery goal.

### Correction

**Per-task scope (`GoalEngine`).** Owner-direction-only scope is now decided per task from code-checked structure:
- every task of an owner-only outcome (every atom targets the owner: follow / come with me);
- any task whose own completion or selectors target the owner (the delivery leg, or a completion that includes the owner atom).

This is not an intent classifier and adds no resource-specific path. The candidate seam's `hints.wantsOwner` and the executor seam are unchanged.

**Exploration bound (`explore_frontier`).** Exploration is bounded by the ORIGINAL admission anchor/radius:
- in the resolver;
- at final execution, which returns `precondition_failed/outside_admission_bounds` before any navigation command.

A live owner-route leg therefore never extends undirected exploration. Without an admission proof (operator diagnostic anchor), the plain anchor bound applies; no leg can apply there either.

### Control (`tests/owner-direction-scope.test.ts`)

Producer: the real GoalEngine window path (planner proposal, check, AdmittedTask). Consumer: the real `SkillRuntime` generator and executor with locator routes enabled.

Fail-before reproduces:
- `requiresOwnerDirection` true for the P4 search window;
- `owner_direction_required` at execution.

Cases after the fix:
- **Resource search in the actual mixed outcome:** frontiers are offered only inside the original bound.
- **Still owner-direction-only:**
  - pure follow outcome;
  - delivery task (completion near the owner);
  - owner selector;
  - task completion that includes the owner atom.
- **Live owner leg:**
  - it exposes frontiers beyond the original bound for owner-directed travel;
  - none of those frontiers is offered to the resource search;
  - executing one is refused `outside_admission_bounds` with zero client writes.

## Checks (Node 24 PATH, exit codes captured directly; logs `var/native-checks/p-r17/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| P-TASK fail-before control on pre-fix source (5 fail, as intended) | 1 | `fe387df962b13af97b499fc81d003560b50adebb760366f62d8c8dc0c4f824ea` |
| P-TASK control after fix (5/5) | 0 | `367df098b0ecd1d01b81f1c4ba0f3758019a61439177198b5a509fb583821c77` |
| P-PLAN fail-before control on pre-fix source (2 fail, 1 control pass) | 1 | `154b94dbd9a319a09934a46c926a90f7667fbefa40815673930a1c8d57ff17ed` |
| P-PLAN control after fix (3/3) | 0 | `85215cd2ec312c819bee0a81f1433ee87c94c72958739566f87cb62f9df8b906` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1429/1429) | 0 | `e2801606c97fa5e4c0a7a4336c36c229ced4f6bbc6dc75da339fef38e31ec558` |
| Focused (task runtime, planner engine, gameplay integration, both new controls, R16 harness; 78/78) | 0 | `718bf5c9d61ba0216f3dbd41c605e8895d112e1647d3947659812188df45f8bf` |
| Doctor 26.1.2 config (read-only, no connection) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Combined `dd0b5a8` + R16+R17 diff (temp detached worktree, since removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Combined: full suite (1545/1545 = 1530 + 7 R16 + 8 R17) | 0 | `59b82d19339452295dd83a49d754e52c417470b028833d03a798876d7f4ee2d4` |

The pre-fix runs restored the exact pre-fix bytes of the three source files with `git checkout`, then copied the fixed files back. The fix bytes were verified by the subsequent passing runs and commits.

## Limitations

- **J2 packet timing:** packet-level times for the 4081 collect were not journaled. The mechanism rests on the recorded times, the installed resync/barrier semantics, the perception visibility probe and the J4 server-confirmed consumption.
- **Effect of the correction:** it removes only the stale-evidence terminal claim. A drop that is genuinely occluded or not yet collected still yields the honest blocker; it is never a hidden lookup.
- **P4 not re-run:** whether a re-run reaches bread depends on actual exploration revealing the occluded item within the ORIGINAL radius 128 and on real planner/Jev choices.
- **What root must re-run:** real jev-live-check (both releases), planner-live-check with real and fault Jev, ordinary goals, handoff and locator, plus the coupled acceptance.
- No shared/API or vendor need, and no W/L/S path was touched.

## R16 evidence wording correction (added with R18)

In the R16 O7P trace, sample 4 is **not** a retained actual point. The original harness kept only its floor/feet/eye block reads (block 212,205, dirt/air/air). "Moved at least 0.8 blocks" is inferred from the thrown stationary check.

The offline O7P control (`tests/ordinary-safety-staging.test.ts`) puts a reconstructed position (212.45, 205.55) inside that recorded block. Its assertion now reads "the reconstructed counterexample step (sample 4 placed inside its recorded block 212,205; not a retained actual point) moved". Since `24c1fc4` every settle sample, including a failing one, is retained. The original failed reports are not relabeled.

# P-SAFETY-R18 — remaining ordinary water/mob staging (worker P)

- Parent `740de23` (R17 role). Source commit `050d03e666f9895aae57cd276dc589a002c75132`; this role update is a separate commit.
- `git diff 740de23 050d03e`: 4 files, +243/−7, SHA-256 `496251da05f1468fca59e6611ead6d380a681e25bb31e5079ecf3d876def7a22`.
- Changed paths:
  - `scripts/ordinary-goal-live-check.ts` (+54/−5)
  - `tests/ordinary-safety-staging.test.ts` (2 lines)
  - new `tests/ordinary-safety-r18.test.ts` (+91)
  - new `tests/ordinary-far-route-geometry.test.ts` (+96)
- No application source, dist, contract or config changed.
- I did not touch `scripts/lib/ordinary-safety-oracles.ts`. W holds the narrow `serverHeldGear` exception there. My R16 negative case `unparsed component body fails closed` in `tests/ordinary-safety-staging.test.ts` must be reconciled to accept structurally valid damaged gear only after root approves and imports W's exact parser source. I left it unchanged.

Evidence was read only, from:
- 261 `2026-10-09T01-45-54-344Z-ordinary-goals` (SHA-256 `59ec08d6…023eb`);
- 262 `2026-10-09T01-45-54-736Z-26.2-ordinary-goals` (SHA-256 `e0bde872…edf5ed6`);
- their `run-safety-ordinary` and mob-case `events.jsonl`.

The harness and staging test bytes on the canonical `3913fb1` equal `740de23`.

## O7F: the far-cue staging passes, but no owned motion can begin from the staged point

### Actual sequence (both releases)

- The fresh far cue and hidden-owner observation now pass. 261: teleport 484045; dashboard 484210 shows actionable `east`; snapshot 484272.
- "follow me" is admitted (261 goal-de389ae3aa70, epoch 5; anchor 218.5,-56,200.5, radius 128). Route-3 is authorized for the owner source.
- The planner plans maintain `near_target owner 3` with `seek_owner`/`follow_entity`/`move_near`. Jev chooses `seek_owner` three times.
- Each window fails within 24–30 ms with `unobserved_terrain`:
  - rays 5/5 unobserved, `commandsIssued 0`, `movedBlocks 0`;
  - route state `authorized`, `legsUsed 0`;
  - cue `east`, precision `chunk`.
- The task ends `per_target_retries_exhausted`; the planner replans and the goal ends `cannot_execute` (261).
- 262 is identical (goal-d7c37dbcee35). Its planner replan was still running when the harness's 20 s motion wait expired.

### Cause: staging geometry

- The bot was staged at `LAYOUT.water.bot`, 5 blocks from the east edge of the 4-block-high O7W dirt platform. The ground beyond the edge is 4 blocks below and hidden by the platform edge.
- The real route runner only walks observed safe frontiers, with a conservative drop of at most 3. `classifyBlocker` honestly reports `unobserved_terrain`, and no owned motion can begin.
- This is neither an application nor a privacy defect.
- A counted route leg begins only when the ORIGINAL 128 admission bound limits progress (`boundLimited`). Inside the declared footprint that never happens, so the old precondition `leg_active && legsUsed >= 1` was unreachable under the required original radius.

### Correction

- O7F teleports the bot (recorded intervention) to `LAYOUT.safety.farStart` (201.5,-56,200.5). This is the west end of the platform, north of the pool. Its dirt/air/air is verified with every water geometry.
- The precondition is now all of:
  - the current owner-route authorization (`authorized` or `leg_active`) of THIS goal;
  - the actual active `seek_owner` lease, with at least 0.6 server motion (unchanged `ownedMotion`);
  - a fresh actionable east cue.
- The route state, legs and distance are recorded.
- Unchanged:
  - privacy checks before and after;
  - cue withdrawal while water safety holds;
  - the strict stationary settle;
  - no refill of route legs, distance or time;
  - the scene-margin guard and explicit stop.

### Control (`tests/ordinary-far-route-geometry.test.ts`)

Real `PerceptionService`, `LocatorService` (actual `tracked_waypoint` chunk 21,12 owner statement), `RouteController` and `runRoute`, over the declared platform/pool geometry in absolute coordinates. The move adapter only records.

| Start | Result |
| --- | --- |
| Actual R18 start | `failed/unobserved_terrain`, 0 moves, legs 0 — reproduces both journals |
| `farStart` | first owned waypoint 223.5,-56,196.5, east on the dry platform, outside the pool, inside the original bound; legs 0 |

Pre-fix, `farStart` did not exist and the second case fails.

## O8N

### 262: the owner could never regenerate

- Owner 19.0 health with foodLevel 17 on all 24 reads over 12 s (my R16 diagnostic readback).
- Vanilla natural regeneration needs food ≥ 18, so the bounded wait could never succeed.
- Food 17 implies several healed hearts earlier in the shared run; the fixed `resetScene` and `prepareExtendedSafetyGeometry` no longer drop the owner.
- Established exposure: each recorded AI zombie outlived the CLI that staged it, with FixtureOwner the only player in the scene:
  - 262 O8M zombie: CLI shutdown 408046 → removal 411848;
  - 262 O8D zombie: 438369 → 442381;
  - 261: 406750 → 410558 and 438199 → 442310.
- Individual owner hits were not journaled, so the exact damage events remain unproven.

### 261: the natural wolf wandered out of view

- Full stable health and strict staging identities passed (staged 514846).
- After the window the natural wolf had wandered to 218.33,-60,194.70 (RCON). The post-window CLI snapshot showed only the owner and the cow, so "actual CLI LOS/visible target correlation missing".
- The real `PerceptionService` over the scene's standard oak trunk (208,-60..-58,202) shows the wolf genuinely occluded there and visible at its staged position. This is legitimate natural behavior, not an app or visibility defect.

### Corrections

| Change | Detail |
| --- | --- |
| `freshCli` | Removes recorded scene actors (existing strict identity cleanup) BEFORE quitting the CLI that staged them. |
| `recordControlCondition` | Read-only bot/owner Health/foodLevel at every CLI replacement and extended geometry, so future damage is attributable. |
| `fullStableHealth` | Refuses at once, with the reason, when a below-full control player's food is < 18. No healing or feeding; the 20/20 two-read stability and the original staged equality are unchanged. |
| `currentMobIdentity` | Post-window only. Re-runs the strict identity on fresh facts every 500 ms, bounded to 10 s, solely for the LOS-correlation failure. UUID, species, health, hazard and other failures throw at once; an actor never seen again fails. Staging keeps the single strict identity. Neutral actors stay natural AI (no NoAI). |

### Controls (`tests/ordinary-safety-r18.test.ts`)

- The actual 262 replies (19 / food 17) give the immediate, reasoned refusal using read-only commands. Food 18 still allows the natural wait to 20/20.
- The real perception occlusion control for the 261 wolf (and visible cow).
- The bounded fresh-identity retry, never-visible and identity-failure cases.
- Source wiring: cleanup before `quit`, the O7F start before the owner teleport, `ownedMotion(seek_owner)` still required, no NoAI.

Pre-fix: 4 of 7 R18 controls fail as intended. The 3 that pass reproduce the actual cause (R18 platform start, wolf occlusion) or the unchanged food ≥ 18 behavior.

## Checks (Node 24 PATH; logs `var/native-checks/p-r18/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| R18 controls on the pre-fix harness (4 fail as intended) | 1 | `bc05f10c49be24e58336e93a2a5d30426688c0f72ad1d98b0d4291308a9f95c3` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1436/1436) | 0 | `07c31b09060c88b0769d5e57927424de6082ec0cb6154bfa001df69e3cac5cc1` |
| Focused ordinary harness/oracle/R18 tests (48/48) | 0 | `2f51ec62fd57ee007e8ba01075d3beb5a2c879a497a0ee56ea224e8da8bb431d` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Canonical `3913fb1` + R17 source + R18 (temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1586/1586) | 0 | `a8146fc494cda86e8de4287a048550597ee3ce45c56c5a67bc0de5af5cdf4899` |

## Limitations

- No live run. Root must rerun all nine ordinary water/mob cases on both releases.
- **O7F:** whether real Jev/seek walk east far enough before the water trigger depends on actual timing. The scene-margin guard still stops before x 223.
- **O8N 262:** the cleanup ordering removes the proven post-CLI exposure. Damage while the bot is present (e.g. a zombie re-targeting the owner during O8M) is not prevented. A depleted owner food state now refuses honestly instead of waiting.
- **O8N 261:** a natural actor can stay out of sight for more than 10 s, which is an honest failure.
- **O8D:** needs W's approved parser and is unchanged here.

# R18 continuation — approved W-R11 dependency, damaged-gear readiness, R17 wording (worker P)

Parent `4e92518` (R18 role).

## Commits

| Commit | Content |
| --- | --- |
| `d37d660` | Exact cherry-pick of root-approved W `98322f8d7bd96d9bcbac16f7db73a4a7b8cf9e93`, source/test only. Neither W's baseline `6bf3a75` nor its role `0a7f947` was imported. |
| `fd7aab93982a5425b6d418cf37e2512ac33fde02` | My test reconciliation. |

About `d37d660`:
- W's parent baseline file equals my `24c1fc4` oracle file, so the pick applied without conflict.
- `git diff 98322f8 d37d660 -- scripts/lib/ordinary-safety-oracles.ts tests/safety-held-gear-oracle.test.ts` is empty.
- Paths: `scripts/lib/ordinary-safety-oracles.ts` (+170/−18) and `tests/safety-held-gear-oracle.test.ts` (+140).

About `fd7aab9`:
- Paths: `tests/ordinary-safety-staging.test.ts` (+36/−2) and `tests/task-terminal-freshness.test.ts` (+10/−8).
- `git diff d37d660 fd7aab9` SHA-256 `cf32e8d651b45d06775ae87885dc0e0ce8c656d870a539294d26cdd9ef5698f5`.
- `git diff 4e92518 fd7aab9` (both commits): 4 files, +357/−27, SHA-256 `d5c6062005286457001f49272623643ed3ee78fe63e1e4c6e5806eb540843759`.

No application source, dist or config changed.

## Gear reconciliation (O8D)

**Actual R18 replies.** These come from 261 readbacks 1791510436544/436545 and 262 readbacks 436714/436715, which are identical:
- `Inventory`: `[{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]`
- `SelectedItemSlot`: `0`
- `equipment`: `{head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_chestplate"}}`

The damage component comes from the genuine staging hit (261 `damage_event` 436044).

**Retired case.** My R16 negative case "unparsed component body fails closed" refused all structurally valid damaged gear, so I replaced it. Two malformed actual structures are now refused instead:
- the actual R18 damaged reply truncated inside a component;
- a damaged helmet stack with no top-level `id` of its own.

**New replay.** It drives the real `stageMeleeEngagement` readiness with the exact R18 equipment reply.

- **Pass:** server gear `{iron_sword, iron_helmet, iron_chestplate, slot 0}`. The raw reply is recorded in the defense proof. The proof holds settled ≥ 250 ms over ≥ 2 samples, hit age ≤ 6 s, melee distance ≤ 3.5, and no mutations.
- **Refuse:** with the same damaged reply, each of these still refuses before admission with no mutation:
  - airborne;
  - expired damage;
  - foreign (unattributed) damage;
  - client gear missing;
  - unknown ground;
  - baby;
  - unsupported floor;
  - active authority;
  - bot health 13.5;
  - a malformed equipment reply;
  - held slot 1.

**Fail-before.** With the pre-W parser bytes (`4e92518` oracle), the replay fails with the actual R18 message `staging_unready: current server gear missing/unknown`. The other 14 oracle functions are unchanged by W, and I did not edit the library.

## P-TASK-R17 wording

The introduction of `tests/task-terminal-freshness.test.ts` now describes the same-tick `window_items`/ack then `collect`/`entity_destroy`/`set_slot` order differently:
- before: "exactly the actual 261 ordering";
- now: a faithful, plausible installed-production ordering that reproduces the observed stale-terminal condition.

The actual pickup packet times were not journaled. That limitation in the R17 section stands, and the source behavior is unchanged.

The R16 fourth-sample position is reconstructed; it is covered by the R18 wording correction above.

## Checks (Node 24 PATH; logs `var/native-checks/p-r18w/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| Damaged-gear replay on the pre-W parser (fails as intended) | 1 | `4ed319c579787453899b56173caccbeaccff7f8c20224cc3038c43641631b980` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1485/1485 = 1436 + 48 W + 1) | 0 | `83e0fbdf0207bb32da17db0778fc8fd33c4f5ff748fac20697ce3e0a4a411497` |
| Focused (staging, W gear oracle, R18, far-route, guard, harness, R17 control; 102/102) | 0 | `b71e33589b91a020ae96c5a742b71e4348b4b67675ede0eed173d27330e4b44f` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Root canonical `8ead4c9` + `git diff 740de23` (R18 + W + reconciliation; temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1635/1635 = 1579 + 7 + 48 + 1) | 0 | `6b8beaebcb423560ab88e85500c548707906e66675fec851f89f1f4837f4a2a7` |

The root acceptance copies were not touched.

## Limitations

- O8D combat itself remains untested until root reruns it live.
- The damaged-gear acceptance covers the exact actual `minecraft:damage` shape and W's structural controls; it does not cover other live component shapes.

# P-JEV-R19 — J1 visible-chest staging (worker P)

Parent `29bc73b4245caddf2cf45d5efa9659092d79d01b`. The source/test commit and this role update are separate commits.

- **Source/test commit:** `c80a1badeeeace812fdaa9f0051f78e2c33ada05`.
- **Changed paths:**
  - `scripts/jev-live-check.ts` (+38/−1)
  - new `tests/jev-j1-visibility.test.ts` (+106)
- **Diff:** `git diff 29bc73b c80a1ba` SHA-256 `8670e594b8e35dc674ddddf651937467247d76ff999fd2e23b5478512e52bbc6`.
- **Unchanged:** application source and other shared paths.

Evidence was read only:
- report `2026-10-09T02-00-43-044Z-jev-real` (SHA-256 `9aa6038f242ef5b9128f17e01d98881a2f641748de1046d30a6dc828dfa165a9`);
- journal `run-88a502a4b00c/events.jsonl` (SHA-256 `f365e7580a5e12c8cc4d86fb5c28c7fac46bcdd4c5a984075f9d8065361e2943`);
- retained J1 trials: 2026-10-05 real, 2026-10-06 fault and 2026-10-09 R17 real.

The original failed reports are unchanged.

## Actual R19 J1

### Timeline (goal-dcd7ba30fa70, task-9bd797660e10)

| Time | Event |
| --- | --- |
| 02:00:47.116 | Setup `tp Chunkbot 214.5 -60 196.5`. |
| Round 1 | Completion `unknown`: "no visible minecraft:chest in the latest observation". |
| Round 1 | Six `explore_frontier` options are offered, plus `move_near:no_grounded_destination`. Real Jev chooses "explore east toward frt-48". |
| Next 240 s | 44 explore actions wander east and north to about 288–317, 73–144. |
| 02:04:48.555 | Completion: "2.9 blocks from minecraft:chest blk-2171". The bot was then at about 288.5,-60,132.5, so this is some other chest in the fixture world, not the scene chest. |

- The harness had already timed out waiting for the terminal (240 s).
- Its RCON end-position proof (≤ 3.6 from the scene chest) would also have failed.
- There is no task or movement regression: all actions succeeded and the completion predicate behaved correctly.

### Earlier passes (2026-10-05 real, 2026-10-06 fault, 2026-10-09 R17 real)

Every retained earlier J1 also began explore-only from the same start: its first round had six `explore_frontier` options and no approach. Those runs passed only because the chosen exploration happened to reveal the chest:
- fault Jev picks the first option, west;
- real Jev picked east then south.

The declared "visible chest" was never visible at the start.

## Cause

The staging is wrong. The straight sight line from 214.5,-60,196.5 to the chest centre (203.5,-59.6,207.5) is diagonal. At x = 208.5 it is at z = 202.5, which is the centre of the scene oak trunk column (208,-60..-58,202).

The control `tests/jev-j1-visibility.test.ts` confirms this. It builds the actual scene from `sceneCommands()`, exactly as the harness sends them, on flat fixture ground, then runs the real `PerceptionService` and `TaskCandidateGenerator` with the registered skills:
- **Chest hidden:** neither the snapshot nor live line of sight shows the chest.
- **Round 1 reproduced:** candidates are explore-only, with `move_near:no_grounded_destination`, exactly as journaled.

## Correction (`scripts/jev-live-check.ts`, J1 only)

**New start.** J1 now starts at `J1_START = 214.5,-60,200.5`:
- inside the original scene, at standing level;
- 13.1 blocks from the chest centre, so the walk is real (more than the completion radius of 3 plus 3).

At that point the chest is visible in the snapshot and by live line of sight at every ±0.3 jitter. The real generator offers an approach to the chest. The suggested 214.5,198.5 also has live line of sight, but at some jitter positions its snapshot ray discovery misses the chest, so I rejected it as marginal.

**Readiness proof before admission.** `j1VisibleChestReadiness` sends the actual CLI `/diag observe` (operator-only output; nothing reaches a model, no RCON). It is bounded to 10 s. It requires all of:
- the snapshot was taken after the teleport;
- `self` is within 0.5 of the start;
- the scene chest block (203,-60,207) is visible, more than 3 blocks away.

It records that proof. Otherwise it fails as staging-unready.

**First round.** J1 now also requires its first round to offer `move_near` to the chest, so staged visibility held at task start.

**Unchanged:**
- objective, decision instruction, capabilities, selectors, completion;
- the 240 s default timeout (no override);
- the completed / ≥ 1 Jev decision assertions;
- the RCON end proof ≤ 3.6 from the scene chest.

## Checks (Node 24 PATH; logs `var/native-checks/p-r19/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| J1 control on the pre-fix harness (actual-start reproduction passes; declared-start and wiring fail as intended) | 1 | `04cc8dd958a4df0770967a17038801f612d14419a94c4c07abe7d4dc62998fc1` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1488/1488) | 0 | `eb6897ef263c92a65943e5022f1bf9cdb4811578c35178dc0cf6864aaa41036d` |
| Focused (J1 control, perception, prediction visibility; 12/12) | 0 | `8124fc4e7ec575e5cf6cd7b7a9d96d46a6c9014248590cde4c378ffdef28e218` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Canonical `8ead4c9` + `git diff 740de23` (R18 + W + reconciliation + J1; temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1638/1638) | 0 | `5e3358809e264436af0a9edc2462b254c2e091e1a2dc840891971d4d092c1817` |

## Limitations

- **Faithful replica, not a live run:** the control replicates the scene on flat ground. Fixture terrain outside the scene is not modelled, but it cannot occlude the in-scene sight line. Server block confirmation is represented by the applied scene commands.
- **J1 still depends on real behaviour:** Jev must choose the approach and the walk must succeed within the unchanged 240 s. No live run was made.
- **Root reruns the real acceptance.**

# P-PLAN-R20 — real 262 P4 "bring me some bread" (worker P)

Parent `71b58805149bd98062397623fdafa85bfd84ed58`.

| Item | Value |
| --- | --- |
| Test/harness commit | `4950b559f3a3837db779b5bdaa4925161f4b827c` |
| Changed: `scripts/planner-live-check.ts` | +3/−1 (P4 evidence label only) |
| Changed: new `tests/planner-p4-fixture.test.ts` | +77 |
| `git diff 71b5880 4950b55` SHA-256 | `a6f55cf54d89eddea1bf6022bee4dc0603c893bd748782f8bd9f852e89fd414f` |

No application, prompt or shared-core change. This role update is a separate commit.

## Evidence (read only)

The driver was still running, so no final report existed. I read:

- the root log `var/gameplay-fixes/codex/R19-planner-real-262.log`;
- the run journals `acceptance-planner/var/runs/run-bfecf3f6d9a6/events.jsonl` (SHA-256 `389706e9acc1c1324d0b0453a68af5fdb9ed9ec805303e02ae3c6d8ab4c13d5b`) and `planner.jsonl` (SHA-256 `79928b7e0c060c4f8d361272c952e5ca11e50aab41d9f4dd985f2aedbcf75f6a`), both as they stood when read;
- the retained historical P4 reports.

Rendered prompts and shown snapshots are not journaled (only digests), so the exact frontier list the model saw is inferred from the replica below and labelled as such.

Labels in this section:
- **fixture command / readback** = taken from the root log;
- **journal** = taken from the run events/planner journal;
- **replica** = my offline real-perception reconstruction;
- **inference** = my reasoning.

## Chronology of goal-d885cb5cd4bb

| Source | Time / turn | Event |
| --- | --- | --- |
| Fixture command | setup | `kill @e[type=item,tag=chunkbot_front]`, then `summon item 203.5 -60 208.5 {Item:{id:"minecraft:bread",count:1},PickupDelay:0s}`, then `tp FixtureOwner 200.5 -60 209.5`. |
| Readback | setup | Bread at 203.5,-60,208.5. |
| Journal | 02:31:36 | Admitted. Anchor 205.5,-60,205.5, radius 128. Admission inventory `{}`. |
| Journal | turns 1 and 3 | Planner proposes a chest-inspection task with completion `container_state … atLeast: 0`. The real schema rejects it both times (`tasks.0.completion.atLeast >= 1`); each counts a repair. Turn 2 asks knowledge: bread recipe, `drop_item`. |
| Journal | turn 4 | Plan accepted. Immutable outcome ALL(`inventory_amount bread ≥ 3 possess`, `near_target owner ≤ 2`). Interpretation: "Bringing 3 bread to you". Window 1: `inspect_container` on the chest, completion ANY(bread ≥ 1, wheat ≥ 1). |
| Journal | window 1 | Four inspections, each 58–83 ms from the start position (no movement), each "contains nothing (server-confirmed)". Ends `blocked/repeated_without_progress`; the R17 pre-terminal recheck agrees. |
| Journal | turn 6 (replan) | Same outcome. Window 2: `explore_frontier` on the frontier the model chose, "Explore this north frontier once". It is admitted; the R17 owner-scope correction holds. |
| Journal | window 2 | Arrives at 204.5,-60,185.5 (north). "Observed 8 visible block types (0 new), 5 entities, 0 drops". `visited_location` is verified, so the task completes. |
| Journal | turn 7 (lookahead) | Wheat harvest query. |
| Journal | turn 8 | `cannot_execute`: "No source of bread or wheat is visible after the bounded exploration, and the nearby chest is server-confirmed empty." |
| Readback | end | Inventory `{}`; the bread entity is still present; Chunkbot is 24.33 from the owner. |

## Faithful facts (`tests/planner-p4-fixture.test.ts`, replica)

The replica uses the real PerceptionService, VersionKnowledge and PlannerProposalSchema over the actual scene commands and the actual P4 setup, which is read from the harness source.

- The harness supplies exactly ONE pickable bread (count 1). The scene has no wheat, hay or other bread, and real knowledge says bread needs wheat.
  - So the accepted outcome **possess ≥ 3 bread is unattainable in this fixture**, however well the bot explores. Root may have more context about the wider fixture world.
- The bread is hidden behind the chest both from the start and from the actual north exploration end. It is visible from the owner's position (200.5,209.5), which is the delivery destination, and from the south and east sides of the chest.
- Eight frontier directions are offered from the start. North is the one whose route never reveals the bread.
- The zero-quantity completions in turns 1 and 3 are refused by the real schema exactly as journaled. The same proposal with `atLeast: 1` is valid.

## Classification

No deterministic application, task-runtime or perception defect is shown.

**Behaved as designed:**
- schema zero-quantity refusal and repair counting;
- the bounded `repeated_without_progress` stop with the fresh pre-terminal read;
- the R17 owner scope, which admitted the resource exploration;
- original-anchor exploration and truthful `visited_location` completion;
- truthful outcome status;
- hidden-world privacy (the bread was never reported while occluded);
- no owner question.

**Planning choices, model-dependent:**

1. **Quantity default.** "some bread" became possess ≥ 3. The v6/v7 guidance I added in MB-PLAN-006 (`36628a1`: "Quantity or material omitted: choose a modest task-appropriate amount … and say so") allows this. With this fixture it makes the outcome impossible.
   - Both observed no-question P4 runs chose 3: R17 fault-Jev and R20 real.
   - The historical passing P4 runs (2026-10-05/06) used the older clarification scenario. The owner's answer pinned "the dropped bread", and the outcome was bread ≥ 1. They are therefore **not comparable** evidence for the quantity default.
2. **Search persistence.** After one exploration the model answered `cannot_execute` with 7 other directions, 12 planner turns, 6 replans and about 18 minutes of deadline remaining. This complies with the same MB-PLAN-006 line: "Target not visible: plan a bounded survey/explore step …; if it stays unavailable, answer cannot_execute". That line was written for deictic absent targets (O5 "kill that rabbit"). For a general resource search it encourages early refusal.
   - The historical clarified runs instead searched from new viewpoints over 3 replans.
3. **Direction choice.** The model picked north, the one direction whose route never reveals the bread. This is an uninformed choice and not a defect.

## Proposals for root (not implemented; product and test decisions)

**Testing correction (recommended first).**
- P4's harness comment states the under-specification under test is *location* ("the owner names the item but not where it is"). The fixture supplies one bread.
- Make the instruction explicit about quantity, for example "bring me a bread" or "bring me one bread". Location stays unspecified and occluded, and all P4 checks stay unchanged:
  - no question;
  - planner-selected movement;
  - code-verified possession and delivery;
  - RCON.
- Alternatively, keep "some bread" and treat the quantity default as a product decision (next item). Do **not** add extra bread silently.
- This requires root review, because it changes the trial input.

**Product guidance option A — quantity (coordinator choice).**
- Proposed replacement for the "Quantity or material omitted" line: "Quantity omitted for a named item ('bring me some X', 'get X'): 1 unless the owner's words or the job clearly need more (e.g. a recipe's ingredients), and say so."
- Generic: no item enum, no rewrite of an accepted outcome.

**Product guidance option B — search persistence.**
- Proposed replacement for the "Target not visible" line: "Target not visible: for 'that/this/the' referents, one bounded survey/explore step, then cannot_execute with the visibility blocker. For a named resource to obtain, explore distinct unexplored directions within the admission radius (prefer frontiers not yet visited, and moving toward where the job ends, e.g. the owner for a delivery) before cannot_execute; never wander beyond the limits."
- Model-dependent. It spends existing planner turns, replans and deadline only, and changes no code bounds.

Either guidance change needs a fresh real-model acceptance by root on both versions. Neither is proven to make P4 pass, because the outcome depends on the model's quantity choice.

**Release limitation until decided.** "bring me some X" for an occluded or absent item may:
- choose a quantity larger than is available;
- end `cannot_execute` after one exploration.

It does so honestly: no question, no false credit, outcome unsatisfied.

## Harness label fix

The P4 evidence printed `window N task … "undefined"` because it read `task_started`, which carries only the app step label. It now reads the correlated `task_admitted` objective. Behaviour is unchanged; only the label is fixed.

## Checks (Node 24 PATH; logs `var/native-checks/p-r20/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| P4 control on the pre-fix harness (3 fact cases pass; the label case fails as intended) | 1 | `db4c2f46e02bada7d8875acb4cdcef54431acd117593f4dc82965aea46886b10` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1492/1492) | 0 | `0c77c0b6ae15c7dbf8cba146fd7aaa99c3e2f06e1f439710efefe22538689f1f` |
| Focused (P4 control, owner scope, planner engine, perception; 21/21) | 0 | `16d166279d81f83e2cef16a7d07b157e064b266a44116c9b9b54d6d75af06178` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Canonical `100ec816…` + this change (temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1642/1642) | 0 | `c6780b09d4bec3ad8ab08b6b760d9c520868776c754965c73db0b2e24ad89ced` |

No inference was used in any test, and no fixture, RCON or provider access by me.

## Uncertainty

- **Prompts and snapshots not retained:** the exact frontier list and wording the model saw are reconstructed, not retained.
- **Final report not yet written:** the outcome rests on the journals.
- **Driver still running:** later events (P5+) were not part of this analysis, and the run-61 world was not touched.
- **Proposal effects unknown:** whether either guidance proposal changes real-model behaviour is unknown until root runs real acceptance.

## P-PLAN-R20 continued — P10 missing-mechanic projection and P4 on 261 (worker P)

Parent `939acd0cc0a4f3d997ce04e0853a4197a4e3a1ca`. This role update is a separate commit.

- **Source/test commit:** `abfd5cb0a9601dd1b0fbfcbf58cfb6281148e3dc`.
- **Changed paths:**
  - `src/goals/public-text.ts` (+9/−3)
  - `src/goals/goal-engine.ts` (+2/−2)
  - new `tests/cannot-execute-mechanic.test.ts` (+89)
- **Diff:** `git diff 939acd0 abfd5cb` SHA-256 `56184f64b90320e6e271eac78da682c3f10cd3bd310e34210d54c97a92be57ca`.

### Evidence (read only)

- `R19-planner-real-262.log` (SHA-256 `b2499fbc3fa97d4a505a7ba6d91250cd589e8a0903207c8fa1de3bce00f4e336`).
- `R19-planner-real-261.log` (SHA-256 `f5fe0ad28a6c53099b46449e40c72fd61febc0bbdf3bbd241268c69116f57cf7`).
- The 262 run journals `run-bfecf3f6d9a6` (hashes as above).

### P10 trace (262, goal-3e279fd5e702), journal

- **Turn 1:** `needs_information` with capability queries `enchanting` and `anvil`. `knowledge_answered` gives statuses `["unknown","unknown"]`. The code catalog's answer is "&lt;id&gt; is not an implemented capability".
- **Turn 2:** accepted `cannot_execute`.
  - Its `missing` text ends "(also missing: enchanting or anvil enchantment application)", and `missingCapabilities: []`.
  - The planner listed its gap descriptively. `proposalFromWire` keeps only snake_case ids in `missingCapabilities` and folds descriptive entries into the internal `missing` prose.
- **Projection:** the MB-PLAN-006 app-owned `publicBlocker` relays only code-id-shaped `missingCapabilities`. The owner-facing terminal was therefore exactly "the planner found no supported way to continue; planner turns 2 (knowledge 1, repairs 0, retries 0, replans 0), windows 0, tasks 0". The reason was silently lost.
- **Comparison:** the passing R17 262 fault-Jev P10 and the 261 R20 P10 differ only because the model happened to list a code-id-shaped capability there (R17: `enchanting`).

**Verdict:** a source projection defect. A code-verified fact was available but never projected. It is not an oracle bug.

### Correction

`publicBlocker` additionally names the capability ids that this goal (or its preparation draft) queried and that the CODE catalog answered `unknown`:

> not implemented (checked against the capability catalog): enchanting, anvil

- It is a code fact; the planner prose (`missing`, `verifiedProgress`) stays internal.
- Only ids that are snake_case, pass the question detector and are not already listed are shown. They are deduplicated, capped at four, and fall within the existing 400-character clip.
- Registered capabilities (status `known`) are never named.
- Both cannot_execute paths are covered: the admitted goal and the preparation discard.

### Control (`tests/cannot-execute-mechanic.test.ts`)

Actual composition: the real GoalEngine, the real `proposalFromWire` and the real VersionKnowledge over the real registered catalog.

The turn-2 raw wire is reconstructed. The real fold reproduces the journaled `missing` string exactly, and the test asserts that equality.

**Fail-before (pre-fix source):** produces exactly the actual terminal detail. Four controls fail as intended; the late-ownership control passes both before and after.

| Case | After the fix |
| --- | --- |
| Actual R20 sequence | Names `enchanting, anvil`; no prose relayed |
| Registered `craft_item` queried | Not named |
| No capability query | No clause |
| Code-id `missingCapabilities` entries | Shown as before |
| Bounds | At most four ids, duplicates merged |
| Redaction | `can_you_enchant` and `let_me_know` (question-shaped) are never relayed |
| Late ownership | A stop before the final turn publishes no capability blocker |

**Limit:** if a planner states the gap only in prose and never queried a capability, nothing new is named. Relaying sanitized descriptive phrases would widen the coordinator's app-owned text boundary, so it is a root decision.

### P4 on 261 (`R19-planner-real-261.log`), log only

goal-388b88db4ec2 shows the same pattern as 262:
- accepted possess ≥ 3 bread and near owner ≤ 3;
- four empty chest inspections, then `repeated_without_progress`;
- one explore toward the same north frontier, 0 drops, ending 24.33 from the owner;
- turn 6 `cannot_execute`;
- no question, inventory `{}`, the bread left in the world.

The P4 diagnosis and proposals above apply unchanged: the quantity is impossible in the fixture; single-frontier persistence is under the current guidance; the north choice is uninformed. The "undefined" objective label appears there too and is fixed in `4950b55`. P10 passed on 261.

### Checks (Node 24 PATH; logs `var/native-checks/p-r20b/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| P10 control on pre-fix source (4 fail as intended, late-ownership passes) | 1 | `3f87cacaf8788ca383b6fb527cb5605c99d43bb2b5b06396a2ac40a629d030c2` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1497/1497) | 0 | `6969d2fa602bcfc0c87e384649ee3cd1861d90d2f3796921d3369d90e4ca5b1f` |
| Focused (P10 control, MB-PLAN-006, planner engine, P4 fixture; 51/51) | 0 | `ebe30a6b44dc81b6979febc1182d95b0ff8f161fa01d77ccb33572d430882958` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Canonical `100ec816…` + `git diff 71b5880` (all R20 src/scripts, plus both new tests; temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1647/1647) | 0 | `17605f4ab4b77dc2677ddfcb39c07991938bebed8ddb982ade31ddb61166578b` |

No inference, fixture, RCON or provider access.

### Remaining uncertain / model-dependent

- **Live P10:** passes only when the model either queries the capability or lists it as a snake_case id. Both have been observed. Root's fresh real run decides.
- **P4:** remains a fixture/guidance product decision (see the proposals above).

# P-PLAN-R21 — root-authorized guidance A/B for P4 (worker P)

Parent `e1566d53a4e06ce2b1b1fe18cfa2ad4d2fa019c9`. This role update is a separate commit.

- **Source/test commit:** `a32cf642b9ba12a89b4e38d865d4d02ff72cd71b`.
- **Changed paths:**
  - `src/planner/prompt.ts` (+7/−4)
  - `src/goals/declarative.ts` (+2/−2)
  - `tests/planner-capability-composition.test.ts` (+1/−1; P-owned since `2f3bf5e`, version pin v7→v8)
  - new `tests/planner-guidance-quantity-search.test.ts` (+217)
- **Diff:** `git diff e1566d5 a32cf64` SHA-256 `5149b76a22758a227d79d11012042a7a8e976a51eb736639e82d4a5a8843d8d2`.

**Unchanged by this round:** the P4 instruction ('bring me some bread'), its hidden position, count 1, timeout and all harness gates. The W-R12 reservation was respected: `src/tasks/task-runtime.ts` and `tests/persistent-maintenance-selection.test.ts` are untouched.

## Causal source (actual 261 goal-388b88db4ec2, 262 goal-d885cb5cd4bb)

Two v7 lines produced the observed behaviour:
- "Quantity or material omitted: choose a modest task-appropriate amount" → both runs accepted possess ≥ 3 bread; the fixture has one.
- "Target not visible: … if it stays unavailable, answer cannot_execute" (written for deictic O5) → `cannot_execute` after one north frontier.

The question-refusal repair guidance (`declarative.ts`) also said "modest quantity".

## Change (instructions v8)

**A — quantity.**
- "Number omitted when obtaining or delivering a named item: plan for 1 unless the owner's words or the job clearly require more (e.g. a requested craft/build's ingredients or materials), and state that assumption."
- "A number the owner gives always binds exactly. Never rewrite an accepted outcome to another quantity."
- Material default kept separately; the interpretation example changed from "8 oak logs" to "1 oak log; no amount was given".
- The repair guidance agrees.

**B — specific targets versus resource search.**
- "that/this/the" specific targets: one bounded survey/explore step, then an honest visibility/path blocker (unchanged meaning).
- Obtaining a named resource: search before refusing.
  - Use distinct current frontiers with `visited` false inside the ORIGINAL admission bound (`route.admission` when present, else `observation.perception.travel`; code already refuses resource exploration beyond it, R17).
  - Spend only the existing remaining turns/replans/deadline.
  - Prefer nearby and toward where the job ends.
  - One empty container or one fruitless direction is not proof.
  - Refuse only when:
    - no unvisited frontier remains;
    - repeated verified failure for the same reason; or
    - the remaining limits cannot cover another step.
  - Name what was searched.
- "Never use hidden lookups or invented coordinates, and never wander indefinitely."

No limit, whitelist, model, provider, schema or code path changed.

## Controls (`tests/planner-guidance-quantity-search.test.ts`, no inference)

| Group | Controls |
| --- | --- |
| Text | Exact A and B rules present; v7 "modest" and the single early-refusal rule gone in both instructions and repair guidance. Generic: the five new lines name no item/block/container, introduce no number except the default 1, and mention no model/provider/fallback; owner seeking unchanged. |
| Grounding | One continuous real PerceptionService over the actual scene and P4 setup, admitted at the journaled anchor. For turn 6 (start) and turn 8 (after the journaled north arrival), the real `renderRequest` shows: the ORIGINAL bound 205.5,205.5 r128; the visible owner; 8 frontiers with direction and `visited`, ≥7 unvisited; the remaining turns/replans/deadline. The bread is occluded in both states. |
| Meaningfulness | The actual north choice never reveals the bread. The unvisited, in-bound frontier nearest the visible owner reveals it from BOTH actual decision states. |
| A attainable | possess ≥ 1 bread + near owner is schema-valid and matches the one supplied bread. |
| Immutability (real GoalEngine) | A replan lowering an accepted possess ≥ 3 to 1 is refused ("changes the accepted goal outcome"); the repair request still shows the original; repeating it exactly is accepted. |

Fail-before on the v7 sources: the three text controls fail; the four grounding/immutability controls pass (existing code facts).

## Checks (Node 24 PATH; logs `var/native-checks/p-r21/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| New controls on v7 sources (3 fail, 4 pass) | 1 | `db0c6ea71e6515d7c34c4a840f345132b5d91e88c2198e78f8162aa54ecf1349` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1504/1504) | 0 | `3fd34e5921b92dc5e81e49807dab4e468f559a0d33cbb33497e03713611f491b` |
| Focused: new controls, P4 fixture, MB-PLAN-006, capability composition, adapter, autonomy wire, planner engine, P10, owner scope (86/86) | 0 | `aadc1043de99f2317ed182a7695dd9dd9b8f11218dd503357a1f3676a40e6370` |
| Doctor 26.1.2 config (read-only) | 0 | `f124ed40f629fe491809411ea8deaa861eee8a3f684e6fb6f7ff26fb217d67e7` |
| Doctor 26.2 config | 0 | `d27f3a898c2054f976071fc265709d6bc9bcf85f6cd3ee01379c392bf8a49292` |
| Canonical `100ec816…` + `git diff 71b5880 a32cf64 -- src scripts tests` (patch SHA-256 `679e7e99…8cbf`, temp detached worktree, removed): typecheck | 0 | `e3b0c442…b855` (empty output) |
| Same: full suite (1654/1654) | 0 | `605e7e14fc5ff00406ff5d3a5aa042bd2cb5348266c51b73527bb1557ca85347` |

No fixture, RCON, provider, key or live-control access.

## Limitations (model-dependent; root fresh real acceptance required)

- Guidance cannot force the model:
  - it may still pick 3 for "some bread", or treat "the bread" as deictic;
  - it may choose a non-revealing unvisited direction or refuse early.
- Only the code-side facts B relies on are proven.
- "Toward where the job ends" assumes the owner is visible or remembered (it was in both replica states). The replica's owner visibility from the north end is inferred, not journaled.
- A changes defaults for every owner instruction with an omitted number for a named item. Explicit numbers and jobs that clearly need more are unaffected. The harness's other goals give explicit numbers, except the house build, which is a job.
- P10 (abfd5cb) is complete and unchanged; its own limits stand.
