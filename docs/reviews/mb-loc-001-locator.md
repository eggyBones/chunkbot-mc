# MB-LOC-001 — Locator-assisted following: worker handoff evidence

Worker: native Claude Opus 5.5 (local DSH), branch `chunkbot/mb-loc-001`, base `f05628f`. Status: **new modules, contracts, tests and gate harness implemented and verified offline. Pre-integration module gates G1/G2/G3/G5 passed 19/19 on 26.2 (`batch002-locator-262-gates-01`) and 26.1.2 (`batch002-locator-261-gates-01`); the C5 observed-geometry label fix (`2fb02f6`) awaits a focused G5 rerun.** Shared-hook integration (H1–H6), ordinary-follow regression, root gates and real Codex/Jev L7 are pending. No provider call has been made. Not accepted.

## Commits

| SHA | Content |
| --- | --- |
| `b894867` | Initial locator/route contract |
| `b323883` | C1 contract revision (integrated in root as a dependency milestone) |
| `9bd2b3c` | Codec gate, locator service, route controller, runner, skills, codec/service tests |
| `c99517b` | Route/runner/skill integration tests; destination dedupe |
| `5623f12` | C2/C3 contract additions (`RouteAdmissionProof`, `EffectiveTravel`, `FrozenOwnIncident`, `RoutePort.effectiveTravel`) |
| `05cf424` | C2/C3 fixes and reproductions |
| `c7c5c84` | Import-safe, lease-guarded gate harness + guard test |

Owned paths only: `src/contracts/locator.ts`, `src/locator/*`, `src/skills/locator.ts`, `tests/locator-*.test.ts`, `scripts/locator-live-check.ts`, this file. No shared file is edited.

## Official-source gate (static, read-only)

Codex granted read-only class parsing of the pinned official jars (`var/source-probes/server-26.1.2.jar`, `server-26.2.jar`). A throwaway disassembler outside the repository parsed the class files; nothing from the jars was executed. Findings (identical in both versions except where noted):

- **Codec.** `ClientboundTrackedWaypointPacket` uses operations track/untrack/update. Untrack is built as `TrackedWaypoint.empty(uuid)`. The pinned `packet_tracked_waypoint` definition (clientbound `0x8a`) is canonical-JSON identical in installed minecraft-data 26.1 and 26.2.
- **Variant selection** (`LivingEntity.makeWaypointConnectionWith`):
  - no connection on the source's first tick or for itself;
  - no connection when distance ≥ min(source `waypoint_transmit_range`, receiver `waypoint_receive_range`), when the source is a spectator, or when it has the receiver as an indirect passenger;
  - **azimuth** when distance > 332 (`REALLY_FAR_DISTANCE`);
  - otherwise **chunk** when the source chunk is outside the receiver's chunk-tracking view distance;
  - otherwise **vec3i** with the source's block position.
- **Azimuth convention.** The angle is `Mth.atan2(v.z, v.x)` where v = (receiver − source) rotated clockwise 90°, i.e. `atan2(dx, −dz)`. This is a Minecraft yaw of the direction from receiver to source, which is exactly `azimuthToVector` in `src/locator/geometry.ts`.
- **Updates.**
  - Block connection: update when the source block position changes; it breaks (reconnecting with a new track) when moved more than 1 Manhattan block between updates.
  - Azimuth: update when the angle changes by more than 0.5°.
  - Transmitter movement (`Entity.setPosRaw`) triggers `updateWaypoint`; receiver chunk moves trigger `updatePlayer`.
  - A stationary owner reached at block or chunk precision therefore gets no further packets. A tracked statement stays current by protocol semantics; the `hintMaxAgeMs` default (120 s) is only a safety bound.
- **Hiding.**
  - `isTransmittingWaypoint` is true only when `waypoint_transmit_range` > 0. Players default to transmit/receive range 6.0e7.
  - Crouching applies the `waypoint_transmit_range_crouch` modifier (−1 × total).
  - The invisibility effect applies `effect.waypoint_transmit_range_hide` (−1).
  - Head-slot items use `Waypoint.addHideAttribute` with modifier `waypoint_transmit_range_hide` (−1).
  - Any change to the attribute calls track/untrack.
