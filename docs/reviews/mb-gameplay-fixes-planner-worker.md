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
