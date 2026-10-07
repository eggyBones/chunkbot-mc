# Chunkbot

Chunkbot joins a Minecraft **Java Edition** server as its own player and accepts open-ended, natural-language goals from its owner, in game chat (`!chunkbot …`) or on the local terminal.

**Current state: foundation (MB-V1-01), skill layer (MB-V1-02), generic Jev task controller (MB-V1-03) and the Codex subscription gameplay planner on normal goal intake (MB-V1-04, independently accepted; final V1 delivery pending).** Chunkbot connects, identifies its owner, and admits arbitrary instructions through one goal intake (owner chat or terminal). An isolated Codex **subscription** planner turn interprets the instruction, may ask read-only knowledge questions or one useful clarification, and proposes a declarative outcome plus a short window of generic tasks. Code validates every proposal (schema, catalog, registry/recipes, shown references, owner-typed coordinates, no code/limit fields) before any action. The generic task runtime then lets real Jev decisions (OpenRouter) choose among grounded skill candidates, and code verifies results. The goal completes only when code verifies its outcome; otherwise Chunkbot replans with verified feedback, within bounded turns, tasks, replans and deadline. Operator diagnostics (`/diag`, `/task`) remain terminal-only. Chunkbot never reports success it did not achieve.

See [feature-plans.md](feature-plans.md) and [docs/v1-foundation-plan.md](docs/v1-foundation-plan.md) for scope.

Chunkbot also has a local dashboard, smooth directive handoff, and optional persistent gameplay memory. These were implemented by three parallel native Claude Opus 5.5 workers through [the agent workflow](agent-workflow.md). Automatic progression, survival/death recovery, and live update management remain separate roadmap work.

## Requirements

| Component | Version / pin | Notes |
| --- | --- | --- |
| Node.js | 24 LTS (verified with 24.21.0) | `engines: >=24 <25` |
| Minecraft Java server | **26.1.x (protocol 775)**, upstream-tested; **exactly 26.2 (protocol 776)** through the local compatibility profile MB-SERVER-001 | Fixtures run vanilla **26.1.2** and, separately, vanilla **26.2**. 26.2 support is a locally verified vendored stack (below), **not** an upstream release and **not** Mineflayer-tested. 26.2.x point releases, 26.3 and later are unsupported. |
| mineflayer | 4.39.0 (vendored build `4.39.0+chunkbot.26.2.1`) | exact pins; one deduplicated copy of each protocol package |
| minecraft-protocol | 1.68.0 | released package, unmodified |
| minecraft-data | 3.117.0 (vendored build `3.117.0+chunkbot.26.2.1`) | |
| prismarine-chunk / prismarine-physics | 1.41.0 / 1.11.1 (vendored builds `+chunkbot.26.2.1`) | |
| prismarine-auth | 3.1.1 | Microsoft auth token cache |
| mineflayer-pathfinder | 2.4.5 | conservative walking only (no digging, placing, towers, parkour or doors) |
| prismarine-block / prismarine-item / vec3 | 1.23.0 / 1.18.0 / 0.1.10 | block shapes, item packets, vectors (same copies Mineflayer uses) |
| zod | 4.6.5 | contract and config validation |
| TypeScript | 7.0.2 (dev) | strict, erasable syntax only |

### Vendored 26.2 compatibility stack (MB-SERVER-001)

No released PrismarineJS version supports Minecraft 26.2 yet. `vendor/` holds four rebuilt npm tarballs that `package.json` installs with `file:` specs and `overrides` (so every transitive consumer gets the same single copy), pinned by sha512 in `package-lock.json`. `npm ci` fails with `EINTEGRITY` if a byte differs. Nothing is hand-edited in `node_modules`.