- **Rule.** Gamerule id is `locator_bar` (default true). A change calls `MinecraftServer.onGameRuleChanged`, which runs `breakAllConnections` (untrack).
- **Lifecycle.** Entity removal or a dimension change calls `untrackWaypoint` (untrack sent to all receivers). Receiver tracking end calls `removePlayer`.
- **26.1.2 vs 26.2.** The transmitter, all connection classes and `ServerWaypointManager` are byte-identical. `LivingEntity` and `ServerPlayer` waypoint methods disassemble identically. `Waypoint.class` differs only by an extra `MAX_RANGE` field in 26.1.2.

Static evidence does not prove runtime broadcasts. Gates L-G1/L-G2 remain required.

## Design delivered

- **Codec gate and decoder** (`src/locator/codec.ts`):
  - Locator perception is admitted only when the installed protocol definition is canonical-equal to the verified one; otherwise it fails closed (`unsupported_codec`).
  - The pinned mapper passes unknown operation/variant ids through as raw numbers. The decoder rejects them, along with malformed identities and out-of-range payloads.
- **Locator service** (`src/locator/service.ts`):
  - **Owner-only.** The configured UUID requires a verified online-mode connection. The trusted offline fixture requires the exact name's derived UUID AND that exact name listed by the server. String ids, other UUIDs, icon colour and packet order never grant identity. Positions are retained only for the owner candidate; others are counts.
  - **Scoping.** Statements are scoped to the delivering client's connection epoch and to the login/respawn generation. Death, respawn, dimension change and ended lifecycle events void them; a late packet from an old client is ignored.
  - **Hint content.** The hint carries only sector, distance band (when the variant justifies it, including chunk uncertainty), elevation (block precision only), precision, age/expiry, epoch and dimension.
  - **Telemetry.** Records transitions and counts only.
- **Routes** (`src/locator/routes.ts`):
  - One frozen authorization per NEW goal epoch; repeated or older epochs are refused.
  - Ceilings are fixed at admission. The deadline is the earlier of admission + `maxRouteMs` and the goal deadline.
  - Cumulative own-movement distance (C1). Stall detection uses net progress.
  - Exact-match leg bounds, terminal revocation, and destination provenance (owner-typed coordinates recorded for the goal; own-incident provider with frozen identity).
- **Runner and skills** (`src/locator/route-runner.ts`, `terrain.ts`, `src/skills/locator.ts`):
  - `seek_owner` and `route_travel` are sustained windows.
  - A visible owner takes over from any cue: the position is read only while visible, and proximity is verified from the bot's own position.
  - Locator bearing and code-owned destinations only rank safe local frontiers. A new counted leg is used only when the bound, not the terrain, limits progress.
  - Specific blockers: `hazard_lava` (seen voxels only), `cliff_drop`, `wall`, `water_crossing`, `unloaded_terrain`, `vertical_separation`, `no_safe_frontier`.
  - A withdrawn or expired cue stops advancing. No digging, placing, towering or doors.

## Coordinator corrections

- **C1** (`b323883`): cumulative own movement with labelled sources; deadline fixed at admission; monotonic admission; exact-match legs carrying the admission anchor; `route_travel` provenance checked in both resolver and executor.
- **C2** (`05cf424`):
  - `legBounds` and the new canonical `effectiveTravel(admissionProof)` return a leg only while the route is `leg_active`, before its deadline, under the distance ceiling and with an exact proof match. Otherwise the original admission bound applies.
  - Reproduced finding: the 0→16→0→16→0 loop with max 64 leaves the route exhausted, and `legBounds` is now undefined.
  - `attachMovement` no longer reads raw journal x/z. It samples the resolved own position on Mineflayer `move`, and relabels the move that `forcedMove` synchronously follows as a server correction. The pinned physics handler applies per-axis relative flags, then emits `move` (in `sendPacketPositionAndLook`), then `forcedMove`; a test checks this order against the installed source.
  - Proven: zero-relative correction counts 0; mixed-axis correction counts its resolved delta once; a true correction counts once; detours count; runner re-sampling adds nothing; a stray `forcedMove` relabels nothing.
