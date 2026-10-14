# MB-OPS-001 — Verified live updates with a brief reconnect

Reported: 2026-10-06 UTC (2026-10-05 in Arizona). Status: **Proposed; unassigned.**
Parent: [companion upgrades](companion-upgrades-plan.md). Procedure: [agent workflow](../agent-workflow.md).

## Outcome and happy path

Jake asks Codex for a Chunkbot feature while Chunkbot is playing. Claude workers implement it in isolated worktrees; Codex reviews the integrated change and tests an exact candidate release against a separate local fixture. Chunkbot keeps using the current release throughout development and testing. When the accepted release is ready, the application manager applies it at a controlled boundary, briefly disconnects and reconnects Chunkbot, verifies the loaded version, and sends a short in-game update notice.

Jake confirmed **a brief automatic reconnect after a verified update** for the first version. Only Chunkbot reconnects; this feature does not restart the Minecraft server or Jake's client. No additional Minecraft account is needed for sequential restarts of the same bot profile. Tests use the existing separate offline fixture, not a second connection with the live account.

Jake also requested deployment instructions in agent-workflow.md once this feature works. The workflow currently links this proposal; installed commands and the accepted deployment procedure are a required part of delivery, not invented here.

## Feasibility and observed baseline

- ChunkbotApp composes one GoalEngine and adapter set for its lifetime. GameSession owns the Mineflayer bot, socket, packet journal, listeners and connection epoch. Shutdown revokes goals, cancels provider work and disconnects the bot; normal startup joins idle. There is no implemented release manager or hot-reload boundary.
- npm run build deletes dist/ before compiling through scripts/clean-dist.ts. Rebuilding the running checkout is unsuitable for live deployment: it can remove files that later planner/app paths need while the old process still exists.
- src/cli.ts creates a new in-memory SpendLedger for each process. A naive restart would replenish the run cap. Goals, admission inventory, evidence, counters and accepted outcomes are also connection/process-scoped.
- src/config/load.ts resolves data/auth paths from the configuration location. A release must explicitly keep the same operator configuration and external data root; copying source into a release directory is not sufficient.
- Node's ordinary watch mode restarts the process on file changes. ESM imports are cached by URL; adding query strings can load additional module instances. **Coordinator inference:** neither mechanism disposes existing Mineflayer listeners, sockets, leases or closures or establishes an atomic application upgrade. [Node watch documentation](https://nodejs.org/api/cli.html#--watch), [Node ESM documentation](https://nodejs.org/api/esm.html#urls) (checked 2026-10-06; these are general mechanics, not a recommendation to upgrade the installed Node 24).

The practical first version is controlled replacement of the application process. Keeping the Minecraft connection uninterrupted through arbitrary controller, library or protocol changes would require a stable connection host and a versioned controller/process interface. That is a separate architecture project, not a promised side effect of this feature.

## Scope and product defaults

Coordinator assumptions unless Jake refines them:

- A small local application manager owns one explicitly started play session, deployment state and the active Chunkbot child. It is separate from DSH and the Minecraft server. It has no gameplay planner, actuator or vault access.
- Within an authorized feature assignment that includes deployment, Codex can promote its accepted release to an eligible running managed session without another per-update permission question. Workers hand off candidates to Codex; they do not deploy their own branches.
- Auto-apply operates only during that managed session. When Chunkbot is logged out, an accepted update is staged for the next explicit start; it never reconnects him merely because a build appears. Logout cancels pending deployment/reconnect intent. Stop remains a gameplay pause across an allowed reconnect.
- Use a confirmed action boundary, with a bounded drain deadline. Defer if an interaction cannot be reconciled or a finite owner goal cannot be continued with equivalent verified semantics. Do not wait indefinitely for sustained follow/furnace tasks: cancel them through the existing bounded ownership cleanup when an update can proceed safely.
- A first release may rejoin idle with an interrupted owner directive displayed rather than transparently resume it. Prefer to wait for a finite owner task to finish when continuation is unsupported. An explicit operator choice to interrupt is distinct from claiming that task completed.
- Do not promise a particular downtime yet. Measure drain, disconnect, spawn, readiness and announcement separately in the fixture; establish finite deadlines and report the observed reconnect range before acceptance.
- Status identifies current release, staged release, updating/ready/deferred/rollback/blocked state and reason. MB-UI-001 can consume the same read-only contract when its dashboard exists; the dashboard is not a prerequisite.

