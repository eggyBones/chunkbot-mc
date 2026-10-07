# MB-LOC-001 — Locator-assisted following: worker handoff evidence

Worker: native Claude Opus 5.5 (local DSH), branch `chunkbot/mb-loc-001`, base `f05628f`. Status: **new modules, contracts, tests and gate harness implemented and verified offline. Shared-hook integration (designated writer) and all fixture gates are pending.** No fixture lease, RCON, join or provider call has been made. Not accepted.

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

- `npm run typecheck`: 0. `npm run build`: 0. `npm test`: 0, **557/557**. This includes 80 locator tests across 6 files:
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
| G1 | Controlled offline `FixtureOwner` and `FixtureGuest`. Owner moved by RCON `tp` to the vec3i, chunk and azimuth distances (view distance read from the fixture properties). Above-elevation case uses slow falling. Hiding cases: crouch, invisibility effect, carved pumpkin, logout/rejoin. Dimension case: `execute in minecraft:the_nether` for the owner and then the bot. |
| G2 | Needs `--approve-rules`. `gamerule locator_bar` false then the original value; `attribute FixtureOwner minecraft:waypoint_transmit_range base set 30` then `base reset` (receive range reset too). Restored in `finally`. |
| G3 | Owner 300 blocks east (+40 z) of base (1000.5, −60, 1000.5); `seek_owner` windows run through the real executor; reunion checked from RCON server positions. No block writes. |
| G5 | Needs `--approve-scene`. Lava, wall and >3 drop scenes, each restored. |

**Footprint:**
- Players are teleported within x 1000..1420, z 960..1060, y −60, plus the bot/owner nether `tp` at (0, 80, 0).
- G5 fills only x 1000..1040, z 1100..1140, y −64..−50, restored to air with a grass floor at −61.
- The skills scene (x 196..224, z 190..224) is never touched.

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