- **C3** (`05cf424`):
  - The whole own-incident identity (id, dimension, position, recorded time) is frozen at first use. Reproduced finding: the same `mf-0001` moved from x20 to x40 is now `destination_changed`.
  - `route_travel` fixed targets carry a `recheck` that runs before every runner step and on every movement poll. A changed or missing incident stops movement at the next poll; this is tested.
  - The runner takes a goal-owned admission proof, never `perception.travelBounds` after H2. `admissionProof()` uses the requested `perception.admissionBounds()` when installed. Before that, it accepts `travelBounds()` only when the anchor is goal-owned and equals the frozen authorization anchor/radius. There is no relaxed fallback.

## Shared hooks requested (designated writer; via Codex)

| Hook | Request |
| --- | --- |
| H1 | `MineflayerConnection.onClientCreated(listener({client, connectionEpoch, version}))`, called synchronously after `createBot`, before login. Composition then calls `locator.attach(client, epoch)`. |
| H2 | `PerceptionOptions.routeTravel?: (proof: RouteAdmissionProof) => EffectiveTravel`, plus a new `PerceptionService.admissionBounds(): RouteAdmissionProof \| undefined` that returns the goal-owned admission anchor/radius/epochs and never a leg. `travelBounds()`/`withinTravel()` return `routeTravel(admissionProof)` for goal-owned anchors on every call, so all skills' navigation polls honour withdrawal on exhaustion, expiry or blocking. `locatorHint?: () => LocatorHint` fills `snapshot.locator`. `perception.travel.{admissionAnchor, route}` in observation; planner `renderObservation`; Jev `snapshotSummary`. |
| H3 | Compose `LocatorService` and `RouteController` (`ownDeath` = survival provider when present). Register `locatorSkills({locator, routes})`. On admission, call `routes.admit({... source, goalDeadlineMs, ownerCoordinates})`; on clarification answers, `routes.noteOwnerCoordinates`; on goal terminal, `routes.revoke`. Lifecycle goes to `locator.onLifecycle` + `routes.revoke`. On ready, call `routes.attachMovement(session, goalEpoch)`. Status lines in `statusExtras`. |
| H4 | `export * from './locator.ts'`; `locator: LocatorConfigSchema.optional()`; existing harnesses set `locator.routes.enabled: false`. |
| H5 | `PlannerRequest.route` / `ProposalContext.route = routes.proposalContext(ctx)`. `checkProposal` rejects `route_travel` without authorization and `destination:"own_death"` unless authorized and `ownDeathAvailable`. One planner paragraph. |
| H6 | Later: whitelisted dashboard projection of `RouteStatus`/`LocatorHint`. |

## Checks (direct exits, worktree `mb-loc-001`, Node 24.21.0)

- `npm run typecheck`: 0. `npm run build`: 0. `npm test`: 0, **562/562**. This includes 79 locator tests across 6 files:
  - `locator-codec`: pinned serializer/deserializer round trips for 26.1.2/26.2 and the fail-closed gate;
  - `locator-service`: attribution, variants, hiding, expiry, lifecycle, connection scoping, no-coordinate telemetry;
  - `locator-routes`: C1/C2/C3 ceilings, sampling, freezing, scope;
  - `locator-runner`: scripted official-variant server, reunion beyond 128 through legs, withdrawal, blockers, ceilings, revocation, provenance stops, proof mismatch;
  - `locator-skills`: real catalog/wire/proposal check/perception/candidate generator, executor provenance, admission proof;
  - `locator-harness-guard`: import safety and lease refusal.
- No doctor, live-check or fixture harness was run (no lease).

## Fixture gate request (not run)

Command, from a frozen build of this branch with an independent data directory (reports go to `var/live-check/<stamp>[-26.2]-locator/`):

