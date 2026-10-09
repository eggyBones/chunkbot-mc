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

---

# W-R11 — server held-gear oracle vs. actual R18 O8D worn-stack replies

Narrow ownership exception granted by the coordinator: only `serverHeldGear` and its private parser helpers in `scripts/lib/ordinary-safety-oracles.ts`, the new `tests/safety-held-gear-oracle.test.ts`, and this document. No other oracle function, P harness/staging test, or application/shared source was edited. No world, RCON, fixture, provider, credential or root access was used. Canonical `acceptance-native` `3913fb1e9c76155684965db6a690e221e7e8f5e5` was read only.

## Verdict

R18 O8D did not execute on either release. That refusal came from a **proven harness representation defect**, not from combat or readiness policy. The actual worn armour now carries routine wear as a nested component. The baseline oracle could not parse that, so it reported the genuinely worn iron helmet and chestplate as absent, and the harness staging refused with `staging_unready: current server gear missing/unknown`. This supersedes W-R10's "current server gear missing/unknown" wording for O8D: actual worn-stack data has now been observed and read. The combat result itself remains unknown, because no defense episode ran.

## Evidence identity

| Artifact | SHA-256 |
| --- | --- |
| R18 261 report `acceptance-native/var/live-check/2026-10-09T01-45-54-344Z-ordinary-goals/report.json` | `59ec08d685c9743739ff4b631acf1ccf2d3074b5e5dda825ec0aecb0988023eb` |
| R18 262 report `acceptance-planner/var/live-check/2026-10-09T01-45-54-736Z-26.2-ordinary-goals/report.json` | `e0bde872fc19e4436752528ca5731774d117aa7c81b168f020340f242edf5ed6` |
| Baseline `scripts/lib/ordinary-safety-oracles.ts` (reviewed `24c1fc47`, identical to canonical `3913fb1`) | `9a2862b82e32cdb23f8ff049753e37dd0d36767f47dae05b0d36e6ad767b78e4` |

Both reports record the same three O8D readbacks, taken after the genuine staging hit:
- 261: `atMs` 1791510436544 to 1791510436545
- 262: `atMs` 1791510436713 to 1791510436715

The readbacks:
- `data get entity Chunkbot Inventory` → `Chunkbot has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]`
- `data get entity Chunkbot equipment` → `Chunkbot has the following entity data: {head: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_helmet"}, chest: {components: {"minecraft:damage": 1}, count: 1, id: "minecraft:iron_chestplate"}}`
- `data get entity Chunkbot SelectedItemSlot` → `Chunkbot has the following entity data: 0`

Both reports retain O8D `fail` with `staging_unready: current server gear missing/unknown`. They are unchanged.

## Pre-fix reproduction (exact actual readbacks, baseline `6bf3a75`)

The baseline `serverHeldGear` returns `{mainHand: "minecraft:iron_sword", head: null, chest: null, selectedSlot: 0}` for those exact replies. Its `worn()` regex `head: \{([^{}]*)\}` cannot span the nested `components` compound, so the worn pieces read as **absent**, not even as unknown. The harness check `gear.head === iron_helmet && gear.chest === iron_chestplate` then refuses.

The new test file run against the baseline (pre-fix) exits 1 with 24 of 47 tests failing (log SHA-256 `a159268884d480e730df978ecdffe366fab8a4693de600142bb7f754865633e1`). Two groups failed:
- **Actual replies:** the exact R18 replies and other normal nested components.
- **Adverse cases the baseline also wrongly accepted:**
  - duplicated `id`, `count` or `Slot`;
  - a duplicated nested component key;
  - missing, zero, negative, fractional or string `count`;
  - a non-namespaced id;
  - a non-compound Inventory entry;
  - truncation, an extra closing brace, a dangling comma;
  - an unknown equipment slot name, a non-stack worn slot, a misnested chest, a worn stack of two;
  - a nested id or `Slot` impostor;
  - oversized input.

## Correction (`98322f8`)

