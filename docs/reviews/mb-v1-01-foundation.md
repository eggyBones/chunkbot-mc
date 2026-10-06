# MB-V1-01 foundation: worker delivery evidence

Worker: Claude Opus 5.5 in local DSH session `session-57f00ccc-6072-42e0-9a2a-9abb17e9f038`. Date: 2026-10-04. Brief: [mb-v1-01-worker-brief.md](mb-v1-01-worker-brief.md). Plan: [v1-foundation-plan.md](../v1-foundation-plan.md).

This is the worker's evidence. Codex independently checks acceptance; nothing here is self-accepted.

## Summary

| State | Evidence |
| --- | --- |
| Implemented | Node 24 / strict TypeScript / npm application in `src/`, wired into the real CLI `src/cli.ts`: `run`, `connect-check`, `doctor`, and `auth login`. |
| Verified locally | Typecheck, build, 84/84 tests, doctor, and 16/16 live fixture scenarios all exit 0, as expected. |
| Built | `dist/` built from the final source by `npm run build` (exit 0) immediately before the final test and live runs. |
| Running | Only the local fixture server: vanilla 26.1.2, java PID **31385** (restarted at the end with the documented stop/start commands; the earlier live runs used PID 28565). No Chunkbot process is left running. |
| Not delivered (by design) | Any model-driven gameplay. No planner, Jev, perception, or skill adapter exists. Every admitted goal ends `blocked (planner_not_ready)` with “No game actions were taken.” |

## G-01 version/library resolution (foundation part)

Question: which exact Java version and library combination works for a separate local test server?

Sources were the installed package code and official metadata; no README ranges were used.

- `mineflayer@4.39.0` `lib/version.js` `testedVersions` ends with `'1.21.11', '26.1'`.
- `minecraft-protocol@1.68.0` `src/version.js` `supportedVersions` ends with `'26.1'` (`defaultVersion: '26.1'`).
- `minecraft-data@3.117.0` `protocolVersions.json`: `26.1`, `26.1.1`, and `26.1.2` all use protocol **775**. `26.2` is protocol 776 and has **no data set**; `minecraftData('26.2')` is undefined.
- The Mojang version manifest (`piston-meta.mojang.com/.../version_manifest_v2.json`, fetched 2026-10-04) lists latest release `26.3`, plus `26.2` (2026-06-16) and `26.1.2` (2026-04-09). Version JSON for 26.1.2: `javaVersion.majorVersion 25`; server jar SHA-1 `97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51`.
- Adoptium API: Temurin JRE `jdk-25.0.4.1+1`, macOS aarch64, SHA-256 `5b02bcc9…f37e1b`. Both downloads were checksum-verified by `npm run fixture -- setup`.

**Resolved profile:** Java Edition **26.1.2** (protocol 775), vanilla server, Temurin 25.0.4.1, Node 24.21.0.

**Pins:**

- mineflayer 4.39.0
- minecraft-protocol 1.68.0
- minecraft-data 3.117.0
- prismarine-auth 3.1.1
- zod 4.6.5
- TypeScript 7.0.2 (dev)
- @types/node 24.19.1 (dev)

`package.json` `overrides` keep one deduplicated copy of each protocol package (`npm ls` exit 0). Config validation rejects any version that lacks a data set or isn't a Mineflayer-tested major version.

**Live join (real CLI):**

```text
[game] server reports 26.1.2 (protocol 775)
[connect-check] OK version=26.1.2 protocol=775 dimension=overworld position=0.5,-60,0.5 gameMode=survival serverOnlineMode=false
```

The server log shows `Chunkbot joined the game` and then `Chunkbot left the game`.

**Engine, auth, identity:**

- Vanilla `server-26.1.2.jar`.
- `online-mode=false`, bound to `127.0.0.1:25566`, RCON on `127.0.0.1:25576` (confirmed with `lsof`).
- Bot player `Chunkbot` uses offline auth with `trustedOfflineFixture: true`.
- Fixture owner is a separate offline test player, `FixtureOwner`; a second test player is `FixtureGuest`.
- Jake's identity and PrismLauncher client/world were not used or touched. His client PID 6236 was only observed (it listens on `*:54902`).