| Package | Base (registry tarball, sha512-verified) | Changes |
| --- | --- | --- |
| minecraft-data | 3.117.0 | 26.2 data from the first-party `pc_26_2` branch at `68ea7b59` (PrismarineJS/minecraft-data#1298), each file verified by git blob SHA-1; `pc."26.2"` in dataPaths, `26.2` in versions; attribute key mapper corrected at the official numeric ids: 26.1 by the exact upstream #1254 hunks (`23303d23`), 26.2 derived from the official 26.2 registry (MB-SERVER-002) |
| prismarine-chunk | 1.41.0 | PrismarineJS/prismarine-chunk#333 (26.2 uses the 1.18 chunk implementation) |
| prismarine-physics | 1.11.1 | PrismarineJS/prismarine-physics#143 (26.2 liquid gravity feature) |
| mineflayer | 4.39.0 | PrismarineJS/mineflayer#4121 (`26.2` in testedVersions: a local admission, never reported as Mineflayer testing) and an MB-SERVER-002 fix that also stores decoded attributes under their registry resource (`minecraft:movement_speed`), so server movement speed reaches physics |

Inputs are recorded in `vendor/compat-sources.json`, outputs in `vendor/compat-lock.json`. `npm run vendor-compat -- --check` rebuilds every tarball from the pinned inputs and compares the bytes. `npm run verify-version-data [-- --fixture 26.2]` compares the installed codec and registries (every block state, items, entities, data components, particles, attributes, packet ids) with Mojang's own data-generator reports from the pinned jar. Chunkbot admits 26.2 only when all four vendored builds are installed (`doctor` reports the support level). Details: [docs/reviews/mb-server-001-compatibility.md](docs/reviews/mb-server-001-compatibility.md).

On this machine the generic Homebrew `node` is broken (missing dylib). Put the keg-only Node 24 first in `PATH` for every command:

```sh
export PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH
```

## Install, build, and check

```sh
git clone https://github.com/eggyBones/chunkbot-mc.git
cd chunkbot-mc
npm ci                 # install exact locked dependencies
npm run typecheck      # tsc --noEmit over src, tests, scripts
npm run build          # clean dist/ and compile src/ -> dist/
npm test               # node:test unit/integration tests (no network, no models)
npm run doctor -- --config config/examples/fixture.json   # read-only diagnostics (needs build)
```

`npm run check` runs typecheck, build, and tests in order.

## Configuration

Configuration is JSON validated at startup. Invalid configuration fails **before connecting**, with a field-specific error that never echoes the value.

- `config/examples/fixture.json`: trusted local test fixture (loopback, offline auth).
- `config/examples/microsoft.json`: online template. Copy it to `chunkbot.config.json` (git-ignored) or pass `--config <file>`. `CHUNKBOT_CONFIG` also works.

Key rules:

- `bot.auth` is `microsoft` or `offline`. Chunkbot never downgrades auth automatically.
- **Offline** auth requires both `bot.trustedOfflineFixture: true` and a loopback `minecraft.host` (`127.0.0.1`, `::1`, or `localhost`). Owner admission uses the exact `owner.name` and is allowed **only** in this fixture.
- **Microsoft** auth requires `owner.uuid`. Owner chat is admitted only when the player-chat packet's sender UUID matches it. On an offline-mode server that UUID cannot be verified, so chat commands are refused. Set `chat.requireSignedChat: true` to require library-verified chat signatures as well.
- The bot must be a **separate player**. Config validation rejects an offline bot name equal to the owner's name. The connection refuses a signed-in profile whose UUID matches the owner.
- Secrets never go in config files. Unknown fields such as `apiKey` are rejected. `models.decision.apiKeyEnv` (default `OPENROUTER_API_KEY`) names the environment variable that holds the OpenRouter key; Chunkbot reads it per request and never prints or stores it.
- `models.decision`: `model` (default `typesafe/jev-1.13`), `expectedProvider` (default `TypeSafe`; responses from any other provider fail closed), and `endpoint` (the OpenRouter Decisions route; only a **loopback** URL may replace it, for local provider fault fixtures).
- `limits.openRouterSpendCapUsd` (default 1) is the OpenRouter spend cap **per application run**. Other Jev limits: `decisionMaxOptions` 8, `decisionMinIntervalMs` 1000, `decisionTimeoutMs` 5000, `decisionRequestsPerGoal` 1200, one request in flight.
- `models.planner`: `mode` `codex` (default; the real Codex subscription planner) or `disabled` (explicit **inference-free profile** used by the foundation/skills/controller checks; goals end `planner_not_ready`), `command` (default `codex`, resolved on `PATH`), `model` (only `gpt-6.1-sol`, the model the isolation profile was verified for) and `reasoningEffort` (`low` default; `medium`/`high` allowed). `config/examples/fixture-inference-free.json` is the fixture with the planner disabled.
- Planner limits: `plannerTurnsPerGoal` 20 (every turn kind counts), `plannerTimeoutMs` 45000 per turn, `planWindowSteps` 8, `totalTaskCeiling` 64, `replans` 8, `goalDeadlineMs` 20 min.
- `limits` default to the architecture plan's provisional values.
- `storage.dataDir` (default `var/`, git-ignored) holds run evidence and auth caches.
- `flow` defaults to `{ "handoff": "smooth", "lookahead": true, "preparationTurnsPerRun": 40 }`. A new instruction prepares while the current task continues; only a validated, freshly grounded plan can take ownership. `handoff: "immediate"` cancels the old goal before planning. Lookahead prepares the next window while the last task runs, within the same goal's limits. Discarded preparations have a separate bounded allowance.
- Persistent memory is disabled unless explicitly configured. See the memory setup below; an endpoint alone does not identify a world.

### Microsoft sign-in for online play

1. Get a **separate Microsoft account that owns Minecraft Java Edition** for the bot. Do not use the owner's account; Chunkbot refuses to run as the owner's identity.
2. In your config, set `bot.auth: "microsoft"`, set `bot.username` to a local label for the token cache (for example `chunkbot-bot`), and set `owner.uuid` to the owner's Minecraft UUID. Set `minecraft.version` to the server's exact version (a 26.1.x release, or exactly `26.2`); Chunkbot refuses to log in when the server's status ping reports a different protocol.
3. Sign in explicitly. This is the only command that starts the Microsoft device-code flow:

   ```sh
   npm run chunkbot -- auth login --config chunkbot.config.json
   ```

   Open the URL shown, enter the code, and sign in as the **bot** account. Tokens are cached in `var/auth/microsoft/`, which is git-ignored.
4. `run` and `connect-check` use only that cache. If it is missing or expired, they stop with `auth_required` (`connect-check` exit 4). They never start sign-in, request a device code, or fall back to offline auth.

## Running

### Local Mac shortcuts

On Jake's configured Mac, double-click these files in Finder or run them from this repository:

```sh
./play.command       # start Chunkbot and open the dashboard; reuse an existing session
./dashboard.command  # open the dashboard without logging the bot in
./logout.command     # log the bot out; keep the dashboard open
```

The dashboard for this installation is <http://127.0.0.1:7382/>. Chunkbot runs in the background, so closing the launch terminal leaves him online. Give him goals in Minecraft with `!chunkbot ...`; `!chunkbot stop` stops gameplay while `logout.command` disconnects him.

The shortcuts use the registered accepted release, your private world config and saved bot login. The ignored `var/live-chunkbot/operator-profile.json` is already installed on this Mac; another machine needs its own registration described in [the local controls review](docs/reviews/mb-ops-002-local-controls.md). Credentials come from the environment or the local vault helper. Starting an existing session preserves its process and spending budget; starting after logout creates a fresh run. These shortcuts do not install updates or reconnect automatically.

Read-only status: `python3 -B scripts/play-controls.py status`. Add `--no-open` to a shortcut to skip opening a browser.

### Application CLI

```sh
npm run chunkbot -- connect-check --config <file>   # join, report version/dimension, leave, exit
npm run chunkbot -- run --config <file>             # join and accept owner commands
npm run chunkbot -- doctor --config <file> [--json] # read-only diagnostics
npm run chunkbot -- auth login --config <file>      # explicit bot sign-in (Microsoft configs only)
npm run chunkbot -- catalog --config <file> [--json]            # capability catalog from the registered skills (offline)
npm run chunkbot -- knowledge '<query json>' --config <file>    # one version-knowledge query (offline, read-only)
npm run chunkbot -- jev-check --config <file> [--json]          # ONE live Jev decision through the real adapter (~USD 0.00002)
npm run chunkbot -- planner-check --config <file> [--probe]     # isolation/auth gate + ONE isolated Codex subscription turn (+ tool-exposure and cancellation probes)
npm run chunkbot -- dashboard --config <file> [--port 7381]    # local read-only viewer; never joins Minecraft
npm run chunkbot -- memory --config <file> [--json]             # inspect saved memory without connecting or changing it
```

`planner-check` exit codes: `0` ok, `8` planner gate not ready (version/auth/catalog/feature/neutral-dir check failed), `9` planner turn or probe failed.

`jev-check` exit codes: `0` valid decision, `6` key env var not set (no request sent), `7` provider failure (explicit kind printed). It proves only the provider route, model and billing fields, not gameplay.

`connect-check` exit codes: `0` ready, `1` invalid config, `3` connection failed, `4` Microsoft sign-in required, `5` bot identity equals owner. `run` exits `0` after a clean shutdown.

`knowledge` answers queries such as `{"kind":"recipe","output":"minecraft:furnace"}`, `{"kind":"harvest","block":"minecraft:stone"}`, or `{"kind":"fuel","item":"minecraft:oak_planks"}`. Recipe, tag, and fuel mechanics come from data extracted from the official server jar of each exact release: `src/knowledge/data/vanilla-26.1.2.ts` and `vanilla-26.2.ts` (`npm run extract-version-data [-- --fixture 26.2]` regenerates them). They are answered **only for exactly 26.1.2 or exactly 26.2**, each from its own jar. Other 26.1.x releases share the network protocol, but report those mechanics `unavailable`. Unknown items stay `unknown`.

`run` reads terminal commands from stdin by default. End of input (Ctrl-D or a closed pipe) is treated as `/quit`. To run without a terminal, use `run --no-terminal`, for example in the background. In that mode Chunkbot cannot `/reconnect`, so it shuts down cleanly and exits `3` when the connection ends. Signals still shut it down with exit `0`.

`doctor` checks Node, package pins, config validity, version support, auth cache presence, storage, model-route binaries/env-var presence (never values), the planner's read-only gate (CLI version, managed-auth MODE via `codex login status`, bundled catalog entry, neutral directory), adapter readiness, and the local fixture. It never joins a server, signs in, calls a model, or writes files; the planner feature gate (which loads the account's cloud configuration) runs only at application startup and in `planner-check`. It exits `1` only when something fails; warnings describe readiness gaps.

