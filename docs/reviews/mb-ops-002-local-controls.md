# MB-OPS-002-L1 — local Mac controls

Accepted by Codex on 2026-10-07 UTC for the configured Mac and accepted application release d348d58. Jake requested local startup/dashboard/logout scripts during live play. Native Claude Opus 5.5 through the existing local DSH subscription wrote the first controller, wrappers and tests. Its subscription then reached the session limit. Jake explicitly authorized Codex to finish the local scripts and review fixes. The native draft and separate feature worktrees are preserved.

## Operator behavior

| File | Result |
| --- | --- |
| `play.command` | Start the registered bot once, confirm its current run is ready, reuse/start the viewer and open it. An existing bot keeps its process and budget. |
| `dashboard.command` | Reuse/start/open only the loopback read-only viewer. No Minecraft login or model decision. |
| `logout.command` | SIGINT the proven owned bot, await exit and report socket/final-publisher evidence. The viewer stays open. |

The executable zsh launchers work from paths containing spaces. Closing the launch terminal leaves the detached bot/viewer running. Read-only status is `python3 -B scripts/play-controls.py status`; `--json` gives structured evidence. `--no-open` skips the browser. Each command accepts `--profile <absolute file>` for an explicitly registered alternate installation.

The installed release joins idle. Goals arrive through owner chat. Starting after a completed logout creates a new application run with its default USD1 cap; duplicate start does not reset it. There is no update/install, automatic reconnect, scheduled login or goal replay. The proposed vanilla trigger bridge and live update manager remain separate work.

## Registration and credentials

The ignored `var/live-chunkbot/operator-profile.json` is already prepared on Jake's Mac. A new installation needs a coordinator-reviewed accepted artifact, Node24, an existing private world config and explicit bot sign-in before registering its profile. Do not point `artifactDir` at the mutable development checkout. The world config must use an absolute `storage.dataDir` so the bot cache and dashboard status refer to the same installation.

Required non-secret profile fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `repoRoot` | Absolute checkout containing these shortcuts |
| `artifactDir` | Absolute independently accepted installation containing `dist/cli.js` and its own dependencies |
| `releaseCommit` | Accepted Git commit ID |
| `buildDigest` | SHA256 over every dist file, sorted by UTF8 relative path: relative path, NUL, file bytes, NUL |
| `configPath` | Absolute private world config |
| `nodePath` | Absolute executable Node24; this Mac uses `/opt/homebrew/Cellar/node@24/24.21.0/bin/node` |
| `runtimeDir` | Absolute ignored receipt/log directory |
| `dashboardPort` | Loopback port; this installation uses `7382` |
| `keyEnv` | Environment variable name used by the world config's decision adapter |
| `vaultItem`, `vaultSelector` | Local credential item name and selector, such as `password`; no credential value |
| `restartPolicy` | Description: explicit operator start only |

Write the profile owned by the operator with mode0600. The coordinator can calculate the digest with the controller's import-safe `build_digest` function after accepting the installation. Controls validate the pin before a play or dashboard launch, and run the application's read-only doctor before a new bot start. Logout remains available if the artifact files are subsequently unavailable.

The key comes from the named inherited environment variable or the existing local creds helper. It is passed only in the bot child's environment. No key is written to the profile, argv or receipts; the viewer receives no decision key. Microsoft/Codex credentials remain in their existing external stores. Logs and receipts are private ignored files. Tests use an explicit fake helper override and dummy keys, without changing HOME or consulting the real vault.

## Review correction C1

The first draft allowed receipt fields to redefine the expected node/entry/config. Codex recorded C1 before correction, then changed proof to use the registered profile; wrong fields, viewer URL or port refuse. Failed process probes cannot count as absence and permit a duplicate. Dashboard-only startup also checks the artifact pin. Post-spawn receipt errors and interrupted readiness clean up only the newly spawned child; a child whose exit cannot be confirmed retains its receipt. Fresh readiness requires current publisher evidence for the same PID/run. Unrelated or reused PIDs are never signalled.

Mutating controls share one OS file lock. Missing credentials, doctor failure, changed artifacts, occupied ports and bounded startup/logout failures return actionable nonzero results. A second explicit logout can send a second SIGINT to the same re-proven process; the application handles that as forced shutdown.

## Independent evidence

- `python3 -B tests/play_controls_test.py`: 31 tests pass, exit0. They exercise concurrent/duplicate starts, paths with spaces, fake credential delivery, private files, wrong configuration/entry/node receipts, wrong viewer URL/port, process-probe failures, drift, startup failures, interrupted readiness, logout timeout, TCP closure and viewer survival. No Minecraft/provider/vault access.
- Each `.command` passes its own `zsh -n` check; the controller compiles with Python3. No application TypeScript or dependencies changed in this slice.
- Coordinator fixture lease `local-controls-fixture-261-01`: accepted d348d58 artifact, loopback26.1.2, unique ControlProbe, planner disabled, dummy key, independent config/data, viewer17382. Play, duplicate play, dashboard reuse, status, logout and final status all exit0. The duplicate retained PID80461/run78457d0d7dc3 and viewer80497. Logout verified process exit, server TCP closure and stopped final publisher; viewer remained alive and served HTTP200. Coordinator then verified cleanup of that owned viewer. No RCON writes, scene reset, rule change or inference.
- Read-only actual live inspection proves unchanged bot71629/run9d8d6a18e52b, viewer65554/port7382 and the matching registered build. Live play is not interrupted to test logout.

Private receipts are under `var/live-chunkbot/`; fixture evidence is in `fixture-control-trial/report.json`. Only these controls and operator documentation are published from the accepted public base. Unfinished progression, survival and locator source is excluded from this publication.