**Deferred by the plan:** G-01's movement/dig/pickup physics smoke belongs to MB-V1-02, per [v1-research.md](../v1-research.md) (“G-01's first join belongs to foundation; its full physics slice is completed in MB-V1-02”).

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Node 24 / strict TS / npm app; pinned compatible Mineflayer; G-01 version/library part against a separate local server; actual version/engine/auth/identity/pins recorded | **Met** | Section above. `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`. |
| 2 | CLI joins the isolated fixture as a separate bot, waits for spawn and valid world state, reports connection/version/dimension, exits cleanly. Microsoft-auth config and instructions provided. Offline only for a trusted loopback fixture. No auto downgrade. No reuse of the owner's identity. | **Met** for the fixture. The Microsoft path is implemented and unit-tested but **not live-verified** (needs a bot account, see Blockers). | L3/L4 live. `src/game/connection.ts` waits for `spawn` plus a known dimension, finite position, and chunks. The server ping confirms version and protocol before login. `README.md` § Microsoft sign-in. Config rules are tested in `tests/config.test.ts`. A missing token cache gives `auth_required` with exit 4 and **no** network contact (L2 live, unit test). The `onMsaCode` callback throws instead of starting device-code login. The auth mode is always passed explicitly, because the library silently defaults unknown values to offline. Identity-conflict checks run in config, after profile lookup, and on login. |
| 3 | Validated config; generic goal, task, capability, knowledge, predicate, clarification, and action schemas and ports; owner admission; lifecycle and state; terminal control; bounded redacted evidence. No Minecraft objects in model interfaces. No resource or intent enums. | **Met** | `src/config/`, `src/contracts/` (zod schemas and ports). `TaskSpec` has no type field; `type` and `code` fields are rejected (contract tests). A test scans `src/contracts`, `src/goals`, `src/commands`, and `src/telemetry`, and finds no protocol-library imports. `src/telemetry/` handles redaction and bounded JSONL with retention. |
| 4 | `!chunkbot <text>` and `!chunkbot goal <text>` reach the SAME intake. Stop, status, and answer work from the terminal. Stone, armor, follow, and unfamiliar compositions are admitted without handlers. Planner-not-ready is shown, with no fake success. | **Met** | L5 live: “collect stone”, “get resources and make yourself armor” (via `goal`), “follow me”, and a flowers/chest/roof composition each produce `accepted` and then `blocked (planner_not_ready) … No game actions were taken`. The owner received the whispers in game. L8 covers the terminal. Every goal enters through `GoalEngine.submit`. |
| 5 | UUID owner admission online; exact name only in the trusted offline fixture. Other players, spoofed server text, and unprefixed chat are ignored. Empty or oversized instructions fail before replacing work. Replacement cancels old ownership before planning. Correlated answers reject stale replies and never revive cancelled goals. | **Met** (offline path live; UUID path unit-tested) | L7 live: guest `not_owner`, `/tellraw` `system_message`, console `/say` `profileless_message`, and no goal created. L6 live: unprefixed owner chat is ignored. L8 live: empty and 685-character input are rejected while the previous goal stays unchanged. Identity tests cover UUID match, `server_offline_mode`, `self`, `unsigned`, and offline-UUID derivation, cross-checked against minecraft-protocol. Goal-engine tests cover replacement order (`aborted → cleanup → new request`), stale `qN`, and no revival after stop or replacement. |
| 6 | Stop works during joining and all foundation states. Kick, disconnect, death, and dimension change end ownership. Rejoin, respawn, and restart start idle. SIGINT/SIGTERM clean up. Diagnostics work without credentials. Doctor is read-only. | **Met** (lifecycle events live; ending an *active* goal is verified in tests, see Gaps) | L13 live: terminal stop while joining a stalled loopback server closes the join socket (open sockets 1 → 0); exit 0. L14 live: SIGTERM while joining gives exit 0. L15 live: stop on the real fixture during join gives `operator_stop`. L9 live: kill → death → respawn idle; nether teleport → dimension change and back. L10 live: kick → `/reconnect` → idle, nothing resumed. L11 live: SIGINT → exit 0, and the server logs Chunkbot leaving. L12 live: restart shows `goal: idle (no goal yet)`. L16 live: `--no-terminal` kick → clean exit 3. L1 live: doctor causes 0 server logins, and `OPENROUTER_API_KEY` is reported only as set or unset. |
| 7 | README, secret-free examples, ignored runtime and auth storage, typecheck/build/test/doctor scripts, AGENTS updated. Live checks of CLI connection, both surfaces, owner rejection, shutdown/restart, and join cancellation. Foundation is not presented as gameplay. | **Met** | `README.md`, `config/examples/{fixture,microsoft}.json`, `.gitignore` (`var/`, `chunkbot.config.json`, `.env*`), `package.json` scripts, `AGENTS.md` (architecture, runtime constraints, required checks), `scripts/live-check.ts`. |

