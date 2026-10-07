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
- `npm test`: 0, 553/553 passing. That includes 70 survival tests across 8 files: contract, tracker, recovery, upkeep, store, skills, wiring and harness guard.
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
- **Recovery policy (R2–R5).** It proposes a planner goal, with code-written bounded context of at most 2,000 characters, and serves `owner_intent` when an owner goal was interrupted. Limits:
  - at most two counted attempts per incident; owner stop, replacement, shutdown and provider-not-ready don't count
  - a second attempt only with material improvement (armor +2 or more, fire protection for fire or lava, a different route policy, or a different start after a non-fatal end)
  - a repeated same hazard near the site blocks early
  - episode ceilings: 12 planner turns, 24 tasks, 4 replans, 30 minutes
  - cross-dimension, unknown sites and sites beyond the travel bound are blocked; far sites need code-owned routing, and the bound is not relaxed
- **Skills.**
  - `go_to_death_site`: only for the bound recovery goal epoch, connection and dimension, inside the travel bounds, and refused if lava is visible at the site.
  - `recover_lost_items`: only still-sought keys, within 8 blocks of the site. Counted from the server collect packet, capped at the missing count, labeled as prior possessions.
  - `eat_safe_food`: never risky or precious food, never at full hunger. It delegates to `use_held_item`.
  - `rest_in_place`: succeeds only on a server-stated health gain. Taking damage, a visible threat or no regeneration end it honestly.
  - `equip_suitable_tool`: picks the cheapest capable tool that isn't nearly worn, according to server durability.
- **`survival_state` predicate.** For recovery, `recovered` is satisfied only when nothing is sought (`recovered` or `no_loss`). `concluded` is satisfied when the episode ended or the bounded visible search at the site found nothing. Its detail and evidence say "NOT a full recovery" and carry `recoveryStatus`. `eat`, `rest`, `tool_upkeep`, `inventory_room` and `resupply` use `satisfied` from fresh server facts. All of them are fenced to the bound support goal.
- **Low-health allowance (R6, R-G3).**
  - At most one grant per admitted support epoch. It is bound to goal id and epoch, connection, dimension and the first task id, with exact capabilities and items, a fixed expiry (90 s) and a maximum of 4 actions. There is no renewal.
  - `check` gates the low-health round and `recheck` runs after the Jev choice. Both refuse on a visible hostile within 8 blocks, full food (eat), food below 18 (rest), an item no longer owned, a stale snapshot, or another dimension or connection.
- **Upkeep (R7).**
  - Tool replacement: proposed only when every owned tool of a kind is nearly worn by server metadata; unknown metadata is never treated as worn.
  - Owned unworn armor: a code task through `equip_item`.
  - Inventory room: owner-designated storage only (memory `container` facts with source `owner_statement`), and nothing is ever dropped. Tools, armor, food, reserves and valuables are never deposited.
  - Resupply: a low/high reserve (default safe food 2/6) with a 15-minute cooldown.
  - Global caps: 12 automatic admissions per hour. An unchanged blocked signature is never re-proposed.
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
| R3 | Offline: mixed and extra drops are not counted, lava and void are not `known_destroyed`, and there is no despawn or XP promise. Live G2 shows only scoped pickup. Full-inventory pickup refusal relies on the existing `pickup_item` reporting and is not separately live-tested. |
| R4 | Offline: far, cross-dimension and repeated-hazard cases block; the original incident is kept; limits survive restart. Far routing is blocked until locator routing is integrated. |
| R5 | Offline: pause, owner priority, stale admission and terminal callbacks, lifecycle clearing of pending proposals and allowances. Still needed: real stop races through the integrated supervisor. |
| R6 | Offline: thresholds, safe-food selection, all allowance bindings, regeneration requirements. Live server food and health rise needs the G3 gate with authorized settings. |
| R7 | Offline: worn-tool proposal, armor code task, designated storage only, resupply cooldown. Planner-selected replacement execution comes after integration. |
| R8 | **Not delivered:** gated. No bed/spawn skill until the mechanics gate is authorized and passes. |
| R9 | Delivered as explicit interrupted state (no continuation, per C1). Integrated behavior pending. |
| R10 | Offline: fake clocks, repeated deaths, unchanged blockers, admission cap, episode ceilings. A combined real fixture trial is Codex acceptance after integration. |

## Shared integration requested (designated progression writer; C1-approved shapes)

