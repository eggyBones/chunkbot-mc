# Chunkbot agent workflow

Jake supplies product direction, Codex coordinates and reviews, and implementation workers run through a **local DSH (DeepSeek Harness) instance** using Jake's subscription.

**Current development route — Jake's 2026-10-07 Arizona instruction:** native Codex harness, personal ChatGPT account, exactly `gpt-6.1-sol`, extra-high reasoning (`xhigh`), and full permissions (`danger-full-access` with approval policy `never`). This supersedes the earlier Claude Opus 5.5 worker requirement. Preserve earlier Claude sessions, source commits and unfinished drafts; hand them to new native Codex sessions through complete coordinator briefs. Verify the installed Codex integration's account and model catalog, session-local selection, effective access mapping and actual native turn before claiming a worker is running. Historical Claude SDK verification applies only to those earlier sessions. The gameplay planner remains a separate runtime with its own pinned settings.

The project goal is to let AI models join Minecraft and play with Jake. Development workers build that system; they are separate from the AI players the system will eventually run. This workflow does not choose the gameplay models, Minecraft edition, control library, or deployment architecture.

Apply this workflow when Jake asks to plan, build, fix, or continue project behavior. A planning request stays planning-only. Reading this document does not authorize starting DSH, launching workers, implementing the roadmap, or connecting agents to a Minecraft world.

## If you are the implementation worker

Follow your coordinator's current brief, `AGENTS.md`, and the assigned feature plan. Implement, validate, and report questions and results to Codex in your DSH chat. The planning, launch, and supervision instructions below belong to Codex. Do not question Jake directly, start unassigned work, take over coordination, or recursively launch workers.

Continue after Codex answers a question until the assigned outcome is complete. If part of the assignment has a concrete external blocker, report the evidence and finish the independent work.

## Roles and decisions

- **Jake owns product direction.** Ask a small number of useful questions about what the player experiences: what triggers a behavior, how Jake controls or talks to an agent, what the agent does, what persists, and what completion looks like. Recommend a default and explain meaningful tradeoffs. Ask in small batches and continue independent inspection while waiting.
- **The coordinating Codex owns scope, plans, prompts, decisions, supervision, and acceptance.** Turn the discussion into concrete behavior and testable outcomes. Answer routine implementation questions using the repository, Jake's preferences, and reasonable judgment. Record assumptions so Jake can refine them later. The coordinator may handle documentation, investigation, review, and scoped operational work directly; DSH workers do the main implementation work.
- **DSH workers own implementation of the assigned scope.** Launch or resume native Codex through local DSH using Jake's personal ChatGPT account and the exact settings above. Verify the account, model and effort before launching. Internal Codex subagents, a stock DSH model loop, another account and API billing are not substitutes for this route.

Before implementation, resolve choices that materially change the intended experience. During implementation, Codex decides ordinary details such as implementation order, copy, layout, routine edge cases, and fixes required to meet the plan. When uncertain, choose a reversible option consistent with the project and label it a **coordinator assumption**. Do not invent extra features.

Escalate only when a real prerequisite or authority is missing: login or MFA, unavailable external access, incompatible requirements with no reasonable default, or work beyond the authorized scope. Prepare everything independently possible, describe the exact dependency, and continue other ready work. Existing authorization carries forward; do not request it again.

Jake's standing preference is **parallel native DSH workers whenever useful independent work is ready**. Once implementation is authorized, Codex should proactively split separable feature work and run workers concurrently through local DSH using the current authorized subscription, model, effort and full-access settings. Do not ask again merely to use parallel workers within that scope. Codex remains the supervisor and controls shared contracts, manifests/lockfiles, integration, deployment, and plan reconciliation. Serialize genuine dependencies, overlapping edits, shared runtime resources or capacity limits; record the reason and keep other ready work moving. This preference does not turn a documentation/planning request into implementation authorization.

## Local runtime boundaries

