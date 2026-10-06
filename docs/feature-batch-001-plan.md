# Feature batch001 — Dashboard, handoff and gameplay memory

Reported: 2026-10-06 UTC. Status: **three native implementations integrated and accepted**, with runtime quality limits retained in the independent review. MB-NAME-001 initial public push was verified at commit `d5eb2fa7826f783354c3a65081cbff151267eb50` before feature launch.

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

All three native implementations are integrated from separate worktrees. Exact paths, sessions, ownership and fixture restrictions are recorded in [supervision](agent-supervision.md); complete private briefs/receipts are under ignored var/batch001. [Independent review](reviews/mb-batch001-coordinator-review.md) records the final 483-test build, both fixtures' memory/handoff checks, real H7/M6 and T3 evidence. Selected feature acceptance is complete, including real M6 on both versions, dashboard C8 and handoff C4. The review retains inherited J1, the original 26.2 P4 timeout and the partial default fault-controller diagnostic; general V1 final acceptance remains unassigned. All worker sessions are idle and clean, and fixture leases are released. No live launch is claimed.

## Assigned ownership

- Handoff worker: goal/preparation scheduling and planner behavior; designated implementer for existing shared contracts, planner request/wire, CLI/config/manifests and app composition. Codex makes the shared design decisions and relays integration requests; this writer does not coordinate the other workers.
- Memory worker: new memory contract/module, durable store/recorder/retrieval, memory skill/candidate/predicate adapters and focused tests. Propose required changes to existing planner/contracts/core composition through Codex rather than editing the designated writer's files.
- Dashboard worker: new dashboard contract/module, typed status/usage projection, persistence/history, local server/static viewer, meaningful tests and feature documentation. Propose app/CLI/config hooks through Codex. Core viewer integration must be completed by the designated writer before acceptance.
- Codex: shared-interface specification, cross-worker communication, branch/worktree registration, integration, all roadmap/supervision documents and provider/browser acceptance. Exact owned paths/test prefixes and shared extensions are fixed in the complete briefs; actual registered sessions/worktrees are recorded in supervision.

Contract delivery is an initial dependency milestone, not the end of any assignment. New companion contract files can be developed independently; existing central exports/request/ports are single-writer paths. Codex can integrate a compiled contract milestone locally and rebase dependent worktrees before all three complete their real entry points. No worker may advertise an uninstalled capability or invent placeholder success to satisfy a consumer.

## Runtime incident MB-BATCH001-I1

At 2026-10-06 08:03:29Z the memory worker dynamically imported its executable memory-live-check.ts during type inspection. Its top-level main ran without a fixture lease, reset the26.1.2 test scene and connected as Chunkbot while the granted handoff trial was active. The worker detected/stopped its own process at08:03:34Z, reported the incident and added a mandatory lease guard. No model/provider call or live-world operation occurred. Coordinator treats the entire handoff run2026-10-06T08-03-23-216Z as invalid, not feature evidence, stopped its remaining owned harness at08:06:15Z, and instructed an isolated rerun. The fixture and native DSH workers were not signalled. The import/lease guard and meaningful refusal regressions are now integrated; the affected handoff trial was rerun in isolation. Private evidence: var/batch001/memory-fixture-incident-tools.json and invalid-handoff-run-stop.json.

### Coordinator checkpoint — 2026-10-06T08:26:16.694660+00:00

- MB-MEM-001 froze clean at `e3d41a16a3ce2265d1ba05b1df66850fcee4804d`; its 26.2 lease is explicitly released. The corrected seed/restart report is 13/13 on `951975f`, with only a code-verified home milestone. Root reviewed the truthful status and harness corrections; this is module evidence, not yet real CLI/M6 acceptance.
- MB-UI-001 final module `24c674478a0b1ac51452c4126012c6f502f445e1` is merged locally. H is authorized to merge those exact final UI and memory commits for combined app wiring.
- H correction `9686b69` re-grounds unbound outcome references and awaits the currently pending preparation. Root found **MB-FLOW-002-C3a**: supersede A with B while A's 150 ms cleanup runs, then immediately stop; stop returned in 0 ms with one owned planner turn still in flight. No inference or fixture contact; proof `var/batch001/superseded-preparation-review-proof.json`. Stop/lifecycle must await all outstanding discarded preparation cleanups, including superseded ones, bounded without delaying synchronous control invalidation. H's 26.1.2 lease remains exclusive through its corrected frozen-build checks.

### Memory bounded-context correction — 2026-10-06T08:32:58.048150+00:00

Root reviewed final module retrieval and reproduced **MB-MEM-001-C3** without inference/fixture contact: 8 project facts serialize to 8,087 characters, exceeding the promised 8,000 limit. The pre-issuance placeholder undercounts actual/non-executable references, project checkpoint refs, and final omission metadata. The existing bound test allows an unexplained extra 2,000 characters. Proof: `var/batch001/memory-view-bound-review-proof.json`. Memory worker is resumed only to enforce the complete serialized view bound, preserve home and usable shown references, tighten regression coverage and report exact commit. H remains frozen at `88089893` for its 26.1.2 gates; this correction will be integrated and checked separately by root.

### Real browser review — 2026-10-06T08:36:31.333132+00:00

Root's real Codex/Jev H7 trial on 26.2 completed two goal windows with both requested outputs independently confirmed by RCON, zero assistance. The lookahead was used (gap 1,936 ms, fresh revalidation 16 ms); one counted repair was honest. Evidence: `var/batch001/real-h7-26-2/report.json`. A journal counter-label error in the coordinator runner is being corrected from actual `goal_window` events; the terminal already records two windows.

A new T3 tab (`tab_8`) successfully captured the actual integrated dashboard at 1280×800, unlike the earlier tab's generic capture failures. Image inspected: `/Users/jakewilcox/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-muwfaft0-78498110.png`. **MB-UI-001-C4:** XP and quota fills use inline style attributes rejected by the server's `style-src 'self'` CSP on every refresh; XP 0% visibly shows a full green bar. **MB-UI-001-C5:** the confirmed tiny charge is horizontally clipped in its narrow three-column card; exact amount must be readable. Root resumes the UI owner for bounded browser/CSP/readability corrections and human-readable outcome summaries. Full screenshot evidence and served metadata stay ignored; no credential/auth contents were captured.