### Commands

In Minecraft chat, only the owner's prefixed messages are commands. In the terminal, use the same words without the prefix (`!chunkbot …` is accepted too).

| Chat | Terminal | Effect |
| --- | --- | --- |
| `!chunkbot <any instruction>` | `<any instruction>` | Prepare a new goal while the current task continues, then switch after validation. |
| `!chunkbot goal <instruction>` | `goal <instruction>` | Explicit alias for the same intake. Use it when the text starts with a reserved word. |
| `!chunkbot stop` | `stop` | Stops current and pending work, and latches automatic behavior paused. While joining, stops the join. |
| `!chunkbot resume` | `resume` | Clears the automatic pause latch; does not replay a goal or reconnect. |
| `!chunkbot status` | `status` | Shows connection, goal, and adapter readiness. Runs no inference. |
| `!chunkbot answer [qN] <reply>` | `answer [qN] <reply>` | Answers the pending clarification question `qN`. |
| — | `/reconnect`, `/quit`, `/help` | Operator-only terminal commands. |
| — | `/diag …` | Operator mechanic diagnostics (below). Terminal only; the same text in chat is an ordinary instruction. |
| — | `/task [maintain] <TaskSpec json>` | Operator task-controller diagnostic with real Jev choices (below). Terminal only. |