- 26.2: `node scripts/locator-live-check.ts --fixture-lease <id> --fixture 26.2 --gates g1,g2,g3,g5 --approve-rules <id> --approve-scene <id>`
- 26.1.2 broadcast sanity: `node scripts/locator-live-check.ts --fixture-lease <id> --gates g1`
- Ordinary-follow regression: existing `npm run skills-live-check` (the code path is unchanged; seek defers to follow when the owner is visible).

What each gate does:

| Gate | Behaviour |
| --- | --- |
| G1 | Controlled offline `FixtureOwner` and `FixtureGuest`. Owner moved by RCON `tp` to the vec3i, chunk and azimuth distances (view distance read from the fixture properties). Above-elevation case uses slow falling. Hiding cases: crouch, invisibility effect, carved pumpkin, logout/rejoin. Dimension case: owner, then bot, to the nether bedrock roof (0.5, 128, 0.5) and back. |
| G2 | Needs `--approve-rules`. `gamerule locator_bar` false then the original value; `attribute FixtureOwner minecraft:waypoint_transmit_range base set 30` then `base reset` (receive range reset too). Restored in `finally`. |
| G3 | Owner 300 blocks east (+40 z) of base (1000.5, −60, 1000.5); `seek_owner` windows run through the real executor; reunion checked from RCON server positions. No block writes. |
| G5 | Needs `--approve-scene`. Lava, wall and >3 drop scenes, each restored. |

**Footprint (MB-LOC-001-C4; declared in `LOCATOR_FOOTPRINT`/`TELEPORTS`, enforced before every RCON teleport):**
- Overworld teleport destinations: x 600..1301, y −60..−46, z 958..1201. The named destinations are base (1000.5, −60, 1000.5); owner at east 40, south 200 (z 1200.5), west 400 (x 600.5), north-east 60 (z 958.5), elevated +14 (y −46), 24/26/28/30/60/61/62 east, G3 (+300, +40); guest west 30; scene bot/owner (1004.5 / 1038.5, −60, 1120.5).
- Nether: (0.5, 128, 0.5), standing on the bedrock roof, for the owner and then the bot.
- G3 bot envelope: seeking is aborted if the bot leaves x 900..1400, z 900..1140.
- G5 writes only x 1000..1040, y −64..−50, z 1100..1140. The read-only reference region is x 1060..1100 (same y/z). The skills scene is never touched.

**G5 baseline and restoration:**
- **Expected baseline.** `scripts/fixture.ts` sets `level-type=minecraft:flat` with no generator settings. The official 26.2 `FlatLevelGeneratorSettings.getDefault` gives 1 bedrock, 2 dirt and 1 grass_block, so bedrock −64, dirt −63..−62, grass −61, air above.
- **Check before any write.** The scene and the reference region are probed per layer at three columns, then compared with one `execute if blocks … all`. If either check fails, G5 fails without writing anything.
- **Restoration.** Every scene layer is rewritten (bedrock, dirt, grass, then air from −60 to −50) and re-verified with the same probes and comparison.
- **Failure handling.** Any restoration or verification failure fails the whole report (`restoreFailures` plus a `RESTORE` result), not just a warning.

**Pre-integration label:**
- The harness's route runner uses explicit admission-proof/leg bounds, so it can prove only its own movement.
- The production all-skill travel guard requires progression's H2 `effectiveTravel` wiring.

**Setting changes and logging:**
- Changes are limited to owner/bot effects, the owner's head item, gamerule `locator_bar`, and the waypoint range attributes, all restored in `finally`.
- Every RCON command is recorded in the report.
- Packet evidence records operation, variant and attribution class only. Setup `tp` commands for the harness-controlled fixture players necessarily carry their positions; no waypoint coordinates are logged.

## Known gaps

