# MB-LOC-002 — Reliable locator following: worker handoff evidence

Worker L: native Claude Opus 5.5 (local DSH), worktree `gameplay-follow`, branch `chunkbot/gameplay-follow`. Base `37c4c170199b4c9d867f720e64561a63a816d14c`.

**Status: module direction/detour fixes, composition tests and two lease-guarded fixture harnesses are implemented and verified offline. No fixture, RCON, provider or live operation has run (no lease granted).** F1–F5 and parent L7 are not accepted. Module and harness-plumbing evidence below is labelled as such; it is not ordinary real-pipeline acceptance.

## Commits (all on `chunkbot/gameplay-follow`, none pushed)

| SHA | Content |
| --- | --- |
| `394bec4` | Bounded observed-geometry detours, net-progress windows, reachable-cell detour search, `seek_owner` descriptor; F1 direction matrix, invalid-hint and detour tests; shared locator simulator |
| `566ada3` | G6 F1 live direction gate in `scripts/locator-live-check.ts`; new `scripts/locator-ordinary-live-check.ts` (actual CLI, scenarios O0–O9); harness guard tests |
| `0875031` | Ordinary-composition tests against the real `SkillRuntime` locator wiring |
| `1f27dc9` | This review/handoff |
| `a9f3e00` | Coordinator corrections: conservative visible-owner progress (no ownerSeen latch); detour path allowance enforced during dispatch |
| `8b24f28` | MB-FLOW-003-C12 route lineage: `RouteCarry`, `exportCarry`/`revokeWithCarry`/`admitContinuation` (focused commit for P) |
| `a3d80e2` | D1: default owner-statement age limit 600 s; freshness regressions |
| `9a55e49` (branch `chunkbot/gameplay-follow-module`) | Module/harness milestone = `a9f3e00` + D1, without C12 |
| `7a77aeb` | C12: `RouteLineage` (superset of P's approved `RouteCarry`), `nextLegIndex`, malformed-lineage guard |
| `283179a` | Two-sided bounded detour (switch once with a return-plus-search budget, ≤ 3 × 96 per episode), the observed obstacle reported when a window ends mid-detour, river/bridge dry-route tests, dynamic catalog verification in O0, model-visible catalog check in O1, P-L8 |

Changed paths (ownership only): `src/locator/route-runner.ts`, `src/locator/terrain.ts`, `src/skills/locator.ts`, `scripts/locator-live-check.ts`, `scripts/locator-ordinary-live-check.ts` (new), `tests/locator-sim.ts` (new helper), `tests/locator-runner.test.ts`, `tests/locator-direction.test.ts` (new), `tests/locator-detour.test.ts` (new), `tests/locator-harness-guard.test.ts`, `tests/locator-ordinary-harness-guard.test.ts` (new), `tests/locator-composition.test.ts` (new), this file. No shared file, contract, config, vendor or `node_modules` edit.

## F-G1 — which layer chose the wrong direction (retained historical trace)

Read-only inspection of the retained events of the last live run, `var/runs/run-9d8d6a18e52b` in the root checkout (accepted batch001 `d348d58`, no locator installed). Only relative offsets from each goal's admission anchor are reported here; no world coordinates.

- Four "follow me" goals. For `goal-e1b85f89a062`, the owner was not visible at admission. The planner first chose `survey_surroundings` (26 actions in 30 s, then `no_progress`). It then chose `explore_frontier`, and Jev walked east, south, east, north-east, north, north, north, west (8 frontier steps). **No component had any owner direction; the search was undirected.** The owner was found at about (+40, −53), then followed with `move_near` for about 4 minutes.
- In the same goal, the owner walked south-west to (−91, +90), which is exactly 128.0 blocks from the anchor. `move_near` failed with `target_outside_travel_bounds`, then `follow_entity` failed three times with the same precondition, then `per_target_retries_exhausted`. The task was blocked; the bot later died.
- `goal-205335fd4c53` hit the same limit: `follow_entity` failed with `target_outside_travel_bounds`, the retries were exhausted, and the planner answered `cannot_execute` ("owner is outside this goal's 128-block travel radius").
- `goal-dd7a6ec1b07b` ended in a follow-up question ("I can't see you. Could you come into view…"). That is MB-PLAN-006, P-owned.

**Conclusions from this evidence:**
- The "wrong direction" in that build is best explained by undirected frontier exploration while the owner was unseen.
- The "loss around 128" is the admitted travel radius, reached while following a visible owner.
- Nothing in this trace shows a reversed axis. The locator was not loaded, so the trace cannot test its sign conventions.
- The earlier live azimuth evidence covered only "400 west". Because west is the same under a z-sign flip, that evidence could not detect a z-axis error. The new G6 gate covers all eight directions and wraparound for every variant (see below).

## Base composition review (`37c4c17`) and the retained failed combined trial

- **Composition.** The ordinary CLI already composes the locator: `cli.ts` sets `features.locator` unless it is disabled, and `SkillRuntime` builds:
  - `RouteController`, with the survival own-death provider;
  - `LocatorService`;
  - perception `effectiveTravel`;
  - `onBotCreated` attachment before login;
  - route admission in `onGoalAdmitted`;
  - revocation in `onGoalTerminal` and lifecycle;
  - `attachMovement` on ready;
  - planner `route`/`locator` request fields;
  - status lines in autonomy status.

  `tests/locator-composition.test.ts` now proves this wiring with the real `SkillRuntime`.
- **Retained failed trial.** The combined skills trial at `674dab6c` (`batch002-674dab6c/var/live-check/2026-10-07T02-57-33-606Z-26.2-skills`) exited 1 with 13/33:
  - S0 expected 20 capabilities, but the runtime registered 22 (locator `seek_owner`/`route_travel`). The initial scene/anchor setup therefore never ran, and P1–X6 cascaded.
  - Its S0 line also shows the bot starting at the locator G5 scene position (about 1001.5, −55.1, 1120.5). The earlier locator gate had left the player there.
  - The capability-count correction is P-owned (`scripts/lib/profile-catalog.ts` exists at base); the report stays retained.
  - My new ordinary harness records Chunkbot's starting position and restores it in `finally`, so it does not leave the player elsewhere for the next harness.

## What changed in the locator module (`394bec4`)

1. **Bounded detour around OBSERVED obstacles.** Before this change, every route step had to advance at least 3 blocks within 67.5° of the cue. That rule rejected legitimate detours around obstacles wider than the sight radius and reported `wall` instead.

   When no forward frontier exists, a detour episode starts only if the observed-geometry classifier names a wall, drop, lava or water. A `vertical_separation` label counts only when its wall rays are observed. Each episode:
   - keeps the cue bearing at its start as a **fixed frame**, so a cue that rotates while the bot walks sideways cannot pull it back into the obstacle;
   - commits to one side, never retreats sideways toward its origin line by more than 8 blocks, and spends at most 8 steps / 96 blocks there;
   - if that side is closed or its budget is spent, switches ONCE to the other side with twice the budget (the walk back past the origin plus the same search), so one episode never exceeds 3 × 96 blocks (an opening out of sight may be on either side);
   - is limited to 3 episodes per window;
   - clears only when the bot is 8 blocks past the episode origin in its own frame **and** the current cue has a forward frontier;
   - is abandoned as `cue_changed` if the cue turns more than 90° away from the frame, and as `owner_visible` when the owner comes into sight.

   Otherwise the runner reports the specific observed blocker, with detour evidence (`detour_budget_spent`, `both_sides_closed`, `episode_limit`, `no_sideways_frontier`). Without observed geometry (unobserved or unloaded terrain, or a plain no-frontier case) there is no detour and no wandering. Detours may briefly increase the distance to the owner. There is no always-decreasing-distance rule.
2. **Detour candidates come from a locator-owned reachable-cell search** (`reachableCells`). It uses the same conservative moves and seen-floor and bound rules as the frontier search. The shared `findFrontiers` keeps only the farthest cell per compass sector, which hid good cells along an obstacle and caused side ping-pong in tests. `perception/frontiers.ts` was not edited.
3. **Window continuation needs NET progress along the cue.** Each step's progress is the smaller of the displacement's projections on the bearing at the step's start and at its end. Sideways or back-and-forth walking therefore cannot keep a window "partial" forever. A window that approached the visible owner still counts its own movement.
4. **The visited-spot penalty is now a tie-breaker** (6, was 12), so a spot straight along the cue that has been visited before does not lose to an unvisited one about 45° off.
5. **`seek_owner` descriptor** (model-visible). It now says when to use the skill (owner out of sight or beyond the travel radius, together with the follow/approach capabilities, instead of undirected exploration). Its limitations are truthful: it picks only dry-land waypoints, and swimming is not a supported route. The shared pathfinder's water policy remains W/P's.

## Coordinator corrections to `394bec4` (third round)

**LOC2-C1 — no raw-movement credit after seeing the owner.** The window-end rule `ownerSeen && moved >= 4` latched after ANY visible-owner moment and then credited arbitrary sideways or backward movement, including movement after the owner was lost.
- Removed. A window now continues locally only when its conservative NET progress is at least 4 blocks.
- While approaching a visible owner, progress is credited at every movement poll. Each displacement between two polls counts by the smaller of its projections on the bearings to the owner's FRESH visible position at both ends.
- While the owner is not visible, nothing can be credited: only `min(0, projection on the last visible bearing)` is added, so movement can be debited but never credited.
- The owner position comes only from `ownerVisible()`, which is visibility-first. A source check in the test proves no other position source.

`tests/locator-progress.test.ts` covers:
- visible → lost → 25 blocks sideways: not continued;
- visible → lost → wrong way: debited;
- a visible owner walking away north while the bot walks south: negative;
- a positive control: following an owner who keeps walking ahead is credited and the window continues.

Mutation check: restoring the old fallback makes the three negative tests fail (exit 1); the source was restored byte-identical (`cmp` 0).

**LOC2-C2 — honest detour bound.** The budget used to be checked only before a step, and each step could then walk a full extra frontier move; tests allowed +32.
- The episode's remaining PATH allowance is now enforced during dispatch: the move is aborted (`detour_allowance`) when the polled path reaches it. The episode records polled path length, not straight displacement.
- Honest finite bound per episode: 96 path blocks on the first side, plus 192 after the single side switch, plus `DETOUR_POLL_SLACK` (2 blocks) per side. That is at most 3 × 96 + 4 = 292.
- Where the slack comes from: the shared `navigate()` polls `abortIf` every 100 ms (300 ms around its arrival settle), which is under 2 blocks at walking speed; the simulator moves at most √2 per poll.
- Tests assert exactly this bound. In the no-way-around scene, an EXTERNAL per-step path oracle (independent of the runner's accounting) shows the whole attempt within 24 + 292 blocks.
- Mutation check: removing the in-dispatch abort makes it fail (walked 338.1 > 316, exit 1); the source was restored (`cmp` 0).
- The whole-route ceilings (cumulative movement, legs, fixed deadline) remain the outer bound. They are never reset across windows, legs or replans (C1/C2, unchanged; composition test).

**Requirement for P's integration of W:** safety must protect route legs and sustained follow windows. A safety grant may suspend a `seek_owner`/`follow_entity` window but must not depend on, refund, reset or re-anchor route authority. After safety, the remaining route budget and admission anchor apply unchanged. An exhausted route must not disable the safety reflex (P-L5).

**Third-round checks** (direct exits, each output redirected to a log and `$?` captured immediately):

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npm run build` | 0 | |
| `npm test` | 0 | 827/827 |
| locator suites (12 files) | 0 | 142/142 |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | |

`dist/cli.js` sha256 `de9409f3ddb24e918274db15435ad1a15d1c5a2896f93149e7799b58e0fa7553`. Nothing is running.

## MB-FLOW-003-C12 route lineage (continuation of the same logical goal)

Owned by L: `src/contracts/locator.ts` and `src/locator/routes.ts`. Tests: `tests/locator-continuation.test.ts` (11).

**The shared type.** P's proposal `56cb906` sketches `RouteCarry` inside `src/contracts/continuation.ts`. That sketch is insufficient for the required lineage semantics. The canonical route-owned shape is now `RouteCarry` in `src/contracts/locator.ts`, next to `RouteCeilings`, which P's sketch already imports from there.

Minimal required shape (exact field list):
`version, routeId, goalId, originalGoalEpoch, fromGoalEpoch, connectionEpoch, dimension, source, grantedAtMs, exportedAtMs, destinations, admissionAnchor, admissionRadius, ceilings (original, absolute routeDeadlineMs), legsUsed, lastLeg, stalledLegs, distance {total, clientPhysics, serverCorrections, correctionCount}, state ('authorized'|'exhausted'|'blocked'), blocker {reason, detail}|null, ownerCoordinates, boundOwnDeath, continuations`.

Fields the sketch lacked:
- logical `goalId`, `fromGoalEpoch`, connection, dimension and source;
- the exact admission anchor and radius;
- the distance SOURCES;
- route state and blocker detail;
- the last-leg summary;
- owner-typed coordinates and the frozen own incident;
- the continuation count.

**What P should do in `continuation.ts`:** delete its local `RouteCarry` and use `import type { RouteCarry } from './locator.ts'` for `ContinuationCheckpoint.route`. Nothing is duplicated.

**API (on `RoutePort` / `RouteController`):**
- `exportCarry(goalEpoch)`: captures the CURRENT, not-yet-revoked route of that epoch. An active leg is finalized as `interrupted_progressed` / `interrupted_stalled` from its last own sample; it stays counted, extends the stall run when stalled, and is never executable again. The export changes no route state; it records itself as the route's latest admissible export. It returns `undefined` after revocation or for another epoch.
- `revokeWithCarry(reason, goalEpoch)`: export, then revoke, atomically.
- `admitContinuation(carry, admission)`: replaces `admit` for a continuation and is synchronous. It accepts only the controller's LATEST unadmitted export of that route, byte-identical (canonical JSON), once. It requires:
  - the same logical `goalId`;
  - a FRESH epoch, greater than every admitted epoch and than `fromGoalEpoch`;
  - the same connection epoch and dimension;
  - EXACTLY the original admission anchor and radius (never the respawn position);
  - the same source.

  **Accepted:** the original routeId, `grantedAtMs` and frozen ceilings, including the absolute deadline. Consumed legs, distance with its sources, stalled run, last leg, owner coordinates and the frozen incident are all kept. `continuation {originalGoalEpoch, fromGoalEpoch, count}` is set, and there is no leg authority until a new counted leg begins. New legs are numbered after `legsUsed`. Own-movement counting restarts its chain at the first post-admission sample, so the respawn displacement is not counted and nothing carried is reduced.

  **Terminal lineage** (exhausted or blocked before the interruption, original deadline passed, distance/leg ceiling reached, stall limit reached): recorded for truthful status, with NO travel authority (`kind: 'terminal'`).

  **Refused** (`stale_epoch`, `unknown_or_stale_carry`, `goal_mismatch`, `connection_mismatch`, `dimension_mismatch`, `anchor_mismatch`, `source_mismatch`): nothing installed. A fresh epoch is still consumed (fail closed), so it can never get a fresh grant later.
- Plain `admit` of a logical goal id that already had a route is refused (`continuation_requires_carry`). Even a mistaken call cannot refill an allowance.
- No movement, handle, candidate, task, path goal or actuator lease is part of the carry. The continuation re-observes and plans freshly.

**Required integration by P (exact):**
1. In the lifecycle/interruption path that creates a checkpoint, call `routes.revokeWithCarry('lifecycle_<type>', goalEpoch)` (or `exportCarry` immediately before the existing revoke) BEFORE `SkillRuntime.onLifecycle` / `onGoalTerminal` revoke the route, and store the result in `checkpoint.route`.
2. In the continuation admission (the `onGoalAdmitted` path for a continued goal), call `routes.admitContinuation(checkpoint.route, {...admission, admissionAnchor: checkpoint.anchor.at, admissionRadius: checkpoint.anchor.radius})` INSTEAD of `routes.admit`. Report `kind` and `reason` in status.
3. Never call `admit` for a continuation. It is refused anyway.

Tests cover:
- export before revoke, and nothing exported after revoke;
- `revokeWithCarry`;
- original ceilings, absolute deadline, anchor and routeId;
- legs, distance and all three distance sources kept;
- no executable leg after admission, and monotonic leg numbering (3, then 4);
- respawn displacement not counted;
- repeated deaths (count 2, cumulative history; an older export or a repeated admission refused);
- expired deadline;
- prior exhausted (distance) and blocked (stalled);
- an interrupted stalled leg extending the stall run;
- stale epoch, connection, dimension, anchor, radius, goal, source, tampered distance/ceilings and forged routeId refusals;
- plain re-admit refused;
- a new goal id granted normally;
- the frozen own incident kept, and a changed incident refused.

**Checks at the C12 code commit `8b24f28`** (direct exits, each output redirected to a log and `$?` captured immediately):

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npm run build` | 0 | |
| `npm test` | 0 | 838/838 |
| locator suites (13 files) | 0 | 153/153 |
| doctor (`fixture.json`) | 0 | |

`dist/cli.js` sha256 `de9409f3ddb24e918274db15435ad1a15d1c5a2896f93149e7799b58e0fa7553`.

The ownerSeen/raw-moved correction (C1 above, `a9f3e00`) is complete: `ownerSeen` is now only an evidence field. No window continues on it; once the owner is lost, sideways or backward movement can only debit progress.

## C12 alignment with P's approved declaration (`4409ba1`, commit `7a77aeb`)

P's approved `src/contracts/continuation.ts` exports a structural `RouteCarry`. It says L may refine the names in `locator.ts`.
- **Rename.** If the locator-owned type were also named `RouteCarry`, the two `export *` lines in `contracts/index.ts` would collide. It is now `RouteLineage` (`ROUTE_LINEAGE_VERSION`). It is a strict superset of the approved shape: it adds the approved `nextLegIndex` (always `legsUsed + 1`), plus the identity and provenance fields the lineage rules need.
- **Requested integration (P, one line):** in `continuation.ts`, `import type { RouteLineage } from './locator.ts'; export type RouteCarry = RouteLineage;`. The checkpoint then stores exactly what `exportCarry` returns and what `admitContinuation` accepts, and nothing is duplicated.
- **Offline type evidence.** In a throwaway `/tmp` copy (nothing committed), adding P's `4409ba1` `continuation.ts` and its `export *` index line leaves the project typechecking (exit 0), with an explicit `RouteLineage → RouteCarry` assignment. No export collision.
- **Hardening.** Malformed lineages (null, empty, missing fields) are refused without throwing, and a fresh epoch is consumed (fail closed).
- **New tests:**
  - `nextLegIndex` matches the leg actually begun across epochs;
  - malformed inputs are refused;
  - the exported lineage has the approved fields with the approved kinds.

  Continuation suite: 14 tests.
- **Checks at `7a77aeb`** (direct exits): typecheck 0, build 0, `npm test` 0 (847/847), doctor 0.
- **Ownership.** Route carry stays a later focused dependency for P: `8b24f28` plus `7a77aeb`, on top of the module milestone. No shared source was edited.

## Coordinator decisions D1–D3 and milestone layout

- **D1 (authorized, implemented `a3d80e2`).** The DEFAULT `hintMaxAgeMs` is now the schema's bounded maximum, 600 s, so an owner who stands still far away is still found.
  - Withdrawal is unchanged and immediate at any age: untrack (hiding, range, locator bar off), logout (identity no longer listed), dimension change, respawn, new connection.
  - An explicitly configured limit stays binding and is never extended. Reported age and remaining freshness are honest. No statement outlives these fences, and none is kept beyond 600 s.
  - `tests/locator-freshness.test.ts` (6 tests) covers: the default and a binding explicit value; a stationary owner found after 5 min with age 300 s and 300 s remaining; expired after 600 s with no movement; immediate withdrawals; an explicit 60 s limit not extended; a new statement restarting the age.
  - Mutation check: with the old 120 s default, three tests fail (exit 1); the source was restored byte-identical (`cmp` 0).
  - Shared follow-up for P: any example, profile, prompt or status text that states a 120 s locator age (none found in `src`/`config`; this document's earlier D1 paragraph is historical).
- **D2.** Persistent follow keeps the explicit operator limits (1024 total movement / 12 legs / 15 min). They are not refilled and Jake is not asked.
- **D3.** The first-option loopback Jev counts only as labelled harness validation. Acceptance waits for shared P-L3; any pre-integration failure is retained.

**Two milestones:**

| Milestone | Ref / SHA | Content | Verified |
| --- | --- | --- | --- |
| Module/harness (for a frozen read-only G6 run) | branch `chunkbot/gameplay-follow-module` = `9a55e49` (parent `a9f3e00`) | locator module, D1, harnesses, every test except C12; NO route-lineage code | Separate throwaway copy (`git archive` + `npm ci`): typecheck 0, build 0, `npm test` 0 (833/833), doctor 0; `dist/cli.js` sha256 `de9409f3…7553`. Copy removed. |
| Main line (module + C12) | branch `chunkbot/gameplay-follow` | the above plus C12 route lineage (`8b24f28`) and this document | `a3d80e2`: typecheck 0, build 0, `npm test` 0 (844/844), doctor 0 |

`9a55e49` was built from `a9f3e00` plus exactly the D1 diff (temporary index, `git apply --cached`, `commit-tree`). It differs from the main line only in `src/contracts/locator.ts` (C12 types), `src/locator/routes.ts`, `tests/locator-continuation.test.ts` and this document. No other checkout or worktree was touched.

## Fixture footprint and restoration (for guard review; no lease requested before it)

| Harness | Teleport box (checked before every RCON tp) | Bot envelope (abort) | World writes | Settings | Players |
| --- | --- | --- | --- | --- | --- |
| G6 (`locator-live-check.ts --gates g6`) | x −1401..−600, y −60, z −1401..−600 (`f1Teleports`, 37 named points) | x/z −1100..−900 | none (flat chunk generation only) | none | Chunkbot (harness connection), FixtureOwner |
| Ordinary (`locator-ordinary-live-check.ts`) | x 1700..2400, y −60, z 1700..2300 (7 named points + checked owner steps); nether roof (0.5, 128, 0.5) for the owner only | x 1600..2500, z 1600..2400 | none (flat chunk generation only) | none (owner sneak via client control only) | Chunkbot (actual CLI), FixtureOwner, FixtureGuest (O5) |

**Restoration:**
- **G6.** The owner returns to `ownerStart` and the bot to `base`. The existing `finally` restorations still apply (owner effects/head/sneak cleared, fake players disconnected, harness connection closed); a failure fails the report.
- **Ordinary.** In `finally`: owner sneak and effects cleared; guest disconnected; Chunkbot teleported back to the starting position recorded at the run's start (dimension included) and VERIFIED by a server read; CLI `/quit` (SIGKILL after 15 s); owner disconnected; loopback Jev closed. A failed restoration or a privacy finding fails the report.

**Guards:**
- Both harnesses refuse (exit 2) without `--fixture-lease`. This happens before any password read, RCON, join, child process or output directory, and is tested.
- Footprints are disjoint from the skills scene and the reviewed locator boxes (tested).
- No `fill`/`setblock`/`clone`/`gamerule`/`attribute`/`difficulty`/`summon`/`kill` appears in the ordinary harness (tested).

## Tests and checks (worktree, Node 24.21.0; direct exit codes)

Method (coordinator note): every command's output is redirected to a log file and `$?` is captured immediately after it; the log is read separately. No pipeline status is used as proof. Latest results are in the third-round section below; the list that follows describes the suites.

- `npm run typecheck`: **0**.
- `npm run build`: **0**.
- `npm test`: **0**, 822/822. The locator suites run on their own: **0**, 137/137:
  - **`locator-direction`** (20 tests, F1):
    - The cue sector equals the true sector for every combination of:
      - 8 directions plus wraparound (±179° straddles due west for `atan2(dz,dx)`; −89/−91° straddles due north, which is the azimuth payload's ±π);
      - block (60), chunk (260) and azimuth (420) variants;
      - positive and negative world coordinates;
      - 6 bot yaws (the hint is identical for every yaw).
    - The first route movement is within 30° of the true bearing, with at least 10 blocks of progress, for every combination.
    - A cue that flips to the opposite side re-steers the bot.
    - Nothing moves for:
      - another player's waypoint;
      - a string id carrying the owner's name;
      - malformed or unknown-variant packets;
      - a stale statement;
      - an unlisted owner UUID;
      - an old connection's packets;
      - statements voided by respawn or dimension change.
  - **`locator-detour`** (8 tests, F3/L5, dry routes only):
    - A wall 120 wide with the owner 40 blocks behind it: one-sided wall following, a detour step that increases the distance, then reunion.
    - A far owner behind a wall 140 wide: one-sided, `cleared`, then reunion.
    - A wall with no way around: the specific `wall` blocker with bounded walking and no crossing.
    - A lake: a dry detour that never stands on water.
    - A river with a dry plank bridge 35 blocks to one side, out of sight: the first side is searched, then the other side; the bridge is crossed dry and the owner reached; never on water; bounded by 3 × 96.
    - An unbridged river: `water_crossing` after a bounded dry search, the bot stays on the near bank, at most 3 windows.
    - A window that ends during an unsuccessful detour reports the observed obstacle (not a generic `no_progress`).
    - No observed obstacle: no detour and no wander.
    - Net-progress windows.
  - **`locator-composition`** (9 tests): the real `SkillRuntime` with `features.locator`, covering:
    - catalog registration and pre-login attachment;
    - owner-only frozen admission with no re-admission;
    - the shared travel guard withdrawing the leg on exhaustion;
    - goal-end and replacement revocation;
    - death, dimension change, respawn and ended voiding;
    - opt-out (disabled locator composes nothing).
  - **`locator-ordinary-harness-guard`** (12 tests):
    - import safety and lease refusal (exit 2, no output);
    - footprint disjoint from the skills scene and the reviewed locator boxes;
    - no world or settings writes;
    - the scripted turns are valid `proposalFromWire` output;
    - the privacy helper;
    - **offline** prompt-capture plumbing (a stub real CLI, the shared fault fixture and a temp dir only).
  - **`locator-harness-guard`** (15 tests): the existing C4/C5 tests plus G6 footprint and geometry.
  - The existing runner, routes, service, codec, skills and terrain tests are unchanged in intent; the runner test now uses the shared simulator, which has a conservative grid pathfinder.
- `npm run doctor -- --config config/examples/fixture.json` (read-only): **0**. It warns that this worktree has no fixture JRE/server set up.
- Built artifact: `dist/cli.js` sha256 `de9409f3ddb24e918274db15435ad1a15d1c5a2896f93149e7799b58e0fa7553`, built from HEAD `0875031`. Nothing is running.
- **Not run:** `live-check`, `skills-live-check`, `jev-live-check`, planner checks, `compat-live-check`, the G6 gate, the ordinary harness, and real-provider checks. All of these need a fixture lease or coordinator providers.

## Harnesses ready for leased fixture runs

### G6 — F1 live direction matrix (`scripts/locator-live-check.ts --gates g6`)

This is still module evidence: it uses the existing harness composition, the real connection, perception, executor and lease, and its own locator/route objects.

- **Setup.** Base (−1000.5, −60, −1000.5). FixtureOwner is placed at all 12 bearings (8 directions + 4 wraparound) at 40 (block), 200 (chunk) and 400 (azimuth) blocks. Bot yaw cycles through 0/90/180/−90/135/−45.
- **Cue check.** The expected variant and sector come from SERVER positions (the C6 oracle).
- **First-movement check.** A 6 s `seek_owner` window per bearing. Server positions must show at least 6 blocks moved, at most 45° off the true bearing, and at least 5 blocks of progress.
- **Footprint.** Teleports are confined to x −1401..−600, z −1401..−600 at y −60, through the single checked helper. An envelope abort fires outside x/z −1100..−900. There are no block writes and no rule or attribute changes. It ends with the owner at `ownerStart` and the bot at `base`.
- **Chunk generation.** The negative-coordinate box may generate new flat chunks; this is the only world-file effect.

### Ordinary CLI scenarios (`scripts/locator-ordinary-live-check.ts`)

The harness drives the actual `node dist/cli.js run --no-autonomy` through owner chat. It uses:
- the **shared planner fault fixture**, wrapped to save every rendered prompt;
- a **loopback first-option Jev** that knows nothing about the scenario and records the offered capabilities.

Its oracle is RCON server positions plus run events. It also runs a **privacy scan**: no planner prompt or Jev body rendered while the owner is out of sight (server distance over 40) may contain the owner's server-truth x/z. A coordinate is checked only where the bot's own sampled positions could not produce it.

| Scenario | What it proves |
| --- | --- |
| O0 | Locator and routes composed; owner tracked; the run's actual catalog (skills line, `status`, `/diag catalog`) verified dynamically against the shared profile expectation (`scripts/lib/profile-catalog.ts`, no hard-coded count) and contains `seek_owner`/`route_travel` |
| O1 | Far follow at 300 blocks: the captured planner prompt offered `seek_owner`/`route_travel`; first movement at most 45° off the true bearing; at least one counted leg; reunion at 4.5 or less (server); one admission anchor; goal persists |
| O1b | Persistent following while the owner walks 60 blocks |
| O1c | Two sight losses (70 blocks away, cue current): the same goal reacquires through `seek_owner` with no planner turn |
| O1d | Hidden owner (sneak): no wander, question or exploration; one declarative end within 2 or fewer planner turns |
| O2 | `stop` while seeking: server-sampled stop trace; route revoked; goal cancelled |
| O3 | Finite "come here" at about 215 blocks: completed only at server proximity |
| O4 | Replacement: old goal `replaced`, old route revoked, exactly one new authorization |
| O5 | Owner logout with a guest on the opposite side: no movement, never toward the guest |
| O6 | Owner in the nether: no movement |
| O8 | Operator `/reconnect` while seeking: no completion and no movement afterwards |
| O9 | Visible follow inside 128 |
| O7 | Separate CLI config with operator route budget 192 blocks / 3 legs: exhaustion, then no further movement |

**Footprint and side effects:**
- Every teleport destination is inside x 1700..2400, z 1700..2300 at y −60, through checked helpers. The bot envelope is x 1600..2500, z 1600..2400. The owner's nether trip goes to (0.5, 128, 0.5).
- There are no block, setting, rule or summon writes.
- Restoration, all in `finally`: owner sneak and effects cleared; fake players disconnected; **Chunkbot teleported back to its recorded start**, then verified; CLI stopped.
- A failed restoration or any privacy finding fails the report.
- Each CLI run has its own data directory under the report.

**Planner passthrough and labels:**
- The fault fixture passes `--version`, `debug models --bundled` and `features list` through to the real installed Codex CLI, as the other fault harnesses do. `features list` loads account cloud configuration, so it needs coordinator approval. There is **no inference**.
- The scripted planner turns are **harness validation**, not planner policy. In O1d they stand in for P's no-question policy.

## Shared seams for P, routed through Codex (no shared file edited)

| ID | Path and semantics | Why (evidence) |
| --- | --- | --- |
| P-L1 | `src/planner/prompt.ts` and/or proposal normalization in `src/goals/`: a task that targets the owner (owner selector or `near_target owner`) and allows `follow_entity`/`move_near` should also allow `seek_owner` whenever it is registered. Prefer a generic code rule keyed on target kind `owner` plus capability targets `['owner']`, not phrase or intent matching; add one prompt sentence. | All four live follow goals allowed only `survey`/`explore`/`follow`/`move`, so locator seeking could never be chosen. |
| P-L2 | `src/skills/movement.ts` `exploreFrontier.resolve`: when `hints.wantsOwner` and the owner is not visible, return unavailable `owner_guidance_unavailable` ("frontier exploration has no owner direction") instead of frontier drafts. Planner prompt: never explore or survey to find an unseen owner. | Undirected east/south/north/west exploration in `goal-e1b85f89a062`. "No random frontier direction" (plan). |
| P-L3 | `src/skills/movement.ts` `followEntity.resolve` and `moveNear.resolve` (owner case): when the visible owner is outside `perception.withinTravel`, offer no draft and return `target_outside_travel_bounds`. `seek_owner` then offers the counted leg. | Three `precondition_failed` results, then `per_target_retries_exhausted` and blocked at exactly 128 (two live goals). With P-L3 no Jev choice can pick a doomed follow. |
| P-L4 | Planner/GoalEngine (MB-PLAN-006): when an owner-following task blocks with `no_locator_hint` / `hint_withdrawn` / `no_actionable_hint`, end with one declarative blocker that carries the hint reason. Do not replan on unchanged evidence and do not ask a question. | O1d checks for 2 or fewer planner turns. |
| P-L5 | W/P navigation and safety composition: the safety grant must not depend on route-leg authority. An exhausted or withdrawn route returns the bot to the admission bound, which may be behind it. The water policy (`liquidCost`) decides whether a path to a dry `seek_owner` waypoint may swim. | Plan C11 and W-G3; the `seek_owner` limitation text depends on it. |
| P-L6 | Status: the route/locator lines currently appear only through `autonomyStatusLines`. Show them in ordinary `status` even when autonomy is disabled (H6 dashboard projection later). | Truthful status (F4). |
| P-L7 | Skills harness capability count (already P-owned, MB-FLOW-001-C9): use the profile catalog (22 with the locator). | Retained 13/33 failure. |
| P-L8 | `src/cli.ts` `commandCatalog` builds `new SkillRegistry(allSkills())`, i.e. the foundation catalog only. It does not show the locator/memory/survival capabilities a `run` registers for the same config. Compose the same profile as `run` (or label it "foundation catalog"). | Operator truthfulness; my harness avoids it and uses `/diag catalog` inside the run. |

## Decisions requested from Codex

- **D1 — freshness of an unwithdrawn statement.**
  - **Static source facts.** A stationary owner at block or chunk precision gets no further packets, even while the bot moves. Chunk connections update only when the source chunk changes, and variant transitions re-track. Under official semantics such a statement stays current until untrack.
  - **The problem.** The default `hintMaxAgeMs` is 120 s. If Jake stands still for more than 2 minutes and then says "come here" from 100–330 blocks away, the result is `expired` and no direction.
  - **Recommendation.** Raise the default to the schema maximum, 600 s, in the L-owned `LocatorConfigSchema` (one line; tests read the default). Alternatively, define "stale" as "no statement and the owner not listed". I have **not** changed it, because "stale hints cannot steer" is an explicit criterion.
- **D2 — route budget for persistent follow.**
  - **Current defaults.** Legs 12, total route movement 1024, 15 min, leg radius 96. Following inside the admission radius uses no route budget.
  - **Consequence.** A long walk beyond 128 ends declaratively after about 1 km of route movement.
  - Confirm the budget, or ask Jake.
- **D3 — harness Jev policy.** The ordinary harness uses a first-option loopback Jev. Without P-L3, O1 can still pick a doomed `follow_entity` for a visible owner beyond the bound; the report will show it. Confirm that first-option is the acceptable neutral policy, or that harness runs wait for P-L3 integration.

## Lease request (exact; nothing has been run)

Freeze source at the HEAD that contains this document, then run `npm ci` (done), `npm run build` and a direct-exit `npm test`. Link only the fixture stores.

1. **26.2 G6** (about 5 min). Exclusive 26.2 driver. No approvals are needed: teleports only, no rule, attribute or block changes.

   ```
   node scripts/locator-live-check.ts --fixture-lease <id> --fixture 26.2 --gates g6
   ```

2. **26.1.2 G6.** The same command without `--fixture 26.2`.
3. **26.2 ordinary** (about 25 min). Exclusive 26.2 driver; actual CLI as Chunkbot; fake FixtureOwner/FixtureGuest; scenario O0–O9 footprint above; nether roof trip; approval for the read-only Codex passthrough (`--version`, `debug models --bundled`, `features list`); loopback Jev only.

   ```
   node scripts/locator-ordinary-live-check.ts --fixture-lease <id> --fixture 26.2
   ```

4. **26.1.2 ordinary.** The same command without `--fixture 26.2`.

I also ask Codex to review the declared boxes. The new flat chunks at x −1401..−600, z −1401..−600 and x 1700..2400, z 1700..2300 are the only world-file effects.

## Acceptance state

| ID | State |
| --- | --- |
| F1 | Module evidence: 8 directions + wraparound × variants × coordinate signs × yaw; invalid/other/stale hints cannot steer. **Live G6 pending (lease).** |
| F2 | Real Codex/Jev beyond 128 / 300+ blocks: coordinator-only, after P-L1–L4 and W safety. The ordinary harness (scripted providers) is ready. |
| F3 | Module evidence: repeated loss/reacquire (O1c pending live); bounded detours or specific blockers; no wrong-player following. Water crossing is out of scope until W proves it; only dry detours are covered. |
| F4 | Module and composition evidence for exhaustion, stop, replacement, lifecycle and reconnect discarding. **Ordinary O2/O4–O8 pending (lease).** |
| F5 | Needs the corrected combined skills regression (P-L7) and L7 on one immutable integration build, then registration and separately authorized live validation. |

## Known gaps and labelled assumptions

- **Simulator gap.** The detour logic is tested against a simulator whose pathfinder is a conservative grid BFS, not mineflayer-pathfinder. Live G5/G6 and the ordinary harness must confirm the behaviour on the real stack.
- **A1 (assumption).** Detours are justified only by observed obstacles. A U-shaped dead end that needs walking more than 112.5° backward reports the blocker instead of searching.
- **A2 (assumption).** The 8-step / 96-block / 3-episode detour bounds are code constants inside the route budget; they are not operator policy. The planner cannot change them.
- **Scope.** This branch makes no reversed-axis root-cause claim. The live trace shows undirected exploration and the 128 radius.