DSH should run on the same local machine as this project. The existing work-server setup is a reference, not this project's runtime. Discover the local installation, authenticated profile, endpoint, preset, and project directory before using them; do not assume a port, browser profile, SDK version, or remote checkout from another project.

Keep three runtimes distinct:

1. **Development orchestration:** local DSH and its native implementation-worker sessions.
2. **Chunkbot:** this project's application and any gameplay-agent processes.
3. **Minecraft:** the client, server, and world those agents use.

Record which runtime a task changes and which checkout each process actually uses. DSH running locally does not imply that Minecraft or a model backend must use the same machine; decide those requirements in the relevant feature plan. Source edits are not proof that a running process has loaded them.

If local DSH setup is assigned, make it a bounded setup task with its own validation and handoff. Do not silently operate the work-server instance or switch to another implementation route when local access is missing. Continue independent planning and review while reporting the exact prerequisite.

## Parallel assignments and Git isolation

Codex owns the work split, dependency order and integration. Prefer a small group of productive workers over a single worker covering unrelated ready features. Size concurrency to actual local resources, the authorized subscription capacity and supervision capacity; no fixed worker count or API fallback is implied.

### Before launching concurrent work

1. Give each worker a complete feature outcome or bounded dependency milestone, stable issue IDs, explicit owned paths and acceptance criteria. Verify the native Codex backend, personal subscription account, exact `gpt-6.1-sol` model, `xhigh` effort and effective full permissions for its DSH session.
2. Define shared interfaces early. Use a single designated writer for shared contracts, manifests/lockfiles, CLI/config, composition and roadmap/supervision. Workers propose needed shared changes to Codex instead of independently editing incompatible versions.
3. Record each worker's DSH session/workspace, exact checkout, branch/base when applicable, dependencies and shared-resource leases in supervision. Check old queues before reuse.
4. Reserve integration ownership for Codex. A worker does not coordinate other workers or expand its scope because another branch has unfinished work.

### Once Git is available

- Use **a separate branch and Git worktree for each concurrent implementation worker**, based on a recorded common integration commit. Keep the coordinator's integration checkout separate. For example, an issue branch can be named chunkbot/mb-flow-002; names and locations are coordinator choices.
- Inspect Git status first and preserve Jake's unrelated changes. Relevant uncommitted baseline changes must be explicitly accounted for; never indiscriminately stage, stash, reset or discard existing work to make worktrees convenient.
- Register/verify the exact worker checkout and workspace through the installed DSH mechanism. A matching project label does not prove the native worker is using the assigned worktree.
- Each worker installs/builds/tests in its own checkout with separate node_modules, dist and mutable runtime data. Record actual source versus built versus running paths. Do not share writable build output between branches.
- Within authorized implementation, creating worktrees/branches and making focused local commits for the assigned changes are ordinary work unless Jake directs otherwise. Workers report branch, base/head commit, changed paths and remaining working-tree changes; they do not merge into the coordinator branch themselves.
- Codex reviews the complete diff and evidence, then integrates accepted local commits in dependency order. Resolve conflicts deliberately, rerun affected checks against the combined build and verify shared behavior. A clean Git merge does not establish compatible contracts or working runtime behavior.
- Never copy Microsoft token caches, provider secrets or DSH credentials into worktrees or Git. Fixture/runtime storage must be scoped and recorded separately.
- Keep worker branches/worktrees until review and integration evidence is captured. Remove only task-owned, reconciled worktrees after checking for uncommitted work and active processes; no force cleanup of another worker or Jake's changes.

This procedure accounts for Git after setup. **It does not authorize Git initialization, creating a remote, pushing, publishing a PR, or deploying merely because the workflow was read or edited.** Those actions follow the current task and Jake's authorization.

### Before Git is available

