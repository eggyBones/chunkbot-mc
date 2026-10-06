# MB-V1-00 — Local Claude development runtime

Created/updated: 2026-10-04. Status: **Verified locally; accepted.** Owner: Codex. This is a coordinator setup task, not a task for a worker to launch itself.

## Outcome and scope

Codex can create or resume one Claude Code Opus 5.5 worker in a local DSH instance attached to `.`, using Jake's Claude subscription. A bounded smoke conversation proves prompt delivery, observation, coordinator answers, native tool access, and completion.

Jake selected local DSH and Claude development workers. Coordinator assumption: reuse a suitable existing local installation/profile before creating another installation. Do not operate or modify the work-server instance. Gameplay Codex and Jev configuration belong to other plans.

Included: discover the local installation and profile, inspect active sessions/queues, establish the project workspace, verify effective integration and permissions, and document the supported controls. Excluded: implementing Minecraft features, migrating the work server, broad harness upgrades, global permission changes, and API billing fallbacks.

## Intake and research gate

Read [the standing workflow](../agent-workflow.md), [AGENTS.md](../AGENTS.md), and [the supervision checkpoint](agent-supervision.md). Inspect local installation instructions and its `AGENTS.md` before changing that installation. None has been inspected for this task; old server ports, presets, browser profiles, and link targets are not current facts.

Gate **G-00** in [research](v1-research.md): can this local integration run the requested model through the subscription? Inspect the actual loaded Agent SDK and its supported-model resolution, selected preset/provider/account, workspace membership, effort, effective permissions, and active sessions. Resolve aliases through that SDK; do not treat a CLI version or UI label as proof. A missing login, unsupported model, or absent installation is an exact prerequisite to report, not authorization to substitute another route.

If an installation/build update is necessary, prepare its smallest scoped change and required checks under that repository's rules. Preserve active sessions and runtime packages. Do not restart the process hosting a worker's turn.

## Milestones and acceptance

1. **RUNTIME-1 — Discover and record.** Record local endpoint, installation/checkout, supported control surface, active workers, and project path without exposing cookies/tokens. Distinguish observed facts from proposed setup.
2. **RUNTIME-2 — Verify configuration.** Record session/workspace IDs, Claude Code preset, subscription route, actual resolved Opus 5.5 model, effort, and permissions. Missing external auth produces an actionable blocked checkpoint; independent inspection continues.
3. **RUNTIME-3 — Smoke the full loop.** In a separate bounded test session, ask a no-tool question that requires a coordinator answer. Answer it, verify the second turn completes, then request a narrowly scoped read-only repository review. Inspect the full response and verify native execution. Confirm idle/no pending queue and settle the test through supported controls.
4. **RUNTIME-4 — Handoff.** Update [agent-supervision.md](agent-supervision.md) with the exact route, evidence, pending prerequisites, safe launch procedure, and next assignment. The smoke test proves development plumbing, not V1 gameplay.

## States, checks, and remaining evidence

### MB-RUNTIME-001 — Default Claude subscription unavailable through the native driver

Reported 2026-10-04. Status: **Verified running; Codex accepted the scoped startup correction.** The requested worker must use Opus 5.5 on Jake's subscription with full access.

Observed: the live `claude:claude-default` route reports `NO_SUBSCRIPTION`. Control-only probes using SDK 0.3.280 report `Claude Team` with the default account directory left implicit, but `tokenSource: none` when `CLAUDE_CONFIG_DIR=/Users/jakewilcox/.claude` is explicit. Both probes scrub API/backend overrides and withhold inference prompts. The installed native driver unconditionally sets that variable, including for `homeKind: default`.

Coordinator decision: make the native driver preserve SDK default-account resolution for explicitly declared default profiles, while continuing to scope managed/custom profiles and scrub inherited credential/backend overrides. No credentials are copied, no account is logged in/out, no SDK/harness dependency is upgraded, and no global permission setting changes.

Acceptance: source tests cover default versus managed/custom environments; affected driver tests/typecheck/build and doctor pass; the running default route exposes the subscription and requested model; a full-access smoke conversation and native tool turn complete. Record source/built/running state separately. Minecraft implementation remains assigned to Claude once this prerequisite passes.

Jake authorized setup and implementation with full worker access on 2026-10-04. Queued old assignments must be inspected before resuming. Failed/denied tool calls require diagnosis of the effective mapping; do not repeatedly send the same operation or weaken global settings. On interruption, preserve changes and leave a usable checkpoint.

Persist only non-secret operational facts in the supervision note. Local installation secrets remain in their supported auth storage. Validate any installation changes with that installation's actual checks; documentation-only checkpoints need content/link review.

Evidence still needed: local DSH presence/authentication, integration SDK/model resolution, workspace membership, permissions, and smoke results. No endpoint, model resolution, or worker session is currently verified for this project.

## Delivery evidence

Local DSH workspace `23299829-62f5-48f5-a51b-bbe833d35047` is registered to the project. Separate smoke session `session-58b0b5c6-0577-4180-9876-e1b77378d684` used Claude Code/native Claude subscription, Opus 5.5, high effort, full access. A coordinator question and answer completed in two turns; a third turn ran native Bash `pwd` and Read `AGENTS.md` successfully. Full responses were inspected. Idle state and empty next-step/next-turn queues were verified before supported archival. MB-RUNTIME-001 passed 255 driver tests, typecheck, build, doctor preflight, and live model/tool verification. See [checkpoint](agent-supervision.md) for current host/worker ownership.
