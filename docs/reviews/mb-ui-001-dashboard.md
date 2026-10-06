# MB-UI-001 — Local dashboard: worker review draft

Branch `chunkbot/mb-ui-001` (base `d5eb2fa`). Worker draft for Codex review. It is not acceptance evidence until Codex runs the coordinated checks. Plan: [chunkbot-dashboard-plan.md](../chunkbot-dashboard-plan.md).

## What exists

| Piece | Path | Notes |
| --- | --- | --- |
| Pure contract | `src/contracts/dashboard.ts` | Status snapshot v1 and usage history v1 are zod schemas, as is the remote metadata. `Known<T>` makes unknown explicit. USD amounts are integer nano-dollars. Seams for MB-FLOW-002 (pending directive), MB-MEM-001 (memory summary) and MB-FLOW-003 (survival). |
| Publisher | `src/dashboard/{publisher,inventory,vitals,directive,usage}.ts` | Runs in-process. Writes `<dataDir>/dashboard/status.json` atomically at 2 Hz (mode 0600). |
| Usage history | `src/dashboard/history.ts` | Writes `<dataDir>/dashboard/usage-history.json`: dated aggregates, per-run cursors and coverage gaps. |
| Integration facade | `src/dashboard/runtime.ts` | `createDashboardRuntime(deps)` with `tapStore`, `start`, `stop` and `statusLine`. Not wired into `cli.ts` yet (that is a designated-writer task). |
| Viewer service | `src/dashboard/{server,viewmodel,remote,codex-quota,viewer-command,main}.ts`, `assets/page.ts` | Node `http` plus SSE, with no new dependency. Run standalone with `node dist/dashboard/main.js --config <file> [--port n]`. |
| Live check | `scripts/dashboard-live-check.ts` | D-G1/D2/D4/D5 against a leased loopback fixture; `--read-only` mode uses `data get` only. Run on 26.2; see below. |
| Tests | `tests/dashboard-*.test.ts`, `tests/dashboard-fakes.ts` | 68 behavior tests. |

## Data sources (typed only)

- **Connection:** `GamePort.state`, `connectionEpoch` and lifecycle events. The bot's own name, dimension and game mode come from the session. The server address and port are never published.
- **Health and food:** the evidence journal's `health` record, which is the server's `update_health` packet with its timestamp. If the journal evicted that record, the publisher falls back to Mineflayer's copy of the same packet.
- **Saturation:** from the same packet.
- **XP:** `bot.experience`. It is set only by the server `experience` packet and starts as `null`, so it is unknown until that packet arrives.
- **Max health:** the server-sent `max_health` attribute with vanilla modifier math. If the attribute was not sent, it shows "max unknown" and no hearts are drawn.
- **Inventory:** server window packets only (`window_items`, `set_slot`, `set_player_inventory`) taken from the evidence journal, plus the player region of an open container mapped through its layout.
  - Mineflayer's optimistic slot model is never used.
  - Death clears the inventory until the server restates it.
  - The selected hotbar slot is labeled `client_selected`, because the server does not echo it.
- **Directive:** `GoalEngine.status()`, which is code-owned. A finished task is never shown as goal completion. "Next" appears only through the handoff seam and is labeled "prepared, not started".
- **Jev usage:** `SpendLedger.snapshot()` is authoritative for counts and USD. Typed `jev_request` and `jev_response` evidence events (via a store tee) provide tokens and retries.
  - Charged failures are reconciled attempts without a validated response; their token counts are unknown.
  - Retained (ambiguous) attempts keep the full reservation and have unknown tokens.
  - Pending is the outstanding reservation. Remaining is the local cap, not the wallet.
- **Planner usage:** `CodexPlanner.totals` plus `planner_turn_*` events. Failed or cancelled turns, and turns that reported no usage, count as unknown. Cached and reasoning tokens are breakdowns, never added to the totals.