Use strictly disjoint files/modules in the shared checkout with an explicit ownership map and one writer for each shared path. Avoid concurrent installs, build cleaning or edits to common outputs. Serialize inseparable integration work; continue independent feature modules in parallel when practical. Do not invent an ad hoc copy-and-merge system or initialize Git solely to unlock concurrency. Transition to worktrees when the assigned Git setup is complete.

### Shared runtimes and final acceptance

During live play, use the registered accepted artifact through `play.command`, `dashboard.command` and `logout.command`. Its ignored operator profile pins the build and private world config. Keep development builds and fixture status in independent data directories. Development workers never invoke these controls against the real profile, fetch the operator's credentials, or interrupt the live bot to test a helper. The coordinator accepts controls on a separately leased loopback fixture, then verifies reuse of the existing live session.

Worktrees do not isolate Minecraft worlds, ports, RCON scene resets, provider quotas or the DSH host. Codex grants exclusive time windows for shared fixture resets/live harnesses and schedules real-provider acceptance. Separate fixtures are an option only when actually provisioned and verified under the assigned scope. Workers do not restart/stop a shared fixture or DSH while another worker uses it. Coordinate a required DSH restart around **all** active native turns.

Parallel source work may continue in isolated worktrees while Codex tests an immutable integration build. No other worker may edit that checkout or reset its fixture during acceptance. Verify each feature and the integrated result; record failures under stable IDs and send consolidated corrections to the responsible worker. Continue ready branches while a dependency is being reviewed.

## Durable working documents

Create supporting documents as tasks need them. Missing roadmap or supervision files in a new project are not permission to invent or start features.

| Document | Purpose and owner |
| --- | --- |
| `AGENTS.md` | Repository entry point, architecture, runtime constraints, and actual required checks. All agents follow it. |
| `agent-workflow.md` | This reusable procedure. Keep current task and session status elsewhere. |
| `feature-plans.md` | Feature roadmap, links to detailed plans, and summary status. Codex owns scope and acceptance. |
| `docs/*-plan.md` | Feature behavior, dependencies, milestones, decisions, acceptance criteria, and remaining work. Extend a relevant existing plan instead of creating a competing one. |
| `docs/agent-supervision.md` | Coordinator handoff: local runtime, worker IDs and ownership, decisions sent, queues and pending questions, evidence, deployment state, and next action. |
| `docs/reviews/` | Delivery evidence and known gaps. Workers report evidence; the coordinator independently checks acceptance. |

At the beginning of a task, inspect Git status when the directory is a Git repository, relevant plans, and the latest supervision checkpoint if present. Preserve unrelated dirty work. For implementation or live investigation, also inspect the local runtimes and existing worker sessions. Planning-only intake and documentation edits do not require runtime access.

Historical notes do not override Jake's current request. Do not initialize Git, commit, push, or deploy solely because a workflow document was read; follow the current assignment and existing authorization.

### Record bugs and behavioral edits before implementation

Record each reported bug or behavioral edit in a repository Markdown plan during intake, including reports collected while implementation is on hold. A chat acknowledgment is not a durable record. Extend the relevant feature or issue plan; create a focused `docs/*-plan.md` only when none fits, and link it from `feature-plans.md`.

Give each issue a stable ID, such as `MB-001`. Include:

- Report date and status.
- User-reported behavior and expected outcome.
- Available reproduction context and relevant session or agent identifiers.
- Observed evidence, separately from hypotheses and coordinator assumptions.
- Unresolved questions and observable acceptance criteria.

For Minecraft reports, include edition/version, test world or server context, agent command, and logs when available and relevant. Do not include secrets. Keep incidental errors distinct from the requested fix.

An explicit “do not start yet” remains in force. Mark the batch and issues **recorded — awaiting Jake's start instruction**, with no worker assigned. Add later reports to the same batch. Documentation updates do not authorize worker launches, implementation changes, runtime probes, or deployment.

When Jake starts work, scope the brief to specific issue IDs and plan sections. Maintain ownership, session IDs, decisions, evidence, and remaining work through acceptance. Do not mark an issue fixed solely on a worker's claim.

