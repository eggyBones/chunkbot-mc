# Oct 13 managed checkpoints worker review

Status: owned checkpoint module implemented; integrated Chunkbot behavior and real acceptance remain pending. This is source work, not a deployed or accepted update. The latest prompt selects this report path instead of the older preparation brief's report path.

## Checkout and authority

- Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-checkpoints`.
- Branch: `chunkbot/batch-20261013-checkpoints`.
- Common base: `2b9255c25e75519c06c94602d5ac60224a3c0521`; initial staged/unstaged status and diffs were clean.
- Before the first owned commit, Git records an external fast-forward to preparation commit `9ca70cbaba438033fbfd35d4097ab69339ba612d` (narrowed ownership/two check slots). It is preserved as an inherited ancestor. Its seven coordination-document changes appear in a whole-branch diff from the recorded base; they are not worker edits or a companion import performed here. Every owned commit stages explicit owned paths only.
- First focused contract commit: `2a6fc4dbe63419d98d1afc0cb84b92f146af957f` (`schema.ts`, `ports.ts`, 199 additions); guarded typecheck exit 0 before storage implementation.
- Source implementation commit: `aa7936f20272c4b7985ce54a8c4cdcdbc00409fb` (919 additions/one deletion across seven owned paths after the contract commit).
- Readiness-port completion: `1220ca04fd4b1305bd97f2751eb383074df69b3f` (four additions in three owned files).
- Atomic decision-attempt completion and final source: `33ccea6bdc739d6d5ff2eb473c8e8c6b9f4d816d` (56 additions/nine deletions in five owned files). Exact base-to-final-source patch, filtered to owned source/tests: `var/checkpoints-checks/source.diff`. Source is frozen at this commit; the remaining commit contains this review only.
- Observed native thread: `01a13846-36ca-7961-a64a-50bc626689fb`; shell exposes home `/Users/jakewilcox/.codex` and a native Codex process under Node. Preset/account/model/effort are not exposed to this shell. The coordinator's launch evidence supplies CLI 0.162.1, relay-codex, codex:codex-default, ChatGPT/prolite, gpt-6.1-sol/xhigh, danger-full-access/never. No substitute account, model, login refresh or global change was attempted.
- All fixture leases absent. No fixture/server/world/client query, join, restart, mutation, real control invocation, credential access, provider inference, worker launch, deployment, push or companion import occurred. Gameplay planner pins and isolation are unchanged.

## Implemented owned entry points

`src/updates/checkpoints/index.ts` exposes the production store, accounting durability adapter, and projections from the **existing** `ContinuationCheckpoint`, `RouteLineage` and `SpendLedger` surface. Source tests import this entry point; crash children import the same module and use only task-owned ignored scratch directories and fake provider work.

```ts
new ManagedCheckpointStore(options: CheckpointStoreOptions)
store.open(): CheckpointLoad
store.createSession(input: CreateManagedSession): ManagedCheckpoint
store.control(command: 'stop' | 'logout' | 'resume' | 'start' | 'directive'): number
store.captureGoal(input: CaptureManagedGoal): void
store.prepareReplacement(input: {
  expectedGeneration: number;
  cleanup: 'owned_child_settled';
}): ManagedCheckpoint
store.resumeView(): ResumeView
store.consumeAllowance(key: string, amount: number, expectedGeneration: number): void
store.disableProvider(provider: 'planner' | 'decision', reason: string): void
store.close(): void

new CheckpointAccounting(store, restore: RestoreCheckpointSpend)
accounting.reserve(amountUsd: number, label: string,
  owner?: { goalId: string; expectedGeneration: number }): SpendReservation | undefined
accounting.beforeDispatch(reservation: SpendReservation): void
accounting.reconcile(reservation: SpendReservation, costUsd: number): void
accounting.retain(reservation: SpendReservation): void
accounting.release(reservation: SpendReservation): void

projectContinuationCheckpoint(checkpoint: ContinuationCheckpoint,
  input: ManagedGoalProjection): SemanticGoal
