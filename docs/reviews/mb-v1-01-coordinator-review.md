# MB-V1-01 — Coordinator acceptance

Accepted for the authorized local fixture on 2026-10-04 (America/Phoenix). Codex reviewed the complete DSH handoff, entry-point wiring, contracts, command/identity/lifecycle boundaries, documentation and relative links, and worker evidence. Main implementation was Claude Opus 5.5, session `session-57f00ccc-6072-42e0-9a2a-9abb17e9f038`; native transcript confirmed `claude-opus-5-5`.

Independent final commands, using Node 24.21.0 first in PATH:

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run check` | 0 | Typecheck, fresh build, 84 tests passed; `/tmp/chunkbot-mc-foundation-coordinator-check.log` |
| `npm run doctor -- --config config/examples/fixture.json` | 0 | Read-only diagnostics; `/tmp/chunkbot-mc-foundation-coordinator-doctor.log` |
| `npm run live-check` | 0 | 16/16 built-CLI scenarios; `var/live-check/2026-10-05T00-14-23-927Z/report.json` and `/tmp/chunkbot-mc-foundation-coordinator-live.log` |
| `node /tmp/chunkbot-mc-foundation-review.mjs` | 0 | Independent original MB-FND-001/002 probes now pass: zero late-created clients, overlapping shutdown admission rejected |
| `npm run fixture -- status` | 0 | Vanilla 26.1.2, protocol 775, PID 31385, zero connected players |

[Worker delivery evidence](mb-v1-01-foundation.md) records setup, exact pins, live controls, faults, restart and hygiene checks. Full DSH response and all session events were read; turn ended completed, session idle, both queues empty, no pending approval. No unrelated work or Git state was changed.

Foundation milestones FOUND-1 through FOUND-4 are accepted locally. Shared runtime contracts remain generic and code-owned; no fixed goal category/intent table or fake gameplay was added. Configuration, auth instructions, packet-based owner admission, both control surfaces, replacement/stop/clarification ownership, lifecycle, redacted evidence and real CLI diagnostics are wired.

MB-FND-001 and MB-FND-002 are verified fixed, including the worker’s failing-before regression evidence and coordinator reruns. Source and freshly built `dist/` match these checks. Only the isolated fixture is left running; Chunkbot is idle/offline between checks.

Scope limits: Microsoft bot-account availability and eventual target server remain pending, so online authentication/UUID admission are implemented and unit-tested but not live-verified. No model-driven gameplay is accepted in this phase. G-01 movement/dig/pickup, visibility, knowledge, actuator leases and skills continue in MB-V1-02; later provider/planner/integration milestones remain required. Git was not initialized or committed.

Coordinator choices: retain documented reserved control verbs, optional bare answer applying to the current pending question with displayed unique qN references, and optional signed-chat enforcement. The fixture choice follows Jake’s instruction. Shared-play version/account decisions can wait while local V1 work proceeds.
