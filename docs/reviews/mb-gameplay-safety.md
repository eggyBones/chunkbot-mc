# MB-FLOW-003-C11/C13 — immediate water and mob safety (worker W)

Updated: 2026-10-07 Arizona / 2026-10-08 UTC. **Owned corrections are implemented and verified offline. C11/C13 are not integrated, fixture-proven or accepted.** The interrupted W1s failure remains open until a new frozen trial proves it. No deployment or live reconnect is authorized.

Worker route supplied by the coordinator: local DSH native Codex, `codex:codex-default`, `relay-codex`, personal ChatGPT prolite, CLI 0.160.0, exactly `gpt-6.1-sol` / `xhigh`, `danger-full-access`, approval `never`. Workspace `acce0215-c372-43d3-9426-c8fd6cc5c6e6`; session `session-698bd9ba-ac47-4ab4-90ac-bad0bb9732ee`. No account/model/effort change, DSH edit, worker launch or API billing was performed. The gameplay planner's separate low-effort profile is unchanged.

Branch `chunkbot/gameplay-safety`; worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/gameplay-safety`. Original integration base `37c4c170199b4c9d867f720e64561a63a816d14c`; application predecessor `fd8ce132cefa61abad1f1b9cbfcf3a5ed9515aa7`; documentation handoff `cee1363ca8b946fadd59f3a86b8d5672b9e6b04f`. All six preserved native drafts were inspected and retained through the corrections. Existing source commits and historical sessions were preserved. No companion branch was merged and no shared source was edited.

## Current commits and checks

| Commit | Focus |
| --- | --- |
| `6f3f5df` | W-C13-R4: unknown armor durability earns zero points; supported aging mobs require known adult state; spiders need no age property. |
| `6dd53ee1d1aa975bd4a2a9e60a2e499ecbc85009` | W-C13-R5 and dispatch/ownership corrections: prospective escape bounds; fixed grant origin through replans; stopped-grant cleanup before new authority; post-aim readiness checks; bounded disengagement; explicit vanilla spawn-default evidence. |
| `0656e47` | Retain 32 episode results, covering the largest configured repeated-hazard ceiling. A functional 17-episode regression proves replacement goals do not refill it. |
| `38cb3510642c8449ff497cd49335636c9d30ad25` | W-H1: durable original settings/forceload and command-intent journal, bounded RCON transport, idempotent interruption/finally restoration, corrected meaningful harness guards. |

Earlier milestones (`804e61d`, `c35353f`, `b246e55`, `db4071a`, `001c1df`, `5b3b003`, `fd8ce13`) remain in branch history. The earlier review's claims of complete evidence are superseded by this document and the [coordinator review](/Users/jakewilcox/code/repos/minecraft-buddy/docs/reviews/mb-gameplay-fixes-coordinator.md) in the integration checkout.

Every implementation/check command ran in this worktree with `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH. Existing dependencies were reused; package/lock/vendor inputs are unchanged. Direct exit codes were captured.

| Check | Direct result |
| --- | --- |
| `npm run typecheck` on final source | 0 |
| `npm run build` on final source | 0 |
| `npm test` on final source | 0, 866/866; earlier complete run retained separately: 0, 865/865 |
| Policy/service/defense/physics-skill correction tests | 0, 56/56 before the extra repeated-window regression |
| `node --test tests/safety-service.test.ts` after that regression | 0, 21/21 |
| `node --test tests/safety-harness-guard.test.ts` | 0, 14/14 |
| `npm run doctor -- --config config/examples/fixture.json` | 0, read-only, no model/world connection |
| `npm run doctor -- --config config/examples/fixture-26.2.json` | 0, read-only, no model/world connection |

Evidence lives in ignored `var/safety-offline/`: `typecheck-final.log`, `build-final.log`, `full-tests-final.log`, `service-final.log`, `doctor-26.1.2.log`, `doctor-26.2.log`, `checks.json`, and `official-defaults.json`. The earlier passing full-suite log is retained as `full-tests.log`. Doctors show 20 shared registered capabilities, no OpenRouter key and no configured memory scope: this worktree still lacks P's safety composition. The default fixture is absent here; the existing 26.2 fixture path is a preserved symlink to shared storage. Doctor only reads readiness metadata; the worker did not manage that server or use the symlink for a trial.