- **Fixture gates.** L-G1/L-G2/L-G3, negative routes, 26.1.2 sanity and real Codex/Jev L7 have not run.
- **Late attach.** Pre-H1, the harness attaches the locator after `ready`, so join-time tracks can be missed (reported as `late`). Each scenario moves the owner to produce fresh statements.
- **Elevation.** Only above/level are exercised live (below needs a block-changing scene).
- **Ordinary skills.** They honour route ceilings only once H2 makes perception travel bounds consult `effectiveTravel` on every call; this module cannot change their code.
- **Distance overshoot.** After distance exhaustion, a bot outside the admission radius is honestly out of bounds for ordinary skills. Cumulative distance can exceed the ceiling by at most the movement between two samples (one physics tick, or one runner poll).

## 26.2 module gate runs (lease `batch002-locator-262-gates-01`; rules `batch002-locator-262-rules-01`; scene `batch002-locator-262-scene-01`)

Run as the same driver with Node 24.21.0:

```
node scripts/locator-live-check.ts --fixture-lease batch002-locator-262-gates-01 --fixture 26.2 --gates g1,g2,g3,g5 --approve-rules batch002-locator-262-rules-01 --approve-scene batch002-locator-262-scene-01
```

Run conditions:
- Each run used a source freeze with clean HEAD, and `npm run typecheck`/`build`/`test` exited 0 at that HEAD before running.
- The harness runs from `src` (TS); the build matched the same HEAD.
- Fixture: 26.2 at 127.0.0.1:25567, view-distance 6. Fake players only (Chunkbot, FixtureOwner, FixtureGuest), all disconnected in `finally`.

| Run (report under `var/live-check/`) | Source | Exit | Result |
| --- | --- | --- | --- |
| `2026-10-07T02-11-21-880Z-26.2-locator` | `fef8ed3` | 1 | 18/19. G1, G2 and G3 passed. **G5 invalid: MB-LOC-001-C5.** Restorations verified. |
| `2026-10-07T02-15-17-487Z-26.2-locator` | `bce707f` | 1 | 13/19. G5 valid and passed (contact/damage/death monitored). **G1 oracle unproven: MB-LOC-001-C6.** Restorations verified. |
| `2026-10-07T02-19-17-753Z-26.2-locator` | `7b28c90` | **0** | **19/19.** `restoreFailures` empty. Bot placement verified on the first attempt. |

**MB-LOC-001-C5** (harness scene geometry):
- **Cause.** `SCENE_BASE` x 1004.5 put the bot inside the obstacle columns, which start at x 1003. The drop scene also removed bedrock, leaving a void hole.
- **Consequence.** Run 1's G5-lava and G5-drop passes are invalid evidence, and its G5-wall failure (`no_safe_frontier`) is not a code finding.
- **Possible death.** The bot may have died in the void. That run did not record lifecycle events, so this is unknown.
- **Fix (`bce707f`).**
  - The bot starts at x 1000.5 and the owner at x 1034.5 on intact ground.
  - The drop is a 5-high stone platform inside the scene box; bedrock is never removed.
  - Each scene monitors obstacle contact, health and death.
  - Accepted outcomes: the specific blocker or a safe detour.

**MB-LOC-001-C6** (harness oracle assumption):
- **Symptom.** Run 2 received azimuth for a 40-block owner offset, and the cue disagreed with the assumed base position. The bot's server position was therefore not at base when the oracle assumed it was. Probable cause: the run-1 void death respawned the bot after its teleport.
- **Guest attribution.** The guest UUID was registered after the guest's join, so its join-time track packet was misattributed.
- **Fix (`7b28c90`).**
  - Wait until the bot is alive.
  - Verify the bot's server AND client position at base (bounded retries).
  - Record a lifecycle log.
  - Compute expected variants and sectors from SERVER positions of both players using the official rule (border cases accept either variant).
  - Register the guest UUID before its join.

**Final run 19/19 evidence** (from the report: counts, classes and relative offsets only):

- **Variant and cue checks:**

  | Owner position relative to bot | Server statement | Cue |
  | --- | --- | --- |
  | 40 east (3 chunks) | `track:vec3i` | east, near, level, block precision |
  | 200 south (13 chunks > view distance 6) | `track:chunk` | south, far, height unknown, chunk precision |
  | 400 west (> 332) | `track:azimuth` | west, distance/height unknown, direction only |
  | north-east 59.4 | `vec3i` | north_east |
  | 13.8 above | `vec3i` | elevation above |

