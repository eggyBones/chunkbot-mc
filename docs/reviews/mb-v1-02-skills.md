# MB-V1-02 skills: worker evidence

**Status: ready for coordinator review. It is not self-accepted.** This covers:

- the original MB-V1-02 assignment (perception, game knowledge, general Minecraft skills);
- correction MB-SKL-001..010 ([consolidated brief](mb-v1-02-correction-brief.md); issues in [v1-perception-skills-plan.md](../v1-perception-skills-plan.md));
- the earlier remaining variants (MB-SKL-007 admission anchor, MB-SKL-009 container freshness);
- this turn's MB-SKL-009 **observation authority boundary** (client-predicted world changes);
- the MB-FND-003 required-check hardening delegated to this worker.

Issue status is the coordinator's to reconcile. Roadmap and status documents were not edited.

Worker: native Claude Code session (Opus 5.5). Date: 2026-10-05 UTC (2026-10-04 local).

## Final commands and results

All commands were run from the repository root with `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`, and exit codes were captured directly. Every result below is against the final source.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` (typecheck, build, test) | 0 | **170 tests / 47 suites, 170 pass**. Two consecutive full runs on the last two source states, each passing on the first attempt. |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | no failures. Knowledge: "recipe/fuel/tag mechanics … used only for exactly 26.1.2". Planner/Jev not-ready warnings are expected. |
| `npm run doctor -- --config config/examples/microsoft.json` | 0 | no failures. Warnings: no bot token cache (no sign-in performed), planner/Jev not installed. |
| `npm run live-check` (foundation, built CLI) | 0 | **16/16**, `var/live-check/2026-10-05T04-00-01-828Z/report.json` |
| `npm run skills-live-check` (built CLI) | 0 | **33/33**, `var/live-check/2026-10-05T03-56-39-351Z-skills/report.json`. CLI pid 80719 exited 0; second session config `travel-radius-8.json` is in the same directory. |
| 22 coordinator probes `/tmp/chunkbot-mc-*-probe.mjs`, each `node <file>` | 0 each | **22/22**, including the new `predicted-visibility` probe, unmodified. The `goal-anchor` probe stays adapted to the admission API as recorded earlier; its unadapted original `/tmp/mb-goal-anchor-original.mjs` also exits 0. |

Fixture and process state after the final runs: vanilla 26.1.2 (protocol 775), PID **31385**, unchanged since foundation acceptance (`npm run fixture -- status`: running, 0 online). Server 127.0.0.1:25566, RCON 127.0.0.1:25576. No Chunkbot CLI process is running.

Server log `var/fixture/server/logs/latest.log`: these final runs added no WARN/ERROR lines. Earlier lines in the file are the startup offline-mode notice, `handleDisconnection() called twice` from the foundation kick scenarios (17:14, 20:32), and one teardown race at 20:09:49. The out-of-range barrier packets produce no server output.

## This turn

### MB-SKL-009: unconfirmed client predictions never reveal world data

**Problem.** Mineflayer changes its world model before the server answers. When a dig finishes, `digging.js` calls `bot._updateBlockState(pos, 0)`. Perception read that mutable model directly, so a client-only hole exposed blocks, entities and drops behind it in `take()`, `blockVisibleNow` and `entityVisibleNow` (coordinator probe `predicted-visibility`).

**Authority boundary.** There is now one authoritative world view for every observation and skill path: `sessionWorld(session)` in `src/perception/perception.ts`.

1. **Marking predictions.** The connection installs `tapClientPredictions(bot, evidence)` (`src/game/server-evidence.ts`). Mineflayer applies server updates through its internal `updateBlockState`, but local optimistic updates go through the public `bot._updateBlockState` property. Wrapping that property marks exactly the locally predicted voxels as pending in the evidence journal. The tap is idempotent and installed when the blocks plugin is ready. The previous mark at dig *start* in the actuator was removed: it was too early, and it covered digs only.
2. **Resolving predictions.** A pending prediction is resolved only by a server statement: `block_change`, `multi_block_change`, a chunk (re)load, unload, respawn or login.
3. **The world view.** `sessionWorld` returns server-loaded block data, except that a voxel with a pending prediction is `UNCONFIRMED_BLOCK`: an opaque, full-cube, **unreported** voxel. It is used by:
   - snapshot discovery rays (`take`);
   - `blockVisibleNow` and `entityVisibleNow` (entities and drops);
   - frontier search;
   - placement sites and destinations;
   - visible-face checks in mining, crafting tables and interfaces;
   - `liveBlock` revalidation, which now refuses a pending voxel with `target_unconfirmed` instead of claiming it "is now air";
   - the `block_state` predicate (via `perception.world()`).

   No code path uses the raw client model for visibility. The raw view is module-private.
4. **What is preserved.**
   - A genuinely server-confirmed hole reveals everything behind it.
   - A server rejection (the server re-states the original block) restores the opaque wall.
   - Glass, pane and fluid policy is unchanged.
   - Earlier observations stay resolvable, timestamped history.
   - Nothing is suppressed globally: only the pending voxel itself is unknown.

**Evidence.**

- Coordinator probe `predicted-visibility`, unmodified, exits 0:

  | Stage | ore | entity | drop |
  | --- | --- | --- | --- |
  | before | false | false | false |
  | through the unconfirmed prediction | false | false | false |
  | after server confirmation | true | true | true |

- `tests/corrections-prediction-visibility.test.ts` uses the real `PerceptionService`, `ServerEvidence`, resolvers and tap over the installed 26.1.2 registry:
  - a predicted hole hides ore, cow and drop in snapshots and in live visibility; the unconfirmed voxel is not reported and no frontier passes through it; after server confirmation all six flags are true;
  - a server rejection restores the wall;
  - an unrelated pending prediction does not affect the glass positive (emerald behind a window) or a resolvable earlier observation of the ore;
  - mining offers no candidate through the hole, and placement neither targets nor fills the unconfirmed voxel, while other faces remain; `liveBlock` returns `target_unconfirmed`; after confirmation, mining offers the ore (positive control);
  - the tap wraps `_updateBlockState` idempotently, runs the original update exactly once, marks the voxel, and the server statement resolves it.
- Built M1: on real Mineflayer, each of the three log breaks reports `clientPredictionsMarked ≥ 1` with `predictionPendingAfter: false`. The real dig made a local air prediction, the tap marked it, and the server block change resolved it. P1, V1 and FL1 visibility positives and negatives all hold.

### MB-FND-003: hardened the abandoned-auth replacement regression

`tests/connection.test.ts` "a late lookup from an abandoned join cannot affect a replacement connection" previously depended on real-time ordering: an 80 ms tick against a 30 ms success window. It now uses **controlled deferred resolution**. The abandoned join's profile lookup is a promise the test releases only after the replacement is ready. The join window is a realistic **150 ms**, so the abandoned join still times out.

All original assertions are kept:

- the old join times out (`no valid spawn within 150ms`) and created no client;
- exactly two lookups happen;
- only the replacement created a client;
- the replacement is `ready` at connection epoch 2;
- the late completion causes no interference.

No production connection deadline changed. Isolated, it passed 10/10. Under deliberate load (8 concurrent copies of the whole `connection.test.ts`, 3 rounds) it passed **24/24**. Both full `npm run check` runs passed on the first attempt.

### Accounting

Normal outcome `commandsIssued` now uses the monotonic `act.issued` counter, the same total used for unknown-after-confirmation counts. The `commandTrace` stays bounded to the last 200 commands (`act.commands`), and cancellation provenance (`partialEffects`) is unchanged.

## Earlier variants (still verified)

**MB-SKL-007 admission anchor.**

- `GoalEngine.onGoalAdmitted` runs synchronously for the new epoch before planning. It calls `SkillRuntime.onGoalAdmitted`, which calls `PerceptionService.admitTravelAnchor`.
- The executor never sets the anchor. A goal action whose epoch did not admit the current anchor is refused with `travel_anchor_not_admitted`.
- `/diag anchor` keeps the current goal's anchor.
- Built B5:
  - admission anchor 199.5,198.5;
  - unchanged after Chunkbot was teleported 6 blocks;
  - a replacement goal gives anchor 205.5,198.5;
  - run evidence `goal_travel_anchor` records epochs 1 and 3. Both goals end `planner_not_ready`.

**MB-SKL-009 container freshness.** `container_state` is current only for a skill's own server-synced read (`inspect_container`, `container_transfer`, or a furnace skill) on this connection and lifecycle, made at or after binding, and at most 60 s old. Anything else is `unknown` and labeled historical. Built T1:

- satisfied after an inspection made after binding;
- **unknown** for an outcome bound after the last read ("historical only (then 1 minecraft:stone)");
- **satisfied** after a fresh inspection.

**Cancellation.** `partialEffects` separates confirmed effects from unknown later commands:

- X3: `{confirmed: none, additional: unknown, commandsAfterLastConfirmation: 25}`; RCON shows the real 12 sticks.
- X5: `{confirmed: server_packet}`.

## Built skills runs (all recorded)

Earlier turns:

| Report | Result | Cause | Classification |
| --- | --- | --- | --- |
| `02-41-46-967Z` | 31/33 | X3 read an old field; PL2 picked the bot's own voxel (correctly refused) | Script defects, fixed |
| `02-48-27-865Z` | 31/33 | M3 vanilla item merge (honest `item_vanished`); PL2 snapshot cap | Script defects, fixed |
| `02-52-47`, `03-00-12`, `03-06-43` | 33/33 | — | Superseded by source and assertion changes |
| `03-20-00-647Z` | 32/33 | FL1: the wall's glass window gave a legitimate line of sight | Scene fixed: window closed for FL1 (recorded), occlusion asserted as a precondition |
| `03-24-23-422Z` | 32/33 | PL1: the staging point plus arrival tolerance put the furnace beyond the 4.2 reach (correct refusal) | Staging fixed (2.5 east); per-face exclusion evidence added |
| `03-33-12-974Z` | 33/33 | — | Superseded by this turn's source |

This turn:

| Report | Result | Note |
| --- | --- | --- |
| `2026-10-05T03-52-35-980Z-skills` | 33/33 | first run on the prediction-boundary source |
| `2026-10-05T03-56-39-351Z-skills` | **33/33** | **final**: adds the M1 assertion that real digs mark and resolve client predictions |

There were no unchanged reruns this turn. Each run followed a source or evidence change.

## Setup and operator interventions (final run)

The scene is rebuilt only in x 196..224, z 190..224 (`scripts/lib/scene.ts`). All **89** RCON setup commands are recorded in `report.json.setupCommands`: 30 `tp`, 18 `setblock`, 13 `fill`, 7 `summon`, 7 `give`, 5 `clear`, 4 `kill`, 2 `effect`, 1 `forceload`, 1 `gamemode`, 1 `list`.

- **Gives**, which never stand in for a tested acquisition:

  | Command | Used by |
  | --- | --- |
  | `give Chunkbot oak_planks 8` | PR1 |
  | `give Chunkbot cobblestone 8` | F1 8-ring (the 2 mined cobblestone are M3's own) |
  | `give Chunkbot bucket 1`, `give Chunkbot shears 1` | E1 tools |
  | `give Chunkbot oak_planks 40` (after clearing planks/sticks) | X3 |
  | `give Chunkbot cobblestone 30` | X4 |
  | `give Chunkbot cobblestone 3` | PL2 |

  No wool top-up was needed.
- **FL1 window:** `setblock 207 -59 212 stone_bricks` before the scene and `… glass` after it. Scene precondition held: owner `visible=false` after the hidden teleport.
- **T2:** `clear FixtureOwner` runs on join, so the owner's gain is measured from 0: stone 0 → 1, matching the one collect packet naming the owner.
- **M3:** no give or teleport repairs a drop. The server auto-collected the drops; the skill-confirmed inventory and RCON both show cobblestone 2 and no stone.
- **RCON truth queries** are serialized and attributed (N1: Chunkbot 211.5,213.5 vs owner 212.7,216.1).

## SKILL-1..5 evidence (final run)

| Slice | Built evidence |
| --- | --- |
| SKILL-1 observation/knowledge | P1: walled ore/cow/apple hidden; emerald behind glass, pig and bread visible; ore and cow visible only from behind the wall. V1: gold behind a glass-enclosed lava box hidden; lapis behind water visible; the same gold visible from the side. K1: recipes answered with no inventory; stone is smelted; a pickaxe is needed and stone drops cobblestone; planks burn 300 ticks; an unknown item stays `unknown`; 20 capabilities. Client predictions unconfirmed in every observation path (unit and probe), proven live in M1. |
| SKILL-2 movement/resources | M1: three logs by hand (server block change, RCON air, predictions marked and resolved); pickup (collect packet; RCON 3 logs). M2: stone without a pickaxe refused (`harvest_tool_missing`). M3: same `mine_block` with the wooden pickaxe; RCON cobblestone 2, no stone. N1: approach; follow succeeded (moved 7.98 blocks, attributed distance 2.84); frontier explored and `visited_location` satisfied. FL1: owner occluded (precondition held); no hidden goal; `finalDistance` null; Chunkbot at z 209.5 < 212. N2: `no_safe_path`, no dig/place. B0–B5: travel radius 8 (below). |
| SKILL-3 inventory/crafting | CR1: 12 planks, table, table placed from a generated candidate (RCON), 4 sticks, wooden pickaxe at the table (RCON 1). C0: `missing_ingredients`, no hidden chain. Equip is server-confirmed. |
| SKILL-4 processing/interaction | F1: furnace crafted and placed; input plus valid fuel; cobblestone refused as fuel; wait (no inference); 2 stone taken; `smelting_result` satisfied; RCON stone=2. T1: deposit/inspect/withdraw and the freshness boundary. T2: owner gain 0 → 1, matching its collect packet. E1: milk; shears give wool drops plus metadata; chicken defeated by server death status; a teleported pig is `unknown`. PL1: staged 206.70,203.50 with the furnace at 203,-60,203; 2 named-furnace candidates; sneaked; wool placed (server block change). PL2: ordinary support (block change plus RCON); owner-occupied voxel refused before any packet (0 of 6 candidates into it); stop during an interactive-support placement. |
| SKILL-5 interruption | X1–X5, I1, PL2, X6, X7. Every stop reached the stop line in ≤ 4 ms, with lease clear ≤ 2 ms (target 250 ms). |

### Control-clear timings and old-lease separation (final run)

| Check | Stop → stop line | Lease clear | Effect evidence |
| --- | --- | --- | --- |
| X1 navigation | 2 ms | 1 ms | Server position 201.66 at stop, +0.1 s and +0.8 s (no movement after stop); the replacement move then succeeded (z=197.50): old cleanup did not clear the new lease |
| X2 mining (obsidian by hand) | 4 ms | 2 ms | `dig_stopped`; RCON: obsidian unchanged |
| X3 crafting | 2 ms | 1 ms | `localProgress.craftsCompleted=3`; RCON sticks 0→12, planks 40→34; `partialEffects {confirmed: none, additional: unknown}` |
| X4 chest transfer | 1 ms | 1 ms | Interface closed; the next inspection succeeded (1 stone, 10 cobblestone) |
| I1 stop after the open-interface use packet (6 delays, 0–50 ms) | 0–1 ms | 0–1 ms | 6/6 stops landed after `block_place`; late windows attributed and closed; the next interface action succeeded |
| PL2 interactive-support placement | 0 ms | 0 ms | Shift released by shared cleanup; furnace intact; next furnace action not refused for an open interface |
| X5 furnace wait | 2 ms | 1 ms | `partialEffects {confirmed: server_packet}`; the furnace kept cooking (1 stone after 12 s) |
| X6 goal replaces a diagnostic | — | 1 ms | `replaced_by_goal`; goal `planner_not_ready` |
| X7 death mid-action | — | 0 ms | `lifecycle_death`; respawn idle |

Unit coverage keeps old and new leases separate: `lease.test.ts` and `corrections-core.test.ts`.

## Travel bounds (second session, radius 8)

- **B1:** an outside destination is refused before moving; an inside move ends 5.00 from the anchor.
- **B2:** the wall's only gap lies outside the radius, giving `no_safe_path` with anchor and radius evidence. Max distance from the anchor during the attempt was 0.83. An inside gap then succeeds.
- **B3:** the moving owner left the radius, giving `target_outside_travel_bounds` (Chunkbot 3.42, owner 16.85 from the anchor).
- **B4:** after re-anchoring, the bot reached a point 11.00 from the old anchor.
- **B5:** admission anchor (above).

## Supported catalog and predicates

Catalog `skills-20-16f587b80d7a` (the same 20 capabilities) is generated from the registered definitions that resolve candidates and execute. Shown as id: supported predicates.

- Movement/observation: `move_near` (near_target, visited_location), `follow_entity` (near_target), `explore_frontier` (visited_location, near_target), `survey_surroundings` (entity_outcome, block_state)
- Resources: `mine_block` (block_state, inventory_delta, inventory_amount), `pickup_item` (inventory_delta, inventory_amount)
- Inventory/transfer: `inspect_inventory` (inventory_amount, inventory_delta, equipped), `equip_item` (equipped), `drop_item` (inventory_amount), `inspect_container` (container_state), `container_transfer` (container_state, inventory_amount)
- Crafting/placement/interaction: `craft_item` (crafting_result, inventory_amount, inventory_delta), `place_block` (block_state), `interact_block` (block_state, inventory_amount), `use_held_item` (inventory_amount)
- Processing: `furnace_insert` (container_state), `furnace_wait` (container_state, smelting_result), `furnace_take` (smelting_result, inventory_amount, inventory_delta)
- Entities: `interact_entity` (entity_outcome, inventory_amount), `attack_entity` (entity_outcome)

Predicate rules:

| Predicate | Rule |
| --- | --- |
| `inventory_amount`, `inventory_delta`, `equipped` | Fresh correlated server resync only; no cache fallback. Admission baselines become `unknown` after a lifecycle interruption. The milestone latch stays bound to the goal/task. |
| `block_state` | A server block update if the position is visible now (in `sessionWorld`) or was this goal's own confirmed change; otherwise visible chunk data with no pending prediction; otherwise `unknown`, without naming the block |
| `container_state` | The freshness boundary above |
| `crafting_result`, `smelting_result` | Skill-confirmed events since binding |
| `near_target`, `visited_location` | Entity positions only while visible; prior results only for this connection, lifecycle generation, and dimension |
| `entity_outcome` | Defeat only from a server death status; presence from current line of sight |
| `all` / `any` / `not` | — |

## Per-issue correction and evidence

| Issue | Correction (cumulative) | Maintained regression | Built evidence |
| --- | --- | --- | --- |
| MB-SKL-001 | Jar-extracted mechanics only for exactly 26.1.2; protocol compatibility reported separately | `corrections-core` 001 | doctor; K1 |
| MB-SKL-002 | Visual geometry for lava and powder snow; water see-through | `corrections-core` 002 | V1 |
| MB-SKL-003 | Shared `isOwnerPlayer` with the admitted policy | `corrections-core` 003 | P1/N1/FL1 |
| MB-SKL-004 | `InterfaceGate` with sequence acks and the out-of-range barrier; late replies closed, never adopted; lifecycle resets drop stale closes; correlated resyncs | `corrections-core` 004, `lease.test.ts` | I1, X4, PL2 |
| MB-SKL-005 | Named targets (including parameters) re-grounded per snapshot; stale targets admit nothing | `corrections-skills` 005 | PL1, T1, E1 |
| MB-SKL-006 | `VisibleTracker`: visibility before position; frozen labeled waypoint; no hidden `finalDistance` | `corrections-skills` 006/007 | N1, FL1 |
| MB-SKL-007 | Path exclusion plus live guards with structured reasons; admission-owned anchor | `corrections-skills`, `corrections-admission-freshness` | B0–B5 |
| MB-SKL-008 | Parameters validated per schema; conflicts dropped; exact counts | `corrections-skills` 008 | T1, PL1/PL2, F1 |
| MB-SKL-009 | Current state from correlated resyncs; lifecycle invalidation; provenance and `partialEffects`; container freshness; **client predictions unconfirmed in the single authoritative world view (`sessionWorld` plus `tapClientPredictions`)**; `liveBlock` `target_unconfirmed` | `corrections-skills` 009, `lease.test.ts`, `corrections-admission-freshness`, **`corrections-prediction-visibility`** | T1, X3/X5, M1 prediction evidence, P1/V1/FL1 |
| MB-SKL-010 | Occupied destinations refused; interactive supports skipped generically and sneaked when named; unexpected interface closed; per-face exclusion reasons | `corrections-placement` | PL1, PL2 |
| MB-FND-003 | The replacement regression uses controlled deferred resolution and a 150 ms window, with all assertions kept | `connection.test.ts` | 24/24 under parallel load; two clean full checks |

## Paths changed this turn

- `src/perception/visibility.ts`: `UNCONFIRMED_BLOCK`
- `src/perception/perception.ts`: `sessionWorld` (authoritative view; the raw view is now private); discovery excludes unconfirmed voxels; all internal reads use it
- `src/game/server-evidence.ts`: `tapClientPredictions`, `predictionsNoted`
- `src/game/connection.ts`: installs the tap
- `src/skills/common.ts`: `liveBlock` refuses unconfirmed targets
- `src/skills/placement.ts`, `src/skills/crafting.ts`, `src/skills/interfaces.ts`, `src/skills/mining.ts`: use `sessionWorld(session)`; mining reports `clientPredictionsMarked` and `predictionPendingAfter`
- `src/execution/actuator.ts`: removed the dig-start prediction mark
- `src/execution/executor.ts`: `commandsIssued` uses `act.issued`
- `tests/corrections-prediction-visibility.test.ts` (new), `tests/connection.test.ts` (MB-FND-003)
- `scripts/skills-live-check.ts`: M1 prediction assertion
- `README.md`, `AGENTS.md`, this file

Earlier turns' paths are listed in their own handoffs. Ownership is unchanged: `src/perception`, `src/knowledge`, `src/execution`, `src/skills`, the `src/game` additions, `src/goals` (admission hook), `src/app`, `src/cli.ts`, `src/contracts` (optional additions only), pins (mineflayer-pathfinder 2.4.5, prismarine-block 1.23.0, prismarine-item 1.18.0, vec3 0.1.10), tests, scripts, and docs.

## Remaining gaps and limitations

- There is no autonomous play: the planner (MB-V1-04) and Jev (MB-V1-03) are not installed. These are mechanic diagnostics through the real intake and executor, and normal goals report `planner_not_ready` (S0, X6, B5).
- Prediction marking covers Mineflayer's public `_updateBlockState` path, which in the installed 4.39.0 is used only by the dig finish. A future library change that predicts through another path would need the tap extended.
- An unconfirmed voxel is conservatively opaque and not walkable until the server answers, normally one tick after a dig.
- Mechanics exist only for exactly 26.1.2. Visibility is a geometric line-of-sight policy, with no render, lighting or fog accuracy.
- The barrier relies on vanilla 26.1.2's out-of-range ABORT_DESTROY_BLOCK handling. There is one interface request per connection, and an unanswered request >5 s leaves the executor not-ready until a late acknowledgement, respawn, dimension change, or reconnect.
- Container contents are never observed while closed. Current evidence needs a fresh in-goal read within 60 s.
- Navigation is conservative. Following re-goals every 250 ms. Crafting clicks are paced at 60 ms. `attack_entity` does not chase. `interact_entity` effect detection is heuristic.
- Online/Microsoft mode was not live-tested (bot-account details unconfirmed; no sign-in performed). UUID-mode owner matching is unit-tested.
