# MB-LOC-001 — Locator-assisted following, reunion and bounded travel

Reported: 2026-10-06. Status: **Native implementation in progress in [batch002](feature-batch-002-plan.md); not yet accepted.**
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

Real packet/source gate, typed hints, hiding/freshness semantics, route legs and autonomous reunion evidence remain unverified. Review target: docs/reviews/mb-loc-001-locator.md.
