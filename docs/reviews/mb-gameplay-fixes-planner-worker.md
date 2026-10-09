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