`serverHeldGear` now parses the three replies structurally:
- **Reply shape:** the exact `<name> has the following entity data: ` prefix, followed by a strict, bounded SNBT subset parse (at most 16 384 characters, depth 12, 2 048 nodes). Accepted values are compounds with bare or quoted keys, lists, typed `[B;/I;/L;]` arrays, quoted strings with escapes, and suffixed numbers.
- **Fails closed (null):** any malformation, duplicate key at any depth, trailing text, extra closer, dangling comma, unterminated string, or exceeded bound.
- **Identity:** only a stack's **own top-level** `id` (namespaced string) and integer `count` (1..99) count.
  - A stack may carry only `id`, `count` and optional `components` (a compound), plus `Slot` for Inventory entries. Any other top-level key, such as a misnested `chest`, is malformed.
  - A nested `id` or `Slot` inside `components` is never an identity or a slot.
- **Inventory:** must be a list of such stacks with a byte `Slot`. The held item is the single entry whose top-level `Slot` equals the selected slot; two such entries is ambiguous and returns null. Legacy `Slot: 100–103b` armour is carried, not worn.
- **Equipment:** must be a compound whose keys are installed EquipmentSlot names (`mainhand, offhand, feet, legs, chest, head, body, saddle`). Every present slot must be a well-formed stack, and worn armour pieces (`head/chest/legs/feet`) must have `count: 1`. An off-hand stack such as 64 torches is valid and never counts as chest armour.
- **SelectedItemSlot:** exactly one decimal digit 0..8. No type suffix, list, fraction, sign or empty reply is accepted.
- **Unchanged:** the return shape, every caller, and all readiness/combat policy. Wear metadata does not revoke a known item identity; the harness still requires the exact sword, helmet and chestplate ids. The client-snapshot equipment check, health of at least 14, the 6 s damage window, reach 3.5, 10 s readiness, exact same-zombie kill, footing and identity/foreign refusals all stay with the existing harness and application code.

`tests/safety-held-gear-oracle.test.ts` (48 tests):
- **Actual replies:** the exact R18 readbacks produce `{iron_sword, iron_helmet, iron_chestplate, slot 0}`.
- **No regression:** the R16 undamaged format still parses.
- **Synthetic normal components:** damage, enchantments, custom name with escapes, trim, an int-array profile, a damaged sword and a carried stack.
- **Synthetic impostors:** a nested container id, a missing top-level id, a nested `Slot`, offhand-as-chest, legacy and carried armour, a non-selected sword, and an off-hand stack.
- **Fail-closed cases:** 38 malformed, duplicate, ambiguous, truncated, misnested, unreadable or invalid-selected-slot replies return null, plus oversized and over-deep inputs.

## P test reconciliation (through root; I did not edit it)

Canonical `tests/ordinary-safety-staging.test.ts`, the R16 O8D block, line 309:

```
[R16_INVENTORY, 'Chunkbot has the following entity data: {head: {components: {"minecraft:damage": 3}, count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}', '0', 'unparsed component body fails closed'],
```

This negative case encodes the defect. It expects a VALID nested `"minecraft:damage": 3` to refuse. With the corrected oracle it returns the full sword/helmet/chestplate gear, so that assertion fails as expected. Proposed replacement for P:
1. Move this input to a positive expectation, "worn damaged helmet keeps identity", returning the full gear.
2. If a fail-closed component case is still wanted, use a genuinely malformed body, e.g. `{head: {components: {"minecraft:damage": 3, count: 1, id: "minecraft:iron_helmet"}, chest: …}` (unterminated components) or a duplicated `"minecraft:damage"` key.

I evaluated every other assertion in that block (lines 299, 301, 303–308) by direct calls to the corrected function. Each still holds. I did not run P's file in this worktree, because it is not present here. The remaining `meleeReplay` override cases (legacy/chest/selected) use formats covered by the same parse paths, but they were not executed.

## Commits (parent → head)

| Commit | Parent | Content |
| --- | --- | --- |
| `6bf3a756a33604e723872477c0ff9c0191932125` | `4bc64fefa5a3e2fbf2faceebe548950683bac7e2` | baseline dependency: exact copy of the reviewed `24c1fc47` oracle file (+260 lines) |
| `98322f8d7bd96d9bcbac16f7db73a4a7b8cf9e93` | `6bf3a75` | correction: `scripts/lib/ordinary-safety-oracles.ts` (single hunk inside `serverHeldGear`, +170/−18), new `tests/safety-held-gear-oracle.test.ts` (+140) |
| this doc commit | `98322f8` | role documentation only |

