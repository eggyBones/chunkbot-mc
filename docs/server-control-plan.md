# MB-OPS-002 — Vanilla slash commands to bring Chunkbot online or log him out

Reported: 2026-10-06 UTC (2026-10-05 in Arizona). Status: **Local controls MB-OPS-002-L1 accepted; vanilla slash-command bridge proposed and unassigned.**
Parent: [companion upgrades](companion-upgrades-plan.md). Shared runtime: [verified updates](live-update-plan.md).

## Outcome and confirmed decisions

While Jake stays connected to his Minecraft server, he can request that eggyBot69 join or leave through slash commands. Jake confirmed this controls the bot, not Jake's own client. He chose to **keep the server vanilla and use /trigger commands**, avoiding a modded server or changes to PrismLauncher.

Proposed operator vocabulary, to verify in the fixture:

| Command | Behavior |
| --- | --- |
| /trigger chunkbot_on | Request one managed connection using the existing bot account and configured server. Report joining, then online only after verified spawn/identity. |
| /trigger chunkbot_off | Cancel joining, gameplay, preparation and update reconnect intent; disconnect and stop the bot child. The command bridge remains available. |
| /trigger chunkbot_status | Read-only joining/online/logging-out/offline/blocked status, including whether the bridge has a fresh heartbeat. Coordinator assumption: include this small companion command. |

Gameplay stop and server logout remain distinct: !chunkbot stop pauses work while connected; off logs the bot out. On establishes a connection and does not erase a latched stop. If progression is installed and enabled it follows its confirmed default; otherwise the current V1 application joins idle. No automatic player-presence schedule is included.

## Feasibility and existing evidence

The current chat listener belongs to GameSession and disappears when the bot disconnects. It cannot receive an on request while eggyBot69 is offline. The server and an external application manager must receive that request independently of the bot connection.

Already-generated Mojang command reports under var/compatibility/reports-26.1.2/generated/reports/commands.json and reports-26.2/generated/reports/commands.json define trigger with an executable objective argument and optional add/set integer values. Neither vanilla command tree defines a chunkbot root. This is syntax evidence, not an end-to-end permission or bridge test. Objective creation/enabling, re-arming, request ordering and ordinary non-operator use remain implementation gates.

Coordinator proposal: a small namespaced datapack/scoreboard setup publishes operator requests and feedback. A restricted bridge on the bot's machine consumes that control state over a private server-administration channel and calls the local manager. No custom /chunkbot command tree is promised on vanilla. A real custom root is a separate server-mod choice; [Fabric documents command registration](https://docs.fabricmc.net/develop/commands/basics), but Jake selected the vanilla route.

The bot machine and Minecraft server must both be awake, reachable and running their respective services. These commands cannot power on a sleeping laptop. Installing the bridge does not change where Minecraft is hosted; Chunkbot remains hosted wherever the managed application is explicitly installed.

## Scope and proposed architecture

- Reuse the single application-manager/session-intent seam from MB-OPS-001. A shared minimal manager can be delivered before either feature; slash controls do not require the full release-upgrade mechanism. Do not introduce a second daemon that races the updater to launch the same account.
- Keep the server vanilla. Admin setup creates only task-owned namespaced control objectives/datapack functions and narrowly scoped feedback. It must be documented, reversible and tested against 26.2 first, with 26.1.2 regression where supported. It must not enable broad player operator permissions.
- Coordinator default: the bridge reads/acknowledges a fixed control protocol through RCON bound privately, preferably localhost over an SSH/Tailscale tunnel. Verify actual access and server properties during the implementation assignment. Do not assume Jake's live server already has RCON enabled; if enabling it requires a server restart, stage the exact setup and coordinate it under that assignment.
- Authenticate Jake by the configured verified-online owner UUID and current server/world profile. The server command source or a verified server-side mapping supplies identity; scoreboard text/name or chat prose alone is insufficient. Other players cannot launch or stop the bot. Console/local operator behavior needs an explicit configured policy.
- A typed request has owner/profile, action, bounded request generation, freshness/expiry and acknowledgment state. Reject unsupported values, wrong profiles, expired requests and repeated delivery. No shell, repository path, arbitrary server command, model prompt or remote hostname is supplied by a player.
- Manager handlers are deterministic and inference-free. Start the installed accepted release, using external private configuration and the already signed-in Microsoft cache. Missing/expired auth blocks with a clear message; no automatic device-code flow, fallback account or offline auth.
- The bridge is privileged operator tooling. Its credential stays outside source, datapack, browser state, gameplay context and worker prompts. It executes only fixed task-owned control/identity/ack commands; it cannot expose RCON or server-wide facts to the gameplay planner.

Inspect src/cli.ts, src/app/app.ts, src/game/connection.ts, src/game/auth.ts, src/commands/, src/config/, lifecycle cleanup and MB-OPS-001's manager/checkpoint proposals. Proposed worker ownership: namespaced datapack/control adapter and its tests; a separate worker can implement the shared manager foundation after Codex sets contracts. Codex owns shared manager/CLI/config integration, installation procedure and final acceptance. Coordinate server/fixture leases with the current maintenance assignment.

## Request, lifecycle and persistence behavior