- **Own position:** the client physics model (labeled client) plus the last server-set position, captured on Mineflayer's `forcedMove` after a server position packet, which resolves relative teleports. No other entity positions.
- **Pause latch, memory world profile/home:** typed seams (`pause`, `memory`). The viewer says "pause state not reported" when the running build does not provide a pause latch.

## Corrections MB-UI-001-C1/C2/C3

- **C1 (history size):**
  - Event identities are no longer persisted; they are kept in memory per run.
  - The writer keeps the file under 512 KiB, inside the viewer's 1 MiB bound. It compacts closed run cursors first, then folds the oldest days into a `rollup` that keeps every sum, then drops the oldest gap notes (counted).
  - A valid version-1 or oversized file of our own (up to 8 MiB) is migrated and compacted, never reset.
- **C2 (cursor/charge atomicity):** `commitLedger(cursor, delta)` changes both in memory before one atomic write. A test asserts that in every written file the dated charges equal the cursor.
- **C3 (nullable usage):**
  - Planner turns with `usage: null` count as unknown. A `null` cached or reasoning breakdown is tracked per turn (`cachedKnownTurns`, `reasoningKnownTurns`) and shown as "unknown" or "≥ N (reported for k of m turns)", never 0. Breakdowns are never added to the totals.
  - Trusted usage on `jev_failure` (`usageTrusted` or `usage`) is counted as separate charged-failure tokens. Cost always comes from the ledger once.
- **History format** is now version 2 (rollup, gapsOmitted, new day fields; no `seen`).

## Viewer behavior

- **Liveness states:** no session, live, disconnected, stale (heartbeat missed while the process exists), crashed (process gone without a clean stop), stopped, and error (malformed file; the last valid update is kept).
- **Historical readings:** world readings are live only when the publisher is live and the readings belong to the current connection epoch. Otherwise they are shown as "last known" with their time.
- **Snapshot ordering:** an out-of-order snapshot (same run, lower seq) or one from a run that started earlier is ignored.
- **Network exposure:** binds loopback only. Requests with a non-loopback `Host` header get 421, a foreign `Origin` gets 403, and non-GET methods get 405.
- **Limits and security:** SSE clients are bounded (default 8). There is a strict CSP and no write route. Assets are rendered with `textContent` only.
- **Shared reads:** one status read per poll tick serves every tab.
- **Port conflicts:** an occupied port produces a clear `--port` hint and exit code 2.
- **Shutdown:** closing the viewer ends only its own streams and listener.

## Optional account metadata (D10/D11)

