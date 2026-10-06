# Chunkbot

## Start here

Read [agent-workflow.md](agent-workflow.md) before planning, implementing, fixing, or continuing project behavior. It contains Jake's standing workflow for this repository.

- Jake owns product direction.
- Codex coordinates planning, worker prompts, supervision, review, and acceptance.
- Claude Code workers perform the main implementation through a local DSH instance using Jake's subscription. The requested model is Claude Opus 5.5; verify actual resolution before launching, as described in the workflow.
- Run independent authorized implementation assignments in parallel by default. Codex assigns disjoint ownership and, once Git is set up, separate branches/worktrees; coordinate shared files and fixture access as described in the workflow.
- Claude workers follow the worker-specific instructions and their assigned brief. They do not take over coordination or launch other workers.
- A planning-only or documentation-only request does not authorize implementation, runtime setup, or roadmap work.

## Project purpose and architecture

Build a system that lets AI models join Minecraft and play with Jake. Development workers and gameplay agents are separate roles.

Jake has selected Java Edition, a bot that joins as its own player with player-like visibility, Jev through OpenRouter for small decisions, and his Codex subscription for the gameplay planner. Claude development workers continue to use the local DSH subscription route.

Start with [feature-plans.md](feature-plans.md), then read the [V1 architecture](docs/v1-architecture-plan.md), [shared contracts](docs/v1-contracts.md), and the assigned implementation plan. [README.md](README.md) is the operator guide.

Installed stack (MB-V1-01): Node.js 24 LTS, strict TypeScript 7.0.2 (erasable syntax only; ESM; `.ts` import specifiers rewritten on build), npm, and exact pins mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, prismarine-auth 3.1.1, and zod 4.6.5.

Supported Java versions:

- **26.1.x (protocol 775):** upstream-tested by the released Mineflayer.
- **Exactly 26.2 (protocol 776):** the LOCAL compatibility profile MB-SERVER-001. It is not an upstream release and not Mineflayer-tested.
- 26.2.x point releases, 26.3 and later are unsupported.

The 26.2 profile is delivered by four vendored, integrity-pinned tarballs in `vendor/` (`<base>+chunkbot.26.2.1` builds of minecraft-data 3.117.0, prismarine-chunk 1.41.0, prismarine-physics 1.11.1 and mineflayer 4.39.0). They are installed by `file:` specs plus `overrides` and pinned by sha512 in `package-lock.json`. Their inputs are in `vendor/compat-sources.json`, their outputs in `vendor/compat-lock.json`, and the recorded patches in `vendor/patches/`. `scripts/vendor-compat.ts` rebuilds them; `--check` verifies the rebuild is byte-identical. Never hand-edit `node_modules`; change inputs/patches and rebuild.