### Required feature-plan contents

Every implementation plan includes:

1. The user outcome and a concrete happy path.
2. Scope and explicit exclusions; starting/default, loading, empty, error, cancellation, and persistence behavior where relevant.
3. Jake's decisions and separately labeled coordinator assumptions.
4. Existing code and integration seams to inspect, plus any bounded research gate. Each gate states a question, a probe, and the decision it will resolve.
5. Small end-to-end milestones with observable acceptance criteria and appropriate tests or live checks.
6. Current status, unresolved dependencies, and evidence still needed.

For gameplay features, specify relevant join/disconnect behavior, player identity, command handling, interruption, and recovery. Select only the cases the assigned behavior needs; do not expand every feature into a full game-agent architecture.

Keep scope and status synchronized after material decisions. A milestone is an implementation checkpoint, not permission to abandon the rest of the assigned outcome. If a capability is proved unsupported, document the evidence, choose a supported fallback within scope when possible, and continue independent work.

## Launching the native implementer

Use the authenticated **local DSH** profile and its **native Codex preset**, selecting Jake's personal ChatGPT account per session. Resume a worker when its context and assignment remain useful. Start a new session for a different native backend, a separate feature, polluted context, or a bounded probe. Inspect queued messages before resuming so an old assignment is not accidentally activated. When changing backend, preserve the old session and drafts, transfer the complete brief and review, and withdraw old pending execution queues before giving its worktree to the new worker.

Before sending work:

1. Confirm the local DSH instance, absolute project directory, registered workspace, session ID, native Codex preset, personal subscription route/account, selected model, effort, and effective permissions. Attach the worker to this project's workspace through the installed supported mechanism; a matching working directory alone is not proof of project membership.
2. Verify the **native App Server used by the installed integration**: `initialize`, a read-only `account/read` selecting the intended home, and `model/list` showing exactly `gpt-6.1-sol` and supported `xhigh` effort. A UI label or `codex --version` alone is insufficient. Check the session-local selection and actual native thread/turn evidence after launch; do not invent a model identifier or assume it is installed. These metadata probes do not start inference or refresh login.
3. If availability or model naming needs clarification, consult current official OpenAI information. Do not silently substitute another model, account, remote worker, or API billing. If the requested model is unavailable, report the exact limitation and continue planning/review work. A different-model fallback requires Jake's decision.
4. Use `xhigh` effort and preserve Jake's personal account. Set full native access to `danger-full-access` and approval policy `never`; inspect the effective integration settings and actual pending approvals instead of assuming a “Full access” label guarantees tool access. Keep selection session-local rather than changing global provider defaults.
5. Send a complete, bounded brief. Record the session and verified configuration in `docs/agent-supervision.md`, then confirm the turn actually starts.

If the catalog is stale, check the installed integration's native catalog before changing runtime dependencies. Any necessary CLI/integration update must be a deliberate, scoped runtime change with pinning, build, and validation appropriate to the installed DSH repository. Changing the CLI alone does not prove what the running integration resolves. Do not incidentally upgrade the harness, and coordinate any restart around active workers.

Use the supported local UI, tools, or installed public API. Prefer T3's collaborative preview tools when available; follow their availability and fallback rules. Inspect the current API schemas before using RPC recipes from another project. Do not expose authentication cookies, tokens, or private profile data in logs or documentation.

Prompt acceptance or queue insertion is not proof of execution. On a transport timeout, inspect the session and inbox before retrying a mutation. Record created IDs immediately and avoid duplicate assignments. Read full worker responses for review; a truncated turn outline is not a substantive handoff.

## Implementation prompt template

Fill every placeholder with concrete paths and outcomes. Put essential instructions in the prompt itself; a temporary file path is insufficient if the worker cannot read it.

