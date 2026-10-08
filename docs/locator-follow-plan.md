# MB-LOC-001 — Locator-assisted following, reunion and bounded travel

Reported: 2026-10-06. Status: **Native implementation integrated into development in [batch002](feature-batch-002-plan.md); acceptance incomplete, not deployed to the live application.**
Parent: [companion upgrades](companion-upgrades-plan.md). Baseline: [perception/skills](v1-perception-skills-plan.md).

## Outcome and happy path

Jake asks “follow me” or “come to me.” Outside direct sight, Chunkbot can use ordinary locator-bar information to seek Jake's general direction, including an above/below indication when supported by the received data. It explores a safe local route and switches to exact entity following when Jake becomes visible.

Knowing a direction is distinct from having a safe path or proving arrival. “Come to me” completes only with fresh verified proximity to the actual owner; a locator hint alone is insufficient.

## Evidence, source and limits

Jake reported losing Chunkbot while following. The recorded live follow in run-8a0b31de06a5 stopped at the 128-block goal travel bound and subsequently reported no visible owner. Observation radius is separately 32 blocks. Fixing only locator perception does not remove the travel boundary.

Mojang describes the Java locator bar as a server-controlled player-direction display, with elevation indicators and concealment behavior. It was introduced in Java 1.21.6; crouching, invisibility and certain worn items can hide a player, and server settings control broadcasting. [Official release notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-6).

Local source inspection on the installed 26.2 stack: packet_tracked_waypoint defines track/update/untrack operations, UUID or string identity, and empty/vec3i/chunk/azimuth payload variants. No gameplay locator adapter was found in src or the inspected Mineflayer plugins. This establishes a codec seam, not proof of packets received on Jake's live server or already implemented behavior.

Coordinator recommendation: expose a coarse direction, distance band if justified, and relative elevation if available. Exact wire coordinates must not become an unrestricted global-position API.

## Scope and identity

- Typed connection/dimension-scoped locator hints with source, receive timestamp, freshness and certainty.
- Bind the configured owner by verified UUID; never choose a dot by color, name similarity, ordering or nearest player.
- Limit model-visible hints to the owner/explicitly authorized target. Unknown UUID/string IDs do not grant player identity.
- Preserve line-of-sight policy for resources/entities and ordinary interactions. A locator hint is not entity visibility, a mining target, a container binding, or completion evidence.
- Respect server withdrawal and hiding: untrack, stale data, disabled broadcasting and lifecycle events remove actionable hints. A historical bearing is labeled and cannot be refreshed from hidden global entity state.
- General above/below guidance is optional by variant. Chunk/azimuth-only data cannot imply an exact altitude. Keep unknown height unknown.
- No automatic server-rule/attribute changes, admin position queries, /tp, increased observation radius, or Bedrock protocol assumptions.

## Travel and recovery behavior

Current admission anchors are immutable. Plan an explicit bounded route/leg abstraction for owner-directed long-distance travel rather than silently moving that anchor or globally removing the radius limit.

Coordinator assumptions: each leg uses finite local bounds and fresh safe geometry; the parent directive has total-distance/time/replan limits. Route continuation is a declared policy represented in contracts and status. A leg is not owner-arrival completion and does not reset provider/session budgets. Application code derives leg bounds and total ceilings from operator policy; the planner cannot supply or change limit fields. Any new travel authorization must pass explicit proposal validation, preserving the recorded admission anchor rather than silently rewriting it.

Use coarse bearing to choose an admissible local frontier/route segment. Recompute after new server hints and observations. Keep conservative pathfinding; being below the owner does not authorize digging upward through unseen terrain or building a tower. If navigation needs a new explicit capability, gate and assign it rather than toggling navigation shortcuts.

When directly visible, normal follow/near-owner skills take over. If the target hides or disappears, stop advancing on expired guidance, report searching/lost/blocked precisely, and accept an owner-supplied destination through the existing typed-coordinate path if offered.

Stop/replacement/lifecycle revocation cancels route and waypoint subscriptions; old connection hints never steer a replacement. Restart requires a fresh broadcast. Persistent memory may retain ordinary observed route locations, not a secret live owner tracker.

## Seams and bounded research gates

Inspect the installed 26.2 codec and pinned upstream inputs, src/game/server-evidence.ts, src/game/connection.ts, src/game/identity.ts, src/perception/perception.ts, src/contracts/observation.ts, src/contracts/selector.ts, src/contracts/planner.ts, src/skills/movement.ts, src/skills/navigation.ts, predicates and proposal validation.

Proposed ownership: locator adapter and evidence translation, follow/reunion and bounded routing capabilities, targeted tests. Codex coordinates typed travel policy, shared schema and catalog/planner integration. Dependencies/patches require the existing compatibility provenance process.