Owned paths changed since the documentation handoff: `src/contracts/safety.ts`; `src/safety/{adapter,dispositions,policy,service,tracker,trial-journal,trial-rcon}.ts`; `src/skills/safety.ts`; `scripts/safety-live-check.ts`; `tests/safety-{defense,harness-guard,policy,service,skills}.test.ts`; existing W test helpers `tests/safety-helpers.ts` and `tests/safety-session.ts`; this review. Existing shared app/goals/tasks/perception/navigation/contracts/config/CLI files are unchanged. The helper paths were already part of W's preserved source/draft scope; no shared fake helper was edited.

Source artifact: final build of the committed owned source at `38cb351`; `checks.json` records dist tree digest `d4ad593470f8bde0964015037c23b54352d94e308a049052fafcdba0f6a42e41`. No Chunkbot application was launched or deployed. The accepted live artifact remains `d348d58`, logged out. A build/test result is not running gameplay evidence.

## Policy and ownership corrections

- W-C13-R4's two false-ready cases now retreat. Every counted armor piece needs a server-stated stack, non-null maximum and remaining durability, at least one use and the configured minimum fraction. Unknown/non-wearing state earns no points. The weapon already requires current durability. Known adult/current gear and species-specific spider controls still defend. Creepers, ranged threats, groups, neutral/passive/player/owner and unsupported matchups are unchanged avoidance/refusal controls.
- Aiming now happens before the final visibility, target identity, equipment, health/food, terrain and reach checks. The attack call carries no further look await. Health, armor or age changing during aiming sends zero attack packets. Attack reservation remains cumulative and immediately before dispatch.
- Any partial/failed defensive action commits the existing episode to avoidance. A six-health loss cannot restart defense with a fresh local health baseline; exhausted attacks cannot start a new attack allowance. Disengagement keeps the original grant, deadline, displacement and action/attack counters.
- W-C13-R5: initial local assessment considers the prospective finite grant around the bot's current position, independently of an exhausted/missing/withdrawn ordinary route. Once an episode exists, every reassessment uses its ORIGINAL origin and displacement. Retreat pathfinding is constrained to that same finite origin/radius. The ordinary goal's anchor/route never moves. Goal-owned skills and their escape-space checks continue to use ordinary travel bounds.
- Stop revokes the grant and clears the leased controls synchronously. A new manual admission while stopped cleanup is settling retains the old hold, then performs a fresh assessment and issues a distinct grant AFTER settlement. It does not clear the automatic pause latch or revive an old grant. Late old-lease cleanup cannot clear the new holder. `close()` waits up to 5,000 ms for the owned executor settlement and reports timeout as an error.
- Application-owned safety may continue across an ordinary owner replacement while non-none authority, connection and dimension remain compatible. `suspended` is informational; P must discard old goal results and keep the new goal behind the same local hold. Explicit stop/logout/death/disconnect/dimension revocation wins.
- Unknown headroom refuses blind upward control. An observed open-column escape under a ceiling steers without pressing jump until the ceiling clears. Water estimates remain local; missing oxygen is unknown. No general buoyancy worker, pursuit, hidden coordinate scan, gear restoration or model call was added.
- Episode history now covers the permitted 32-episode maximum. Ordinary goal changes and local preemptions preserve the rolling count. Goal outcome, inventory baseline, progress, epochs, turn/task/travel allowances and SpendLedger remain host-owned and are never changed by this service.

## Mechanics evidence and conservative assumptions

Installed integrity-pinned prismarine-physics adds 0.04 velocity per held jump tick against water gravity 0.005. Prior exact-registry offline simulations surface the eyes from five-deep still water in 23 ticks and re-submerge after controls are released. These observations support an ownership/control hypothesis; they do NOT establish the cause of Jake's incident or prove W1s fixed on the server. No vendor edit is proposed.

Mineflayer's oxygen field can be updated from another entity. Safety therefore reads `air_supply` only from server metadata addressed to the login entity id, using the exact registry index. Never-stated oxygen remains unknown. Existing pathfinder deep-water avoidance is instance-local and tested against its diagonal/landing paths; `node_modules` was not patched.