Instructions are never keyword-gated or matched to built-in handlers. “collect stone”, “make yourself armor”, “follow me”, and new combinations all reach the same intake. Reserved first words are `stop`, `status`, `answer`, and `goal`.

Only a bare `resume` is a control command; “resume mining” is an ordinary instruction. Manual goals remain allowed while automatic behavior is paused. Rapid replacement instructions keep only the newest preparation. Stop, disconnect and death revoke pending work as well as the active owner.

Chunkbot rejects empty instructions and instructions longer than `chat.maxInstructionChars` (default 500) **before** touching the current goal. Unprefixed chat, other players, `/tellraw`, console `/say`, and Chunkbot's own messages are ignored. Their text is not stored.

### Dashboard

Start the viewer in another terminal, using the same config and data directory as the app:

```sh
npm run chunkbot -- dashboard --config chunkbot.config.json
```

Open <http://127.0.0.1:7381/>. It shows health and actual maximum health, hunger, XP, inventory/equipment, the directive and task, pending preparation, saved memory, model readiness, token usage and dated usage history. Confirmed charges, uncertain retained charges, pending reservations and the remaining local run cap are separate. Missing usage stays unknown; disconnected or stopped readings are marked historical.

The viewer is read-only and binds to loopback. Several tabs share the same bounded reads. Closing it leaves the bot running; starting it does not join Minecraft. Use `--port <number>` if the default port is occupied.

Optional account metadata shows the current OpenRouter key's usage/limit when its configured environment variable is present, and the quota windows actually returned by the pinned Codex CLI. These are account-wide observations, separate from Chunkbot's local spending cap. An OpenRouter wallet balance is unavailable without a management key. `--no-openrouter-key` and `--no-codex-quota` disable those reads; unsupported or unavailable reads do not prevent the dashboard from working.

### Persistent memory

Add an explicit scope to your private config:

```json
"memory": {
  "enabled": true,
  "worldProfile": "my-world",
  "worldRevision": 1,
  "botProfile": "chunkbot",
  "dir": "memory"
}
```

