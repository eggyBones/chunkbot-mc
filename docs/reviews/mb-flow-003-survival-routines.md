# MB-FLOW-003 — survival routines and death recovery: worker handoff

Worker: native Claude Code (Opus 5.5) in DSH session `mb-flow-003-ea`, worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/mb-flow-003`, branch `chunkbot/mb-flow-003`, base `f05628f8d92499a7a8ea847992a8960e51d9300f`. Plan: [survival-routines-plan.md](../survival-routines-plan.md). Batch: [feature-batch-002-plan.md](../feature-batch-002-plan.md).

Delivery state: **implemented and verified offline only** (survival-owned modules, contract, skills, tests and the gate harness). It has **not** been integrated into the shared app/task/predicate/memory files, which progression writes. It has **not** been fixture-verified, because no lease is granted, and it is **not** feature-accepted. No model inference, provider call, fixture join, RCON or settings change was performed.

## Commits

| Commit | Content |
| --- | --- |
| `545da3a37cb4449f5b1bf10a670bf7ed1cd564aa` | First survival contract milestone |
| `978f927dba2c6d36696bbcfdae954a0cdf97b7cf` | Contract revised per coordinator C1 (integrated by Codex as a dependency milestone) |
| `5e39cb5368595d0bff52e206d1f536e8b7502865` | Tracker, store, episodes, policy, service, skills, first offline tests |
| `c04b10a7a431fabf92a5023ea76f6e6061b06ff7` | Wiring helpers, lease-guarded gate harness, skill/wiring/guard tests |

Owned paths only:
- `src/contracts/survival.ts`
- `src/survival/{items,tracker,death-cause,store,episodes,allowance,policy,service,registry,wiring}.ts`
- `src/skills/survival.ts`
- `tests/survival-*.ts`
- `scripts/survival-live-check.ts`
- this review

No existing file was edited.

## Checks (direct exit codes, Node 24.21.0)

- `npm run typecheck`: 0
- `npm run build`: 0
- `npm test`: 0, 589/589 passing. That includes 106 survival tests across 12 files: contract, tracker, recovery, upkeep, allowance (C2), pickup (C3), interrupted intent (C4), durability (C5), store, skills, wiring and harness guard.
- The harness guard spawns `scripts/survival-live-check.ts` with a missing or invalid lease. Each run exits 2 before any password read, RCON command, join or output directory.
- Not run (they need a lease or provider): the fixture gates, live-check, skills-live-check, planner and Jev checks, doctor.

## Mechanism summary

- **Packet tracker (R1, R-G1 seam).** It keeps the bot's own server-stated inventory, including slot component patches (damage, max damage, enchantments, custom name), plus vitals.
  - The last-alive copy is frozen at the own `death_combat_event`, else at the first zero-health `update_health`, else at the app's death event. The record says which signal froze it and how many inventory packets followed.
  - The death site is refined from the respawn packet's own `death` GlobalPos (dimension and block). The client estimate's offset is kept.
  - "Fresh respawn" requires the respawn packet, then a full window-0 sync, then health above zero.
  - Codec evidence: the pinned 26.1 and 26.2 protocol definitions both contain `respawn.worldState.death: option GlobalPos`, `death_combat_event {playerId, message}` and Slot component patches. The vanilla packet order (combat kill, then clearing slot updates, then health 0) is a **hypothesis** that the G1 gate must confirm.
- **Exact incident linkage.** `deathContext()` returns the memory `DeathContext` of the same capture plus its `captureId`. Only `linkIncident(captureId, factId)` links it; unknown ids are refused. An unlinked capture blocks recovery with `incident_not_linked`. Nothing is matched by time.
- **Durable episodes (R4, R10).** An atomic, checksummed, scoped store sits under `<dataDir>/survival/<world>/r<rev>/<bot>`. Without an operator scope it is `unscoped` and recovery is blocked with `durable_scope_unavailable`; eating and resting are unaffected.
  - Original-incident rule: a later death during an open episode is a related incident, with a hazard record and the running attempt ending as `death`. It never replaces the original site. Related losses within `sameHazardRadius` join the same search.
  - Attempts, budgets and hazards survive death, restart and new admissions. On restart a running attempt is closed as `restart_interrupted` and counts.
- **Loss assessment (R1, R3).** Last-alive minus the fresh respawn inventory gives missing and retained items. A retained inventory gives `no_loss` (no trip).
  - Lava and void causes mark items `likely_destroyed` and the episode `blocked`. They are never `known_destroyed`, which is reserved for real evidence this release does not have.
  - A missing last-alive record is blocked as `loss_manifest_unknown`. Partial manifests are labeled.
  - C1 truthfulness: items kept through respawn reach memory as `retained` (P `c704ad4` API; memory derives `no_loss`), never as `regained`. Only server-confirmed recovery pickups are `regained`. Partial retention sends both separately, at different times.
- **Recovery policy (R2–R5).** It proposes a planner goal, with code-written bounded context of at most 2,000 characters, and serves `owner_intent` when an owner goal was interrupted. Limits:
  - at most two counted attempts per incident; owner stop, replacement, shutdown and provider-not-ready don't count
  - a second attempt only with material improvement (armor +2 or more, fire protection for fire or lava, a different route policy, or a different start after a non-fatal end)
  - a repeated same hazard near the site blocks early
  - episode ceilings: 12 planner turns, 24 tasks, 4 replans, 30 minutes
  - cross-dimension, unknown sites and sites beyond the travel bound are blocked; far sites need code-owned routing, and the bound is not relaxed
- **Skills.**
  - `go_to_death_site`: only for the bound recovery goal epoch, connection and dimension, inside the travel bounds, and refused if lava is visible at the site.
  - `recover_lost_items` (corrected for MB-FLOW-003-C3): candidates come only from SERVER-stated drop stacks — the tracker reads each item entity's own `spawn_entity`/`entity_metadata` packets, including the component identity digest, and never parses display labels.
    - Refused BEFORE any movement: a pile larger than the still-missing count (oversized or merged), unknown server stack facts, any other item entity within pickup range (2.5 blocks) that is not itself acceptable (visible or not), a valuable item whose server identity differs (`metadata_mismatch`) or cannot be proven (`valuable_identity_unproven`), and anything outside the task's named-target scope (no fallback).
    - Revalidated on every movement poll: newly in-range loot must be acceptable and the target pile must not change, otherwise it stops.
    - Counting is per collect packet: only planned entities count, with their frozen identity, capped at the missing count. Unplanned collections are reported as `partial` / `unscoped_item_collected` and never counted.
    - Valuable manifest items keep their per-stack server identity digests. Unknown pre-death metadata leaves them unproven: never collected, never claimed recovered.
  - `eat_safe_food`: never risky or precious food, never at full hunger. It delegates to `use_held_item`.
  - `rest_in_place`: succeeds only on a server-stated health gain. Taking damage, a visible threat or no regeneration end it honestly.
  - `equip_suitable_tool`: picks the cheapest capable tool that isn't nearly worn, according to server durability.
- **`survival_state` predicate.** For recovery, `recovered` is satisfied only when nothing is sought (`recovered` or `no_loss`). `concluded` is satisfied when the episode ended or the bounded visible search at the site found nothing. Its detail and evidence say "NOT a full recovery" and carry `recoveryStatus`. `eat`, `rest`, `tool_upkeep`, `inventory_room` and `resupply` use `satisfied` from fresh server facts. All of them are fenced to the bound support goal.
- **Low-health allowance (R6, R-G3, C2).**
  - At most one grant per admitted support epoch. It is bound to goal id and epoch, connection, dimension and the first task id, with exact capabilities and items, a fixed expiry (90 s) and a maximum of 4 actions. There is no renewal.
  - `reserve` must precede every dispatch (Jev or sustained local continuation) and counts before execution; the last allowed action leaves zero and a further window is refused.
  - `check` gates the low-health round and `recheck` runs after the Jev choice. Both refuse on a visible hostile within 8 blocks, full food (eat), food below 18 (rest), an item no longer owned, a stale snapshot, or another dimension or connection.
- **Necessary low-health eat/rest (C6).** A routine cooldown from an earlier completed eat or rest never suppresses a necessary low-health eat or rest.
- **Valuable/custom preservation (C3).** A food or tool key with any custom-named or enchanted stack is never auto-eaten or auto-selected, because use-by-key cannot choose which stack. Ordinary tools are preferred over valuable ones, and safe-food reserves exclude custom stacks.
- **Upkeep (R7).**
  - Tool replacement: proposed only when every owned tool of a kind is nearly worn by server metadata; unknown metadata is never treated as worn.
  - Owned unworn armor: a code task through `equip_item`.
  - Inventory room: owner-designated storage only (memory `container` facts with source `owner_statement`), and nothing is ever dropped. Tools, armor, food, reserves and valuables are never deposited.
  - Resupply: a low/high reserve (default safe food 2/6) with a 15-minute cooldown.
  - Global caps: 12 automatic admissions per hour. An unchanged blocked signature is never re-proposed.
- **Durable recovery authority (C5).** Recovery travel and pickup are authorized (`recoveryTarget`, the own-death route destination, `go_to_death_site`/`recover_lost_items` candidates) only when ALL of these hold:
  - the admitted attempt and everything before it (the incident, its exact link, budgets) are in a COMPLETE durable survival revision, i.e. the successful write's version is at least the attempt's commit version;
  - no survival write has failed since;
  - the exact memory death fact is durable through the memory seam.
  A pending survival or memory write is a bounded wait: `durable_write_pending` / `incident_write_pending`, no destination, and the support slot is held so lower routines don't jump in. A failed write blocks with `attempt_write_failed` / `durable_write_failed` / `incident_write_failed` until a later write succeeds; `assess` retries at most every 30 s, never on the lifecycle path. Capture and lifecycle never wait for disk. After a failed attempt write the in-process counter is kept; after a restart the never-durable attempt is absent from disk, but nothing travelled or collected under it, so restart-safe limits hold. A durable attempt survives restart and counts.
- **Interrupted owner intent (C4).** `SurvivalAssessmentInput` splits the old ambiguous flag:
  - `ownerIntakePending`: LIVE intake only, i.e. a preparing or handing-off instruction, or an owner question awaiting an answer. Survival yields to it.
  - `ownerIntentInterrupted`: a retained interrupted directive. Survival then proposes only necessary support (`eat`, `rest`, `death_recovery`) serving `owner_intent`; other upkeep and unrelated progression wait.
  - Survival also ORs in its own durable record, so a restart, or a supervisor that lost its in-process state, still sees the directive. `interruptedOwnerIntent()` lists durable unresolved directives so the supervisor can keep progression blocked.
  - Only `onOwnerInstruction` (a new explicit instruction) or `dismissInterrupted` clears it, and both persist. Pause and resume don't clear it, and nothing is replayed or resubmitted with a new baseline.
- **Priority and continuation (R5, R9).**
  - Lifecycle, then `revoke_unsafe` (low health, once per goal epoch, keeping owner intent), then owner work or a pending owner instruction, then support, then progression.
  - Pause blocks every proposal.
  - Interrupted owner goals (death, low health, dimension change, disconnect, kick) become `requires_owner_decision`, `awaiting_owner`, and are never resubmitted. A new owner instruction supersedes them; bare `resume` doesn't dismiss them.
- **Gated slices (honest labels in status):** `home_rest` (R8 bed/spawn, `mechanics_gate_pending`) and the later slices: lighting, replanting, emergency escape, combat defense.

## Acceptance status (R criteria)

| ID | Status |
| --- | --- |
| R1 | Implemented and tested offline (tracker, linkage, manifest, retained and unknown cases). Live packet order and metadata provenance still need the G1 gate. |
| R2 | Mechanism implemented (skills, fencing, regain accounting, predicate). Live pickup needs the G2 gate. Real planner/Jev recovery is Codex acceptance after integration. |
| R3 | Offline (C3): oversized piles refused, named-target fencing, unrelated nearby loot refused, valuable identity match/mismatch/unproven, never counted twice; lava and void never `known_destroyed`; no despawn or XP promise. Live: G2 (mixed piles refused before collection) and G2b (ordinary server-confirmed recovery including the enchanted sword) need the lease. A full inventory is reported by the collect path, not separately live-tested. |
| R4 | Offline: far, cross-dimension and repeated-hazard cases block; the original incident is kept; limits survive restart. Far routing is blocked until locator routing is integrated. |
| R5 | Offline: pause, owner priority, stale admission and terminal callbacks, lifecycle clearing of pending proposals and allowances. Still needed: real stop races through the integrated supervisor. |
| R6 | Offline: thresholds, safe-food selection, all allowance bindings, regeneration requirements. Live server food and health rise needs the G3 gate with authorized settings. |
| R7 | Offline: worn-tool proposal, armor code task, designated storage only, resupply cooldown. Planner-selected replacement execution comes after integration. |
| R8 | **Not delivered:** gated. The G4/G4n mechanics observations are in the harness; no bed/spawn routine or skill until that gate passes and the routine is approved. |
| R9 | Delivered as explicit interrupted state (no continuation, per C1). Integrated behavior pending. |
| R10 | Offline: fake clocks, repeated deaths, unchanged blockers, admission cap, episode ceilings. A combined real fixture trial is Codex acceptance after integration. |

## Shared integration requested (designated progression writer; C1-approved shapes)

1. **Composition.** Build the service with `createSurvivalService({survival: config.survival, scope: <enabled memory scope>, dataDir, minecraftVersion, limits: {lowHealth, travelRadius}, now, record, memory, latestSnapshot})` and add `survival: SurvivalConfigSchema.optional()` to `ChunkbotConfig`. Normal runs: enabled with explicit scope. Explicit disable, diagnostics and inference-free profiles stay off.
2. **Packet tap.** A synchronous `onBotCreated(bot, epoch)` hook calling `survival.attachConnection(bot._client, {connectionEpoch, selfPosition, containerLayout?})` before login. Fallback seed: `librarySeed(bot)`.
3. **Lifecycle order.** Engine revocation, then `survival.onLifecycle(e)`, then memory captures with `survival.deathContext()` and returns the captured `MemoryFact` (approved), then `survival.linkIncident(ctx.captureId, fact.id)`, then ledger, perception and interface invalidation. `memory.close()` and `survival.close()` run after owned cleanup.
4. **TaskRuntime (MB-FLOW-003-C2, progression owns the fix).** Add `lowHealthAllowance?: LowHealthAllowancePort`. At the guard, `check`, then `allowedUnderAllowance(candidates, check)`. Immediately before EVERY dispatch under an allowance — the Jev-chosen action after its fresh revalidation AND every sustained local continuation — call `reserve(allowanceId, task, candidate, freshSnapshot)`; a refusal dispatches nothing. `reserve` counts before execution, so an abort or exception still consumed the action, and the same action id is never counted twice. `consumed(...)` after the outcome is an idempotent note; an unreserved dispatch is still counted conservatively.
5. **Predicate.** Add `SurvivalStatePredicateSchema` to the atomic union, evaluated through `survival.evaluateSurvivalState(p, owner)`, and expose it in the planner wire schema.
6. **Supervisor (C4: progression owns the shared flags and persistence).** Pass `ownerIntakePending` only for a live preparing or handing-off instruction or an unanswered owner question, and `ownerIntentInterrupted` for a retained interrupted directive. Block unrelated progression while either `ownerIntentInterrupted` or `survival.interruptedOwnerIntent().length > 0`, including after restart. Bare `resume` must not clear it; a new explicit owner instruction calls `onOwnerInstruction`.
7. **Supervisor (ports).**
   - `assess` gets `ownerIntentInterrupted` from `survival.hasInterruptedOwnerIntent()` or the supervisor's own owner-intent state.
   - Proposals become `supportGoalSource(p, n)`: `planner_goal` uses its instruction, with `context` in the autonomy planner context; `code_task` goes through `supportTaskSpec(p)` and the same-admission support-task seam.
   - Report back with `onSupportAdmitted` (attaching the returned grant to that task), `onSupportTerminal(counters)`, `onOwnerGoalEnd`, `onOwnerInstruction`, `dismissInterrupted` and `abandonRecovery`.
   - Handle `revoke_unsafe` by revoking the running goal with owner intent retained.
8. **Skills.** Register `survivalSkills(service)`, which is empty when disabled.
9. **Status and dashboard.** Use `survival.statusLines(now)` and `survival.status(now)`, at most 4,000 characters, read-only.
10. **Routing.** Pass `farRoute` and the own-death provider to locator's RoutePort when the corrected routing is integrated. `SurvivalService` implements the canonical `RouteDestinationProvider` (locator `b323883`, cherry-picked unchanged): `current(ctx)` returns `provenance: 'own_incident'` only for the bound recovery goal epoch, connection and dimension, with an exact capture → memory fact → episode link, and only while the whole incident identity frozen at admission (episode, fact, dimension, coordinates, source) is unchanged. The `destinationId` encodes that whole identity; a changed coordinate gives no destination (`destination_changed`). Far recovery stays blocked until then.
11. **Memory retained/no_loss (C1, delivered by P `c704ad4`).** `SurvivalMemoryPort.updateDeathRecovery` accepts `retained`. The G1k memory assertion (retained count, nothing regained, status `no_loss`) needs this integrated memory; against the older branch memory it fails honestly.
12. **Memory durability seam (C5, required for recovery; the progression/memory writer owns it).** Add `MemoryService.factDurability(factId: string): 'durable' | 'pending' | 'failed' | 'unknown'`, passed through `SurvivalMemoryPort.factDurability`:
    - `durable`: the last complete durable revision contains the fact at its current fact revision (the existing private `durable` map holds a value at least `fact.revision`);
    - `pending`: the fact exists in the book but isn't durable yet;
    - `failed`: its write failed or was rolled back;
    - `unknown`: no such fact in this scope.
    Without the seam, recovery is blocked as `incident_durability_unknown`. The synchronous `onLifecycle` fact return stays the exact CAPTURE association; durability is a separate, later check made before planning or action, never on the revocation path. The gate harness uses a labeled stand-in that reads memory's last complete on-disk revision (`inspectMemory`).
13. **(superseded by item 11)** `updateDeathRecovery({retained})` so a respawn-retained inventory isn't recorded as "regained". The current use is labeled in the detail text.

## Lease request (R-G1/R-G2/R-G3 gate; corrected for MB-FLOW-003-C6)

- **Frozen source:** the HEAD reported in the handoff message, clean tree. The harness records `git rev-parse HEAD` and the dirty count, and imports `src` directly, as the memory harness does. No `dist` is needed, and the build won't be cleaned during the run. This is a module gate, not integrated-application acceptance.
- **Commands:**
  - 26.1.2: `node scripts/survival-live-check.ts --fixture-lease <id> [--with-settings]`
  - 26.2: the same command with `--fixture 26.2`
- **Owned write footprint** (every block and entity write stays inside it; static guard test enforced):
  - scene x 196..224, y −61..−50, z 190..224: block fills and item/experience-orb entity removal only within `x=196,y=-61,z=190,dx=28,dy=11,dz=34`;
  - backup x 196..224, y 200..211, z 190..224: holds the pre-trial scene copy. It must be verified empty first (a non-destructive masked self-clone count); otherwise the trial refuses before changing anything.
  - forceload: each scene chunk is queried, and only chunks this trial added are removed;
  - foreign test piles use a unique per-run tag `cbsurv_<time>_<pid>`, always further scoped to the owned volume.
- **Bot state changes (fixture bot only):** `clear`, `effect clear`, `tp` inside the scene (no `spawnpoint` command), `give` (a damaged iron pickaxe, bread, cobblestone, an enchanted diamond sword), `kill Chunkbot`, `damage Chunkbot`, hunger effects. G4 and G4n may set the bot's respawn point to the trial bed; the before and after values are recorded. That bed is removed by the scene restore.
- **Settings, only with `--with-settings`:** difficulty → easy, `keepInventory` → true for G1k only, `naturalRegeneration` → true then false (each verified by query before the assertion that depends on it), and time of day → 1000 (day, G4) and 13000 (night, G4n).
- **Restoration (all verified, ANY failure fails the report through a `RESTORE` result):**
  - original difficulty, `keepInventory`, `naturalRegeneration` and daytime (±100 ticks) restored and re-queried;
  - tagged piles removed and verified gone;
  - scene item/xp entities removed;
  - scene cloned back from the backup and verified with `execute if blocks … all`;
  - backup volume cleared and verified empty;
  - trial-added forceload removed and verified;
  - bot inventory and effects cleared, bot moved to just above the scene.
- **Gates and assertions:**
  - G1, G2, G2b: no settings needed. G1 additionally requires the server-stated own death location.
  - G3: eating is completed only when `survival_state eat` is satisfied (food ≥ `eatUntil`). A necessary low-health eat runs right after it, which proves the cooldown fix. With regeneration verified on, rest must give a server health gain of at least 1. With regeneration verified off, rest must end `no_regeneration` inside its bounded window with no gain.
  - G4 and G4n are R8 OBSERVATIONS only, with day or night set at trial start. They record the server respawn data, `sleeping_pos`, bed occupancy and daytime after sleeping. R8 stays gated; no sleep/spawn support is claimed.
- **Join:** the offline `Chunkbot` from the inference-free example configs. No model calls.
- **Report:** `var/live-check/<stamp>[-26.2]-survival/report.json`, including footprint, restoration checks, every RCON command and reply, packet order and survival events.

## Known gaps and honest limits

- Every gate result is pending until a lease is granted. Packet ordering, component metadata provenance and the server death location are unconfirmed on real servers.
- The shared integration listed above is not done. Until it is, the routines are not active in `run`.
- Real planner/Jev recovery and upkeep trials are Codex acceptance after integration.
- Not delivered: R8 bed/spawn, lighting, replanting, emergency escape and combat (gated).
- Not separately live-tested: full-inventory pickup refusal (relies on the existing `pickup_item` reporting), and far own-death recovery (blocked until locator routing is integrated).
- Cause classification uses vanilla translation keys only. Damage-type packets are not used.