## Commands and exit codes (final run, rebuilt source)

All commands were run from the repository root with `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH`. Each exit code was captured directly, with output redirected to `var/checks/final/*.log`.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | 0 | Clean install from the lockfile (earlier final pass). |
| `npm run typecheck` | 0 | |
| `npm run build` | 0 | `dist/` rebuilt. |
| `npm test` | 0 | 84 tests, 24 suites, 84 pass, 0 fail. |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | PASS: Node, pins, config, version (26.1.2 → data 26.1, protocol 775), auth, storage, fixture. WARN: planner, Jev, and skills not installed. |
| `npm run doctor -- --config config/examples/microsoft.json` | 0 | WARN: no bot token cache; tells the operator to run `auth login`. |
| `npm run doctor` (no `chunkbot.config.json`) | 1 | FAIL: cannot read configuration file (ENOENT). |
| `node dist/cli.js connect-check --config config/examples/fixture.json` | 0 | `OK version=26.1.2 protocol=775 dimension=overworld`. |
| `npm run live-check` | 0 | 16/16 passed. Report: `var/live-check/2026-10-05T00-09-51-615Z/report.json` plus per-process transcripts. |
| `npm run fixture -- setup --accept-eula` / `start` / `status` | 0 / 0 / 0 | Ready: 26.1.2 (protocol 775), PID 28565. |
| `npm run fixture -- stop`, then `status`, then `start`, then `connect-check` | 0 / 0 / 0 / 0 | Handoff check of the stop/restart commands. Graceful RCON stop of 28565; `process: not running`; restart as PID 31385; `[connect-check] OK version=26.1.2 protocol=775`. |

### Live scenarios (`scripts/live-check.ts`, real `dist/cli.js` child process)

| ID | Scenario | Key observed lines |
| --- | --- | --- |
| L1 | doctor is read-only | Fixture exit 0; invalid config exit 1 with `bot.trustedOfflineFixture: …`; 0 server logins. |
| L2 | Failures before joining | Offline + `192.0.2.10` → exit 1 `offline auth is only allowed for a loopback host` and `No connection was attempted.` Microsoft without a cache → exit 4 `auth_required … (no automatic sign-in)`. 0 server logins. |
| L3 | connect-check | Exit 0. Server log shows `Chunkbot joined the game`, then `Chunkbot left the game`. |
| L4 | run starts idle | `ready: version=26.1.2 protocol=775 dimension=overworld … — idle`; `[status] goal: idle (no goal yet)`. |
| L5 | Same intake from chat | Four goals `accepted` → `blocked (planner_not_ready)`. Owner received `Chunkbot whispers to you: Goal … accepted: "collect stone"`. |
| L6 | Chat controls | Status whisper `Status: ready, goal blocked (planner_not_ready), planner not ready, 0 capabilities`. `answer q1` → `no pending question`. `stop` → `Nothing to stop`. Unprefixed chat produced nothing. |
| L7 | Rejections | `ignored player … (not_owner)`, `ignored system … (system_message)`, `ignored profileless … (profileless_message)`. No goals. |
| L8 | Terminal surface | Goal accepted/blocked. `instruction is empty; nothing was changed`. `instruction has 685 characters; the limit is 500; nothing was changed`. Status still shows the previous goal. |
| L9 | Death and dimension | RCON `kill` → `bot died; no active goal` → `respawned in overworld; idle (goals never auto-resume)`. Nether teleport → `dimension changed overworld -> the_nether`, then back. |
| L10 | Kick and reconnect | `connection ended (kicked): Live check kick`. Goal rejected `not connected`. `/reconnect` → ready; status shows the previous goal still terminal. |
| L11 | SIGINT | `received SIGINT` → `shutdown complete`, exit 0, `Chunkbot left the game`. |
| L12 | Restart | Fresh process `goal: idle (no goal yet)`; `/quit` exit 0. |
| L13 | Stop while joining | Stalled loopback server had 1 open socket → `stop: cancelling join…` → `connection ended (operator_stop)` → 0 open sockets; exit 0. |
| L14 | SIGTERM while joining | `received SIGTERM` → `shutdown complete`; exit 0; sockets closed. |
| L15 | Stop while joining the real fixture | `connection ended (operator_stop): join cancelled by operator`; exit 0. This race was won in both runs; the harness records the outcome either way. |
| L16 | `--no-terminal` | Kick → `no operator terminal, shutting down` → exit 3. |