`config/examples/fixture-memory.json` is a complete loopback example. Give each distinct world a different profile; increment the revision when a world is reset. A changed endpoint is refused for the same scope unless `rebindEndpoint: true` explicitly identifies a move of that same world.

Use ordinary goals such as “remember this spot as home,” “go home,” or “forget home.” The planner uses bounded, request-scoped references to saved locations. Chunkbot retains grounded places, verified construction progress and outcomes, historical container contents, and death incident evidence under the ignored data directory. It inspects a container again before using remembered contents; contradictory visible evidence revises memory. Unverified notes stay separate from confirmed facts.

Saved facts survive restart. They do not resume actions, reconnect, clear pause, or perform automatic death recovery. `npm run chunkbot -- memory --config chunkbot.config.json` inspects the store without starting gameplay. Corrupt, incompatible or conflicting stores are reported and cannot be silently overwritten with empty memory.

### Operator mechanic diagnostics (`/diag`)

The skill layer can also be exercised through explicit terminal diagnostics. They run the **same** registered skill definitions, candidate resolvers, executor, actuator lease, perception, knowledge, and predicate evaluator that goal execution will use. Every step is chosen by the operator, and no model is called.

| Terminal | Effect |
| --- | --- |
| `/diag catalog` | Capability catalog (ids, families) generated from the registered skills. |
| `/diag observe` | Bounded line-of-sight observation snapshot (blocks, entities, drops, frontiers, owner, inventory). |
| `/diag knowledge <query json>` | Version-knowledge answer. |
| `/diag candidates <TaskSpec json>` | Grounded candidates for a generic task, or structured reasons why none exist. |
| `/diag run <act-id>` | Execute one candidate from the last set. |
| `/diag do <capability> <params json>` | Execute one action with explicit parameters (validated against its schema). |
| `/diag inventory` | Server-confirmed inventory. |
| `/diag bind <name> <predicate json>` / `/diag eval <name>` | Bind predicate baselines now, then evaluate the predicate later. |
| `/diag anchor` | Set the diagnostic travel anchor at the current position. It does not replace the current goal's anchor, which is captured at goal admission. |

`stop` (terminal or owner chat) cancels a running diagnostic action. An admitted owner goal replaces it. Each diagnostic also prints a machine-readable `[diag-json]` line. Skills never dig, place, or tower to move. They act only on visible targets within reach, stay inside the travel radius around the anchor, and report missing tools, ingredients, workstations, fuel, targets, or paths as evidence. They do not chain prerequisites themselves.

### Operator task-controller diagnostics (`/task`)

`/task <TaskSpec json>` admits one **operator-written** generic `TaskSpec` (objective, decision instruction, allowed capabilities, target selectors, parameters, completion predicate) through the same validation, replacement, epoch, travel-anchor admission and stop path as a goal. It is labeled `operator_task_diagnostic` and is never natural-language goal planning. The generic task runtime then loops:

1. observe (filtered line-of-sight snapshot) and evaluate the completion predicate in code;
2. generate candidates through the **registered resolvers** of the allowed capabilities only;
3. freeze up to `decisionMaxOptions` options and ask Jev for exactly one code-generated ID;
4. after the reply, recheck ownership, then revalidate the choice against a fresh snapshot through the same resolvers;
5. execute it through the accepted skill executor and validate the outcome identity.

The task completes only when its completion predicate is verified. When no allowed capability has a grounded option, it ends `blocked` with the resolvers' structured reasons (for example `harvest_tool_missing`, `workstation_required`, `missing_ingredients`, `no_visible_target`, `no_safe_path`). Other guards: per-target retries, the no-progress window, low health, the per-goal Jev allowance and the run spend cap.

`/task maintain <TaskSpec json>` treats the completion predicate as a condition to keep (for example near the owner). While it holds, Chunkbot holds locally with no inference. Sustained skills (`follow_entity`, `furnace_wait`) continue locally while their wait window simply elapses. Stop and replacement work as for goals. Each step prints a `[task-json]` line, and run evidence records the request, offered options, choice, actual model, usage/cost, latency, action and verified result. Diagnostic notices are terminal-only; they are not whispered in game.

Example:

```text
/task {"objective":"Collect three oak logs from the visible tree.","decisionInstruction":"Mine visible logs and pick up dropped logs.","allowedCapabilities":["mine_block","move_near","pickup_item"],"targetSelectors":[{"kind":"registry","key":"#minecraft:logs"}],"completion":{"predicate":"inventory_delta","selector":"#minecraft:logs","atLeast":3,"mayBeConsumedLater":true}}
```