Gate L-G1: capture/decode real waypoint variants on the separate 26.2 fixture, moving a controlled owner and exercising hide/untrack/server-rule/range cases. Compare ordinary Java client display and official protocol behavior; determine freshness and usable altitude/distance information.

Gate L-G2: verify 26.2 owner UUID attribution, dimension behavior and the actual version's rule/attribute names. Keep unsupported/missing signals explicit; do not alter Jake's live server.

Gate L-G3: fixture route longer than 128 blocks using declared bounded legs. Choose finite total limits and demonstrate local safe frontier selection without hidden geometry exposure or resetting goal accounting.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| L1 | Track/update/untrack and all codec variants produce bounded, correctly attributed hints. Unknown/other-player targets are excluded; invalid or withdrawn data cannot steer. |
| L2 | Owner beyond 32-block sight yields a usable direction; above/below appears only where justified. No exact hidden owner coordinate enters planner/Jev context. |
| L3 | A route beyond the previous 128-block bound proceeds through declared finite legs, reacquires the owner and verifies proximity. Packet/world evidence shows honest route and counters. |
| L4 | Crouching/hiding, stale signals, locator disabled/range-limited, logout and dimension change produce visible loss/unknown state, no silent omniscience or wrong-player following. |
| L5 | Impassable cliffs, walls, lava and vertical separation produce a safe detour or specific blocker; no automatic digging/towering or invented terrain. |
| L6 | Come-to-me is finite; follow remains persistent. Stop/replacement revokes motion within the existing local-fixture target; old waypoint packets cannot affect a new connection or goal. |
| L7 | Real Codex/Jev chooses the locator-seeking/reacquisition tasks from the same catalog; code confirms reunion without operator intervention inside the trial. |

Required checks: typecheck/build/test, doctors, connection/identity live checks, skill/controller regressions, planner validation/diagnostic and real integration on 26.2. Retain ordinary 26.1.2 perception/follow behavior. Record any unsupported locator profile rather than silently admitting it.

## Remaining delivery

Typed hints, route legs and packet/hiding/reunion module gates have been implemented. Fresh module gates on the observed-geometry source pass 19/19 on vanilla 26.1.2 and exactly 26.2, including 300-block reunion in two legs with the admission anchor unchanged. Shared application regression and real ordinary Codex/Jev L7 remain unaccepted. The corrected shared capability-count harness has not completed its combined rerun. Water safety and the newly reported direction failure also need the tests below. The live application still uses batch001 without locator following. Review target: docs/reviews/mb-loc-001-locator.md.

## Batch002 contract review and decisions

Native contract milestone `b894867fdf3155b35570fc4926ca577f00005213` contains coarse owner-only hints, admission-frozen route authorization and companion ports; no shared integration is merged yet. Codex grants read-only immutable copies of both fixtures' official class jars under the locator worktree's ignored `var/source-probes/`, verified byte-identical to their pinned downloaded bundles. Static parsing is authorized without a world lease; passwords/world/runtime files are excluded.

**MB-LOC-001-C1 — Route distance ceiling semantics.** Recorded before implementation acceptance: the contract calls maxTotalDistance the sum of leg displacements. Net displacement can undercount a looping or detouring path. Count cumulative own movement with explicit source/correction handling for the travel ceiling; keep projected/net progress as a separate stalled-leg metric. Deadline is fixed at admission, never first-leg refresh. Tests must exercise an out-and-back path, repeated legs, time/leg exhaustion and stale goal/connection/dimension callbacks. This is a design correction from the source contract, not a claimed runtime reproduction.

Codec equality alone does not prove broadcasts on both versions. Actual packet/hiding/withdrawal gates remain required on 26.2, plus a real short 26.1.2 locator sanity trial and ordinary-follow regression before claiming that profile. Startup client listeners may attach before ready, but hints become actionable only with verified owner/current connection/dimension. Destination/current-leg provenance is checked in resolver, executor and proposal admission; catalog parameter validation alone cannot authorize a route or a historical death target.

**MB-LOC-001-C2 — Effective bounds and correction accounting.** Review of native `9bd2b3c` finds `legBounds` still returns an expanded leg after distance exhaustion, and only the route runner checks its budget. Every skill using the effective travel bound must lose that expanded authority on exhausted/blocked/revoked/expired routes; active navigation also needs the code-owned guard. `attachMovement` samples raw journal position fields as absolute points, but the pinned physics adapter resolves relative flags and may emit movement before the journal callback. Normalize relative/absolute corrections and count the same displacement once with the correct source; prove zero-relative, mixed flags, ordinary movement, actual correction and detour cases. This is source-review evidence, not a live reproduction.