- **Shared refresher:** one per source. At most one read is in flight, with at least 60 s between reads (120 s for Codex), a timeout, exponential backoff and a stale label after 5 min. Reads happen only while a tab is open, and tabs cannot trigger reads.
- **OpenRouter current key** (`GET /api/v1/key`, using the configured key variable in the viewer's environment):
  - Only the usage and limit fields are normalized, and the key label is dropped.
  - A null limit is shown as "no key cap reported (not unlimited credit)".
  - The scope is labeled "includes every tool using this key".
  - The wallet balance is always "unavailable" because it would need a management key.
- **Codex quota** (`codex-quota.ts`, a separate adapter):
  - The pinned 0.160.0 CLI is verified, as is the login mode (managed ChatGPT, mode only, file credentials store), using the planner's environment allowlist (the Jev key is denied).
  - It runs `codex app-server --listen stdio://` in an app-owned neutral directory `$TMPDIR/chunkbot-dashboard-quota-<uid>`, in its own process group, with tree cleanup.
  - It sends exactly four messages: `initialize`, `initialized`, `account/read {refreshToken:false}`, and `account/rateLimits/read {excludeResetCreditDetails:true, supportsLunaReserve:false}`.
  - `account.type` must be `chatgpt`. Email and plan are discarded.
  - Benign notifications are ignored: `remoteControl/status/changed`, `account/updated`, `account/rateLimits/updated`, `configWarning` and `deprecationNotice`.
  - Any server request or other event rejects the read. RPC errors and stderr are never surfaced.
  - Only returned windows are normalized (bucket, used %, duration, reset). Null fields stay unknown.
  - The protocol shapes come from `codex app-server generate-json-schema`, run offline into the ignored `var/batch001/codex-schema/`.
  - Workers made no live account read. Per Codex's D-G4 probe, the root read is proven.

## Checks run by the worker

`npm run typecheck`, `npm run build` and `npm test` all exit 0, with 365 tests: the 297 baseline plus 68 dashboard tests. Logs are in the ignored `var/batch001/`. No shared files, npm scripts, CLI, config or planner/decision files were edited.

## Live evidence (26.2 fixture, exclusive lease, commit `3333ecd`)

Reports are under the ignored `var/live-check/`.

| Run | Exit | Result |
| --- | --- | --- |
| `--fixture 26.2 --read-only` (`2026-10-06T08-06-48-359Z…-readonly`, `…08-09-29-186Z…-readonly`) | 0, 0 | 6/6. RCON: 7 `data get` only |
| `--fixture 26.2` full (`2026-10-06T08-09-16-809Z-26.2-dashboard`) | 0 | 13/13. 30 RCON commands recorded |

- **Latency (from the command, including the RCON round trip):**
  - damage: file 45 ms, screen 76 ms;
  - max health 24: file 467 ms, screen 496 ms;
  - inventory: last change published 488 ms after its command;
  - XP: 472 ms.
- **Match:** values equal the server's entity data (Health, foodLevel, XpLevel/XpP, Inventory NBT plus equipment, Pos within 0.6 blocks).
- **D5:** with 5 tabs and 10 refreshes, the only client packets were `chunk_batch_received` ×14, `flying` ×2 and `position` ×3. There were no interaction packets.
- **D4:**
  - after death the inventory became unknown, then the empty restated inventory appeared after respawn;
  - a kick showed disconnected with historical readings;
  - the rejoin was epoch 1 → 2, with live readings only after the new epoch reported;
  - a graceful stop showed as stopped.
- **D-G1 findings:**
  - A fresh 26.2 player gets no `max_health` attribute at join, so the dashboard shows "max unknown". Once the server has synced the attribute (any change), it is known. It is never guessed.
  - `/xp set` does not update the server's total-experience field, so the viewer shows only level and progress.
  - The fixture runs `difficulty=peaceful`, so food cannot change there. The food check is static equality, and health regenerates 1 HP/s, so the health check allows one regeneration step. The harness never reconfigures the server.
- **Harness corrections during the lease:** two runs failed because of fixture behavior, not dashboard defects (`2026-10-06T08-07-08…`: health raced regeneration; `…08-08-19…`: Hunger has no effect on peaceful).
- **Not run:** 26.1.2, which is owned by the handoff worker.

## Integration still needed (designated writer, via Codex)

1. Compose `createDashboardRuntime` in `buildApp` and pass `tapStore(store)` to `JevDecisionAdapter` and `CodexPlanner`.
2. Call `start()` after the app exists and `stop()` on close.
3. Add the `chunkbot dashboard` command (`parseViewerArgs`, `runDashboardViewer`), an npm `dashboard` script, and operator documentation.
4. Later, wire the `pending` and `memory` closures when MB-FLOW-002 and MB-MEM-001 land.

## Unmet or pending

- **D-G1/D2 live proof:** needs a fixture lease (`scripts/dashboard-live-check.ts`).
- **D1 real command:** needs the CLI wiring above. Until then the standalone entry exists.
- **D7 browser review:** owned by Codex, using the T3 preview.
- **D11:** Codex's coordinator acceptance of the quota observer through the real viewer.
- **Shared finding (being fixed by the designated writer):** `planner/transport.ts` turns missing usage into 0. The dashboard already accepts the null forms; until that change lands, a missing field still arrives as 0.
- **Day-level attribution:** charged failures are attributed to a day only at quiescent ledger points, which relies on the adapter's synchronous reconcile-then-record order. Session totals are exact regardless.
- **Single writer:** two Chunkbot processes writing the same dataDir at once would race on the history file. One app run per dataDir is assumed.