projectRouteLineage(carry: RouteLineage): NonNullable<SemanticGoal['route']>
```

The store writes private 0600 checksummed revisions under a 0700 dedicated directory: exclusive temp write, file fsync, revision rename, directory fsync, independently atomic/fsynced head, then acknowledgement. A chain plus head detects gaps, a missing tail and unpublished extra revisions. Newest corruption, unsupported formats, scope/session mismatch, incomplete writes and ambiguous locks are held; there is **no older-budget fallback**, pruning, implicit migration or fresh default cap. A dead writer is adopted only under an exclusive recovery guard after a read-only PID-liveness check. PID reuse/unknown ownership and abandoned recovery guards stay held.

An unclean manager restart durably records `held_unclean`. Compatible accounting still retains every outstanding maximum, but a child cannot be bound and automatic resume remains held until explicit operator start. The hold survives a further graceful reopen. An update/rollback inside the still-running manager instead calls `prepareReplacement` after actual owned-child cleanup, retaining unresolved charges without changing logical session, cap, directive generation or semantic goal. Store code does not claim to prove external child/process/socket cleanup; the manager must establish that fact before calling it.

Control acknowledgement follows durable commit. Stop keeps pause, logout keeps offline intent, and directive/control generations fence delayed captures and pending provider dispatch. Resume does not replay stopped work. Generation-specific operation guards differ from child-lifetime accounting ownership: an ordinary new directive uses the same ledger, but cannot dispatch/refund the old directive's permit. Trustworthy late costs can update accounting only; they cannot produce goal completion or overwrite a directive. Replacement invalidates the old child's settlement authority.

Supported semantic views preserve original logical goal, immutable outcome digest, ALL-item acquisition baseline/provenance, admission anchor, counters/caps, absolute deadline, count/effect credit and consumed allowances. With 8 original logs, a goal for 5 additional logs and 4 credited, the saved target remains 13, not 17 from a refreshed baseline of 12. A persistent near-owner outcome saves the semantic owner selector and requests fresh planning; it saves no task or entity handle. Historical effects are explicitly historical. Original counters, caps, latched credit and verified effect prefix cannot be refilled or rewritten on the same directive.

Reference-bearing outcomes are held with digest only; handles/action IDs/tasks/planner drafts/interface bindings are not saved. Display-only/restart/terminal continuation records are never upgraded into active authority. Missing decision allowance, count provenance after an own-loss incident, expired/exhausted limits and disabled providers remain held. Route usage retains original ceilings/deadline/anchor/source/destinations and consumed distance sources/legs/stalls, but returns `route_requires_compatible_rebind`: existing route admission is connection-local and cannot be promoted into fresh connection authority by this store. Removal/container/craft/place jobs with old references are held, not replayed.

The accounting adapter delegates cost arithmetic to the real `SpendLedger`. Its port includes the actual Jev readiness reads `readonly capUsd` and `remainingUsd()`. A reservation reaches durable storage before it is returned for dispatch; failed persistence returns no permit. An active captured goal requires the exact logical-goal/generation binding; money and that goal's `decision_attempts` debit commit **in one revision**. Refused funding does not debit a goal attempt, matching the current Jev adapter. A provider-I/O crash cannot refill the decision allowance while retaining its monetary charge. No reservation labels, provider keys, environment, tokens or auth caches are written. Unknown in-flight charges become fully retained, including pending attempt counts; repeated reopen/rollback does not double-charge or refill. Forged/double reservations and outside-adapter ledger mutations are refused. Untrustworthy reported cost retains the maximum and disables the decision provider **in one atomic revision**, so a crash cannot preserve the charge while losing the disable flag.

## Exact integration-owned dependencies

No shared file or another worktree was edited. No proposed seam/companion commit has received approval in this worker chat as of this review.

1. **Spend restoration:** implement and validate `SpendLedger.fromCheckpoint(snapshot: SpendSnapshot): SpendLedger` in `src/decision/spend.ts`, then supply it as `RestoreCheckpointSpend`. Input has already been schema-validated and has zero outstanding spend after recovery/replacement. Restore cap, reconciled/retained amounts, ALL counts, and a collision-safe next reservation ID. A restored snapshot must equal the input exactly; the owned adapter refuses a newly zeroed ledger. This is the only missing ledger mutation seam. No private fields are patched from this module.
2. **Provider and allowance wiring:** use the durable adapter at the actual reservation/HTTP-dispatch boundary; no await may split `beforeDispatch` from initiating HTTP. Export/restore Jev per-logical-goal attempt allowance and disabled state, plus session preparation/support/recovery allowances, from their actual owners. Feed these as `SemanticGoal.allowances` and `ManagedCheckpoint.allowances`; `decision_attempts` is required for a resumable goal. Do not infer missing allowances from log text or allocate defaults. The current concrete Jev option is typed as `SpendLedger`; integration must accept `CheckpointSpendPort` (including cap/readiness fields) or add equivalent persistence hooks. Pass the request's original manager-correlated `{goalId, expectedGeneration}` as the third reservation argument; do not substitute a later current generation. A minimal optional `checkpointOwner(request)` option can provide this binding at the existing `reserve(maxCharge, requestId, owner)` call. The existing explicit no-inference rejection branch is the only refund authority. An active captured goal with missing/stale binding is refused, not silently given a new allowance.
3. **Goal capture/admission:** at the actual drain boundary export the current code-authored immutable outcome, original admitted time/inventory/anchor, counters/caps/deadline, verified effects and count lineage. `projectContinuationCheckpoint` consumes the existing contract; extra fields come from those actual services. Existing optional durable survival continuation copies remain display-only. Admission of a `ResumeView.kind === 'replan'` must allocate fresh goal/connection ownership, bind the ORIGINAL outcome/baseline, restore remaining allowances and re-ground fresh server state; it must not call ordinary `submit` and refresh the acquisition baseline. Suggested minimal core seam: `captureManagedGoal(): SemanticGoal | null` and `admitManagedGoal(goal: SemanticGoal, expectedGeneration: number): Promise<ContinueResult>` (integration must validate cleanup/currentness and fresh epoch). The store never invokes either itself.
4. **Manager/IPC composition:** own this store outside immutable release directories, route absent-child terminal controls to its generation mutations, carry only validated semantic IPC, establish exclusive child cleanup before `prepareReplacement`, and use generation-bound fresh readiness before rejoin. An offline/paused/held view has no automatic execution authority. Status should expose the held reason honestly. Real CLI/composition/manager wiring is integration-owned and not present on this branch.
5. **Route/loss compatibility:** either implement a tested fresh-connection lineage rebind preserving original route ceilings, usage and own-incident identity, or keep those goals visibly held. Current same-connection route continuation and survival provenance are not sufficient proof across a managed child replacement. No duplicate recovery framework or memory store was introduced.

## Validation and remaining acceptance

All heavy commands use the coordinator's two-slot stdlib guard with Node `/opt/homebrew/Cellar/node@24/24.21.0/bin` first in PATH. Direct exits and complete logs live under ignored `var/checkpoints-checks/`.

- `01-contract-typecheck.log`: exit 0.
- `02-storage-typecheck.log`: exit 0.
- `03-focused.log`: exit 1, 16/19 passed. Retained original failures: strict zero assertion on floating residue; invalid synthetic `snap-1`; test child omitted its fixed clock during options serialization, causing truthful clock/lineage refusal. These were test input/assertion corrections, not suppressed failures.
- `04-owned-typecheck.log`: exit 0.
- `05-focused.log`: exit 0, 19/19 passed.
- `06-final-typecheck.log`: exit 0, before journal-head/replacement refinements.
- `07-build.log`: exit 0, before final replacement/accounting refinements.
- `08-final-focused.log`: exit 0, 23/23 passed.
- `09-final-typecheck.log`: exit 0, before final reservation-generation case.
- `10-final-build.log`: exit 0, before final lock/provider-disable hardening.
- `11-full-test.log`: exit 0, 1,689/1,689 passed, before final lock/provider-disable hardening.
- `12-typecheck.log`: exit 0, before final lock/provider-disable hardening.
- `13-doctor-26.1.2.log`, `14-doctor-26.2.log`: each exit 1. Both fail the unchanged gameplay-planner version gate: `/opt/homebrew/bin/codex` resolves 0.162.1, but gameplay isolation is pinned to 0.160.0. Config/packages/both version profiles pass; missing fixture JRE/server are warnings. No connection/inference occurs; provider keys were explicitly unset. No pin, config, login or global executable was changed. Coordinator must supply the separate pinned gameplay binary/config before real acceptance. These unchanged failures were not rerun.
- `15-lock-typecheck.log`: exit 0; `16-lock-focused.log`: exit 0, 25/25 passed, before atomic provider-disable refinement.
- `17-accounting-typecheck.log`: exit 0 on final source.
- `18-accounting-build.log`: exit 0 on final source.
- `19-final-full-test.log`: exit 1, 1,690/1,691 passed. All owned cases pass; the unchanged `tests/safety-defense.test.ts:141` scripted-defense case failed its 10-second settlement wait. Safety source and that test have no diff from the common base. Do not relabel this failed full gate as passed.
- `20-built-entry.log`: exit 0. The compiled `dist/updates/checkpoints/index.js` imports and exposes the four production store/accounting/projection entry points.
- `21-safety-defense-focused.log`: exit 0, 10/10 passed. The full-run safety failure did not reproduce in isolation; load sensitivity is an inference, not a proven root cause.
- `22-final-owned-focused.log`: exit 0, 26/26 passed on final source.
- `23-bounded-full-test.log`: exit 1, 1,690/1,691 passed, with `npm test -- --test-concurrency=2` under the same guard. The same safety-defense wait fails; that changed concurrency did not resolve it. No test was skipped or edited.
- `24-port-typecheck.log`, `25-port-build.log`: each exit 0, before the atomic decision-attempt seam.
- `26-final-serial-full-test.log`: exit 0, 1,691/1,691 passed with `npm test -- --test-concurrency=1`. This changes only test-file scheduling and preserves the two failed full-run logs. Root cause of the timing variation remains unproved.
- `27-atomic-attempt-focused.log`: exit 0, 27/27 passed on final source, including per-goal budget/provider-I/O crash coupling.
- `28-atomic-attempt-typecheck.log`: exit 0 on final source.
- `29-atomic-attempt-build.log`: exit 0 on final source.
- `30-atomic-attempt-full-test.log`: exit 0, 1,692/1,692 passed on final source with `npm test -- --test-concurrency=1` under the resource guard. No skipped tests. Standard/concurrency-2 full-run timing failures remain retained; serial execution is the verified scheduling condition on this nine-worker machine.
- `31-final-built-entry.log`: exit 0 on final built source; compiled public entry points and the actual Jev readiness cap getter are present.

Final digests (`var/checkpoints-checks/final-digests.json`): sort repository-relative paths, append each path, NUL and sha256(file bytes), then sha256 the accumulated bytes.

| Set | Digest |
| --- | --- |
| Owned source, six TypeScript files | `sha256:6d2d9b6d98fd9079a274591dab1e069b1703411745df92cbdb2dbe23cef99ce7` |
| Application build inputs, 185 files (all src TS, clean-dist script, tsconfigs and package manifests/lock) | `sha256:90e93a21d57e5d22891857559693410f1e44841d5ecd9ef3d57f86002e530373` |
| Built dist, 360 files | `sha256:2624a09d9ee19e0dcb81b51e87d7c52bc7cdf36593ed34128f4c8cc8b0d9b0d3` |

Initial/intermediate digests remain separately in `var/checkpoints-checks/digests.json` and `pre-final-digests.json`; they are not claimed as final. No running Chunkbot artifact is built from this branch. Docs/source changes are owned only; the inherited preparation-doc ancestor is preserved. Worktree is expected clean after the final review commit. Built output and logs are ignored.

Offline tests prove module-level durability/fencing and consume actual ports, not a working Minecraft update. Both-version U4/U6 acceptance still requires integrated owner acquisition and persistent-follow continuation, delayed planner/Jev cancellation, inventory-changing interruption with fresh server inspection, actual manager replacement/rollback/crash, descendant/interface/socket cleanup and real subscription/Jev accounting within the original cap. Planner/auth isolation and loaded artifact checks, fixture live harnesses, owner-facing readiness/update notices, and deployment remain coordinator-owned and unrun. Accepted live release `64e2609` remains separate.

The independent owned implementation is ready for coordinator contract/source review. Actual end-to-end continuation remains blocked on the five integration dependencies above, the pinned gameplay executable for the doctors, and absent provider/fixture grants. No feature acceptance or loaded-runtime success is claimed. Preserve the inherited preparation ancestor and integrate only the explicit owned commits after review; no companion approval has been inferred.