**MB-LOC-001-C3 — Frozen incident destination.** The same native milestone binds an own-death destination ID but does not freeze its position, dimension and recorded identity. A provider can return changed coordinates under the same ID, and a frozen candidate can outlive that change. Bind the entire incident destination on first use and recheck it before each movement window/poll. Missing, replaced or changed incident data stops travel with a precise blocker; no unrelated or updated location silently becomes the old route's target. The runner must also compare effective-leg provenance with the immutable admission bound.

Codex independently reproduced C2/C3 with the actual module in an offline toy world: a valid 0→16→0→16→0 loop exhausts the 64-block budget but still returns a leg; after binding the same own-incident ID, changing its x coordinate from 20 to 40 is still accepted. No connection, RCON or inference was involved. Both corrections and negative tests were assigned to the existing native locator worker; shared navigation/journal hooks remain progression-owned.

**MB-LOC-001-C4 — Gate footprint and restoration.** Recorded in coordinator review on 2026-10-07 UTC (2026-10-06 Arizona), before any gate lease. Harness `c7c5c843` declares player bounds that omit its west-400, south-200, elevated and nether trials. Its cliff trial clears y −64..−61 but restores only the top grass layer, leaving removed lower terrain behind. Correct the declared footprint to cover every setup command and restore all changed layers, with original-state evidence or the verified dedicated flat-scene baseline. Restoration failures must make the report fail. The pre-integration harness remains module evidence; only actual shared application wiring and all-skill bound checks prove production routing.

**MB-LOC-001-C5 — Hazard gate geometry.** First leased 26.2 module gate at source `fef8ed3e` exits 1 with 18/19 recorded checks (`2026-10-07T02-11-21-880Z-26.2-locator`). Actual 300-block owner reunion succeeds in two counted legs, server distance 2.2 blocks and admission anchor unchanged. Review of the negative scenes then finds the starting position inside their obstacle footprint and a drop cut through bedrock into the void. Those scenes do not establish safe lava/drop refusal or a production wall-label defect. Retain the failed report; start outside the obstacle, use a bounded supported drop scene, observe contact/damage/death, and accept only a demonstrated safe detour or a specific observed blocker. The corrected harness is frozen at `bce707ff`; integrated ordinary-follow evidence remains required.

**MB-LOC-001-C6 — Gate position and UUID oracle.** During C5 rerun, six packet checks disagree with assumed starting geometry. The harness had not established that the bot was alive and at the base after the earlier invalid void scene, and it registered the guest UUID after join-time packets. Source `7b28c90c` adds bounded alive/base verification, server-position-derived expected sectors/variants, lifecycle evidence and pre-join guest identity. This corrects the test oracle; it is not evidence of a production codec defect. Rerun the complete packet, hiding, reunion and hazard gates on this immutable source, including final restoration.

Corrected module gates at `7b28c90c` pass 19/19 on 26.2 and 26.1.2, with no restoration failures. The 26.1.2 report is `2026-10-07T02-22-35-525Z-locator`; both server-confirmed reunions end at 2.2 blocks in two route legs. These remain pre-integration module evidence. Additional C5 source review finds that old blocker labels could name walls/drops from loaded collision geometry outside the current sighting. Native `2fb02f69` restricts labels to observed voxels, with a content-read spy test. Since production code changed, earlier live reports do not certify this new source; fresh gates are required before acceptance.

## MB-LOC-002 — Wrong direction and distance loss