Adult-default investigation read official jar artifacts only, with no server process/world operation. Outer SHA1s match pinned inputs: 26.1.2 `97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51`; 26.2 `823e2250d24b3ddac457a60c92a6a941943fcd6a`. Both `Zombie.defineSynchedData` bodies define `DATA_BABY_ID` with `iconst_0` / `Boolean.valueOf`; `SynchedEntityData.getNonDefaultValues` omits default-valued entries; `ServerEntity` snapshots those values and `addPairing` wraps initial spawn/data in `ClientboundBundlePacket`. The installed protocol buffers/delivers the closing bundle delimiter after all contained packets.

`official-defaults.json` records extracted method bytes and class hashes. Zombie class SHA256: 26.1.2 `280c4204d8685ce679965e17e4724bd774a96a604f551c9ca7aa38c86ed67947`; 26.2 `3c2089904082dd2617b4f640c8f5a68441091043b1d82f982e8c7843778aad7c`. SynchedEntityData is byte-identical across the two jars (`cc868be7d73576d779e3a02edd519734779b0f0b4546ffc4d568696ecf1ee49c`).

The reader reports `baby: false, ageEvidence: vanilla_spawn_default` ONLY for a registry-matched zombie-family spawn in a CLOSED pairing bundle on exactly 26.1.2 or 26.2, with no explicit/malformed baby value. Incomplete/unbundled/missing spawn, identity mismatch and unproved release remain unknown. Explicit metadata overrides the default; destroy/login/respawn/detach invalidate it. Spiders use species support and `not_applicable`, not an invented adult value. Packet tests cover both exact releases. This proves the source/protocol default, not actual combat acceptance.

Defense thresholds remain coordinator assumptions pending both fixture mechanics gates: retreat by default; only one supported isolated adult zombie/husk/zombie villager/drowned without ranged equipment, or a spider, already engaging within at most 3.5-block contact. Minimum health 14, food 7, armor points 6, stone-or-better sword/axe, weapon at least 16 uses and 15% durability, counted armor at least 10%, visible safe escape terrain. Disengage at health <=10 or local loss >=6; no cornered waiver. Defeat requires server entity status 3; leaving view is never defeat.

## Exact shared integration request (P owns these edits)

Stable APIs: `createSafetyRuntime`, `leaseActuation`, `safetySkills`, `SafetyService.{attachConnection,onLifecycle,onAuthorityChanged,start,hold,waitClear,grantCurrent,reserveAttack,status,close}`. `ageEvidence` is an additive optional field; no mandatory new shared contract parameter is required.

1. Export safety contracts, register the same three skill definitions in the ONE catalog, and accept `SafetyExecutionOwner` / `SkillOutcome.owner: safety`. Executor/lease admission must fence the real current grant; schema recognition by itself grants nothing. Safety skips ordinary goal-epoch/travel-anchor checks ONLY under that actual owner. Planner/task owners remain goal owners.
2. Feed `SafetyAuthority` directly from admitted manual goal state, explicit pause/shutdown and fresh connection/lifecycle state. An active manual goal authorizes protection even when memory/autonomy are absent and the automatic latch remains set. With no newer owner goal after stop, basis is `none`. Call stop/admission/terminal/resume hooks synchronously; connect the packet tracker before login and lifecycle hook before lease/ledger invalidation.
3. Use the existing single executor and lease. Before every ordinary/Jev/sustained dispatch and across planner/preparation waits, consult the hold/`waitClear`; `safety_preempt` suspends work instead of spending target retry/no-progress credit. Initial join/respawn assessment and natural visibility/radius/route-leg/window transitions must remain covered.
4. Keep old goal publication fenced and new goal work held through safety cleanup. Preserve immutable outcome, original admission baseline, verified feedback, deadline/counters, route lineage and spend. C12 continuation remains P/S integration work.
5. Apply the deep-water path policy to ordinary navigation; expose bounded safety status with local/server/unknown provenance. Do not register a second actuator loop or planner-only catalog.