### Gameplay planner (Codex subscription)

Every natural-language goal (chat `!chunkbot …` or terminal) goes to one isolated planner turn per step of reasoning:

- **Route:** the installed `codex exec` CLI (pinned **0.160.0**) with the **managed ChatGPT subscription** login only. Before startup and before **every** turn, `codex login status` (read-only, pinned `file` credentials store, the same store exec uses) must report ChatGPT; a persisted API key, no login, or any other mode is refused before inference with mode-only evidence. Chunkbot never logs in/out, copies tokens, changes accounts/settings, or falls back to API billing or another model.
- **Model identity:** `gpt-6.1-sol`, effort `low`, explicitly selected. The CLI JSON stream does **not** echo a server-resolved model; any "model rerouted" event rejects the turn and disables the planner for the run.
- **Isolation** (verified at startup, fail-closed on any other CLI version or changed registration metadata): a scoped model catalog with only the selected entry's tool exposure restricted (shell disabled, apply-patch absent, experimental tools empty, search tool off, direct tool mode); 40 feature states verified with `codex features list` (`unified_exec` cannot be disabled by config in 0.160.0 and is accepted only because `shell_tool` is off and the model shell type is disabled); `agents.enabled=false` (removes the collaboration tools the catalog's multi-agent metadata would otherwise register); no MCP servers, memories, skills, apps, project docs or environment/permissions/collaboration instructions; gameplay-only base instructions; read-only sandbox, approval never, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--no-daemon`; an app-owned neutral working directory outside any development instructions (`$TMPDIR/chunkbot-planner-<uid>`, with app-owned sqlite state); an environment **allowlist** (never API keys, tokens, sessions or the Jev key).
- **Stream validation:** only `agent_message`, `reasoning` (never read or stored) and `error` items are allowed. Any tool/agent item (command execution, file change, MCP/collaboration call, web search, todo list, or an unknown type) rejects the turn even if a valid answer follows, and disables the planner for the run.
- **Process ownership:** each turn runs in its own process group; the tree is observed while it runs and proven descendants are retained by identity (pid + start time), so stop/replacement/timeout/death cleanup kills the group and attributable children that left it, verifies nothing owned remains, and never touches other processes.
- **Proposals:** a strict output schema generated from the implemented catalog; dispositions `plan`, `needs_information` (read-only knowledge queries), `needs_clarification` (one question; Chunkbot stays put and makes no calls until `answer qN …`), `cannot_execute` (the exact missing mechanic). Rejected proposals cause no action; the planner gets at most 2 consecutive repair turns.
- **Outcome contract:** bound once to the server-confirmed inventory captured at goal **admission** (all items) and immutable across knowledge rounds, clarifications, windows and replans. Task/window completion never completes a goal; code evaluates the outcome after each window.

Evidence: `var/runs/<run-id>/planner.jsonl` (interpretations, accepted/rejected proposals, questions/answers, final predicate evidence; no reasoning or secrets) next to `events.jsonl` (turn timing/usage, isolation checks, process cleanup).

### Jev decisions and spend

The adapter sends raw HTTP `POST https://openrouter.ai/api/alpha/decisions` with `provider.allow_fallbacks: false` and the proven price ceiling `max_price {prompt: 0.042, completion: 0, request: 0}` (USD per million tokens). Before each attempt, it reserves the route's proven maximum charge: the full serving context of the verified endpoint (32,000 tokens) at the admitted prompt price (USD 0.042/M), which is USD 0.001344. Provider templating overhead is therefore never estimated. The call is refused, with nothing sent, if the remaining per-run budget cannot cover that maximum. This bound exists only for the verified route (`typesafe/jev-1.13` served by TypeSafe); any other configured model or provider is refused. The serialized request body stays separately bounded at 16 KiB.

Settling a reservation:

- **Reconciled** from a trustworthy reported cost.
- **Released** after an explicit 4xx routing rejection.
- **Retained** in full (the serving-context maximum) when the charge is ambiguous: timeout, abort after dispatch, 5xx, or an unreadable response.

Failure handling:

- Timeout, 429 and 5xx get at most one retry, and every attempt counts toward the per-goal allowance.
- 401/403 (auth), 402 (payment), 404 (no endpoint within the price ceiling), 400 and schema errors are explicit failures.
- A different response model or provider, a cost above the ceiling, or input tokens above the bound disable Jev for the rest of the run.
- Credits are never purchased automatically.