- **Other G1 checks:**
  - The guest's waypoint was received and counted as other. The owner cue was unaffected.
  - Crouch, invisibility and carved pumpkin each produced `untrack` (no direction), and restoring produced `track`.
  - Logout gave `untrack` (identity no longer listed); rejoin needed a fresh `track`.
  - Owner moving to the nether roof gave `untrack`. The bot moving to the nether recorded `dimension_change` and voided statements. Returning restored tracking.
- **Packets:** 43 recorded:

  | Class | Count |
  | --- | --- |
  | owner `track` vec3i / chunk / azimuth | 21 / 6 / 1 |
  | owner `update` vec3i | 1 |
  | owner `untrack` | 8 |
  | guest `track` vec3i / chunk | 3 / 1 |
  | guest `untrack` | 2 |

- **G2:**
  - `locator_bar` false gave `untrack` (no direction); the original value (`true`) was restored and gave `track`.
  - Owner `waypoint_transmit_range` 30 at 60 blocks gave `untrack` (range-limited); after reset it gave `track`.
  - The attribute was reset to its default 6.0E7 in `finally`.
- **G3:**
  - The owner was 300 blocks east and 40 south, beyond the 128 admission radius. Run through the real executor, `seek_owner` took window 0 as `route_window_elapsed` (leg 1, 110.9 route blocks), then window 1 `owner_reached` (leg 2/12, 206 of 1024 blocks, 0 corrections).
  - The server-measured bot–owner distance was 2.2. The admission anchor was unchanged. No in-trial assistance.
- **G5:**
  - **Baseline:** the scene equalled the flat baseline and the reference region before any write (probes plus `execute if blocks`).
  - **Lava:** a safe detour around the band to the owner (`owner_reached`), with no contact, no damage and no death.
  - **Wall:** the specific `wall` blocker, with the bot not moved.
  - **Drop (platform):** the specific `cliff_drop` blocker, with the bot not moved.
  - **Restoration:** after every scene, all layers were rewritten and verified. During the wall scene, 3 grass blocks under the stone turned to dirt; this is vanilla behaviour, and they were restored and verified.
- **Footprint:** all teleports went through the checked helper inside the declared footprint. Final cleanup restored the scene, the attribute, the gamerule and the owner's effects/head, and disconnected all fake players. No harness process remains.

**Scope of this evidence:**
- This is pre-integration module evidence. The harness composes the real connection, perception, executor and lease, with the locator attached late (pre-H1).
- The route runner's explicit bounds prove only its own movement. The production all-skill guard needs H2 `effectiveTravel`.
- Still open: 26.1.2 broadcast sanity plus an ordinary-follow regression, root gates after H1–H6, and real Codex/Jev L7.

## 26.1.2 broadcast sanity and module gates (lease `batch002-locator-261-gates-01`)

Run from frozen `7b28c90` (HEAD `57ac58d` differs only in this document); default 26.1.2 fixture (127.0.0.1:25566, view-distance 6). Rules approval `batch002-locator-261-rules-01`, scene approval `batch002-locator-261-scene-01`.

```
node scripts/locator-live-check.ts --fixture-lease batch002-locator-261-gates-01 --gates g1,g2,g3,g5 --approve-rules batch002-locator-261-rules-01 --approve-scene batch002-locator-261-scene-01
```

**Result:** exit **0**, **19/19**. Report: `var/live-check/2026-10-07T02-22-35-525Z-locator/report.json`.

- **Codec:** 26.1.2 codec verified.
- **Variants:** the same official-rule variants were observed from server positions — 40 east block position, 200 south chunk, 400 west azimuth, north-east block position, above block position.
- **Withdrawals:** guest attributed as another player; crouch, invisibility, pumpkin and logout withdrawn and restored; dimension changes voided statements.
- **G2:** `locator_bar` and range behaviour matched 26.2.
- **G3:** two legs, 206.2 of 1024 route blocks, server distance 2.2.
- **G5:** lava detour, `wall`, `cliff_drop`; no contact, damage or death.
- **Packets:** 44.
- **Cleanup:** `restoreFailures` empty, every restore verified, all fake players disconnected, no harness process remaining.

