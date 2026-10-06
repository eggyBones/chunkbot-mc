# Feature batch001 — Dashboard, handoff and gameplay memory

Reported:2026-10-06 UTC. Status: authorized; implementation starts after MB-NAME-001 is finished and its initial public push is verified.

Jake explicitly requested three features in parallel through the standing agent workflow, using native Claude Opus5.5 with full DSH permissions. One must be the dashboard. Codex selects smooth directive handoff and persistent gameplay memory as the two companion foundations.

## Selected outcomes

- **MB-UI-001:** [local dashboard](chunkbot-dashboard-plan.md), showing actual connection/health/hunger/levels, inventory/equipment, current directive/task, pending preparation, planner/Jev tokens, conservative OpenRouter spend/history and honest offline/stale state. Optional account/quota reads are bounded research gates; unsupported allowance displays unavailable and does not block the core viewer.
- **MB-FLOW-002:** [smooth handoff](smooth-handoff-plan.md), continuing the existing admitted task while preparing a replacement, then switching through one owner after fresh admission/revalidation. Stop and lifecycle cancellation stay immediate; pending drafts and rejected/replaced work consume bounded allowances.
- **MB-MEM-001:** [persistent memory](gameplay-memory-plan.md), retaining scoped home/important-location and verified progress facts across restarts, with provenance/freshness and fresh planner references. Memory cannot reconnect a logged-out bot or replay old actions.

These are the assigned child plans. Conditional integration with proposed progression, survival/recovery, locator or update-manager features does not assign those features to this batch. Deliver the reusable seams and current observable behavior; preserve their roadmap status.

## Parallel execution and integration

1. Finish and verify the initial public rebrand push. Record its exact commit as the common base; no feature worker starts before this boundary.
2. Inspect the repository/workers/runtime and freshly resolve Opus5.5 through the SDK loaded by local DSH. Verify the Claude subscription preset, high effort where supported and native full permissions for each of three sessions.
3. Create three distinct feature branches/worktrees with separate node_modules, dist and ignored runtime storage. Never copy Minecraft/provider/Codex authentication data into a worktree.
4. Establish coordinator-owned shared interfaces and a designated writer for each integration path before overlapping consumers change them. Each worker owns its feature modules/tests and delivers a complete bounded outcome. Shared contracts, planner request/wire, status, config/CLI/manifests and app composition require explicit ownership and coordinator integration.
5. Keep all three native workers moving on independent modules. Serialize genuine shared dependencies and fixture leases; use the already separate loopback fixtures only when no driver overlaps that world. No DSH restart while turns are active.
6. Read full handoffs, review code/behavior and integrate accepted commits in dependency order. Run affected AGENTS checks and new child-plan acceptance on the combined build; Codex injects provider credentials for real acceptance. Use the native T3 preview for dashboard browser validation.

## Constraints and remaining work

The public repository must remain free of Minecraft, OpenRouter and Codex credentials, private configs and runtime data. Worker briefs forbid vault access, secret requests/reads, GitHub publication and live-world operations. Full permissions describe the native tool mode, not authority to expand the feature scope.

The live bot remains logged out under Jake's latest instruction. These features use loopback worlds and a local read-only viewer; no live reconnect or private server modifications are authorized. Existing acceptance failures unrelated to branding are preserved and scoped independently.

Before launch, Codex still needs to finish the rebrand boundary, assign exact paths/contracts/worktrees/sessions, and record the concurrency and runtime leases in supervision. After launch, each feature needs implementation, independent child-plan acceptance, integrated source/build evidence and updated operator instructions. This document records authorization; it is not a launch receipt.

## Working ownership proposal (verify against the published base before launch)

- Handoff worker: goal/preparation scheduling and planner behavior; designated implementer for existing shared contracts, planner request/wire, CLI/config/manifests and app composition. Codex makes the shared design decisions and relays integration requests; this writer does not coordinate the other workers.
- Memory worker: new memory contract/module, durable store/recorder/retrieval, memory skill/candidate/predicate adapters and focused tests. Propose required changes to existing planner/contracts/core composition through Codex rather than editing the designated writer's files.
- Dashboard worker: new dashboard contract/module, typed status/usage projection, persistence/history, local server/static viewer, meaningful tests and feature documentation. Propose app/CLI/config hooks through Codex. Core viewer integration must be completed by the designated writer before acceptance.
- Codex: shared-interface specification, cross-worker communication, branch/worktree registration, integration, all roadmap/supervision documents and provider/browser acceptance. Exact test-path ownership and shared extensions will be fixed in complete worker briefs, then recorded with actual sessions and commits.

Contract delivery is an initial dependency milestone, not the end of any assignment. New companion contract files can be developed independently; existing central exports/request/ports are single-writer paths. Codex can integrate a compiled contract milestone locally and rebase dependent worktrees before all three complete their real entry points. No worker may advertise an uninstalled capability or invent placeholder success to satisfy a consumer.