```text
You are the native DSH implementation worker. I am Codex, your coordinator and reviewer.
Jake owns product direction; send implementation questions to me in this DSH chat.

Task: [feature and complete assigned outcome].
Repository: [absolute assigned checkout/worktree]. Read AGENTS.md and the "If you are the
implementation worker" section of agent-workflow.md, then [plan path and specific sections].
This assignment limits scope. Do not start unrelated roadmap work or launch workers.

Behavior and acceptance criteria:
[Concrete scenarios and outcomes, including relevant failure and interruption cases.]

Decisions already made:
[Jake's choices, labeled coordinator assumptions, verified integration findings.]

Ownership: [paths you may edit; other workers and disjoint scopes]. Preserve existing unrelated changes.
Git: [assigned branch/worktree, integration base, local commit and handoff expectations; or no Git yet].
Shared integration changes: [coordinator-owned paths and how to request needed edits].
Runtime: [local DSH session, source/build/run paths, affected project processes,
Minecraft test target if relevant, existing workers, shared-resource lease and actual restart constraints].

Implement the entire assigned outcome, wire it into its real entry points, and
validate it. Do not stop after research, helpers, tests, or one milestone when
required work remains. Make routine reversible choices consistent with the plan
and document them. If a real decision blocks you, send the exact question and
your recommendation, then continue independent work. After my answer, resume;
do not ask whether to continue.

Checks: [actual affected checks from AGENTS.md, exact commands, and live scenarios].
Capture real exit statuses. Use the designated test world for gameplay probes;
do not test failure recovery by damaging Jake's active world or breaking DSH.
Do not restart the DSH process hosting this turn. Hand off READY_FOR_RESTART
when needed. [Other actual scope restrictions.]

Handoff: branch/worktree/base/head and local commits when applicable; changed paths;
acceptance criteria met and still missing; exact checks
and results; source vs built vs running state; blockers/questions and recommended
resolution. Claim ready for review only when the assigned outcome is complete,
or identify a concrete external blocker. Test counts alone do not prove delivery.
```

## Supervision loop

Codex remains responsible until the requested outcome is verified, Jake pauses or cancels, or a genuine external dependency prevents further progress.

1. **Observe.** Check running state, recent output/tool activity, pending interactions, errors, and queued work. Poll at a sensible cadence, usually 15–30 seconds. Review relevant diffs and evidence between checks, and give Jake concise progress updates at least once a minute during active work. Silence alone is not proof of a hang.
2. **Unblock.** Answer ordinary questions directly. Approve routine actions already within scope through the actual approval surface. Diagnose denied tools rather than repeating the same command or weakening global permissions. When appropriate, perform an already-authorized scoped operation yourself and return the evidence.
3. **Continue.** Compare a worker's handoff with the acceptance criteria. If it stops early, identify the missing items, resolve its questions, and send a concrete continuation. “Shall I do the next part?” is not a task boundary.
4. **Review.** Inspect source and actual entry-point wiring, reproduce relevant behavior, and verify evidence. Send a consolidated correction brief with reproducible failures and expected outcomes. Recheck current files before repeating a finding.
5. **Accept.** Verify the integrated result, update plan status and the supervision checkpoint, and report the outcome and material limitations to Jake. Continue other already-assigned milestones without another permission loop.

Useful continuation wording:

```text
Coordinator decision: [answer and reason]. Record it in [plan/decision section].
The assigned feature is not complete yet: [specific unmet criteria].
Continue in this session and finish [concrete remaining work], then run
[appropriate checks]. Do not stop for another choice about implementation order.
If one part is externally blocked, provide exact evidence and finish the rest.
```

Do not assume a queued or steered message reached a running native query. Deliver at a turn boundary and verify the response reflects it. For an urgent correction, cancel only the affected worker at a safe checkpoint, verify it is idle, inspect the queue, and send one consolidated continuation. Do not flood it with duplicate prompts or kill DSH to interrupt a worker.

