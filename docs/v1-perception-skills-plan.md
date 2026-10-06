# MB-V1-02 — Perception, game knowledge, and general Minecraft skills

Created/updated: 2026-10-04. Status: **Accepted; independently verified locally and built.** Depends on MB-V1-01. Read [architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and G-01/G-04/G-05/G-06 in [research](v1-research.md).

## Outcome and scope

The connected bot exposes a discoverable, reusable player capability catalog. Grounded actions perform movement, resource collection, inventory, crafting, placement, workstation/furnace, and basic entity interactions. Code verifies results, and stop interrupts every action.

These are mechanisms the LLM can compose for broad goals. Do not implement a hardcoded “logs → pickaxe → stone” goal recipe or restrict mining/crafting to example items. The planner owns prerequisite selection and progression.

Jake selected player-like perception. Coordinator assumptions: bounded local line-of-sight, labeled remembered observations, version-correct mechanics, conservative navigation, and explicit world modifications only through task-admitted skills.

Proposed owned paths: `src/perception/`, `src/knowledge/`, `src/execution/`, `src/skills/`, approved game-adapter additions, and affected fixtures/tests. Shared contracts/config/dependencies/entry points require Codex coordination.

## Catalog and knowledge behavior

Every entry declares parameter schema, supported targets, preconditions, candidate resolver, observable effects, outcome predicates, cancellation, and limitations. Use the same registered definitions for planner capability descriptions and executor validation.

Implement general families:

- Move near a grounded target/waypoint; look/survey; propose bounded reachable exploration frontiers and record visited observations.
- Mine an admitted visible block with a valid tool, pick up visible drops, inspect/select/equip inventory.
- Resolve version-correct recipes and craft specified items/amounts at the required available workstation.
- Place inventory blocks on grounded visible faces; use/interact with admitted blocks/items/entities.
- Operate an observed furnace with valid inputs/fuel, await processing, and collect verified output.
- Drop/transfer selected items through supported visible interfaces and perform direct entity interactions/attacks with reliable result evidence.

Keep individual skills bounded. Workstation setup and ingredient gathering are separate planner-chosen steps, not hidden automatic prerequisite chains inside a crafting skill. A missing tool/table/fuel returns structured precondition evidence for the planner.

Knowledge queries return validated registry items/tags, recipes, harvest/tool requirements, and implemented capability details. Query possible recipes and table requirements even when ingredients/workstations are absent; a currently-craftable-only query cannot support prerequisite planning. Unknown mechanics stay unknown. Static game recipes may be known even when corresponding resources are not observed.

V1 does not need specialized automation for every mechanic. Record unsupported adapters/predicates precisely and finish independent catalog entries. Never mark a missing generic crafting/furnace capability complete because a log demo works.

## Perception and world control

Filter loaded block/entity data before model exposure. Probe block visibility/raycasting and entity/drop occlusion separately. Bound observations, attach timestamps/dimensions, and exclude hidden ore/global player tracking. Remembered anchors are historical evidence.

Exploration candidates come from reachable local geometry/frontiers within the goal's configured bounds. Survey/look actions produce new observations; they do not query hidden resource positions. A resource may become observed after an explicit admitted dig. No world-seed or buried-block shortcut.

Pathfinder movement must not dig/place/scaffold automatically. Disable those shortcuts and unsafe movement through verified installed settings. Mining and placement happen only as explicit admitted skills. Report no-safe-path when navigation cannot proceed without a separately planned modification.

Recheck target, reach, visibility, dimension, selected item/tool, recipe, space, and ownership before interaction. A completed request/promise is not proof of block break, pickup, crafting, placement, smelting, transfer, or entity death. Use actual protocol/world/inventory evidence, distinguishing optimistic client updates from server-confirmed effects.

Crafting must handle ingredient/output counts correctly. Furnaces/containers track owned interfaces and partial contents. Dropping items near Jake cannot claim he received them without reliable evidence. Entity disappearance cannot stand in for death.

## Cancellation and persistence

One actuator lease owns game control and interaction interfaces. Invalidate epochs first, then clear path/dig/control and close owned interfaces. Pathfinder stop semantics require an immediate clear-goal path verified under G-05. Record completed world effects and any partial workstation state; cancellation does not undo Minecraft actions.

A delayed old action cannot execute or clear a replacement lease. Inspect library macros for internal asynchronous subcommands: an aborted outer promise must not permit later clicks/crafts to continue under old ownership. Use a verified lower-level/fenced adapter when the installed macro cannot meet this contract. Stop must remain responsive during navigation, mining, recipe operations, and furnace waiting. Stable intentional waits use local observations and guards rather than repeated inference. An already-started furnace can continue cooking in Minecraft after the interface closes; report its partial state rather than promise rollback.

Death/disconnect/dimension changes clear handles and end the goal; no automatic resume. Targets/leases are transient; Minecraft changes persist normally, and redacted evidence records them.

## Milestones and acceptance

1. **SKILL-1 — Observation/knowledge slice.** Visible versus obstructed blocks/entities/drops match policy. Recipe/tool queries match the tested version and expose unknowns honestly.
2. **SKILL-2 — General movement/resource slice.** Approach, survey/explore, mine at least two mechanically different block types with valid tools, and verify pickup. Same capability path handles differing targets.
3. **SKILL-3 — General inventory/crafting slice.** Select/equip, craft from queried recipes, place/use a workstation, and verify output. A missing prerequisite is returned without an internal fixed goal progression.
4. **SKILL-4 — Processing/interaction slice.** Place/use a furnace, load valid fuel/input, wait/collect output; verify placement/transfer/entity interactions supported by the installed adapter. Document exact predicate gaps.
5. **SKILL-5 — Interruption slice.** Stop navigation, mining, crafting/interface use, and processing waits. Meet the control-clear target, preserve partial-effect evidence, and prove old cleanup cannot affect new control.

## Checks and remaining evidence

Run real build/typecheck and affected catalog, visibility, recipe, predicate, lease, and lifecycle tests. Live-check representative mechanics in a separate fixture; do not expand into an exhaustive test of every Minecraft item.

SKILL-1 through SKILL-5 are independently accepted:170 tests,22 coordinator probes,16 foundation and33 built skill scenarios. [Coordinator acceptance](reviews/mb-v1-02-coordinator-review.md) records source/build evidence and precise limits. Diagnostic skill checks do not replace later real LLM/Jev integration.

## Current assignment

Assigned 2026-10-04 to native Claude Code Opus 5.5/high/full subscription worker `session-53373eb0-67eb-4aa3-a5d6-ce77f5647eb2`. [Complete brief](reviews/mb-v1-02-worker-brief.md) assigns all skill/knowledge/perception milestones and required shared integration paths. Foundation is independently accepted; use its isolated vanilla 26.1.2 fixture. Source/build and all five skill milestones are independently accepted; see the linked coordinator review. This worker is completed and idle.

## Coordinator review findings

Correction MB-SKL-001..010 was assigned once to the same worker at 2026-10-05 02:04 UTC through the [consolidated brief](reviews/mb-v1-02-correction-brief.md), after an affected-worker-only interruption at a completed live-check boundary. The worker acknowledged and read all recorded issues/probes before changes. MB-SKL-001 through MB-SKL-010 are now independently verified fixed; the historical reproductions below preserve the failing-before evidence. See [coordinator acceptance](reviews/mb-v1-02-coordinator-review.md).

### MB-SKL-001 — Keep knowledge compatibility tied to verified mechanics

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Worker: `session-53373eb0-67eb-4aa3-a5d6-ce77f5647eb2`.

Observed: `VersionKnowledge` currently assigns the generated 26.1.2 recipe/tag/fuel dataset to every `26.1.x` version, citing their shared protocol 775. The dataset provenance and live fixture verify 26.1.2 only. Equal network protocol does not establish equal recipe/fuel/tag mechanics. No other patch-version equivalence probe has been recorded.

Reproduction: coordinator `/tmp/chunkbot-mc-knowledge-scope-probe.mjs`, Node 24.21.0, exits 1 because both 26.1.1 and 26.1 return `known` pickaxe/fuel answers from dataset 26.1.2 instead of `unavailable`. The exact 26.1.2 recipe answer remains known. This is a scope/verification defect; the probe does not claim those other releases' recipes actually differ.

Expected: expose generated mechanics only for the exact verified version, or record a bounded comparison proving a particular additional version's mechanics match before admitting it. Return precise unavailable knowledge/capability evidence for an unverified version; retain item/protocol support separately where valid. The accepted 26.1.2 fixture must continue working.

Acceptance: the implementation and doctor/operator claims distinguish connection/protocol compatibility from verified mechanic data; an unverified patch cannot receive a falsely version-specific known recipe/fuel/tag answer.

### MB-SKL-002 — Enforce the declared opaque-fluid visibility rule

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker/fixture compatibility context as MB-SKL-001.

Observed: the visibility policy and `canOcclude` classify lava as opaque, but `traceSegment` only stops on collision shapes. Fluid blocks have no collision shapes, so the ray passes through lava. Coordinator `/tmp/chunkbot-mc-visibility-probe.mjs`, Node 24.21.0, exits 1 with `{declaredOccluder: true, visibleThroughLava: true}` for a lava voxel between the eye and target.

Expected/acceptance: the implemented ray policy must stop on opaque fluids using appropriate visual geometry, even without collision shapes. The pure regression probe must pass; existing partial-block and ordinary wall/entity/drop visibility must remain valid. Confirm the fluid behavior against the installed block shape and a bounded fixture scene. No camera-render accuracy is claimed.

### MB-SKL-003 — Use the admitted owner identity in perception

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: `PerceptionService.isOwnerEntity` accepts a case-insensitive name match before consulting the configured UUID. With both owner name and UUID configured, a visible player with that name and a different UUID becomes the owner. The offline fixture also accepts a different-case name, while accepted chat admission requires the exact name and derived offline UUID. Coordinator `/tmp/chunkbot-mc-owner-perception-probe.mjs`, Node 24.21.0, exits 1; both mismatches returned true.

Expected/acceptance: share or faithfully apply the admitted owner policy. UUID mode must rely on server-asserted UUID and verified online mode, with no display-name override; trusted offline mode must use the exact name and derived UUID. Matching/mismatching identity tests must cover both modes. Observation/candidate/spatial predicates must never treat another player as the owner; current fixture owner behavior must still work.

### MB-SKL-004 — Clean up a window that opens after cancellation

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: `Actuator.openBlockWindow` registers the owned window only after the server reply is awaited. When stop occurs after `block_place` was sent but before `open_window` arrives, abort rejects the waiter and cleanup has no owned window. A late response can subsequently open the interface. Coordinator `/tmp/chunkbot-mc-late-window-probe.mjs`, Node 24.21.0, exits 1 with a revoked lease and window 7 still open; no close packet was sent.

Recheck: the worker added pending-open cleanup, and the original simple cancellation probe now passes. Two required variants still fail in `/tmp/chunkbot-mc-pending-window-probe.mjs`: an open reply arriving after the request timeout leaves window 7 open, and a replacement request **adopts the old late window 7** as its own response. The probe prints both results before failing. The protocol reply is uncorrelated; merely skipping cleanup while a newer lease exists does not prevent the newer action using the wrong interface. Resolve/drain pending ownership or return precise temporarily unavailable evidence before a replacement may issue/adopt an interface request; preserve bounded controls and attributable cleanup.

Further recheck at 2026-10-05 02:15 UTC: the new connection-wide gate passes the original timeout/replacement probes, but its entity-use barrier treats **any later window-0 contents** as its own ordered reply. `/tmp/chunkbot-mc-interface-barrier-probe.mjs` sends an earlier resync request, then entity use and stop, then that earlier resync's delayed reply. A fresh block-open request is released and adopts the old entity interface 7. It prints `{window:7, oldLateWindow:7}` and exits 1. Earlier uncorrelated resync replies must not release a newer barrier; all relevant in-flight request classes need sound ordering/correlation or precise unavailable behavior. This is the same ownership issue; no new worker steering was queued during the correction turn. Recheck final source before assigning any remaining correction.

Lifecycle recheck at 2026-10-05 02:29 UTC: `/tmp/chunkbot-mc-window-lifecycle-probe.mjs` schedules passive cleanup for an old late-open window7, clears the gate on dimension lifecycle, then admits a new window7 in the new scene. The old scheduled callback closes the new window (`replacementWindow:null`, new ownership still reports7). `clear` changes request state but does not cancel/check the pending callback. Passive cleanup needs lifecycle/request-generation validation before writing, including reused window IDs. This remains the same old-cleanup authority issue; current worker is still implementing and independent acceptance is pending.

Expected/acceptance: track pending interface requests as owned work and handle late opened interfaces after cancellation/timeout. Cleanup must be bounded, attributable to the original request, and cannot close a replacement lease's interface. Test stop before open reply and during content arrival, timeout, and replacement; verify the built fixture path as well as the delayed-response regression. Ordinary stop must still meet the 250 ms control-clear target. Recheck the eventual integration before repeating this finding.

### MB-SKL-005 — Do not widen a stale explicit target to every handle

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: `handleFilter` keeps only explicit handles whose snapshot ID matches the current snapshot, then returns an unrestricted filter when that list is empty. A task naming `snap-1/blk-1`, evaluated against fresh `snap-2`, admits an unrelated `blk-2`. Coordinator `/tmp/chunkbot-mc-target-scope-probe.mjs`, Node 24.21.0, exits 1. A normal controller refresh also produces a new snapshot ID; refreshing must not broaden target authority.

Confirmed through the actual mining resolver: `/tmp/chunkbot-mc-mine-scope-probe.mjs` exits 1 and returns an unrelated `snap-2/blk-2` oak-log candidate for that old explicit selector. Pickup repeats the same empty-filter fallback. The finding is not limited to an unused helper.

The container resolver also ignores a **current** explicit primary target: `/tmp/chunkbot-mc-container-policy-probe.mjs` exits 1 because a task admitting `snap-1/blk-1` returns transfer candidates for the first nearby chest `blk-2`. Apply target authority consistently across registered world-target resolvers, not merely the common helper. Required secondary mechanical targets (such as a crafting workstation) need a declared policy separate from the primary target.

Recheck after the worker added `translateHandle` normalization to the generator: `/tmp/chunkbot-mc-candidate-authority-probe.mjs` uses valid contract IDs and calls the actual `TaskCandidateGenerator`. Its expired mining target correctly produces zero candidates with `named_target_not_visible`. The same generator still produces transfer candidates for the wrong current chest, with deposit-64 and withdraw-5 effects for an admitted deposit-two task. The original direct-resolver reproductions bypass the new normalization seam; review the real generator and all registered resolvers together.

Expected/acceptance: re-ground the same valid originally admitted target using code-held provenance and fresh visibility, or return precise unavailable/stale-target evidence. An expired/removed explicit target never admits unrelated blocks/entities. Verify this through actual candidate generation and execution, including refreshed snapshots, removed targets and disconnected/dimension-changed handles. Recheck final integration before repeating the finding.

### MB-SKL-006 — Stop tracking hidden live entity positions

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: follow/approach give the dynamic pathfinder the raw entity object. `GoalFollow.hasChanged` reads its current protocol position even after perception loses line of sight. The follow loop waits up to the owner-loss window while leaving that dynamic target active. Coordinator `/tmp/chunkbot-mc-follow-visibility-probe.mjs`, Node 24.21.0 with the installed registry/pathfinder, exits 1: after visibility becomes false, the path goal updates from x=3 to hidden x=25. The movement approach path also checks presence rather than fresh visibility.

Rechecked after the worker replaced `GoalFollow` with a local `GoalNear` loop: the updated probe still exits 1, now with one **new path goal written to hidden x=25** and `finalDistance: 25` in returned evidence. Freezing each individual path object is insufficient if the re-goal loop reads hidden positions before testing visibility. The probe covers both dynamic mutation and subsequent writes; positive follow acceptance must also measure actual movement/distance while the entity is visible, not merely allow a timed `partial` result.

Expected/acceptance: movement may use fresh visible positions or a frozen, labeled last-observed waypoint, never continuing dynamic tracking of hidden protocol coordinates. Freeze/clear the dynamic target on loss of sight, maintain local loss guards, and recover only from a fresh admitted observation. Verify wall-occluded moving owner/entity behavior through the built fixture; no repeated inference loop is required for the local wait.

Live final-correction recheck at2026-10-05 03:21 UTC: the current03:20 built skills run failsFL1 (`/tmp/slc6.out`). Expected hidden-owner failed/partial, but follow succeeded with30/32 visible samples, finalDistance1.5 and owner last observed206.3,-60,214.5. This establishes that the required hidden scene/outcome was not verified; it does not yet establish whether scene geometry/starting position or the visibility implementation is wrong. Diagnose the actual scene and server positions, retain a meaningful wall-occluded positive/negative pair, and do not loosen the assertion or rerun unchanged for a lucky pass. The already-assigned final correction includes completing any remaining live failure.

Scene diagnosis at03:24 UTC: the wall includes a see-through glass window. The worker's correctedFL1 closes that window with a recorded setup command, verifies `owner.visible=false` after the behind-wall teleport, retains the original hidden-distance/position assertions, and restores the glass in finally. The visible-follow positive remainsN1. The rerun is justified by this changed scene and its explicit precondition; final evidence still pending.

### MB-SKL-007 — Enforce travel bounds during paths and following

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: follow does not check the travel bound when starting or while controlling the bot. Approach checks its initial destination only; installed conservative movements have no goal-anchor exclusion and the navigate loop has no travel guard. A detour or moving owner can cross the configured radius. Coordinator `/tmp/chunkbot-mc-travel-bound-probe.mjs`, Node 24.21.0, exits 1: a simulated walking step from x=127.5 to x=128.5 under the radius-128 policy finishes `succeeded`, with zero bound checks.

Further recheck at 2026-10-05 02:19 UTC: the worker added path exclusions and loop guards, but `navigate` returns `arrived` from its initial already-near fast path before checking the live bound. `/tmp/chunkbot-mc-navigation-bound-probe.mjs` calls the actual helper with x=129 under radius128 and an inside-bound target 1.5 blocks away. It exits 1 with `{status:arrived, checks:0, writes:0}`. Check bounds before initial arrival, before/after final settling and before every movement success, as well as during path execution. The root follow-bound recheck now starts with both bot and visible target inside the radius, then simulates an in-loop crossing. Current code stops at 250ms with outside_travel_bounds and four checks; this is controlled development evidence, not built live acceptance. This remains MB-SKL-007; recheck the final source before continuation.

Goal-admission integration review at 2026-10-05 02:41 UTC: `SkillExecutorImpl` currently resets the travel anchor to the bot's position at the first action of each goal epoch. That must not overwrite an earlier admission anchor after planning/clarification/processing delay or a server correction. Capture/bind the goal anchor at admission (before planning), preserve it across task windows, and let replacement establish its own admission anchor. The skills port/executor and later controller/planner wiring need one consistent ownership hook; add coverage where the bot moves between admission and the first action. Normal model-driven intake is not yet installed, so the final real-goal proof also belongs to MB-V1-03/04 integration.

Controlled reproduction at 2026-10-05 02:59 UTC: `/tmp/chunkbot-mc-goal-anchor-probe.mjs` sets the actual perception admission anchor at0, moves the fake bot to129 while planning is pending, then calls the actual goal-owned executor. Even an already-aborted first action changes the anchor to129 and makes the new position inside the radius. It exits1. The03:04 strengthened probe prints both already-aborted and active first-action results; both reset the anchor. Preserve the admission anchor and never let an aborted/stale first action establish a replacement boundary. The seam may evolve to an explicit goal-admission API; verify through that documented API and the real intake path as well.

Expected/acceptance: apply the goal-anchored travel bound to path search/steps and live movement guards, including dynamic following, exploration, approach and pickup. At the boundary, stop/clamp or return exact path/limit evidence without silently expanding the bound. Verify a near-boundary detour and moving-owner scene in the built fixture; replacement may establish its own fresh admission anchor.

### MB-SKL-008 — Honor admitted mechanical parameters in candidates

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context.

Observed: a task naming stone, `parameters: {direction: deposit, item: minecraft:stone, count: 2}`, and a two-item container outcome produces a deposit-64 candidate and a withdraw-5 candidate. The resolver uses whole source counts and does not consult these explicit parameters. `/tmp/chunkbot-mc-container-policy-probe.mjs` records those candidates (and the separate primary-target defect above). Jev can only select an ID, so it cannot repair their direction/quantity.

Confirmed again through the complete candidate generator with valid IDs in `/tmp/chunkbot-mc-candidate-authority-probe.mjs`; the wrong-target/direction/quantity assertion exits 1 after printing both candidates.

Expected/acceptance: declared task parameters and quantities must constrain generated effects. A deposit-two task must not offer a withdraw or transfer the entire inventory. Validate parameter hints against each registered schema; use outcome progress to avoid repeated overproduction/transfer where appropriate. Verify representative count/direction handling across craft, equip, placement, furnace and transfer, without introducing goal-specific handlers. Retain explicit missing-prerequisite evidence.

### MB-SKL-009 — Evaluate completion from current authoritative evidence

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same worker context, Node 24.21.0 and installed 26.1.2 registry. Coordinator probe uses controlled objects, without modifying the Minecraft fixture.

Observed: inventory evaluation falls back to an old ledger inventory when the requested current server resync times out. `block_state` reads Mineflayer's mutable world model and labels it server chunk/block data, even though that model also contains optimistic dig/place updates. `/tmp/chunkbot-mc-predicate-authority-probe.mjs` exits 1: failed refresh still returns `satisfied` for four stone from the old cache, and an unconfirmed local stone-to-air update satisfies the air predicate. Both results are printed before the assertion fails.

Also reproduced through the real executor/follow definition: `/tmp/chunkbot-mc-cancel-evidence-probe.mjs` exits 1 because a cancelled follow with only local sample counters returns `confirmation: server_packet`, despite **zero server evidence packets**. The executor infers confirmation merely from any progress key being present. New interface progress also includes explicitly optimistic click counts. Carry authoritative provenance separately from local progress; cancellation cannot promote unconfirmed samples/clicks/crafts to server-confirmed partial effects.

Further coordinator reproduction at 2026-10-05 02:09 UTC: `/tmp/chunkbot-mc-held-evidence-probe.mjs` invokes the actual equip skill with only an optimistic already-held slot. It returns `succeeded`, `confirmation: server_sync`, with **zero resyncs**. `ensureInHand` bypasses confirmation on its already-in-hand fast path. This extends the same evidence-authority defect; check held-slot proof as well as cancellation and predicate provenance. The probe contains no runtime connection or source mutation.

Freshness/lifecycle recheck at 2026-10-05 02:34 UTC: `/tmp/chunkbot-mc-predicate-lifecycle-probe.mjs` exercises the actual engine and ledger after death invalidation on the same connection. Three remaining cases return satisfied: an old chest view after invalidation (merely labeled historical), a prior result in the Nether evaluated as near the same coordinates in the Overworld, and a server block update behind current LOS revealing diamond ore through a current block predicate. Current predicates must return unknown for those invalidated/cross-dimension/unobservable cases. A historical label does not make old contents current. Preserve explicitly valid historical milestones separately; invalidate transient result/container references and validate dimensions/visibility before using current state. The initial controlled repro prints all three results before exiting1.

Same-connection handle recheck at 2026-10-05 02:55 UTC: `/tmp/chunkbot-mc-perception-lifecycle-probe.mjs` creates an actual observed log handle with the installed registry, calls the actual `SkillRuntime.onLifecycle(death)` path, and then resolves the old handle/anchor/latest snapshot. All remain available because only connection/dimension equality is checked and perception is not invalidated. The probe exits1. Clear transient snapshots/handles/anchors at the documented lifecycle boundary even when the connection and dimension do not change; returning to a former dimension must not revive old references. New observations after recovery must remain usable. This is an extension of MB-SKL-009's lifecycle scope, recorded before correction implementation.

Freshness recheck at 2026-10-05 03:01 UTC: the lifecycle fixes pass the three original new probes, but `/tmp/chunkbot-mc-container-freshness-probe.mjs` still returns satisfied for a closed chest view observed roughly100s earlier and before this goal's admission, with no current interface or fresh validation. Same-connection historical contents cannot complete a new current-state goal. Require fresh current validated contents or unknown, preserving a freshly synchronized inspection/transfer positive and explicitly valid historical effects. Record the exact freshness/ownership boundary; do not just relabel stale data.

Worker-reported accounting review at03:15 UTC: the actuator's diagnostic command log is bounded to200 entries, so subtracting/slicing its array index can undercount commands on long operations. The worker is replacing that evidence calculation with a monotonic issued-command counter while retaining the bounded diagnostic log. This belongs to009's provenance/accounting scope; verify meaningful cancellation/replacement and long-operation counts before acceptance. Source changes alone are development evidence.

Model-observation recheck at2026-10-05 03:41 UTC: `/tmp/chunkbot-mc-predicted-visibility-probe.mjs` uses the actual perception/evidence services and installed-registry fake bot. Ore starts hidden by a stone-brick wall. Two wall voxels are marked pending predictions and changed to air only in the client model; the next observation exposes diamond ore before either server statement. After the actual server block-change records, ore is legitimately visible. Result `{before:false, throughUnconfirmedPrediction:true, afterServerConfirmation:true}`, exit1. Predicate guards alone do not protect the model-facing observation/raycast/frontier and entity/drop visibility paths. Treat pending predicted voxels conservatively as unknown/occluding until current server data confirms them; preserve the confirmed-hole reveal and ordinary visibility positives. This is MB-SKL-009's authoritative-versus-optimistic boundary, recorded before its correction assignment. Acceptance was withheld at this failing-before checkpoint; the subsequent correction passed independent review.

Live cancellation recheck: expanded report `var/live-check/2026-10-05T02-41-46-967Z-skills/report.json` passes31/33 but fails X3: after stop, the actual server inventory changes sticks0->12 and planks40->34, while the outcome reports craftsCompleted0 with confirmation:none. Separate the number confirmed before stop from unknown final partial effects; do not present an unconfirmed total as zero. Where available, attribute/passively confirm post-cancellation packets without new old-owner commands; otherwise explicitly report unknown and preserve the subsequent independent inventory verification. Current built PL2 also refuses a self-occupied destination (correct guard, invalid positive scene); maintain a valid ordinary-support positive. These development failures need correction/verification before full handoff.

Expected/acceptance: distinguish authoritative current state, verified historical events and optimistic/unknown state. Current possession/equipment predicates cannot silently use an invalidated cache after a failed refresh. Block completion must use proven server state/effect evidence, and loaded but unobservable world data must not expose hidden blocks through predicate feedback. Remembered container contents are historical unless validated as current. Scope or invalidate evidence on connection/death/dimension transitions; a prior connection's inventory/result cannot complete the replacement goal. Preserve valid acquisition/crafting milestones as explicitly historical events within their admitted goal/task lifetime. Verify relevant positive cases and failed/late refresh, rejected optimistic change and lifecycle cases through tests and the built fixture path.

### MB-SKL-010 — Place safely against interactive support blocks

Reported 2026-10-04. Status: **Verified fixed; independent source/build/live acceptance passed.** Same native skills worker and vanilla 26.1.2 survival fixture.

Observed: the final live run `var/live-check/2026-10-05T01-30-57-927Z-skills/report.json` failed F1 placing a furnace: the server kept air at the destination, then T1/T2/E1 refused because an interface remained open. The worker's current investigation is checking interactive support blocks and the installed modern sneak protocol. The evidence establishes failed placement and leaked interface; interactive-support behavior is the current root-cause hypothesis until the targeted probe confirms it.

Expected/acceptance: generated/admitted placement against a visible face must account for interactive supports, using verified player sneak semantics or rejecting that face with exact evidence. An unexpected interface opened by the attempt must be attributed and cleaned up without touching a replacement lease. Test placement on ordinary and interactive supports, including stop during the attempt; verify server block/item effects and interface closure. Retain genuine rejected-placement evidence rather than turning it into success. The full built skills suite must pass after the correction, with meaningful placement preconditions and no hidden scene workaround.

Final-correction geometry recheck at2026-10-05 03:27 UTC: `var/live-check/2026-10-05T03-24-23-422Z-skills/report.json` passes32/33, including correctedFL1 and admissionB5. PL1 returns `no_placement_site`: the generated furnace is at201,-60,205, and the scripted approach to204.5,-60,205.5 finishes1.19 blocks from that approach point. No named free visible face within reach is admitted. This is observed prerequisite/scene evidence, not a proven erroneous placement rejection. Inspect the actual standing position/reach/visibility/occupants, establish a valid named interactive-support positive and retain all refusal/stop assertions before rerunning.
