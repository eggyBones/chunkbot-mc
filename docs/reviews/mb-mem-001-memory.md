# MB-MEM-001 persistent gameplay memory: worker evidence (draft)

**Status: memory modules, memory skills and unit/fault/integration tests are implemented and verified locally by the worker; the PRE-INTEGRATION live harness passed 13/13 on the leased 26.2 fixture. Shared integration (designated writer), the CLI-driven live check, the 26.1.2 run and the real-provider M6 run are NOT done.** Worker: native Claude Code session `mb-mem-001` (Opus 5.5), branch `chunkbot/mb-mem-001`, worktree `/Users/jakewilcox/code/worktrees/chunkbot-mc/mb-mem-001`. Date: 2026-10-06 UTC.

This document is worker evidence. It does not change the roadmap, plans, status or acceptance records; the coordinator owns those. Nothing here is whole-feature acceptance.

## Commits

| Commit | Content |
| --- | --- |
| `521cf10` | Memory contract, atomic store, fact book, refs, retrieval, service, memory skills, store fault tests |
| `c56e3d4` | Subject-aware view (goal / preparation), goal-fenced unique refs, prepared refs, behavior tests |
| `54923dc` | Merge of the reviewed MB-FLOW-002 contract `49a8e22` (coordinator-authorized) |
| `16684a5` | `MemorySubject = PlanningSubject`, ref identity/revision checks, write-sequence `memory_state` baseline (MB-MEM-001-C1) |
| `7962081` | MB-MEM-001-C2: `forgotten`/`recorded` only from durable state; failed writes rolled back |
| `8e8dc09` | Lease-guarded pre-integration live harness `scripts/memory-live-check.ts` (not run) |
| `bc785f3` | This evidence draft and the M6 proposal |
| `60b630d` | MB-BATCH001-I1 prevention: import-safe entry guard, stricter lease id, `tests/memory-harness-guard.test.ts` |
| `951975f` | Harness ends unverified steps without `outcome_verified` (no fake milestones); truthful status after writes/close |

Base: `d5eb2fa`. Owned paths only: `src/contracts/memory.ts`, `src/memory/**`, `src/skills/memory.ts`, `tests/memory-*.ts`, `scripts/memory-live-check.ts`, this file. No shared path was edited.

## Checks (actual exit codes)