For a suspected stall, inspect activity and the exact subprocess first. A long test or reasoning interval can be healthy. Diagnose boundedly, stop only a confirmed stuck turn/process when needed, preserve edits, and resume with the finding. Repeating an unchanged failing test or already-passing full suite is not progress.

## Acceptance and delivery

Review the user-visible outcome and runtime integration, not only the worker's summary. Check real entry points, boundary data, async cancellation and cleanup, session/player identity, permissions, and reconnect behavior where the change touches them. Use relevant adverse scenarios without expanding small changes into an exhaustive audit.

For code changes, follow the actual checks recorded in `AGENTS.md`: affected tests, build/typecheck, and any installed diagnostic or integration checks required for that change. Verify relevant Minecraft behavior in the designated test world when gameplay is part of acceptance. Record edition/version and runtime configuration with the evidence. Mock tests alone do not establish that an agent can join and play.

Capture command exit codes directly; avoid pipelines that can hide failures. Repeat checks when new edits, failures, or unresolved concerns justify it. Documentation-only changes need content, link, and diff review, not an unrelated rebuild or worker launch.

Keep delivery states distinct: **implemented**, **verified locally**, **ready for restart**, **verified running**, and **committed/reconciled** when applicable. Record which version is built and loaded. Say exactly which state has been reached; source accepted offline is not a feature Jake can already use.

If deployment belongs to the assignment, complete it within existing authorization. Restart only the affected runtime. A worker must not restart DSH while DSH hosts its turn. Codex coordinates that restart after required checks and once affected turns are idle, preserving runtime state and verifying the intended checkout/build. Project application or Minecraft restarts have separate constraints; follow the feature plan and world-storage requirements. Recheck the requested behavior afterward.

### Verified application updates — planned MB-OPS-001

Jake wants Chunkbot updates applied after independent acceptance while he plays, and accepts a brief Chunkbot-only automatic reconnect. [MB-OPS-001](docs/live-update-plan.md) defines the proposed release manager, immutable builds, stop/logout and budget preservation, loaded-version checks, truthful chat announcement and bounded rollback. This service is **not implemented**; this paragraph supplies no new launch/deployment command or connection authorization.

The implementation assignment must deliver and test the real promotion/status/rollback entry points, then replace this planned section with the proven operator procedure and update README.md/AGENTS.md. Codex owns promotion of the integrated accepted artifact; parallel workers hand off their branch/commit, artifact and acceptance evidence rather than independently updating the live bot. Keep the playing release isolated from development builds and fixture resets. Within a deployment-authorized managed session, use the accepted update policy without asking for repeat permission; an offline/logged-out Chunkbot stays offline until explicitly started. Record the actual loaded release and deployment result in supervision.

### Coordinator checkpoint

Keep a compact checkpoint in `docs/agent-supervision.md` after each meaningful handoff:

```text
Feature / plan / issue IDs:
Local DSH instance / worker sessions / workspaces / assignment ownership:
Git branches / worktrees / integration base and heads / pending integrations:
Shared runtime/fixture leases / dependencies / concurrency decisions:
Preset / subscription route / resolved model / effort / effective permissions:
Owned paths / baseline dirty work:
Last turn state / pending queue or interaction:
Latest decision / delivery confirmed:
Completed acceptance criteria / remaining criteria:
Checks and evidence / relevant Minecraft configuration:
Source checkout / built version / running version / restart needs:
External dependencies, if any:
Next concrete action:
```

### Validate local orchestration when setup is assigned

Use a separate test session on the verified native subscription route and requested model. Ask a bounded no-tool question that makes the worker request a coordinator decision; answer it and verify a second turn completes. Follow with a narrowly scoped read-only repository task to check native tool access.

Inspect full responses, confirm idle state and an empty queue, then settle/archive the test chat through supported controls. Record session IDs, model resolution, continuation delivery, and tool results in the supervision note. This validates local orchestration; it does not establish that Chunkbot features are implemented.