This is broadcast and module evidence only. The **ordinary-follow regression** (`npm run skills-live-check`, unchanged `follow_entity`/`move_near` code) was NOT run by this worker; it needs its own lease.

## Report index

| Report | Fixture | Source | Exit | Status |
| --- | --- | --- | --- | --- |
| `var/live-check/2026-10-07T02-11-21-880Z-26.2-locator` | 26.2 | `fef8ed3` | 1 (18/19) | **Original, retained.** G5 invalid (C5 geometry); the wall label there was `no_safe_frontier`. |
| `var/live-check/2026-10-07T02-15-17-487Z-26.2-locator` | 26.2 | `bce707f` | 1 (13/19) | G5 valid; G1 oracle unproven (C6). |
| `var/live-check/2026-10-07T02-19-17-753Z-26.2-locator` | 26.2 | `7b28c90` | 0 (19/19) | Module gates passed. |
| `var/live-check/2026-10-07T02-22-35-525Z-locator` | 26.1.2 | `7b28c90` | 0 (19/19) | Module gates passed. |

## MB-LOC-001-C5: observed-geometry blocker labels (`2fb02f6`, offline only)

**Problem.**
- Before this fix, `classifyBlocker` named walls and drops from loaded collision geometry along the bearing, which may include terrain the bot never saw.
- Run 1's wall case was mislabelled `no_safe_frontier`. That run is invalid because the bot was inside the wall.

**Fix.**
- Every label is derived from voxels in the current line-of-sight observation only:
  - **wall:** an observed solid voxel at feet and head height;
  - **cliff_drop:** past the last observed walkable floor, the next observed floor is more than 3 below walk level;
  - **hazard / water:** observed voxels.
- The world view is read only for chunk loadedness. A content-read spy test proves no block name or shape is read from it.
- Columns with nothing observed are labelled `unobserved_terrain`; nothing is invented.
- The scripted runner sim now records visible faces.

**Checks:** typecheck, build and test all exit 0 (569/569, including 6 new `locator-terrain` tests).

**Not yet live-gated.** The 26.2 lease is released, and the 26.1.2 run above used the earlier classifier (`7b28c90`), which already labelled the fixture wall `wall`. A focused G5 rerun of `2fb02f6`, with the same declared footprint and restoration, needs a new lease.

## Ordinary-follow seam recommendations (for the progression writer; no shared file edited)

1. **Planner guidance (H5).** For owner-following and "come to me" instructions, the maintain/complete task should allow `seek_owner` alongside `follow_entity`/`move_near`. Jev can then switch to locator seeking when the owner leaves sight (`follow_entity` ends `target_lost`), with no planner turn. `seek_owner`'s resolver already declines (`owner_visible`) whenever the owner is visible inside the bound, so ordinary visible following is unchanged.
2. **Travel guard (H2).** `follow_entity` and `move_near` check `perception.withinTravel` on every poll. Once `travelBounds()` returns `routes.effectiveTravel(admissionBounds())`, they operate inside a live leg after `seek_owner` begins one. They fall back to the unchanged admission bound as soon as the route is exhausted, expired, blocked or revoked (C2).
3. **Persistent follow.** Keep `near_target owner` (visible-now) as the maintained predicate. A locator cue never satisfies it. A route leg does not end the persistent task, and route ceilings bound the seeking.
4. **Loss reporting.** When `seek_owner` reports `no_actionable_hint` or `hint_withdrawn`, surface the hint reason in status/feedback (untracked, expired, disabled, dimension). Do not replay old cues.
5. **26.1.2 regression.** Run the root `skills-live-check` and ordinary-follow scenarios after integrating H1–H6, so the shared wiring is proven not to alter visible following.

L7 (real Codex/Jev choosing these tasks from the shared catalog) and the production all-skill guard remain undelivered. The module harness's executor runs are not L7 evidence.