Node `/opt/homebrew/Cellar/node@24/24.21.0/bin`, from the worktree root:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npm run build` | 0 | |
| `npm test` | 0 | 344/344 on `951975f` (297 inherited baseline + 47 memory tests) |
| `tests/memory-harness-guard.test.ts` (in `npm test`) | 0 | harness import-safe; refuses without a valid lease (no fixture contact) |

Logs: `var/batch001/live2-{typecheck,build,test}.log` (344/344 on `951975f`), earlier `c5-*` (ignored, worktree-owned). No doctor run: no config/diagnostic file changed. No model or provider call by the worker. Live runs only under lease `batch001-mem-26-2-0815` (below); the earlier unleased contact is MB-BATCH001-I1.

## Design decisions

### Gate M-G1: storage

Atomic JSON revisions under ignored `<dataDir>/memory/<worldProfile>/r<worldRevision>/<botProfile>/memory-<rev>.json`. No SQLite, vector service or new dependency.
- Write: temp file (`O_EXCL`) → fsync → rename → directory fsync; sha256 checksum of the body in every revision; the newest 4 complete revisions are kept.
- Load: the newest revision whose format, schema version, scope and checksum verify. Unreadable newer revisions are reported (`recovered`, `corruptRevisions`); the next write never reuses their numbers.
- Never empty over data: if revisions exist but none is readable, or a newer schema / unmigratable older schema is present, the store is `read_only` and refuses writes.
- Migration: an ordered `MEMORY_MIGRATIONS` chain upgrades older documents in memory (`migrated`), keeping the original file. v1 is the first schema, so the chain is empty; it is exercised with an injected v0 document.
- One writer per scope (lock file with pid liveness; a dead holder is taken over; a live one gives read-only).
- Bounds: 512 facts, 1 MB body, 4 evidence entries per fact, per-category caps; retention never evicts the active home, active/interrupted projects or unresolved deaths. A fact failing the durable schema is quarantined (dropped with evidence), never allowed to block later writes.

### Gate M-G2: world identity

Scope is the explicit operator-configured `worldProfile` + `worldRevision` + `botProfile`; dimension is per fact. The endpoint is connection metadata only: the first ready connection binds `host:port`; a different endpoint later gives `scope_conflict` (no retrieval, no writes) until the operator sets a new profile/revision or `rebindEndpoint`. A same-endpoint reset cannot be detected reliably from the client, so the plan's default applies: a new world needs a new revision. No guess from the host.

### Provenance and trust

Sources: `observation` (line-of-sight perception only), `verified_skill` (server-confirmed ledger effects or a code-verified goal outcome), `owner_statement`, `unverified_note`.
- An owner designation is trusted only when every content word of its label is in the owner's own words (instruction or clarification answers); the location must be code-grounded (bot position, visible owner, visible block handle, shown anchor, or owner-typed coordinates). Otherwise it is stored as an unverified note with no typed location, and the skill reports `partial` / `not_owner_grounded`.
- Forgetting is refused unless the owner named the fact.
- Notes are listed separately, only when relevant, and never get refs.
- Memory writes are LOCAL confirmations: outcomes report `confirmation: none` with `evidence.memory.confirmation = local_memory_store` and the store revision, never a server packet.

### References

- Executable `mref-` refs only for an admitted goal, one planner request, one connection and dimension, one trusted located fact. Ids are a per-run random nonce + monotonic counter (no wrap, no reuse, no cross-run collision).
- Resolution requires `MemoryRefFence {goalEpoch, goalId|null, connectionEpoch, dimension}` and re-checks fact status, category, key and exact location; returns the issuance record (goal, epoch, request) and fact revisions. Unknown, expired (older than the goal's last 4 requests), released, lifecycle-voided, cross-owner, moved, changed, superseded or forgotten refs fail closed.
- Preparation subjects (MB-FLOW-002) get the same bounded facts with non-executable `mprep-` refs; after the real admission `regroundPrepared` issues a fresh `mref-` only for the SAME still-active fact (same generation, connection, dimension, location). Preparations record nothing and get no goal.
- Death incidents, milestones and notes never get refs.

### `memory_state` predicate

`recorded` / `noted` are satisfied only by an owner/skill write made after the binding's captured write-sequence baseline (`memoryBaseline()`, not a timestamp) and only once durable. `forgotten` is satisfied only when the label is absent in memory and in the last complete durable revision; a pending or failed write is `unknown`. A failed write is rolled back in memory. Disabled, conflicted, read-only or unreadable memory is always `unknown`.

### Recording rules

- Observation: visible workstations/containers, ore/log/stem sightings aggregated per 16-block cell, visible lava as hazard. Hidden blocks are never recorded (real perception test).
- Contradiction: a remembered workstation/container/resource whose voxel is directly observable now (inside the radius, loaded, server-stated, visible face or clear sight line to an empty voxel) and holds something else becomes `invalid`. Not-visible is never evidence; a client-only prediction never revises memory.
- Verified: ledger `block_changed` / `container` entries of an action (mined resources, placed workstations, historical container contents), construction checkpoints for `place_block`, and unknown effects of a cancelled action (`partialEffects.additional = unknown`). Client-only arrival records nothing durable.
- Goal end: `outcome_verified` → bounded milestone and completed project; any other end → interrupted project (confirmed checkpoints kept, nothing replayed).
- Death (MB-FLOW-003 seam): captured synchronously from the live position and the best inventory evidence (server-sync, else client model, labeled with age) BEFORE ledger/perception invalidation; persisted asynchronously. A later death is `relatedTo` the original unresolved incident and never overwrites it. `updateDeathRecovery` takes verified regains only. No recovery, reconnect, unpause or replay policy.

## Milestone evidence (unit / fault / integration tests)

| ID | Covered by | Notes |
| --- | --- | --- |
| M1 | `memory-service`: restart persistence and scope; endpoint conflict; disabled memory | Live 26.2: S1, R0, R2, R5 (real process restart). |
| M2 | `memory-service` provenance tests; `memory-skills` invented label, owner-typed coordinates, diagnostics | Live 26.2: S2. |
| M3 | `memory-service` emptied chest / destroyed workstation; `memory-world` real perception: hidden ore never recorded, prediction never revises | Live 26.2: R3, R4. |
| M4 | `memory-store` (10 fault tests); `memory-service` corrupt-newest status, retrieval bounds (20 facts, 8,000 chars), C2 durability tests | |
| M5 | `memory-service` interrupted construction (checkpoints vs unknown effects, restart replays nothing) | Live 26.2: S5, R1 (no unknown effects occurred live; that path is unit-tested). |
| M6 | Not run (real planner + real Jev, coordinator) | Exact proposal below. |
| M7 | Memory-side seams only: `memory-service` / `memory-world` death tests | Live 26.2: S6/R0 (capture + persistence only). Full M7 needs MB-FLOW-003. |

Ref/subject tests: cross-owner, expired request window, released goal, lifecycle, moved/changed fact in place, owner-corrected home, preparation → admission re-grounding (wrong generation/dimension, superseded fact, release on stop/supersession/lifecycle).

## Corrections and incidents

- **MB-MEM-001-C1** (coordinator, against `521cf10`): resolution did not verify owner/epoch/request; a moved fact could yield stale coordinates; the counter wrapped. Fixed in `c56e3d4` / `16684a5` with tests.
- **MB-MEM-001-C2** (coordinator, against `16684a5`): `forgotten` was satisfied from mutable memory while the write was pending and after it failed. Fixed in `7962081`: durable-absence check, rollback of failed writes, tests for pending, failed rename, restart and already-absent labels.
- **MB-BATCH001-I1 fixture incident (worker, recorded by the coordinator).** Exact command, run from the worktree while compile-checking the then-uncommitted harness:
  `npx tsc -p tsconfig.json --noEmit 2>&1 | head; node -e "import('./scripts/memory-live-check.ts').catch(e=>{console.log('import err',e.message)})" --input-type=module 2>&1 | head -3 &`
  The dynamic import executed the module's top-level `main()` (no entry guard, no lease guard then). Timeline (UTC): 08:03:29.956 run directory `var/live-check/2026-10-06T08-03-29-956Z-memory/` created; 08:03:30.629 memory store opened, seed phase read the 26.1.2 fixture RCON password in code (not printed) and sent scene clear/rebuild RCON commands in x196..224 z190..224 (forceload, tp/effect Chunkbot, kill non-player entities and items, fill air/grass/dirt, setblock logs/stone/chest/wall/glass/ores/obsidian, summons, `clear Chunkbot`, `clear FixtureOwner`, `effect clear`, `gamemode survival`, tp, crafting table, two chest `item replace`); 08:03:32.675 joined as `Chunkbot`; ≈08:03:40–50 killed with `pkill -f "memory-live-check"` (a broad pattern; future cleanup targets only a proven owned PID/start time or supported task control). No skill action ran. The 26.1.2 fixture was leased to the handoff worker, whose active run the coordinator invalidated.
  Containment and prevention (`8e8dc09` + this revision): the harness runs only as the process entry point (`isEntryPoint(import.meta.url, argv[1])`), so importing it does nothing; `main()` refuses with exit 2 before any password read, RCON, join or output-directory setup unless `--fixture-lease <granted id>` (an id not starting with `-`) is given. `tests/memory-harness-guard.test.ts` verifies this statically (no import) and by spawning the script only with missing/invalid leases (exit 2, no stdout, no output files, no new live-check directory) — no fixture contact. Executable harnesses are never imported for inspection; static typecheck only. The stray run directory remains in this worktree as evidence.

## Shared integration (designated writer)

Exact steps were sent to the coordinator with `16684a5`; the API is unchanged by `7962081`. Summary:
1. Contracts: export `memory.ts`; add `MemoryRefSelectorSchema` to `TargetSelectorSchema`, `MemoryStatePredicateSchema` to `AtomicPredicateSchema`, `PlannerRequest.memory?: MemoryView`.
2. Config: `memory: MemoryConfigSchema.optional()` (absent = disabled); fixture examples get explicit profiles.
3. CLI: `MemoryService({config, rootDir: memoryRoot(dataDir, cfg.memory), endpoint, clock, record}).open()`; status lines; `close()` after engine shutdown; doctor via read-only `inspectMemory`.
4. SkillRuntime: registry `[...allSkills(), ...memorySkills(memory)]`; `attachWorld(installedMemoryWorld(...))`; `memory.onLifecycle(event)` FIRST in `onLifecycle`; `beginGoal` in the admission hook (needs `instruction`); executor `onOutcome → recordOutcome`.
5. Candidates: `TaskHints.memoryRefs`.
6. Predicates: `baselines['memory:seq'] = memoryBaseline()` at bind; `evaluateMemoryState`; `position()` resolves `memory_ref` with the owner fence (bound predicates need `{goalId, goalEpoch}`).
7. Goal engine: `view({subject, ...})` per goal and preparation turn; `shownRefs` / `shownPreparedRefs` for proposal checks; `regroundPrepared` + fresh `checkProposal` at admission; `releasePreparation` on stop/supersession/discard/admission; `onGoalTerminal({..., kind})`.
8. Proposal check, wire and prompt variants (`memory_ref`, `memory_state`, `MEMORY_PLANNER_INSTRUCTIONS`, `renderMemoryView`).

## Live harness (pre-integration) — run on the leased 26.2 fixture

`scripts/memory-live-check.ts` composes the real connection, `SkillRuntime`, executor and the memory skills/service with exactly the proposed hooks; the harness plays the owner (fixed owner words) and a fixed decision (one grounded candidate per step). No model, provider, account or credential is used. Seed and recall are separate Node processes (a real restart); between them the orchestrator destroys the crafting table and empties the chest over RCON. Only steps whose outcome a code predicate evaluated end `outcome_verified`.

Lease `batch001-mem-26-2-0815` (26.2 only, 127.0.0.1:25567 / RCON 25577, existing server PID 15009; no start/stop/restart). Command, on a clean head after typecheck 0 / build 0:

```
node scripts/memory-live-check.ts --fixture-lease batch001-mem-26-2-0815 --fixture 26.2
```

| Run | Commit | UTC | Exit | Result | Report |
| --- | --- | --- | --- | --- | --- |
| 1 | `60b630d` | 08:17:18–08:17:47 | 0 | 13/13 | `var/live-check/2026-10-06T08-17-18-356Z-26.2-memory/` |
| 2 | `951975f` | 08:19:03–08:19:32 | 0 | 13/13 | `var/live-check/2026-10-06T08-19-03-690Z-26.2-memory/` |

Run 1 passed but its store showed milestones for steps the harness had ended with `outcome_verified` without any code evaluation (e.g. "craft sticks from the planks in the chest", where no sticks were crafted). That was a harness honesty defect, not a memory defect; `951975f` fixed it and added an R0 assertion that milestones exist only for the code-verified step. Run 2 is the evidence of record.

Run 2 evidence (from `report.json`):
- S1: `remember_location` succeeded, `confirmation none`, local memory store revision; `memory_state recorded` satisfied; remembered home = RCON server position 205.5,-60,205.5.
- S2: invented label "treasure" → `partial` / `not_owner_grounded`, an unverified note without location.
- S3: `inspect_container` server sync: 12 oak_planks, 20 cobblestone recorded as verified, historical; visible crafting table recorded as observation.
- S4: `mine_block` server block change → verified oak_log resource (cell fact).
- S5: two `place_block` server-confirmed placements, owner stop → interrupted project with exactly 2 checkpoints, 0 unknown effects.
- S6: RCON `kill Chunkbot` → incident at the server position (accuracy `client_position_at_death_event`), last-alive inventory `server_sync` (oak_log 1, cobblestone 2, iron_pickaxe 1), unresolved.
- R0 (new process): `ready` revision 11; home, verified resource, interrupted project, unresolved death; milestones only `["remember this spot as home"]`.
- R1: idle reconnect for 3 s: 0 ledger entries, 0 skill outcomes; RCON confirms both wall blocks unchanged (nothing replayed).
- R2: fresh `mref-` home ref; `go_to_memory` arrived (client_only, "presence not verified"); RCON position 206.5,-60,204.52 (1.4 from home); the ref from another goal epoch fails `memory_ref_not_owned`.
- R3: view shows the chest's 12 planks as `historical: true` (age 20 s); fresh `inspect_container` reads nothing; memory revised to `{}`.
- R4: the destroyed crafting table (air, directly observable) → `invalid` ("observed air at 207,-60,207 instead of crafting table").
- R5: world revision 2 at the same endpoint: empty, 0 facts.

Setup and interventions (all recorded in the reports): per run, the seed phase sent 42 RCON commands — the standard scene clear/rebuild inside x196..224 z190..224 (several `tp`/`effect`/`clear`/`gamemode` replies were "No entity/player was found" because they precede Chunkbot's join; Chunkbot was teleported after joining), `setblock 207 -60 207 crafting_table`, two chest `item replace`, five `tp Chunkbot`, `give Chunkbot cobblestone 4`, `give Chunkbot iron_pickaxe 1`, `kill Chunkbot`. Between runs: `setblock 207 -60 207 air`, `data merge block 203 -60 207 {Items:[]}`. The recall phase sent three `tp Chunkbot`. Nothing outside the scene area was changed except Chunkbot's own state. The death drops (Chunkbot's items) were left in the scene area at about 206.5,-60,198.5 (normal despawn; the next scene reset clears the area).

Still to do: the 26.1.2 run (needs a lease) and a CLI-driven variant once the writer has installed memory in the app.

## M6 proposal (coordinator real-provider run)

Goal: a real planner uses retrieved base/ingredient memory in a materially appropriate new plan after a restart, code verifies the result, with zero in-trial assistance and bounded context.

**Config:** `config/examples/fixture.json` plus
`"memory": {"worldProfile": "m6-fixture-26-1-2", "worldRevision": <fresh integer per acceptance run>, "botProfile": "chunkbot"}`
(a fresh revision isolates each acceptance run; the real Codex planner, real Jev with the injected key, USD 1 cap, default limits).

**Setup (RCON, recorded, before any instruction):** the standard scene (`scripts/lib/scene.ts`), no crafting table in the area, chest at 203,-60,207 with 12 `oak_planks`; Chunkbot inventory cleared.

**Run 1 (`node dist/cli.js run --config <m6.json>`, terminal owner):**
1. With Chunkbot at 205.5,-60,205.5: `remember this spot as home` → expect `outcome_verified` via `memory_state recorded`; fact `home` (owner_statement).
2. `check what is in the chest` → expect `inspect_container` (server sync); chest fact with 12 oak_planks (historical).
3. `/quit`. Expect the memory revision on disk and status `ready`.

**Run 2 (new process, restart):** after `ready`, recorded setup only: `tp Chunkbot 214.5 -60 196.5`, `clear Chunkbot`. Then one instruction:
`go home and make a crafting table there from the planks in the chest`
No further RCON, chat or answers until the goal is terminal. A clarification question ends the trial as "needed assistance".

**Pass criteria (code/RCON verified):**
- Goal terminal `outcome_verified` (code-evaluated outcome).
- RCON: a `crafting_table` block within 6 blocks of the remembered home; chest `oak_planks` reduced by at least 4; Chunkbot did not leave the travel radius.
- Planner journal: the request contained `memory` with the home `mref-` ref and the chest's historical contents; an accepted proposal used a `memory_ref` (home or chest) target; the chest was inspected (fresh server sync) before planks were withdrawn; no proposal treated historical contents as present stock.
- Bounds: memory view ≤ 20 facts and ≤ 8,000 characters per request; planner turns ≤ 20; Jev requests and spend within the configured caps.

**Negative variant (optional):** empty the chest between runs; pass = the plan inspects, finds no planks, and ends with a truthful missing-ingredient outcome (no fake success).

## Unmet criteria / remaining work

- Shared integration by the designated writer (not started in this branch; no shared file edited).
- Live fixture checks: pre-integration harness passed on 26.2 (lease released); 26.1.2 not run (H holds it).
- Real-provider M6: coordinator-owned; proposal above.
- CLI-driven live variant after integration.
- M7: only memory-side death seams; recovery policy, death cause parsing and recovery skills belong to MB-FLOW-003.
- Operator entry points: none in the shipped app yet; `statusLines()` and `inspectMemory`/`renderMemoryReport` are ready for the writer's status/doctor/`memory` subcommand.
