# Oct 13 release-manager worker review

Scope: MB-OPS-001 U-G2/U-G5/U2/U3/U5, with the shared MB-OPS-002 manager/control seam. This is offline implementation evidence; it is not integrated, accepted or deployed gameplay.

## Checkout and native route

- Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-manager`.
- Branch: `chunkbot/batch-20261013-manager`; common base `2b9255c25e75519c06c94602d5ac60224a3c0521`. Initial staged/unstaged/untracked status was clean.
- Actual native thread: `01a13846-1ce9-7a20-89e7-4e3b117f7243`, originator `dsh_provider_codex`, CLI `0.162.1`, exact assigned cwd, `gpt-6.1-sol`, `xhigh`, `danger-full-access`, approval `never`. Mode-only coordinator gate at `var/parallel-20261013/native-gate.json` reports initialize/account-read(refreshToken:false)/model-list passed for existing `chatgpt/prolite` route. No worker login refresh, account/config change or inference probe.
- Port milestone commit: `9418e839876219b7b559071bea02e206c4d7c206` (+163 lines in the new owned ports file). Its guarded typecheck exited 0. No companion SHA has been approved/imported, and no shared file has been edited.
- Implementation commit: `6d7d227a20a1c5b473ac05164678502bf9861f80` (seven owned paths, 1,553 insertions/one deletion). Final report is a separate documentation-only commit. All task source/tests are committed; no owned source dirt remains.
- An external preparation fast-forward to `9ca70cbaba438033fbfd35d4097ab69339ba612d` occurred after the initial clean-base inspection and before the first worker commit. Reflog records `merge 9ca70...: Fast-forward`; this worker issued no merge/cherry-pick. It changes seven coordinator-owned planning/supervision documents (33 insertions/20 deletions). Preserve it. Review/cherry-pick only the listed owned worker commits; do not attribute that inherited documentation diff to this implementation.

## Implemented behavior and entry points

[`src/updates/manager/index.ts`](../../src/updates/manager/index.ts) exports `createNativeReleaseManager`, which binds `ReleaseManager` to the actual `NativeChildDriver`. [`child-endpoint.ts`](../../src/updates/manager/child-endpoint.ts) exports `attachManagedChild`, the child-side IPC entry point. The native tests use both exported entry points with credential-free fake Node children; they do not connect to Minecraft or call a model.

- One exclusive profile lease, one registered child slot, one transition and one staged candidate. Re-offering the active release cannot reconnect or repeat a notice. Repeated on during joining is idempotent. Source saves never trigger this API.
- Offline updates stage only. Manager restart ignores saved online intent; bridge requests require a fresh boot token, profile/session match, monotonic generation and a TTL no longer than 30 seconds. Bare resume changes pause without joining or replaying.
- The accepted artifact is validated before touching A, the fallback is validated before drain, and bytes are revalidated immediately before launch. Mismatched digest/profile/checkpoint schema is refused. The artifact validator must prove acceptance, completeness, hashes and reversible compatibility.
- Drain closes admission, cancels preparation/providers and proves actuator/interface/socket cleanup. The checkpoint port validates the durable child freeze and retains its logical session/accounting reference. Root, observed retained descendants and sockets must be proved gone before replacement. Uncertain checkpoint/intent writes block further launches; no budget is created by promotion or rollback.
- The native adapter forks a fixed Node entry point without shell hooks, automatic login or runtime restarts. It tracks root birth and registered descendant identities, including children that leave the process group. Signals require a fresh identity match. Unknown/foreign PIDs are never adopted; process-table failure is not proof of absence. An uncertain audit holds the slot.
- The joining child remains admission-gated. Readiness checks release digest, profile, checkpoint identity, valid fresh spawn, connection epoch, server-confirmed inventory/observation, capability registration, provider/auth readiness and pause. Atomic commit precedes activation; activation must recheck current readiness. Notice is one bounded attempt through the existing configured owner reply mode, with no public fallback or inference. Missing chat acknowledgment remains visible as unavailable.
- Downtime is measured from child-reported local socket closure (`DrainEvidence.socketClosedAtMs`) to the replacement's valid spawn (`ReadinessEvidence.spawnedAtMs`), including the checkpoint/cleanup gap. Closure/spawn/observation timestamps must be finite and ordered; a copied pre-launch spawn is refused. These are local connection-event measurements; real server/owner observations remain fixture acceptance.
- Stop/off generation fences every await; a newer command prevents an older promotion/reconnect/rollback. A pre-existing stop survives successful update and rollback. Logout captures accounting, proves cleanup and stays offline. Lost activation acknowledgment is treated as potentially dispatched work and requires a checkpoint before replacement.
- Candidate startup/readiness failure permits one fallback after full candidate teardown. A second failure remains stopped. Auth, whitelist, server, identity and protocol failures never try alternate code as an external-service repair. Natural root/connection loss revokes ready status and schedules no reconnect.
- Child IPC has bounded envelopes, correlated request IDs, child/session/deployment/command fences, initialization/activation/notice deduplication and a finite active request set. Drain aborts initialization and awaits its actual settlement. A timeout does not release the manager's unresolved-operation barrier.

## Exact integration dependencies

The coordinator owns existing app, CLI, config, controls, shared contracts and composition. None was changed. The proposed owned [ports](../../src/updates/manager/ports.ts) are reviewable contracts, not approval to import companion commits.

1. Bind packaging's approved artifact validator to `ArtifactPort.validate(id, signal): Promise<AcceptedRelease>` and its active pointer/journal writer to `commitActive(release, fence, signal): Promise<void>`. Commit must atomically fence against the latest persisted command intent; cancellation alone is insufficient. Revalidate the complete accepted artifact immediately before execution. Map packaging receipt fields into the manager view rather than inventing a second artifact format.
2. Bind the approved checkpoint store to `persistIntent(intent, signal): Promise<void>` with monotonic durable CAS and `capture(child, drain, signal): Promise<CheckpointRef>`. Capture must validate the supplied freeze, retain full ambiguous reservations, disabled-provider state, consumed counters, deadlines and immutable directive semantics. It must never refresh allowance or turn historical effects into current inventory. Only a durable opaque reference crosses this manager seam. Store recovery and continuation compatibility remain checkpoint-owned.
3. Acquire `acquireManagerLease(sharedProfileDirectory)` outside all release directories and retain it across child replacement. An existing/uncertain lease is not automatically reclaimed. Release it only after `off()` has proved cleanup. Explicit recovery of stale leases/processes belongs to the coordinator's proven controller protocol; this module adopts no old child PID.
4. Existing CLI managed mode must detect `CHUNKBOT_MANAGED_CHILD=1`, install `attachManagedChild(services, ipc)` **before joining**, and wait for initialize. Ordinary unmanaged startup must not accidentally join in managed mode. Supply independently measured loaded artifact/profile/readiness, restore durable accounting before admission, use real GoalEngine/preparation/provider/control/interface shutdown and socket evidence for drain, report actual socket-closure/valid-spawn timestamps, and recheck live readiness atomically in activate. Call endpoint `reportLoss` on unexpected game lifecycle loss. Existing `replyToOwner` is best effort; return unavailable unless the adapter has the claimed delivery evidence, and preserve whisper/public configuration.
5. Bind the trusted local controller/bridge to `manager.control(request)`. It must authenticate the configured owner itself, read `status().controlSessionId`, and use fresh request generation/expiry. This surface accepts on/off/stop/resume only; promotion stays a trusted local artifact operation. The manager adds no public HTTP endpoint or arbitrary chat deployment command.
6. Map `ManagerStatus` into existing read-only status/dashboard. A retained child registration in blocked state is cleanup uncertainty, not proof that the bot is online/offline. Natural crash/kick must not create an implicit new start or budget.

Concrete production blockers: review/approval of these contracts and exact companion SHAs; artifact/checkpoint adapters; existing CLI/app/controller binding; coordinator-granted world leases and real acceptance. No dependency was imported to bypass them.

## Checks and retained evidence

All heavy commands use the coordinator's ignored two-slot stdlib guard, Node 24.21.0 first in PATH, this worktree's own installed node_modules/dist, and private credential-free scratch under ignored `var/manager-*`.

| Check | Direct exit / result | Evidence |
| --- | --- | --- |
| Port milestone typecheck | 0 | Native tool result before `9418e83` |
| Implementation typechecks 1–3 | 0 | `var/manager-checks/typecheck-implementation-1.log`, `typecheck-implementation-2.log`, `typecheck-3.log` |
| Focused tests 1, 2, 3 | 0; 27/27, 27/27, 33/33 | `var/manager-checks/focused-1.log`, `focused-2.log`, `focused-3.log` |
| Intermediate lifecycle typecheck/focused tests | 0; 35/35 | `var/manager-checks/typecheck-4.log`, `focused-4.log` |
| Further boundary reviews | 0; 37/37 then 39/39 | `var/manager-checks/typecheck-final.log`, `focused-final.log`, `typecheck-final-2.log`, `focused-final-2.log` |
| Final delivery typecheck/focused tests | 0; 40/40 | `var/manager-checks/typecheck-delivery.log`, `focused-delivery.log` |
| Builds before final timing changes | 0 | `var/manager-checks/build-1.log`, `build-final.log`; retained, final build below |
| Delivery build | 0 | `var/manager-checks/build-delivery.log` |
| Full suite | 0; 1,705/1,705 | `var/manager-checks/full-test-1.log`; one full run against delivery source |
| Read-only doctor, 26.1.2 fixture config | 1; planner executable pin mismatch | `var/manager-checks/doctor-26-1-2.log` |
| Read-only doctor, 26.2 fixture config | 1; identical planner executable pin mismatch | `var/manager-checks/doctor-26-2.log` |

No observed worker check failure has been discarded. Later checks are justified by new lifecycle/control/test changes, rather than repetitions of unchanged full passes. Native dummy processes are task-owned; an unrelated sentinel survives. Fake IPC/fixture proofs test the supervisor's decisions and lifecycle protocol, not live Mineflayer/server readiness.

Both doctor failures are retained without retry: example configs resolve `/opt/homebrew/bin/codex` to CLI `0.162.1`, but the separate gameplay planner's isolation gate requires exactly `0.160.0` and correctly fails closed. Node, packages, both version profiles, fixture config, offline admission, capabilities and knowledge pass. Missing private fixture setup/key/scope are warnings; no setup or inference was attempted. The worker did not change the planner model, effort, binary selection, pin or isolation. Coordinator acceptance must supply the already-approved gameplay executable/configuration without weakening that gate; the development route remains 0.162.1.

Delivery digests (`var/manager-checks/digests.json`): SHA-256 over sorted relative paths, NUL, bytes, NUL for each file. `source` includes `src/**/*.ts`; `dist` includes every built file; owned subsets include only the manager directory.

| Artifact | Files | SHA-256 |
| --- | ---: | --- |
| Source | 180 | `09c4f88d3b1bfb4ffaf944a4bddffe3a8221cec1afe4616d031e64ba4fb06e1e` |
| Owned source | 6 | `e8b9cfa949d4bdaadeb54d1890958dced9d6a5a4652c0c54d46daf77134bd301` |
| Built dist | 360 | `4b2b077c01335c97b84d378840cd98b5c8a586d835da82bc8aed2e69e04eaee5` |
| Owned built dist | 12 | `cc37392bb096fd92e44adf78accbdcc9f06fdd73e7f99ea53758e10997c53807` |

## Deferred acceptance and limitations

All fixture leases were absent. No fixture/server/client/world query, connection, reset, settings change, provider call, vault/key/cache access, real controls, accepted artifact change, deployment or DSH restart occurred. The separate accepted playing release `64e2609` remains untouched. Existing gameplay planner model/effort/CLI pin/tools/isolation remain unchanged.

U-G2 still needs integrated real app drain evidence for delayed planner descendants, sustained execution and inventory-changing work. Native ownership sampling retains **observed** descendants; the actual child's process ownership/drain oracle must prove its registered planner/process cleanup, including any child that could otherwise escape between samples. Without that proof a deployment must not launch a second bot.

U-G5/U2 still need exact-artifact launches on both leased versions, actual server/profile/identity/spawn/fresh server evidence, measured gameplay downtime, loaded bytes and owner receipt of the truthful notice. No server action or paid inference should be added merely to announce readiness.

U3 needs integrated local/server controls at each real deployment boundary; U5 needs packaging tamper/incompatible-migration trials, actual startup/readiness failure and one rollback. Conservative crash-safe budget/directive preservation is checkpoint/integration-owned and requires its own fault plus real-provider acceptance. The manager never rewinds world/memory/charges or claims arbitrary continuation is safe.

Source is this branch; built output is only this worktree's `dist`; no process is running the production artifact from these changes. Local source/fake tests do not close integrated or deployed acceptance.