First-version exclusions: arbitrary in-process code patching, source-save-triggered live restarts, zero-disconnect protocol upgrades, Minecraft server/client updates, remote deployment or server plugins, automatic sign-in, API model fallbacks, and auto-resume after ordinary crashes/kicks/death. Optional future reload of dashboard assets or validated pure data needs its own explicit compatibility boundary; planner isolation, pricing, identity and execution policy cannot bypass review as a “data-only” reload.

## Release architecture and deployment sequence

Proposed ownership: a release/manager module, release receipt and checkpoint contracts, CLI wiring and a fixture acceptance harness. Codex owns shared schemas, CLI/config, manifests, cross-feature integration and promotion. Candidate packaging and manager lifecycle can be parallel assignments after these interfaces are settled.

1. **Freeze and verify.** Integrate reviewed commits into the coordinator checkout. Build/install/test in a separate staging area, with isolated node_modules and dist. Record commit/base or, before Git exists, a complete source digest; lockfile/vendor inputs, built artifact digest, Node/runtime compatibility, data/checkpoint versions, human feature summary and acceptance evidence. Recheck the frozen bytes after tests. A changed artifact needs new affected acceptance.
2. **Publish an immutable release.** Put each complete artifact in its own directory, proposed under ignored var/releases/, including its exact installed dependencies and entry point. Mutable state lives outside releases. No shared writable worker build output, npm install in the active release, credentials in artifacts, or mutable “latest” import path. Keep the previous working artifact. Verify packaging by actually running the fixture application from the candidate directory, not only the source checkout.
3. **Offer through the manager.** Codex promotes only a verified manifest. The manager validates its compatibility, hashes, configured world/bot identity and session eligibility. Use one deployment lock and at most one pending candidate. Re-offering the active release is a no-op; newer candidates must be independently accepted. Do not expose deployment through arbitrary Minecraft chat or a public HTTP endpoint.
4. **Drain and checkpoint.** Gate new admissions, cancel preparation, revoke active execution, abort providers and await bounded owned-process/interface cleanup. Record confirmed effects separately from unknown effects. Persist paused mode, latest command generation, relevant directive checkpoint, durable memory revision when installed, budget accounting and reconnect intent. An update is not owner stop or goal success. A late stop/logout wins over the saved checkpoint.
5. **Replace once.** Prove the old Chunkbot child and its owned planner descendants are gone and its server connection is closed before starting the candidate with the same external configuration/auth/data paths. Fence IPC/status messages by session and deployment generation. There is never a second connected bot using eggyBot69 as a warm standby. A PID alone is not sufficient process identity.
6. **Verify readiness.** Verify the child-reported release digest matches the promoted bytes, bot and owner identity, server version/protocol/world profile, valid spawn, fresh server-confirmed inventory/observation, registered capabilities, provider/auth readiness and new connection-scoped evidence. Use read-only readiness checks where possible; do not inject a live-world gameplay diagnostic or a paid inference solely to emit the notice. A changed feature already has its own independent fixture acceptance.
7. **Commit and announce.** Atomically record the verified active release. Send a bounded notice through Chunkbot's existing configured owner chat channel, for example “Updated: I can remember our base now. I'm back.” That example applies only when the named feature is delivered. No success notice before readiness; status always records the result even if chat delivery fails. Do not turn a whisper configuration into public announcements automatically. Retry/deduplication must not create repeated notices or model calls.

The manager uses a supported local control surface/typed IPC chosen during implementation. It does not restart DSH, run a worker's arbitrary shell hook, or edit the Minecraft server. Changing the manager itself requires a separately coordinated manager restart; the child-upgrade mechanism cannot claim to hot-reload its own supervisor.

[MB-OPS-002 vanilla slash controls](server-control-plan.md) shares this manager foundation and adds an explicit owner on/off request source. A verified on is an explicit start request; an off cancels pending update/reconnect intent. Dashboard usage/spend observes the same logical session and conservative budget. Define these shared interfaces before parallel workers implement overlapping lifecycle paths.

## State, interruption and budgets