- Being kicked, disconnected, killed, or moved to another dimension ends active goal ownership. Respawn, `/reconnect`, and restart start idle; goals never auto-resume.
- `SIGINT`/`SIGTERM` (Ctrl-C), `/quit`, and end of terminal input cancel the goal, disconnect the bot, close evidence, and exit `0`. A second signal forces exit `130`.
- Each run writes redacted, bounded evidence to `var/runs/<run-id>/events.jsonl` and `summary.json`. The newest 20 runs are kept. Secrets, rejected or unrelated chat text, and full UUIDs are not recorded.

## Local test fixture

The fixture is a **separate vanilla 26.1.2 server bound to 127.0.0.1:25566**, with RCON on `127.0.0.1:25576`. It uses offline auth and a flat, peaceful world. Its JRE (Temurin 25.0.4.1), server jar, world, logs, and RCON password are stored in git-ignored `var/fixture/`. Downloads are checksum-verified against pinned values. It does not touch any Minecraft launcher, client, or personal world.

```sh
npm run fixture -- setup --accept-eula   # download/verify JRE + server; accepts the Minecraft EULA for this fixture
npm run fixture -- start                 # start detached; waits until it answers pings; records var/fixture/server.pid
npm run fixture -- status
npm run fixture -- rcon "list"           # console command over loopback RCON
npm run fixture -- stop                  # graceful RCON stop, bounded SIGTERM fallback (only for our own PID)
```

The fixture uses `FixtureOwner` as the owner name and `Chunkbot` as the bot name.

