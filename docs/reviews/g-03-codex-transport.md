# G-03 — Codex subscription transport probe

Coordinator probe, 2026-10-04, authorized by Jake’s V1 implementation request. A scoped CLI transport passed the bounded schema and in-flight process cancellation probes. This is transport evidence; the gameplay planner is not implemented or accepted.

Installed native CLI: `/opt/homebrew/bin/codex`, version 0.160.0. `codex login status` reports ChatGPT sign-in. No OpenAI API key was used or copied. API-key, token, backend, and inherited session environment inputs were scrubbed for the probes; ordinary OS environment and managed authentication location remained intact.

The successful `codex --no-daemon exec` turn used `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, a neutral app-owned working directory under `/tmp` outside repository instructions, read-only sandbox, approval policy never, stdin input, fixed output schema, and JSON events. Returned `{decision: "wait", reason: "No active goal."}` in 4503 ms, exit 0. Usage: 1674 input, 22 output tokens. There were no tool events.

Explicitly selected `gpt-6.1-sol`, low effort, from the installed bundled catalog. The successful CLI JSON stream does not echo a server-resolved model identity; evidence is explicit selection, matching scoped catalog, and accepted subscription execution. The application must retain that distinction and reject any unexpected model fallback.

## Scoped isolation controls

Used supported `model_catalog_json` with the selected installed model’s metadata restricted for this invocation: shell disabled, apply-patch metadata absent, experimental tools empty, search unsupported, and tool mode direct. Only tool exposure metadata changed; provider route/model ID were preserved. The application must verify these fields against the installed CLI version and fail closed if its registration rules change. A stock read-only Codex invocation still has tools and is insufficient.

Feature controls disabled shell/unified exec, image viewing/generation, apps, plugins, remote plugins, browser/computer use, Code Mode/host, hooks, agents, goals, skill search/install, sleep, tool suggestion, and the shared daemon. Scoped settings also disabled web search, planner/update-plan/user-question utilities, inherited MCP, memories, bundled skill enablement, skill instruction injection, environment/app/collaboration instructions, and project-document loading. Replaced the coding system instructions with a short gameplay-only system instruction.

The installed `skip_host_skill_discovery` flag was enabled for this scope. CLI reports it as under development; the eventual adapter needs a versioned isolation check, not a global setting change. The coordinator inspected the exact official v0.160.0 configuration schema and tool registration source to check gates. [Official source tag](https://github.com/openai/codex/tree/rust-v0.160.0), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

`codex debug prompt-input` has no ignore-user-config switch. For the supplementary prompt inspection, the same overrides plus explicit disabled entries for configured MCP/plugins and replacement developer instructions were used. It returned exactly developer and user messages, without Chunkbot/agent-workflow, skills, or apps blocks. This inspection complements the actual exec controls; it is not represented as the same invocation.

## Cancellation

A separate app-owned ephemeral process reached `turn.started` and was terminated via its own newly-created process group. PID 27241 exited on SIGTERM in 3 ms; no descendants or owned PIDs remained, and no `turn.completed` event arrived. No shared Codex/T3/DSH process was touched. An earlier buffered-reader cancellation attempt observed completion before signaling; it was not counted as an in-flight cancellation pass.

[Redacted transport and cancellation evidence](g-03-codex-transport.json). Probing commands, neutral directory, schema, restricted catalog, and scoped argument array are retained in `/tmp/chunkbot-mc-codex-*` for the planner worker. Application cancellation still needs adapter tests and later live integration; stop/replacement must discard late outputs even after process exit.