Reported: 2026-10-06 Arizona (2026-10-07 UTC). Implementation authorized: 2026-10-07 Arizona. Status: **Assigned to locator work with one shared integration writer.** Parent delivery remains MB-LOC-001 L1–L7. See [intake and release distinction](live-gameplay-fixes-plan.md) and [water safety dependency](survival-routines-plan.md#mb-flow-003-c11--water-safety-during-following).

Jake reports that a distant “follow me” sent Chunkbot in the opposite direction, and follow was lost around the 128-block limit. Last live session: eggyBot69, Java 26.2/protocol 776, run-9d8d6a18e52b, accepted application d348d58 without the new locator implementation. Exact goal/action IDs and incident timing are not matched. Previous live evidence separately proves an ordinary follow stopping at its 128-block admitted travel bound; its observation radius is 32 blocks. The user's new wording does not distinguish leaving visibility from crossing that bound.

Source evidence: ordinary follow_entity only reads current visible owner positions, can keep its last observed waypoint briefly, and stops on target loss or travel-bound violation. An unseen-owner command cannot use the uninstalled locator. Potential causes include an unhelpful exploration plan, stale waypoint, wrong coordinate/bearing convention or path detour. None is established as this incident's root cause; do not call this a verified reversed-axis bug.

### Outcome and operating states

“Follow me” maintains owner proximity. If Jake is unseen, seek along fresh owner-UUID-bound coarse locator guidance when supported, choose safe local legs, reacquire him and switch to visible follow. “Come here” ends only at verified owner proximity. Follow lasts across local task windows until stop/replacement, a genuine bounded blocker or its admitted deadline/allowances.

- On joining, install the verified locator adapter and route/catalog composition before readiness. Admit each command with an immutable anchor and explicit code-owned finite route ceilings. A viewer starting or a Git push does not load these features.
- Prefer a fresh visible owner over coarse hints. Hints are bearing/elevation/range guidance, never an entity handle, hidden-owner coordinate or arrival proof. After loss, a route leg is freshly grounded rather than reusing an expired entity position.
- On an open safe plane the initial movement must agree with the usable bearing. An obstacle detour may briefly increase distance; justify it from observed local geometry and require bounded eventual progress. Do not suppress useful detours with a simplistic always-decrease-distance test.
- Hiding, missing broadcasts, stale/untracked hints, absent owner, unavailable profile and dimension changes yield one declarative lost/blocked state, with no follow-up question or repeated inference on unchanged evidence. The no-question policy does not justify choosing a random frontier direction.
- An exhausted route loses expanded travel authority for every skill. Preserve the admission anchor, cumulative movement, deadlines, leg/turn/task/replan limits and SpendLedger. Never reset the goal at 128 blocks to pretend travel is unbounded.
- Surface/shore safety must remain effective during reacquisition, leg completion, visibility loss and radius failure. Route failure must not leave an active water episode unhandled. Explicit stop/logout still revokes all motion; no reconnect from this feature.
- Stop, replacement, death and disconnect revoke route, path controls and hint ownership. Restart needs fresh verified identity and broadcasts; never persist a hidden live tracker or replay a stale leg.

### Bounded diagnosis and delivery milestones

| Gate | Question, probe and decision |
| --- | --- |
| F-G1 | Which layer chose the wrong direction? Inspect a narrow redacted historical goal trace if retained; otherwise reproduce an ordinary command in the leased fixture. Record target visibility, planner task/selector, locator variant/sector, own position/yaw, route target, path/control updates and corrections. Decide whether the fix belongs to grounding, sign/angle conversion, routing or pathfinding. No need to reconnect Jake's bot to investigate. |
| F-G2 | Are all coordinate conventions correct? Controlled owner north/south/east/west and diagonals; vary bot yaw and negative/world coordinates, cross bearing wraparound, and exercise actual supported payload variants. Compare fixture server truth as the test oracle with coarse application hints; unseen exact owner coordinates must not reach models. |
| F-G3 | Does the ordinary pipeline cross both limits? Use the actual CLI/chat path and shared catalog on both supported fixtures; lose sight beyond 32, cross the 128 admission radius through authorized legs, and reunite at 300+ blocks. Decide shared composition versus module behavior; include water only after C11 mechanics pass. |

| ID | Observable acceptance |
| --- | --- |
| F1 | All eight directions and yaw/wraparound cases select a direction-consistent first leg on a clear plane; server-position progress confirms it. Invalid/other-owner/stale hints cannot steer. |
| F2 | Real Codex/Jev “follow me” and finite reunion work beyond 128 blocks in normal run, with fresh visible-owner takeover and no manual coordinate/answer/teleport intervention. At least one 300+ block route; limits and original anchor remain unchanged. |
| F3 | Visible follow loses/reacquires sight repeatedly and remains persistent across windows; wall/vertical/water cases safely detour or state a specific blocker. No wrong-player following or random searching without actionable evidence. |
| F4 | Exhaustion, stop/replacement while seeking or following, owner hiding/logout, dimension change and reconnect discard old guidance, clear controls and retain truthful counters/status. C11 verifies water transitions separately. |
| F5 | Corrected combined skills regression and L7 pass on the same immutable integration build, followed by accepted-release registration and separately authorized live validation. Source/module passes alone do not close the report. |

Future ownership: existing locator worker owns locator modules and dedicated tests; one shared writer owns movement/navigation, game identity/evidence, perception, planner/contracts and app wiring. Codex assigns branches/leases and checks native Opus 5.5 availability before work. Run affected AGENTS.md unit/build/doctor, identity/skills/fault-controller/planner checks and compatibility checks on 26.1.2/26.2, then real-provider ordinary goals. Do not add an undocumented harness command or expose private endpoints/credentials in reports. MB-LOC-002 remains unimplemented by this plan update.