1. **Composition.** Build the service with `createSurvivalService({survival: config.survival, scope: <enabled memory scope>, dataDir, minecraftVersion, limits: {lowHealth, travelRadius}, now, record, memory, latestSnapshot})` and add `survival: SurvivalConfigSchema.optional()` to `ChunkbotConfig`. Normal runs: enabled with explicit scope. Explicit disable, diagnostics and inference-free profiles stay off.
2. **Packet tap.** A synchronous `onBotCreated(bot, epoch)` hook calling `survival.attachConnection(bot._client, {connectionEpoch, selfPosition, containerLayout?})` before login. Fallback seed: `librarySeed(bot)`.
3. **Lifecycle order.** Engine revocation, then `survival.onLifecycle(e)`, then memory captures with `survival.deathContext()` and returns the captured `MemoryFact` (approved), then `survival.linkIncident(ctx.captureId, fact.id)`, then ledger, perception and interface invalidation. `memory.close()` and `survival.close()` run after owned cleanup.
4. **TaskRuntime.** Add `lowHealthAllowance?: LowHealthAllowancePort`. At the guard, `check`, then `allowedUnderAllowance(candidates, check)`. After the Jev choice and fresh revalidation, `recheck(allowanceId, task, chosen, freshSnapshot)` before execute, then `consumed(...)`.
5. **Predicate.** Add `SurvivalStatePredicateSchema` to the atomic union, evaluated through `survival.evaluateSurvivalState(p, owner)`, and expose it in the planner wire schema.
6. **Supervisor.**
   - `assess` gets `ownerIntentInterrupted` from `survival.hasInterruptedOwnerIntent()` or the supervisor's own owner-intent state.
   - Proposals become `supportGoalSource(p, n)`: `planner_goal` uses its instruction, with `context` in the autonomy planner context; `code_task` goes through `supportTaskSpec(p)` and the same-admission support-task seam.
   - Report back with `onSupportAdmitted` (attaching the returned grant to that task), `onSupportTerminal(counters)`, `onOwnerGoalEnd`, `onOwnerInstruction`, `dismissInterrupted` and `abandonRecovery`.
   - Handle `revoke_unsafe` by revoking the running goal with owner intent retained.
7. **Skills.** Register `survivalSkills(service)`, which is empty when disabled.
8. **Status and dashboard.** Use `survival.statusLines(now)` and `survival.status(now)`, at most 4,000 characters, read-only.
9. **Routing.** Pass `farRoute` and the own-death provider (`survival` implements `current(ctx)` with the canonical `RouteDestinationProvider` shape) to locator's RoutePort when it is integrated.
10. **Optional memory extension.** `updateDeathRecovery({retained})` so a respawn-retained inventory isn't recorded as "regained". The current use is labeled in the detail text.

## Lease request (R-G1/R-G2/R-G3 gate)

- **Frozen source:** commit `c04b10a7a431fabf92a5023ea76f6e6061b06ff7`, clean tree. The harness records `git rev-parse HEAD` and the dirty count, and imports `src` directly, as the memory harness does. No `dist` is needed, and the build won't be cleaned during the run.
- **Commands:**
  - 26.1.2: `node scripts/survival-live-check.ts --fixture-lease <id> [--with-settings]`
  - 26.2: the same command with `--fixture 26.2`
- **Scene footprint:** forceload and reset of x 196..224, z 190..224, y −61..−50 (the existing skills scene area).
- **Bot state changes:** `spawnpoint Chunkbot 205 -60 205`, `clear`, `effect clear`, tp, give (damaged iron pickaxe, bread, cobblestone), `kill Chunkbot`, summoned item entities (dirt, bread) inside the area, `damage Chunkbot`, hunger and saturation effects.
- **Settings, only with `--with-settings`:** difficulty Peaceful → Easy (needed for real hunger and regeneration on the peaceful fixture), `gamerule keepInventory true`, `gamerule naturalRegeneration false`. All three are read first and restored in `finally`, and every command and reply is recorded in the report.
- **Join:** the offline `Chunkbot` from the inference-free example configs. No model calls.
- **Report:** `var/live-check/<stamp>[-26.2]-survival/report.json`.

## Known gaps and honest limits

- Every gate result is pending until a lease is granted. Packet ordering, component metadata provenance and the server death location are unconfirmed on real servers.
- The shared integration listed above is not done. Until it is, the routines are not active in `run`.
- Real planner/Jev recovery and upkeep trials are Codex acceptance after integration.
- Not delivered: R8 bed/spawn, lighting, replanting, emergency escape and combat (gated).
- Not separately live-tested: full-inventory pickup refusal (relies on the existing `pickup_item` reporting), and far own-death recovery (blocked until locator routing is integrated).
- Cause classification uses vanilla translation keys only. Damage-type packets are not used.