- Minecraft retains the bot profile's world state, such as inventory and position, subject to ordinary server rules. Always obtain fresh server packets after rejoin; an old snapshot does not prove where Chunkbot spawned or what it now owns.
- Persist the stop latch and latest directive generation outside release directories. Logout disables rejoin even if it arrives during drain/startup; a late ready event cannot resurrect the session. Local terminal stop/logout must remain available while the child is absent. In-game commands sent while Chunkbot is disconnected cannot be received; do not claim they were queued.
- No active lease, pending action, candidate ID, entity handle, planner draft, clarification ref or interface binding survives as executable state. Every new child gets fresh epochs, references and ownership. Unknown partial effects are inspected, not replayed.
- MB-MEM-001 supplies durable gameplay facts when delivered; upgrades preserve its world-scoped records and compatible schemas. This feature's minimal operating/budget checkpoint must work even before full gameplay memory exists.
- Automatic continuation is a separate validated path: preserve the logical instruction, accepted immutable outcome and admission baseline semantics, consumed counters, historical verified effects and original deadline. Re-ground current state and replan without repeating already satisfied work. Never resubmit “collect N new items” with a fresh baseline and silently double the target, refresh limits or claim prior historical evidence is current inventory. If equivalent continuation cannot be proved, leave the directive interrupted/pending and report it. Progression may select a fresh milestone only when its own feature is installed, was enabled and no unresolved owner directive takes priority.
- A code update or rollback stays within the same logical managed session and its existing USD 1 default cap. Preserve reconciled and retained charges, decision/planner/preparation allowances and any provider-disabled state. Persist reservations before dispatch or otherwise prove crash-safe accounting; an unresolved in-flight charge retains its full maximum after recovery. Missing/corrupt accounting cannot create a fresh allowance. Starting a new budget/session is an explicit operator action, not a side effect of deployment.
- Microsoft tokens and provider keys stay in existing external caches/environment with inherited permissions. The manager obtains no vault credential and performs no device-code login or auth downgrade. The gameplay planner keeps its restricted subscription-only process/isolation gate after every release.

## Failure and rollback

Before drain, build/test/manifest/compatibility failures leave the current child untouched. An unreconciled cleanup/checkpoint defers the update rather than starting a conflicting child.

If a candidate cannot start or fails its bounded readiness gate, tear it down fully and attempt the last working release once, using the latest stop/logout state and the same session budget. A rolled-back bot reports the failure honestly instead of announcing the candidate as installed. If rollback also fails, remain stopped with a clear blocker; no restart loop. Auth-required, bans/whitelist, unavailable server, identity conflict and protocol mismatch must be classified so the manager does not repeatedly try code versions to repair an unrelated external failure.

First-version releases must have backward-compatible durable data/checkpoints or an explicitly tested reversible migration. Defer incompatible migrations from automatic deployment. A code rollback does not rewind the Minecraft world, confirmed item changes, memory facts or model charges. Keep the prior artifact and deployment journal until review; garbage collection removes only inactive task-owned releases after process/reference checks.

## Bounded research gates

| Gate | Question, probe and resulting decision |
| --- | --- |
| U-G1 | Can the real CLI run from an immutable artifact with external config/auth/data and exact vendored dependencies? Launch the candidate from that directory against each loopback fixture; decide packaging/path changes from actual resolution, not symlink assumptions. |
| U-G2 | Which shutdown paths prove planner descendants, actuator/interface cleanup and socket closure? Exercise delayed planner, sustained follow and an inventory-changing skill in the fixture; choose bounded drain/startup timeouts and a supervisor ownership protocol. |
| U-G3 | How will paused mode, deployment generations and spend reservations survive manager/child crashes? Choose atomic storage/IPC consistent with MB-MEM-001, inject crashes around writes and provider dispatch, and prove no lost stop or replenished budget. |
| U-G4 | Which owner goals can be continued without changing admission-bound outcomes? Test inventory acquisition and a persistent follow directive across releases. Define the supported checkpoint contract; defer incompatible active goals instead of pretending arbitrary replay is continuation. |
| U-G5 | Which readiness evidence is available without a live-world action, and can the fixture owner actually receive one update notice? Probe the real app/status/auth gates and configured chat transport, then choose explicit health conditions and a bounded notification policy. |

Inspect src/cli.ts, src/app/app.ts, src/app/skill-runtime.ts, src/app/status.ts, src/game/connection.ts, src/game/auth.ts, src/goals/goal-engine.ts, src/planner/process.ts, src/decision/spend.ts, src/decision/jev-adapter.ts, src/execution/, src/config/load.ts, src/telemetry/run-store.ts and scripts/clean-dist.ts. Integrate with [smooth handoff](smooth-handoff-plan.md), [memory](gameplay-memory-plan.md), [progression](autonomous-progression-plan.md) and [dashboard](chunkbot-dashboard-plan.md) only at their accepted interfaces; do not treat proposed features as installed dependencies.