MB-SERVER-002 corrected the attribute key mapper at the official numeric ids (26.1 from upstream #1254, 26.2 from the official registry). It also lets mineflayer store attributes under their registry resource, so server movement speed reaches prismarine-physics.

The fixtures run vanilla 26.1.2 (default) and, separately, vanilla 26.2.

Commands are open-ended natural-language goals. The gameplay planner decides steps and prerequisites using the implemented capability catalog; examples such as logs, stone, following, and armor are not a goal whitelist. Keep it isolated from development-worker instructions and tools. It returns structured plans and Jev instructions; it does not edit this repository, launch workers, or directly control Minecraft. Jev selects currently valid actions, and application code verifies outcomes.

Record current task and runtime evidence in [docs/agent-supervision.md](docs/agent-supervision.md).

## Application architecture

- `src/contracts/`: shared zod schemas and ports. This is the single source of truth for IDs, states, goals, generic `TaskSpec`, predicates, selectors, capability catalog, knowledge queries, clarification, planner proposals, actions/outcomes, observations, `GamePort`, and `PlannerPort`. It has no goal or task enum, and no Minecraft library imports.
- `src/goals/`: `GoalEngine`. One active goal, epochs, and the single `submit` intake. Validation happens before replacement, and old ownership is revoked with bounded cleanup before new planning. It also handles stop, correlated clarification (`qN`), lifecycle `endOwnership`, planner-turn/deadline limits, and proposal validation. `onGoalAdmitted` is the admission ownership hook: it is called synchronously for the new epoch before planning, and `SkillRuntime` uses it to capture the goal's travel anchor. MB-V1-03 adds two generic seams that share the same admission path (`admit`):
  - `submitOperatorTask`: the terminal-only `/task` operator task diagnostic (`kind: operator_task_diagnostic`), run through the task runtime.
  - The plan-window seam: accepted plan tasks run in order, the goal outcome is bound once and evaluated by code, and `TaskFeedback` goes to the next planner turn. A task completing is never goal completion.

  A task result that returns after its goal lost ownership is discarded (`task_result_discarded`) and never published to status, progress or feedback (MB-JEV-002).

  MB-V1-04 rolling planner windows (`plan`): at admission the travel anchor (sync hook) and then a server-confirmed ALL-item inventory baseline (`captureBaseline`) are taken before the first planner turn. Each planner turn gets a fresh bounded `PlannerRequest` (instruction, correlated answers, filtered observation, catalog, knowledge, admission inventory, accepted outcome/status, verified feedback and prior results, owner-typed coordinates, counters, remaining limits, last rejection). Proposals pass `checkProposal` (forbidden code/limit fields, schema, catalog capabilities, declared parameters, registry/recipe facts, shown handles/anchors, ledger-verified prior results, owner-typed coordinates, persistent maintain task) before any action; rejected ones get at most 2 consecutive counted repair turns; transport timeouts/process errors get one counted retry; auth/quota/model errors block (`planner_not_ready`) without fallback; reroute/prohibited events fail (`planner_error`) and disable the planner. The first accepted outcome is bound to the ADMISSION baseline and is immutable; every turn kind (initial, knowledge, repair, retry, clarification, replan) counts toward `plannerTurnsPerGoal`; `GoalRecord.counters` never reset across windows. Windows run in order through the task runtime; a persistent outcome's maintaining task runs in `maintain` mode; after each window code evaluates the outcome (completion only when verified), else a counted replan (`limits.replans`). Planner process cleanup is a registered goal cleanup, so stop/replacement/lifecycle revocation waits (bounded) for the owned process group.
- `src/planner/` (MB-V1-04): the Codex SUBSCRIPTION planner. `codex-cli.ts` pins CLI 0.160.0 and model `gpt-6.1-sol` (effort `low`), verifies the managed ChatGPT login MODE with read-only `codex login status` (file credentials store pinned for status and exec; API-key/absent/other/unrecognized refused, re-checked before every turn, mode-only evidence — MB-PLAN-002), derives the restricted catalog entry from `codex debug models --bundled`, verifies 40 feature states with `codex features list` (documented inert `unified_exec`), refuses a neutral directory under development-instruction markers, builds the environment allowlist and exec arguments (`agents.enabled=false`, no MCP/memories/skills/project docs, app-owned sqlite home). `process.ts` runs each turn in its own process group and retains proven descendants by pid+start time across reparenting (MB-PLAN-001). `transport.ts` validates the JSONL event stream (only agent_message/reasoning/error items; reroute or any tool/agent item rejects). `wire.ts` generates the strict `anyOf`-variant output schema from the catalog and converts/normalizes output; `prompt.ts` holds the gameplay-only instructions and bounded request rendering; `planner-check.ts` is the live diagnostic. Doctor runs only the read-only part of the gate (no feature list, which loads the account cloud config).
- `src/commands/`: chat and terminal parsing and routing. Reserved first words are `stop`, `status`, `answer`, and `goal`; terminal-only operator commands are `/quit`, `/reconnect`, and `/help`.
- `src/config/versions.ts`: support levels. `upstream-tested` is the released Mineflayer testedVersions minus the locally admitted entry. `local-compat` is exactly 26.2, admitted only when all four vendored builds and their `chunkbotCompat` markers are installed (fail closed otherwise).
- `src/game/`: connection adapter (`GameSession`: bot, connection epoch, evidence), the codec-health audit (`codec-audit.ts`: per-packet decoded / trailing-byte / failed counts; shown by `status` and `connect-check`; observes only), the server-packet evidence journal (`server-evidence.ts`: block/inventory/window/entity/ack records, server block facts vs. client predictions marked by `tapClientPredictions`, client sequences from 1,000,000), packet-based owner identity shared with perception (`isOwnerPlayer`: verified-online UUID, or exact offline name plus derived UUID in the trusted fixture), Microsoft auth with no automatic sign-in or downgrade, and an abortable status ping.
- `src/perception/` (MB-V1-02): `translateHandle` re-grounds blocks, entities/drops and (MB-PLAN-003) frontier waypoints only to the SAME target produced again in the newer snapshot; never a fallback. `sessionWorld(session)` is the single authoritative world view for every observation and skill path. A voxel with a pending client-side prediction (marked by the connection's `tapClientPredictions`) is an opaque, unreported `UNCONFIRMED_BLOCK` until the server states it. Also: line-of-sight visibility (collision shapes, see-through glass/panes/bars, opaque lava and powder snow by fluid height), bounded snapshots with timestamped and dimension-scoped handles, handle re-grounding (`translateHandle`), frontiers inside goal-anchored travel bounds. It exposes no hidden ores and no global player positions.
- `src/knowledge/`: `VersionKnowledge`. It combines minecraft-data with recipes, tags, and fuels extracted from each exact release's official server jar (`scripts/extract-version-data.ts [--fixture 26.2]` writes `data/vanilla-26.1.2.ts` / `data/vanilla-26.2.ts`). Mechanics are dispatched by exact version (`mechanicsDatasetFor`), and one release's facts are never served as another's.
- `src/skills/`: 20 registered skill definitions. Each one is a descriptor, zod params, a resolver, and an executor: the same object feeds the catalog, candidate generation, and execution. Conservative pathfinder policy (no dig, place, towers, parkour, or doors). Task parameters and named targets are binding (`admittedParameters`, `targetScope`).
- `src/execution/`: registry/catalog, `TaskCandidateGenerator`, `SkillExecutorImpl`, single `ActuatorLeases` lease, fenced `Actuator`, `InterfaceGate` (one interface request in flight, correlated by sequence acknowledgements and an out-of-range abort-destroy barrier), `EvidenceLedger` (connection-scoped, invalidated on lifecycle), and `PredicateEngine` (current state from correlated server resyncs; historical evidence labeled; container contents current only when server-synced by a skill after binding and ≤ 60 s old). The executor never sets the travel anchor; goal actions need the anchor admitted for their epoch. Cancellation is server-confirmed only by server-provenance progress, and `partialEffects` separates confirmed effects from unknown later commands.
- `src/decision/` (MB-V1-03): `JevDecisionAdapter`, a raw-HTTP OpenRouter Decisions client. The wire contract is frozen from G-02 (`wire.ts`). Behavior:
  - It sends `provider.allow_fallbacks=false` and `max_price {prompt 0.042, completion 0, request 0}`. `pricing.ts` holds the verified route profile; any other model or provider is refused. Before every attempt it reserves the proven maximum: serving context 32,000 tokens × admitted prompt price = USD 0.001344 (MB-JEV-001).
  - It validates the envelope, the admitted choice, a complete probability distribution, confidence, the model (requested id or its dated snapshot), the provider (`TypeSafe`), and usage/cost against the bound.
  - One request is in flight, with a minimum interval and an abortable timeout. Only timeout/429/5xx get a retry, at most one.
  - Every attempt counts toward the per-goal allowance. A per-RUN `SpendLedger` reserves, reconciles, retains (the full maximum for ambiguous charges) or releases charges, and refuses calls the cap cannot cover.
  - Model, provider or price drift disables Jev for the run.

  `context.ts` builds the bounded model-visible state from the filtered snapshot only. `jev-check.ts` is the one-request live diagnostic.
- `src/tasks/` (MB-V1-03): `TaskRuntime` (`TaskExecutionPort`). It observes and evaluates the completion predicate in code, then generates candidates through the registered resolvers. It freezes a bounded option set and gets one Jev ID. After the await it rechecks ownership and the connection, revalidates the choice against a fresh snapshot, and executes the frozen candidate through the accepted executor. Outcome identity (action, goal, task, epochs, owner) is validated.
  - Guards: per-target retries, no-progress, low health, decision failure mapping (`decision_not_ready`, `decision_limit`, `decision_error`).
  - Sustained skills (`SkillDefinition.sustained`: `follow_entity`, `furnace_wait`) continue locally without inference. `maintain` tasks hold locally while their condition holds.
  - No intent enum or resource-specific loop exists. An empty option set returns structured resolver reasons as `TaskFeedback`.
- `src/app/`: `ChunkbotApp` composition root.
  - `SkillRuntime` installs the MB-V1-02 adapters plus the task runtime and outcome evaluator.
  - Terminal-only diagnostics: `/diag` (operator mechanics) and `/task` (operator task controller, real Jev).
  - Lifecycle handling ends goal ownership (which aborts provider I/O) before the skill layer releases actuator resources.
  - Operator-diagnostic notices stay on the terminal.
  - Also: status, read-only doctor, and fixture layout.
- `src/telemetry/`: redacted, bounded JSONL evidence.
- `src/cli.ts` is the real entry point (`run`, `connect-check`, `doctor`, `auth login`, `catalog`, `knowledge`, `jev-check`, `planner-check`). It creates ONE `SpendLedger` per application run and composes the real `CodexPlanner` (or, with `models.planner.mode: "disabled"`, an explicit inference-free not-ready planner) plus a per-run `planner.jsonl` journal.
- Later assignments install real adapters through `AppDeps.adapters` and the ports. Do not add intent handlers or a second planner-only catalog.

## Runtime constraints

- Use `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in `PATH`; the generic Homebrew `node` currently fails to load a dylib.
- Runtime data lives in git-ignored `var/`: `var/runs/` evidence, `var/auth/microsoft/` bot token cache, `var/fixture/` (JRE, server, world, RCON password), and `var/live-check/` reports.
- Installed skill-layer pins: mineflayer-pathfinder 2.4.5, prismarine-block 1.23.0, prismarine-item 1.18.0 (loaded through `createRequire`), and vec3 0.1.10.
- `var/fixture-26.2/` holds the 26.2 fixture, and `var/compatibility/` holds MB-SERVER-001 work: baseline copy, upstream clone, official reports, vendor build cache, and clean-install probes.
- The skills live check resets only the scene area x 196..224, z 190..224 of the fixture world, over RCON. Every setup command is recorded in its report.
- The trusted test fixture is a separate vanilla 26.1.2 server on `127.0.0.1:25566` with RCON on `127.0.0.1:25576`. Start/stop it only through `npm run fixture -- start|stop|status`.
- The distinct 26.2 fixture (MB-SERVER-001) runs on `127.0.0.1:25567` with RCON on `127.0.0.1:25577`. It has its own world, password and PID under `var/fixture-26.2/`. Manage it only with `npm run fixture -- <cmd> --fixture 26.2`; configs are `config/examples/fixture-26.2*.json`.
- Development workers and test harnesses connect only to the separate loopback fixtures. Never modify Jake's PrismLauncher client, worlds, or live server. Codex may connect the separately authenticated bot to the live server only within Jake's latest explicit instruction; check `docs/live-server-connection-plan.md` for any deferral before live operations.
- Offline auth is valid only with `trustedOfflineFixture: true` and a loopback host. Online play needs the bot's own Microsoft account, signed in explicitly with `npm run chunkbot -- auth login`.
- No model inference happens in the foundation or skill layer, in unit tests, or in fault-provider checks. Only `jev-check`, `jev-live-check` and `planner-live-check` (real Jev mode) call OpenRouter, each with a USD 1 per-run cap. The planner uses the Codex subscription only (`planner-check`, `planner-live-check`, normal `run` goals); foundation/skills/controller checks use `config/examples/fixture-inference-free.json` (planner disabled). The planner's neutral directory is `$TMPDIR/chunkbot-planner-<uid>` (app-owned, outside the repository). Workers never call bw/vault or request keys. The coordinator runs real-provider checks with the key injected into the environment (`OPENROUTER_API_KEY`). Keys never appear in source, config, prompts, logs, or handoffs.

## Required checks

Run these from the repository root with the Node 24 `PATH` above. Capture exit codes directly.

| Change touches | Command |
| --- | --- |
| Any TypeScript (src, tests, scripts) | `npm run typecheck` |
| Application source | `npm run build`, then `npm test` |
| Diagnostics/config | `npm run doctor -- --config config/examples/fixture.json` (read-only; exit 0 expected) |
| Connection, identity, commands, lifecycle, CLI | With the fixture running: `npm run build && npm run live-check` (exit 0; report under `var/live-check/`) |
| Perception, knowledge, skills, execution, predicates, `/diag` | With the fixture running: `npm run build && npm run skills-live-check` (exit 0; report under `var/live-check/<stamp>-skills/`) |
| Decision adapter, task runtime, goal/task seams, `/task` | `npm run build && npm run jev-live-check -- --provider fault` with the fixture running (exit 0; report under `var/live-check/<stamp>-jev-fault/`; harness validation only). Real Jev acceptance: `npm run jev-live-check` and `node dist/cli.js jev-check --config config/examples/fixture.json` with `OPENROUTER_API_KEY` injected by the coordinator. |
| Planner, goal engine windows, planner/isolation/auth/process code | `npm run build && node dist/cli.js planner-check --config config/examples/fixture.json --probe` (exit 0; real subscription turn, tool-exposure self-report, in-flight cancellation) and, with the fixture running, `npm run planner-live-check -- --jev fault` (real planner, loopback Jev; harness validation). Real acceptance: `npm run planner-live-check` with `OPENROUTER_API_KEY` injected by the coordinator. |
| Version knowledge data (new server jar) | `npm run extract-version-data [-- --fixture 26.2]` (after the fixture's first start), then review the regenerated `src/knowledge/data/` diff |
| Vendored stack (`vendor/`, `package.json`/lock, overrides) | `npm run vendor-compat -- --check` (byte-identical rebuild); `npm run verify-version-data` and `npm run verify-version-data -- --fixture 26.2` (official-report comparison, exit 0); clean `npm ci` in an isolated copy, never by deleting the running project's `node_modules` |
| 26.2 support (any of the above areas) | The same live checks with `--fixture 26.2` and the 26.2 fixture running, plus `npm run compat-live-check -- --fixture 26.2` (and without `--fixture` for 26.1.2) |

`npm run check` runs typecheck, build, and test. Unit tests do not prove a working connection; use the live fixture check for that. Foundation review evidence is in [docs/reviews/mb-v1-01-foundation.md](docs/reviews/mb-v1-01-foundation.md). Skill-layer evidence is in [docs/reviews/mb-v1-02-skills.md](docs/reviews/mb-v1-02-skills.md). Jev controller evidence is in [docs/reviews/mb-v1-03-jev-controller.md](docs/reviews/mb-v1-03-jev-controller.md). Planner evidence is in [docs/reviews/mb-v1-04-planner.md](docs/reviews/mb-v1-04-planner.md). 26.2 compatibility evidence is in [docs/reviews/mb-server-001-compatibility.md](docs/reviews/mb-server-001-compatibility.md).

## Repository practices and checks

- Inspect existing files and Git status when Git is initialized. Preserve unrelated work.
- Keep roadmap and current task/session status in the documents defined by `agent-workflow.md`.
- Update this file with actual architecture, runtime constraints, and required check commands as tooling is introduced. Do not invent build, test, or diagnostic commands.
- For documentation edits, review content, relative links, and the diff. No application build or DSH launch is required.
- Keep secrets out of source, prompts, logs, and handoff documents.