- A trigger is re-enabled for the authorized owner after its request is consumed. Clear/expire stale control flags on bridge/server restart and bind requests to the current control session. Booting a bridge must not replay yesterday's on request.
- On while already online/joining is idempotent. Only one child/socket per bot/server profile exists; a timeout checking status is not permission to launch another.
- Off during startup, a model turn, a sustained skill or deployment wins over older reconnect intent. Cancel provider/process ownership before releasing game resources. Confirm the old child/socket is gone before reporting offline. Manager status alone must not fabricate a successful disconnect.
- Apply the latest reliably ordered owner request. If the vanilla protocol cannot establish order for concurrent on/off flags, off wins and stale on is discarded; document that behavior. Test rapid sequences before claiming last-command behavior.
- A new on after completed logout is an explicit new connection request. Ordinary duplicate delivery, network reconnect, retry or code update does not allocate a fresh session budget. Any intentional new-run allowance follows the documented session policy; recorded history/ambiguous charges are not erased.
- Owner stop state and durable memory, when installed, remain intact. Disconnect invalidates leases, pending plans, handles, interface bindings and unfinished actions. No direct command/action replay on rejoin; task continuation follows the compatible-checkpoint rules of MB-OPS-001.
- On/off can be received while the bot child is absent. Local operator stop/logout remains available when the server bridge is unreachable. Commands acknowledged as queued are not reported as completed until actual process/connection evidence arrives.
- A dead manager, expired heartbeat, unreachable server/tunnel, auth failure, identity conflict, whitelist problem or unsupported protocol yields distinct feedback. Bound connect attempts and timeouts; no infinite login/reconnect loop or automatic join when an old request finally arrives after the Mac wakes.
- Feedback uses the server's owner-targeted control channel, so logging out the bot does not remove the ability to say it is offline. The dashboard may display the same state but remains read-only; no dashboard command console is added by this plan.

## Bounded research gates

| Gate | Question, probe and resulting decision |
| --- | --- |
| C-G1 | Can a non-operator owner use the three trigger objectives while the bot is absent? Build a task-owned fixture setup, connect the fixture owner, test enabling/re-arming and unauthorized players, then settle the exact commands/install artifacts. |
| C-G2 | Can vanilla control state prove owner UUID, fresh generations, ordering, acknowledgments and bridge heartbeat? Exercise repeated/rapid on-off requests and bridge/server restarts in the fixture. Choose the minimum datapack/scoreboard protocol; if ordering is ambiguous, enforce off precedence rather than invent timestamps. |
| C-G3 | What private administration channel is available on the apartment server? Once implementation/server setup is assigned, inspect the actual host through the already provided ssh egg route. Decide scoped RCON/tunnel setup and any restart requirement; do not inspect or modify that host during this planning task. |
| C-G4 | Can the shared manager cancel startup/update and prove process/socket cleanup? Test delayed connection, delayed planner, sustained follow and manager crash. Set finite request TTL/connect/stop deadlines and prevent a second bot launch. |

## Milestones and observable acceptance

| ID | Criterion |
| --- | --- |
| C1 | With eggyBot69's fixture equivalent fully logged out, the non-operator owner sends the documented on trigger. The configured profile joins once and the owner receives truthful online feedback. No model call is made by the command handler. |
| C2 | Off during idle, joining, real gameplay and a delayed provider turn cancels work, removes the server player and stops the child. The same bridge can accept a later explicit on without a second account. |
| C3 | Repeated on/off, rapid conflicting requests, duplicate acknowledgments and stale persisted flags cannot spawn two children, undo a newer off or auto-join after a restart/wake. |
| C4 | Spoofed names, unauthorized UUIDs, disabled triggers, altered/unsupported values and another world/profile produce no control action. The owner needs no general operator permission. |
| C5 | Missing auth, whitelist denial, version mismatch, tunnel loss, sleeping/unreachable host and killed manager have bounded, honest status; old heartbeat cannot leave a permanent online indicator. No sign-in or reconnect loop. |
| C6 | Integrated update/on/off races retain one manager, the stop latch, correct budget/history and fresh connection evidence. Jake's own client/server remains running. |
| C7 | Deliver exact setup, start/status/stop, objective/datapack install/uninstall and troubleshooting commands in README.md and agent-workflow.md once verified. Install on the live server only under the assigned deployment scope; record the actual topology and owner/profile binding. |

Run actual affected AGENTS.md typecheck/build/test, doctor and connection/identity/lifecycle live checks; add a dedicated command-bridge harness since existing scripts do not cover offline trigger control. Controller/planner/skill changes require their existing checks. Coordinator validates any real-provider cancellation within the existing cap. Keep all fault injection and datapack experiments in separate loopback fixtures; no live-world reset or server modification is performed for this proposal.

Remaining delivery: shared manager, private bridge, fixture-proved vanilla control/identity protocol, feedback, installer, runtime evidence and operator procedure. No worker or server setup is assigned by this document.

## Accepted local slice MB-OPS-002-L1

On 2026-10-07 Jake requested local scripts to start Chunkbot and the dashboard, and log the bot out from this Mac. `play.command`, `dashboard.command` and `logout.command` are implemented and independently accepted; [operator behavior, registration and evidence](reviews/mb-ops-002-local-controls.md). They use the registered accepted artifact and existing private login/config, serialize starts, preserve an existing session, and leave the read-only viewer open after logout. The coordinator verified 31 credential-free tests, actual fixture startup/duplicate/logout/TCP closure and live reuse without interruption. Native Claude drafted the implementation; Jake explicitly authorized Codex completion after Claude reached its subscription limit.

This local slice does not install the proposed vanilla command bridge or automatic live updates. Their remaining delivery above is unchanged.