## Milestones and observable acceptance

| ID | Criterion |
| --- | --- |
| U1 | Build and test release B while A plays in a separate fixture session. A's loaded digest, connection and permitted work remain unchanged; no active dist/node_modules mutation. B runs from its actual packaged directory. |
| U2 | Promote accepted B: bounded drain, old socket/descendants gone, exactly one same-profile rejoin, fresh evidence and correct loaded digest. Fixture owner receives the truthful update notice after readiness. Measure actual downtime. |
| U3 | Stop/logout at each deployment boundary wins. Stop stays paused across B and rollback; logout never reconnects. Offline promotion stages only. Repeating a promotion cannot reconnect or announce again. |
| U4 | Delayed planner/Jev, sustained follow, container/craft/place interruption and stale late results cannot act under the new epoch or overwrite newer directives. Supported continuation keeps outcomes/counters/deadlines; unsupported continuation is visibly deferred/interrupted. |
| U5 | Failed build, incomplete/tampered artifact, startup crash, readiness failure and incompatible migration give distinct results. B failure restores A once when appropriate; a second failure stops. No two active children or infinite reconnects. |
| U6 | Across successful update, rollback and crash during provider I/O, reconciled/retained/outstanding accounting preserves the same cap; exhausted allowance stays exhausted. Keys/caches remain external and private; planner isolation and auth gates still pass. |
| U7 | After integrated real Codex/Jev fixture acceptance, write installed promotion/status/rollback commands and the proven procedure into agent-workflow.md, README.md and required checks in AGENTS.md. Workers hand off releases; Codex independently accepts and deploys within existing authorization. |

Run affected actual AGENTS.md checks: typecheck/build/test, both fixture doctors, connection/lifecycle live checks, and skill/controller/planner regressions where those paths change. Extend a dedicated update harness for U1–U6; it does not exist yet. Coordinator runs real-provider acceptance within the existing cap. No failure injection, RCON changes, account switching or unsolicited connection on Jake's apartment server. Record exact artifacts, exits, world/version, timings, interventions, rollback and chat evidence under docs/reviews/mb-ops-001-live-updates.md when available.

Remaining delivery: manager/packaging/IPC/storage design, implementation, continuation compatibility, independent fixture acceptance and installed deployment documentation. This proposal starts no workers, deployment or connection.

## Offline assignment authorization — 2026-10-13 Arizona

Status: **authorized / preparing; not accepted; no worker launched.** Jake starts only the scopes below using native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. The current CLI 0.162.1 read-only native gate passed; gameplay planner configuration and all historical evidence remain unchanged. Source implementation/entry-point wiring is authorized for the later coordinator-launched workers, while this preparation performs coordination documents/worktrees/dependency installs only. No live deployment/join is authorized; all fixture leases are **ABSENT**. World/provider/vault/key/live-control work is coordinator-only and requires a later explicit grant.

| Prepared lane | Existing scope | Ownership / dependency |
| --- | --- | --- |
| packaging | MB-OPS-001 U-G1/U1/U5 | `src/updates/artifacts/ (new)`, `scripts/package-release.ts (new)`, `tests/update-artifacts.test.ts (new)`; Propose the public manifest/API to the coordinator before stabilizing it; shared contracts are integration-owned. Manager consumes only the approved contract. |
| manager | MB-OPS-001 U-G2/U-G5/U2/U3/U5 | `src/updates/manager/ (new)`, `tests/update-manager.test.ts (new)`; Approved artifact/checkpoint/manager port contracts first. Existing app, control, CLI and connection seams are integration-owned. |
| checkpoints | MB-OPS-001 U-G3/U-G4/U4/U6 | `src/updates/checkpoints/ (new)`, `tests/update-checkpoints.test.ts (new)`, `tests/update-accounting.test.ts (new)`; Propose semantic/storage/IPC contracts first; existing memory/core/SpendLedger seams require integration/coordinator approval. Manager shares the approved contracts. |

Complete outcomes/exclusions, exact owned tests/paths and source/build/live boundaries are in [the preparation checkpoint](agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona) and the ignored per-lane briefs. No shared schema/predicate/CLI/composition edit is accepted by proposal alone. Dedicated local role review: `docs/reviews/mb-20261013-<suffix>-worker.md`; acceptance instead owns `docs/reviews/mb-v1-05-20261013.md`. Coordinator approval of exact contract/companion commits precedes cross-branch imports.