A **second, distinct 26.2 fixture** (MB-SERVER-001) runs vanilla 26.2 on `127.0.0.1:25567` with RCON on `127.0.0.1:25577`. It has its own world, RCON password and PID file under `var/fixture-26.2/`, and the same pinned Temurin 25 JRE (its archive is copied from the 26.1.2 fixture's verified download and re-verified). Every fixture command takes `--fixture 26.2`; without it the 26.1.2 fixture is used:

```sh
npm run fixture -- setup --accept-eula --fixture 26.2
npm run fixture -- start --fixture 26.2   # refuses to start if 25567/25577 are in use
npm run fixture -- stop --fixture 26.2
```

Configs: `config/examples/fixture-26.2.json` (real planner) and `config/examples/fixture-26.2-inference-free.json`.

### Live checks

With the fixture running and `dist/` built, run:

```sh
npm run live-check
```

This drives the real CLI as a child process. It uses separate fixture players (`FixtureOwner`, `FixtureGuest`) and loopback RCON to check:

- doctor and config/auth failures
- connect-check
- both control surfaces
- owner rejection and spoof rejection
- death, dimension change, kick, and reconnect
- SIGINT shutdown and restart
- join cancellation (including a stalled loopback server)

It writes a report and per-process transcripts to `var/live-check/<timestamp>/` and makes no model calls.

The skill layer has its own built-CLI check:

```sh
npm run build && npm run skills-live-check
```

It rebuilds a controlled survival scene inside a reset area of the fixture world over loopback RCON, and records every setup command in the report. It then drives `/diag` against perception (walls, glass, lava/water), knowledge, mining, crafting, furnace use, containers, entities, placement, movement/following, travel bounds (a second session with `travelRadius` 8), and interruption. Server-side truth is checked through serialized RCON queries. The report goes to `var/live-check/<timestamp>-skills/report.json`.

The Jev task controller has its own built-CLI check:

```sh
npm run build && npm run jev-live-check                    # REAL Jev: needs OPENROUTER_API_KEY in the environment
npm run build && npm run jev-live-check -- --provider fault # loopback fault-fixture provider (harness validation only)
```

It drives `/task` diagnostics through these scenarios:

- **Movement:** walk to a visible chest.
- **Mining by hand:** three oak logs.
- **Crafting:** planks, a crafting table and sticks.
- **Interaction:** place the table at a Jev-chosen site, then craft a wooden pickaxe at it.
- **Tool mining:** cobblestone with the pickaxe.
- **Planner feedback:** a missing tool, a missing workstation and a hidden target.
- **Interruption:** stop while a Jev request is in flight.
- **Persistent follow:** follow while the owner moves, then replacement.
- **Quiet states:** natural-language intake stays `planner_not_ready`, and idle makes no calls.

The report links each request, its offered options, the choice, the actual model, cost and latency, the executed action and its verified result. It also includes RCON truth, setup commands and in-trial interventions (recorded separately). It is written to `var/live-check/<timestamp>-jev-<provider>/report.json`. Fault-provider runs are labeled as not Jev acceptance evidence.

The planner has its own built-CLI check, using the **real Codex subscription planner** on normal intake:

```sh
npm run build && npm run planner-live-check                 # REAL planner + REAL Jev: needs OPENROUTER_API_KEY in the environment
npm run build && npm run planner-live-check -- --jev fault  # REAL planner + loopback Jev fault provider (harness validation only)
```

Scenarios: "come here" (chat), a resource goal from an empty inventory (planner-chosen prerequisites), the same goal with a prepared inventory, an ambiguous instruction with correlated clarification and exploration, a novel composition (planks into the chest), persistent following, stone versus cobblestone (furnace), an unsupported mechanic, a removed prerequisite (intervened recovery), stop/replacement during planning with travel anchors, and death during planning. A second CLI process uses a scripted **planner fault fixture** (wrapping the real CLI's read-only gate) for code-bearing/invented references, quota/auth failures, a hanging turn with a child process, the turn limit, a login switched to an API key, a model reroute and a prohibited tool event. Reports go to `var/live-check/<timestamp>-planner-jev-<mode>/report.json`, with setup commands and in-trial interventions recorded separately.

The foundation, skills and Jev controller checks run the inference-free profile (`config/examples/fixture-inference-free.json`).

Every live check accepts `--fixture 26.2` to run against the 26.2 fixture with the matching configs. Reports then go to `var/live-check/<timestamp>-26.2[-kind]/`. The default stays 26.1.2.

`npm run compat-live-check [-- --fixture 26.2]` (built CLI, inference-free) checks MB-SERVER-001/002 directly:

- real attribute packets decode to the server's values at the official ids;
- a server movement-speed change reaches the physics key;
- production pathfinder movement honours the server speed (half speed takes about twice as long, the server confirms the position, and there are no corrections);
- 26.2-only blocks decode with exact properties, in the harness bot and in Chunkbot's perception;
- status reports clean codec health.

`connect-check` and `status` report network codec health (`codec=decoded:N,trailing:T,failed:F`): packets the installed protocol definition could not decode exactly.

## Project layout

```text
src/cli.ts                 CLI entry (run, connect-check, doctor, auth login, catalog, knowledge, jev-check, planner-check), signals
src/app/                   composition root (ChunkbotApp, /task intake), skill runtime (+ task runtime wiring), /diag diagnostics, status, doctor, fixture layout
src/decision/              Jev raw-HTTP adapter, wire validation, price bound, per-run spend ledger, decision context, jev-check
src/tasks/                 generic task runtime (candidates -> Jev -> revalidation -> executor -> verified predicates)
src/config/                config schema/loader, installed-version compatibility (upstream-tested vs local 26.2 profile)
src/contracts/             shared zod schemas + ports (goals, tasks, predicates, capabilities, knowledge, clarification, actions, observations)
src/goals/                 goal engine (lifecycle, epochs, rolling planner/task windows, clarification), proposal validation, owner coordinates, not-ready adapters
src/planner/               Codex subscription planner: isolation/auth gate, owned process groups, turn transport, prompt, strict output schema
src/commands/              chat/terminal parsing and routing to the single intake
src/game/                  Mineflayer connection adapter, server-packet evidence journal, codec-health audit, owner identity, Microsoft auth, abortable status ping
src/perception/            line-of-sight visibility (shapes, see-through blocks, opaque fluids), frontiers, snapshots/handles
src/knowledge/             version knowledge: minecraft-data + recipes/tags/fuels extracted from the exact 26.1.2 and 26.2 server jars
src/skills/                registered skill definitions (descriptor + schema + resolver + executor), conservative navigation
src/execution/             registry/catalog, candidate generator, executor, actuator lease, interface gate, ledger, predicates
src/telemetry/             redaction and bounded JSONL run evidence
tests/                     node:test suites (run directly from TypeScript)
scripts/                   fixture management (26.1.2 and 26.2 profiles), RCON client, live checks (foundation, skills, Jev controller, planner, compatibility), planner fault fixture, version-data extraction and official-report verification, vendored-stack build, build helper
vendor/                    vendored 26.2 compatibility tarballs, their pinned inputs/outputs and recorded patches (MB-SERVER-001/002)
tests/fixtures/            digests of the official 26.1.2 / 26.2 data-generator reports
config/examples/           secret-free configuration examples
```