### Evidence hygiene (checked after the run)

- Main-run `events.jsonl` has 0 matches for rejected or unrelated chat text (`spoofed|come here|hello chunkbot`).
- The fixture RCON password appears in 0 files under `var/runs`, `var/live-check`, `var/checks`, `docs`, `src`, `scripts`, `config`, `README.md`, or `AGENTS.md`. It exists only in `var/fixture/server/server.properties` (mode 0600, git-ignored).
- No provider inference was performed, and no model credentials were used.

## Coordinator review findings addressed

Codex recorded these in [v1-foundation-plan.md](../v1-foundation-plan.md#coordinator-review-findings). I fixed them in this session; acceptance remains with Codex.

- **MB-FND-001** (late authentication completion after join timeout).
  - Every pre-login await (status ping and cached-profile lookup) is now raced against the join's own settlement. Timeout, stop, or abort settles immediately, without waiting for an auth call that can't be aborted.
  - Each continuation is fenced by `ownsJoin()`: same epoch, still `joining`, not settled, not aborted. Late results are discarded, and no client is ever created after settlement.
  - `endedError(epoch)` and a per-attempt `endedForThisJoin` mean a stale attempt can't read or await a replacement connection's state.
  - A sibling race was also fenced: a join that times out while the spawn handler awaits chunks can no longer report `ready`.
  - Tests in `tests/connection.test.ts`, section “late completions never take ownership (MB-FND-001)”:
    - delayed-profile timeout: settles under 60 ms, and 0 bots exist after the lookup finishes
    - late lookup vs. replacement connection: one bot, epoch 2, ready
    - abort during a slow lookup
    - timeout during chunk load with a slow socket close: no `ready` event
  - The new tests failed before the fix (3 failures observed). The chunk-load test was confirmed to fail with the fence removed and pass with it.
- **MB-FND-002** (goal admitted while shutdown cleanup is pending).
  - `GoalEngine.shutdown()` now sets `closed` synchronously, before any await.
  - Submissions that arrive during shutdown are rejected with `shutting_down`. One already waiting on replacement cleanup is `superseded`.
  - `answer` is refused once closed. `ChunkbotApp.shutdown` aborts joining before awaiting engine cleanup.
  - Tests in `tests/goal-engine.test.ts`: the coordinator's overlapping shutdown/admission scenario, plus a pre-existing pending replacement. Both failed before the fix.

## Decisions and assumptions (routine, reversible)

- **Minecraft EULA**: `npm run fixture -- setup --accept-eula` wrote `eula=true` for the task-local fixture server only. A vanilla server can't run without it, and Jake authorized a separate local test server. This is recorded here for Codex and Jake's visibility.
- **Fixture world**: vanilla 26.1.2, flat, peaceful, survival, `spawn-protection=0`, `pause-when-empty-seconds=-1`, port 25566 (not the default 25565), RCON with a random password. MB-V1-02 may want normal terrain for G-04/G-05; `level-type` can be changed with a world reset.
- **Tooling**:
  - TypeScript 7.0.2, the current stable release (since 2026-07). It typechecks the whole tree cleanly.
  - Built-in `node:test` running `.ts` directly through Node 24 type stripping, so there is no test-framework dependency.
  - JSON config files.
- **Chat semantics**:
  - The reserved first words (`stop`, `status`, `answer`, `goal`) are controls whatever follows them; for example, `!chunkbot stop following me` stops. Use `goal …` to send such text as an instruction.
  - Operator-only terminal commands are slash-prefixed (`/quit`, `/reconnect`, `/help`).
  - Replies are whispered to the owner (`chat.replyMode`).
- **Clarification correlation**:
  - Questions get run-unique refs `q1`, `q2`, …. `answer qN …` must match the pending question, otherwise it is rejected as `stale_reference`.
  - A bare `answer …` applies to the current pending question. Requiring the ref would close the remaining ambiguity; that is an easy change if Codex prefers it.
- **Terminal mapping**:
  - Stop, replacement, and shutdown → `cancelled`.
  - Not-ready, limit, invalid proposal, or cannot-execute → `blocked`.
  - Death, disconnect, kick, dimension change, or planner error → `failed`, with the typed reason.
- **Online identity**:
  - The sender UUID comes from the player-chat packet.
  - With Microsoft auth, chat admission is refused if the server did not do online-mode (encrypted) login, because UUIDs on offline-mode servers are spoofable.
  - `chat.requireSignedChat` defaults to `false`. Set it to `true` to also require library-verified signatures; this is untested against a real secure-chat server.
- Goals are rejected (`not_connected`) unless the connection is `ready`.
- `run --no-terminal` exits 3 when the connection ends; the default terminal mode stays alive for `/reconnect`.
- The status ping uses a small abortable implementation (`src/game/ping.ts`) instead of the library helper, so stop releases its socket immediately.

## Gaps, blockers, and recommendations

1. **External dependency: the bot's Microsoft account.**
   - Implemented and unit-tested: online auth, `auth login` (device code), cached-session reuse, identity-conflict refusal, and UUID admission.
   - Not live-verified, because the bot-account details and online-mode target have not been provided.
   - Recommendation: when Jake provides a separate Java-owning Microsoft account for the bot and a target server, run:
     1. `auth login`
     2. `connect-check`
     3. an owner-UUID chat check on an online-mode test server
2. **Version mismatch with Jake's current client.**
   - Codex observed Jake's running client as **26.2**.
   - The installed stack supports at most 26.1.x; 26.2 and 26.3 have no protocol data in minecraft-data 3.117.0.
   - Shared play therefore needs one of these, which is Jake's decision:
     - a 26.1.2 PrismLauncher instance for Jake (recommended; it's the smallest change)
     - waiting for upstream Mineflayer 26.2+ support and re-pinning
     - a protocol-translation layer on the server
3. **Stopping an *active* goal live.** With no planner installed, every live goal is blocked immediately, so live runs only show stop, death, dimension change, and kick against an idle or terminal goal. These are verified with real planner-port timing in `tests/goal-engine.test.ts` and `tests/app.test.ts`:
   - stop or replacement during planning and while awaiting the owner
   - death, disconnect, kick, or dimension change while a goal is active
   - shutdown while a goal is active
   Live coverage arrives with MB-V1-04.
4. **Actuator cleanup.** The 250 ms control-clear target applies to skill leases, which don't exist yet. `GoalEngine.registerCleanup(epoch, fn)` is the seam later work uses.
5. Doctor reports a missing config file as “invalid configuration: 1 problem(s) … ENOENT”. The behavior is correct, but the wording could be clearer.

## Changed paths

New files:

- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `README.md`
- `config/examples/fixture.json`, `config/examples/microsoft.json`
- `src/cli.ts`
- `src/app/{app,doctor,status,fixture-layout}.ts`
- `src/config/{schema,load,versions}.ts`
- `src/contracts/{index,ids,common,states,goal,task,selector,predicate,capability,knowledge,planner,clarification,action,observation,ports}.ts`
- `src/goals/{goal-engine,proposal,not-ready}.ts`
- `src/commands/{parse,router}.ts`
- `src/game/{connection,identity,auth,ping}.ts`
- `src/telemetry/{redact,run-store}.ts`
- `tests/{helpers,goal-engine,config,parse,identity,evidence,contracts,app,connection,ping}.test.ts` (`helpers` is `tests/helpers.ts`)
- `scripts/{fixture,live-check,clean-dist}.ts`, `scripts/lib/rcon.ts`
- `docs/reviews/mb-v1-01-foundation.md` (this file)

Edited: `AGENTS.md`. The stack sentence and the “documentation only” state paragraph were replaced, and Application architecture, Runtime constraints, and Required checks sections were added. The coordination content is preserved.

Not edited: `agent-workflow.md`, `docs/agent-supervision.md`, `feature-plans.md`, `docs/v1-*.md`, and the G-02/G-03 review files.

Generated and ignored: `node_modules/`, `dist/`, and `var/` (fixture, runs, live-check, checks).

## Fixture operations

```sh
export PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH
npm run fixture -- status     # PID 31385 at handoff; 26.1.2 / protocol 775
npm run fixture -- stop       # graceful RCON stop; SIGTERM fallback only for our own verified PID
npm run fixture -- start      # restart; waits until it answers pings
npm run build && npm run live-check
```