The 14 other exported oracle functions are byte-unchanged:
- `pendingRealTurn`, `verifyPlannerWaterRace`, `verifySafetyOwnership`, `verifyFiniteEpisode`;
- `verifyNoAttacks`, `verifyPreemption`, `ownerStandingCommands`, `verifyHiddenOwner`;
- `freshFarCue`, `verifySharedSafetyHistory`, `postReleaseMotion`, `insideSceneColumns`;
- `foreignVisibleAfterResponse`, `verifyNoFarPoint`.

Root imports only the correction diff `6bf3a75..98322f8`.

## Checks (Node 24.21.0, direct exits; logs retained in this worktree's ignored `var/w-r11/`)

| Command | Exit | Log SHA-256 |
| --- | --- | --- |
| focused test, pre-fix (baseline) | 1 (24/47 fail) | `a159268884d480e730df978ecdffe366fab8a4693de600142bb7f754865633e1` |
| focused test, post-fix | 0 (48/48) | `52f9eec59c6f81da50dabd1badf22625ac282ce3d419320671cf6d3b3b1c66bf` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test` (1008/1008; P's staging test file is not in this worktree) | 0 | `32acaf75b87094f5a1bd371280a312676aff66fe844990ecede26b5e18ef1ef1` |

## Limitations

- This is an offline representation proof from exact retained replies. No server re-read, world, provider or combat evidence exists for the corrected staging, and O8D's defense outcome remains unproven until the coordinator reruns it.
- The SNBT subset covers the printed shapes of these three `data get` replies, not every SNBT form. Unsupported forms fail closed to `null`, which yields staging-unready, never a pass.
- The expected failure of P's old line-309 case is separate from these focused checks and needs P's reconciliation after root approves this source.

# W-R12 — persistent maintenance selection vs. actual R19 26.1.2 P6 (worker W)

Worker: native Claude Opus 5.5 (DSH, high), same worktree. New branch `chunkbot/gameplay-safety-r12` was created with `git switch -c` from root-reviewed `100ec81604f44ca867c48306fba4e0b1c3e80b6a`; the old branch `chunkbot/gameplay-safety` (`0a7f947`) is preserved. Temporary ownership: `src/tasks/task-runtime.ts`, the new `tests/persistent-maintenance-selection.test.ts` and this document. No world, RCON, fixture, provider, credential or root-copy mutation. Root artifacts were read only.

## Verdict

**An owned runtime efficiency defect was established, and a generic correction was made.** Following itself was good: server distance 2.2, the goal still active and no planner turns. The original quiet gate failed because the runtime offered, for a persistent maintain task, the sustained `follow_entity` next to the finite `move_near` on every violation round. Jev legitimately chose the one-off each time. Each choice ended on arrival, so every owner step needed a new request. The P6 oracle is not wrong: stable following is designed to be a local wait (`follow_entity` limitation: "stable following is a local wait, not repeated inference").

## Evidence identity (read only)

| Artifact | SHA-256 |
| --- | --- |
| `acceptance-native/var/live-check/2026-10-09T02-33-38-033Z-planner-jev-real/report.json` | `13260e76e41113ee8596176b1046042dc5a1295a72554698bca9bd67edcc1073` |
| same dir `run-planner-jev-real.log` | `376bbacbd522ac48fcb995ce3e6e0458111bccb91693836491adbf29848ed1f5` |
| run journal `acceptance-native/var/runs/run-43de6c6a40fc/events.jsonl` | `0909e0da399f357a4f7d8e604501cd580050a808d9f73bc6181a9efdfd036f43` |
| run planner journal `.../run-43de6c6a40fc/planner.jsonl` | `8b0a95fe52f4bde110a5c26202b64458f4b2caeec36d05a9281d91996f796498` |
| `codex/R19-planner-real-261.log` (P6 FAIL) | `f5fe0ad28a6c53099b46449e40c72fd61febc0bbdf3bbd241268c69116f57cf7` |
| `codex/R19-planner-real-262.log` (P6 PASS) | `b2499fbc3fa97d4a505a7ba6d91250cd589e8a0903207c8fa1de3bce00f4e336` |

## Actual trace (261 P6, goal-b65c8f2fbb3f, task-631733828d2a, mode maintain)

The accepted TaskSpec (planner `req-39e8640f6055`) had:
- `allowedCapabilities` `[follow_entity, move_near, seek_owner]`;
- `parameters` `{within: 3}`;
- completion `near_target owner within 3`;
- the instruction "Follow the visible owner within 3 blocks … Maintain quietly when already near."

| Round | Distance | Offered (frozen) | Jev choice (p) | Result |
| --- | --- | --- | --- | --- |
| 1 | 4.5 | follow_entity, move_near; seek_owner:owner_visible | move_near (0.70) | arrived 2.42, hold |
| 2 | 5.2 | same | move_near (0.84) | arrived 2.24, hold |
| 3 | 4.5 | same | move_near (0.82) | arrived 2.42, hold |
| 4 | 4.3 | same | move_near (0.90) | arrived 2.24, hold |
| 5 | 3.0 | follow_entity only (move_near:no_grounded_destination) | follow_entity (1.0) | followed 15.5 s until stop, cancelled owner_stop |

Totals: 5 Jev requests and 0 local continuations in ~32 s, against the gate of at most 3. 262 P6 had Jev choose follow first: 1 request, 1 local continuation, pass. The extra requests are valid, safe one-off choices. They are explained by the option set, not by motion, survival or a Jev fault.

## Correction (`84cf97a`, `src/tasks/task-runtime.ts` only)

- **Scope:** `maintain` tasks only.
- **Qualified option:** a usable option is preferred when all three hold:
  1. its registered skill definition declares `sustained` (`deps.sustained`, which is the registry; no capability names in code);
  2. it already passed the existing retry, repeat-without-progress and low-health allowance filtering;
  3. its own last non-cancelled dispatch in this task, if any, ended in that policy's healthy window.
- **Freezing:** when any qualified option exists, the bounded option set is frozen from that subset only.
- **Fallbacks:**
  - An option whose last dispatch ended unhealthily (failed, precondition, or partial without a window) is not preferred until it completes a healthy window itself. Until then the full valid set is offered.
  - A cancellation (safety preempt, stop) neither declines nor requalifies an option.
  - With no qualified option, the ordinary full set is offered.
  - Finite tasks are unchanged.
- **Unchanged:**
  - There is still exactly one Jev choice per round.
  - After the await: ownership, connection and safety checks, then revalidation against a fresh snapshot.
  - Allowance gates and reservation, outcome identity, the no-progress guard, and safety hold clearing `sustain`.
  - Local continuation only while an equivalent option exists.
- **Journal:** `task_round` gains `sustainedPreference.deferred` (capabilities withheld). `truncated` now refers to the frozen pool, so a deferred one-off is not called truncation.
- No contract, port, registry, prompt, GoalEngine, harness or enum change. Thresholds and budgets are unchanged.

## Proof (`tests/persistent-maintenance-selection.test.ts`)

**Composition.** Actual PerceptionService (offline-name owner policy), `SkillRegistry(allSkills + locatorSkills)`, TaskCandidateGenerator, PredicateEngine (its correlated inventory resync is answered by the fake server) and TaskRuntime, with the registry's own sustained policies and the actual fixture limits. The executor, the Jev port and time are scripted, so this is not movement physics. The fixture uses:
- the verbatim P6 TaskSpec;
- the P6 harness owner walk, translated by (−208, +60, −200): 8 steps × 4 s, stop at 32 s.

The first test proves the composition yields the actual round-1 option list and distance: follow_entity, move_near, `seek_owner:owner_visible`, 4.5.

**Fail-before** (baseline `100ec81` runtime, committed test): exit 1, 3/11 failing.
- The P6 replay with the R19 one-off-preferring Jev gives `quiet maintenance: Jev 7` (0 continuations).
- The unhealthy-end case fails, as does the safety case (follow is never chosen).

**After:** 11/11.
- P6 replay: exactly 1 request, frozen `[follow_entity]`, at least 1 local continuation, distance ≤ 3, `sustainedPreference.deferred [move_near]`, `truncated false`.

**Adverse controls:**
- follow-first Jev unchanged;
- finite task still offers both options and may execute move_near;
- maintain without a sustained option falls back to the ordinary set (every dispatch has a Jev choice);
- an unhealthy follow end gives the full set next;
- retries still exclude a thrice-failing follow;
- a safety preempt gives hold, clear and a fresh request, with the preempted follow re-preferred and never continued across safety;
- a low-health allowance granting only move_near is never widened;
- a stop during the Jev await dispatches nothing;
- an owner hidden during the await gives `task_choice_stale` and no follow.

**Mutation check** (temporary, restored byte-identical):
- applying the preference to all modes fails the finite control;
- removing the decline fails the unhealthy-end control;
- declining on cancel fails the safety control;
- preferring over the unfiltered set is behaviourally equivalent, because every retry-excluded option has already been declined.

## Commits

| Commit | Parent | Paths |
| --- | --- | --- |
| `84cf97a0a43b862388d30e1e72cba33e46ca76b7` | `100ec81604f44ca867c48306fba4e0b1c3e80b6a` | `src/tasks/task-runtime.ts` (+27/−3), `tests/persistent-maintenance-selection.test.ts` (+348) |
| (this document) | `84cf97a…` | `docs/reviews/mb-gameplay-fixes-safety-worker.md` |

- Source patch `git diff 100ec81 84cf97a | shasum -a 256`: `3494bb4ad5775ac668c4a50a01053dcfdc1b07cc2478d58eba8ed430e0aeecc6`.
- File SHA-256: runtime `4e109cfd6437d68d1ef2594bae9cde4ba8b06df7f2e75419b1c334a888c5e48b`, test `e217b34ec13859cd7c0ef907eb6637fb78ab8aefd22a24e9d438829af808add6`.

## Checks (Node 24.21.0, direct exits; logs in this worktree's ignored `var/w-r12/`)

| Check | Exit | Log SHA-256 |
| --- | --- | --- |
| Focused fail-before (baseline runtime, committed test), 3/11 fail | 1 | `a3b9dd494f773c84a4904668261fa5f39dea3a73615568aa3b61dae0992ef102` |
| Focused after, 11/11 | 0 | `1bb8ddd0941934557bafc42f3f4b4c767a110eada128e72902d2e24e56d98ea0` |
| `npm run typecheck` | 0 | `54f8c884c94b75895a95d9205c411167bfd4a94fd36c0a921ae8313e715fd7f8` |
| `npm run build` | 0 | `1537c3e259c4849c097c4c340708415b7d230f36bcf2a1dfee6410196b294715` |
| `npm test`, 1649/1649 | 0 | `0561b3052fbe646aef2dc5224dad1d5b85d0c29975bbcc0a88fabf98e5de8764` |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | `47073e74c354fb9021bca0f04869aa05bd1bc17922e84978b9ac29244e3858b2` |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | 0 | `1eb8797260df04dda6fc1889fb892cf39a0d7ee0d902d48f3de065d519afcaa5` |

The 26.2 doctor reported, read-only, a running fixture process (pid 69677, root's `var/fixture-26.2` server started Oct 7). I did not contact or change it.

## Limitations

- This is offline, inference-free evidence. The scripted executor stands in for actual pathfinding; I claim no world or Jev proof. The original R19 261 P6 failure stays failed. The fix is unaccepted until root reviews it and reruns actual P6 (and P4/P10 and the handoff checks as affected) on both fixtures.
- A healthy sustained window that does not advance an unmet maintained condition is still bounded only by the existing no-progress guard (blocked `no_progress`, then planner feedback). In a maintain task that also allows a finite alternative, Jev can no longer pick that alternative while the sustained option stays qualified. For the current sustained skills (follow_entity, seek_owner, route_travel, rest_in_place, furnace_wait) the healthy window is their intended waiting. An unhealthy end restores the full set.
- Decline is per task and keyed by the option's world identity at dispatch. A new task starts fresh.
