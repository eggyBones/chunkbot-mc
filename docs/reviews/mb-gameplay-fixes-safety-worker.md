# W-R10 — survival-first water and mob policy vs. actual R16 failures (worker W)

Worker: native Claude Opus 5.5 (DSH `claude:claude-default`, `opus[1m]` → `claude-opus-5-5[1m]`, high). Worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-safety`, branch `chunkbot/gameplay-safety`, parent `63bde91a025f483f81a9afec1f98596bfb5f4c35`. No world, RCON, fixture, provider, credential or root-file access was used. The canonical copy `var/gameplay-fixes/acceptance-native` was read only.

## Verdict

**No owned product defect is established for O7P/O7R, O8D, O8C or O8N. No product source was changed.** O7P/O7R fail P's stationary post-release oracle. Every logged sample shows server-verified dry, grounded support with full air. The unlogged failing sample passed the oracle's support checks before failing its distance check. The movement is the intended resumption of the same ordinary follow goal on a fresh lease. O8D, O8C and O8N refused in staging before admission, so no mob policy executed. One owned regression was added: `9e9b84c`, test-only. It locks the diagnosed post-release boundary.

## Evidence identity

| Artifact | SHA-256 |
| --- | --- |
| 261 report `acceptance-native/.../2026-10-09T01-03-25-688Z-ordinary-goals/report.json` | `d4933b95f18d5a493b06b37644bdf83db0eb234efbf5a4df2b948c5f6de56b67` |
| 262 report `acceptance-planner/.../2026-10-09T01-03-25-641Z-26.2-ordinary-goals/report.json` | `b474b15cda556df633a03b6b6c87f6715d9a1ab5bcbd2fd7481a70f69f72df21` |
| 261 `run-safety-ordinary` journal `data/runs/run-3dd2d4f6b02d/events.jsonl` | `4ba1643c30b94968a5a3d81b831cf988305ba85a4921f8685983dd04444de30c` |
| 262 `run-safety-ordinary` journal `data/runs/run-405961ae54f2/events.jsonl` | `3d1b3c2ef439b4fd6d53a1e57b651debed822911ccf1a5d819056e17e4941c53` |

The 14 safety paths common to W `63bde91` and canonical `dd0b5a86` are byte-identical (`cmp`):
- `src/contracts/safety.ts`
- `src/skills/safety.ts`
- `src/safety/{adapter,dispositions,geometry,policy,service,tracker,trial-arena,trial-journal,trial-mobs,trial-rcon,trial-water,wiring}.ts`

`src/safety/ordinary-trial.ts` is a legacy W-only file. It is deliberately absent from canonical, was not compared, and plays no part in this diagnosis. Shared `conservativeMovements` in canonical `src/skills/navigation.ts:137` applies W's complete `applyDeepWaterAvoidance` (getBlock fence plus step hook) to every movement capability.

## O7P / O7R — application vs. oracle

P's oracle (`scripts/ordinary-goal-live-check.ts` `waterExitSettled`, lines 723–750) checks each sample in this order:
1. `onWaterBank`;
2. server `OnGround`, solid floor, air at feet and eye, and full Air;
3. only then the rule that horizontal movement since the previous sample must be under 0.8 blocks.

It samples every 250 ms plus RCON latency, for at least 3 s and 4 samples.

Actual frames (journal `t`, safety events):

| Case | Release (`skill_outcome escape_water`, "settled on dry solid support for 1000ms after control release") | Episode end | Ordinary resume | Fresh goal lease | Oracle failure → harness `stop_requested` |
| --- | --- | --- | --- | --- | --- |
| 261 O7P | 01:05:00.832 | 00.844 resolved | planner completes 04.196; owner 10.7 blocks away | `goal:1` 04.647, `follow_entity` | 05.151 |
| 261 O7R | 01:05:24.481 | 24.492 resolved, then `task_safety_clear` (waited 4111 ms) 24.493 | round 2: owner 10.3 blocks away | `goal:3` 24.947, `follow_entity` | 25.265 |
| 262 O7P | 01:05:00.247 | 00.254 resolved | planner completes 02.314; owner 10.7 blocks away | `goal:1` 02.851 | 03.389 |
| 262 O7R | 01:05:20.475 | 20.493, then `task_safety_clear` (waited 4003 ms) | round 2: owner 10.3 blocks away | `goal:3` 20.958 | 21.309 |

- In O7P the harness first waits for the actual planner completion, so the oracle's first sample is about 2–3.4 s after release. That coincides with the first ordinary action.
- In O7R the oracle starts at release, while the suspended task resumes 1 ms later. Escape moved the bot to the bank, so the owner was already more than 3 blocks away. The resumed `follow_entity` lease is taken about 0.45 s later.
- In every case the samples before the fresh lease are identical: stationary, grounded, solid floor, feet and eye in air, Air 300.
- The failing sample came after the fresh lease. Its failure message is the distance check. The oracle evaluates that check only after the same sample has passed the dry-bank and support/air checks.
- The failing sample itself was not appended to the evidence. Its exact position and displacement are therefore not recorded, and I make no claim about them.
- The last successfully logged samples are recorded:
  - 261 O7P sample 3 and 262 O7P sample 4 moved 0.63 blocks from the previous sample;
  - 261 O7R sample 3 moved 0.10 blocks.
  These logged samples are server-dry and grounded with Air 300.

The questions in the brief:
- **Release on truly stable support:** yes. The escape returns success only when, with controls already released, the eyes are out, the column is dry (or genuine shallow wading), and client `onGround` plus `hasSafeFluidSupport` hold continuously for 1000 ms. A surface bob never enters that branch. The server samples corroborate this.
- **Immediate re-entry by the resumed task:** none was observed. Every sampled resumed position is server-dry bank. Resumed movement uses the shared deep-water policy, and the installed A* evidence is in `tests/safety-pathing.test.ts`. If re-entry did happen, the monitor would preempt again (see the regression below).
- **Survival priority and finite allowances across protected transitions:**
  - The O7R journal shows `safety_preempt` of the active follow lease, `task_safety_hold`, a finite grant (1 action, about 4.4 s, displacement within bound), `task_safety_clear`, then the same goal and epoch with a fresh lease. Goal counters were unchanged (plannerTurns 1, tasksAdmitted 1). There was no re-anchor, and the route reported `legsUsed 0`.
  - O7P shows the same finite grant during the actual in-flight subscription planner turn.

**Diagnosis:** the movement is the intended product behavior ("freshly resumes the same goal", O7R title), not unsafe release. Suppressing ordinary movement to satisfy the oracle would contradict the product. This belongs to P's harness.

**Proposal to P via Codex (harness only; no application change):**
- Keep the strict stationary rule where no ordinary work can resume: O7W after stop, and W's module gates.
- For O7P/O7R:
  - Require every post-release sample, for at least 3 s, to keep the dry-bank, grounded, solid-floor, air-feet/eye and Air-300 checks, with no new safety episode.
  - Accept horizontal displacement only after a journaled post-release ordinary action of the same goal and epoch. That means a `lease_acquired goal:<epoch>` / `skill_started owner goal` whose time precedes the moving sample.
  - Fail any displacement without that provenance, any loss of dry support, and any new episode, as now.

## Mobs

- **O8D (both releases):** `staging_unready: current server gear missing/unknown`. The O8D CLI journals (261 `da33a3636a08…`, 262 `fb2bbcdc6afe…`, 34 events each, exit 0) contain zero `goal_admitted`, zero `safety_episode_started` and zero `skill_started`. Nothing executed, so I make no claim about combat. Prepared-defense policy is unchanged: retreat default, melee-contact cap, gear/health/food/adult/footing/damage windows, cumulative attack budget. Also unchanged are the retained results of the old genuine O8D (one hit, loss of footing, correct finite retreat, kill failed, no kill credit).
- **261 O8N:** `staging_unready: full stable control-player health required`.
- **262 O8C:** `staging_unready: unexpected visible nonplayer group`.
- Both are pre-admission staging refusals in P's harness. The opposite release passed each case (261 O8C retreat resolved with no attacks; 262 O8N no damage, attacks or episodes). No policy defect is shown.
- O8M/O8A pass on both releases at health 20.

## Owned change

`9e9b84c` `tests/safety-skills.test.ts` (+44 lines) is an installed-physics module regression through the real lease, actuator and service monitor:
1. An ordinary goal lease is preempted by water, and the episode resolves on settled solid support.
2. A fresh ordinary goal lease then walks away from the pool on dry ground. It sees no hold, no preemption and no new episode, and moves more than 0.8 blocks.
3. When that resumed motion walks back into deep water, the lease is revoked with `safety_preempt`. A NEW finite grant (different id) resolves, and cumulative episode history is 2.

It passes on unchanged source. That is intended: it documents correct behavior, it does not fix anything.

## Checks (Node 24.21.0, direct exits)

| Command | Exit | Log SHA-256 |
| --- | --- | --- |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (960/960 pass) | 0 | `9bbbf0aa3fcc877c3af318c7ff3a99477511d1f89437c69d5f9b1b1328a94c3f` |

## Limitations

- The regression is client-physics and module evidence: a Mineflayer-shaped bot plus installed prismarine-physics. It is not server or provider proof.
- The real follow pathfinder plugin is not loaded offline. The resumed mover is a goal-owned actuator with direct controls.
- World, provider and combined acceptance stay with the coordinator.
- O7F (hidden-owner oracle before staged execution) is outside W-R10's owned policy question and was not diagnosed.