W's module test helper now selects the real `SkillExecutorImpl` when the shared outcome schema supports `safety`; otherwise it labels/uses the stand-in. The live harness has the same explicit switch and `--require-real-executor`. On this branch the shared variant is absent, so the stand-in remains selected. The coordinator must rerun the known-zombie defense through P's real owner-aware executor; the earlier combined timeout is not accepted by W's standalone test pass.

## Harness, interrupted evidence and NEW lease request

The prior 26.2 trial at `var/live-check/2026-10-08T02-21-18-609Z-26.2-safety` was INTERRUPTED: W1 escaped once, W1s failed after stop/new admission, and no harness exit/final report existed. The retained `manual-restoration.json` and coordinator reports remain failures/cleanup evidence. Cleanup compared all 13,454 scene blocks, restored Peaceful difficulty and removed scene entities. Six forceload removals used INFERRED provenance after the original set was lost; exact prior-set restoration cannot be proved. This caveat is not repaired retroactively. All old leases are released.

New harness safeguards: lease refusal before output/credential/fixture access; clean frozen source required; original difficulty and EXACT complete forceload set fsynced before join or mutation; every mutation intent fsynced before its packet and every reply recorded. Additions are journaled before writes, including ambiguous interrupted writes. Backup emptiness and full source/backup equality are verified before scene writes. A failed restore comparison preserves the backup. Only originally absent trial-planned chunks can be removed, and the final COMPLETE forceload set must equal the saved original. Unknown command errors never prove an entity removed.

Signals halt admission, joining, waits and queued non-restoration commands. Signal and normal `finally` share one cleanup promise. Each RCON operation has a 2,000-ms absolute connect/auth/response deadline that destroys its socket; world restoration has a 45,000-ms deadline, followed by local executor/connection teardown even if the world deadline expires. Inventory/effects are verified while the owned bot remains online; absence is a failure. Any restoration/journal/setup failure makes the report fail. Interrupted reports explicitly remain non-passes. SIGKILL cannot run `finally`; the durable journal/backup enables coordinator recovery and is never a pass.

Requested frozen coordinator trial command, only after a NEW named exclusive lease:

`node scripts/safety-live-check.ts --fixture-lease <new-granted-id> [--fixture 26.2] --require-real-executor`

- Scene: x240..270, y-61..-48, z190..220. Backup: x240..270, y200..213, z190..220; must be verified empty. Both boxes contain 13,454 blocks and span chunks x15..16, z11..13. Only trial-added chunks are removed; preexisting chunks are retained.
- Entities: unique per-run tagged mobs inside the scene; scene item/xp drops only. Fixture bot inventory/effects/position/health only. No live server/client/world or Microsoft cache is used.
- Settings: read difficulty/forceload; change Peaceful to Easy only when necessary, restore/verify the saved value. No time, gamerule or spawnpoint mutation. Fire resistance on tagged zombies avoids a daylight change. All commands/interventions are journaled; setup teleports/damage/equipment/effects earn no autonomous credit.
- Scenarios: W1, W1s (stop, released-control sinking, then fresh manual escape), W2 ordinary water path/preemption, W3 ceiling blocker; M1 unarmed retreat, M2 verified equipped defense, M2b readiness downgrade, M3 creeper avoidance, M3b passive/neutral refusal, M4 stop during retreat. Restore tagged entities, bot state, difficulty, every scene block, empty backup and exact forceload set; disconnect the owned bot. No scene reset outside those boxes.
- Run both 26.1.2 and exactly 26.2 separately. Foreground only, through direct exit/report/verified restoration. No edit/build during a trial, no background mutation harness and no automatic fixture startup/restart/cleanup. No provider inference in this harness.

## Remaining acceptance blockers

No current world driver lease exists. W cannot verify server water reauthorization, currents/ceilings/exits, actual retreat/attack effects or full restoration without a new lease. P owns the shared runtime entry points and actual planner-wait/transition coverage; W cannot complete that wiring in owned paths. Coordinator acceptance must still prove W1-W5/M1-M5 on the combined immutable build, compatibility/skills/controller/planner/handoff checks on both releases, outside-anchor/missing-route/stop/replacement fencing, and real ordinary Codex/Jev hazards with the original owner outcome and accounting retained. C12 recovery/continuation is a separate shared dependency. Source/mocks/one interrupted escape do not complete those criteria.
