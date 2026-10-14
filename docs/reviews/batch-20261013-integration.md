# Oct 13 shared integration worker

Status: contract milestone proposed; independent implementation continuing. This
is offline source work, not accepted, deployed or running gameplay evidence.

Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-integration`.
Branch: `chunkbot/batch-20261013-integration`.
Common base: `2b9255c25e75519c06c94602d5ac60224a3c0521`; initially clean.

Native metadata (selected fields only): thread
`01a13844-0073-7f13-b8bf-a1e2f637567e`, origin `dsh_provider_codex`, CLI
`0.162.1`, actual cwd as above, model `gpt-6.1-sol`, effort `xhigh`, sandbox
`danger-full-access`, approval `never`. Coordinator's current read-only native
App Server ChatGPT/prolite gate is retained; no account refresh, login or model
inference was performed here. Gameplay planner settings are unchanged.

## Proposed contract milestone

Canonical public types are [releases](../../src/contracts/releases.ts) and
[server controls](../../src/contracts/server-controls.ts), exported by the
[existing barrel](../../src/contracts/index.ts).

- `ReleaseArtifactPort.verify(directory): Promise<VerifiedRelease>`: complete
  regular-file inventory, source/lock/vendor/manifest digests, Node 24, supported
  versions, checkpoint compatibility and independent acceptance receipt.
- `SessionCheckpointPort.load(sessionId)` and
  `save(checkpoint, expectedRevision)`: compare-and-swap durable session intent,
  scope, control generation, pause latch, semantic directive and accounting.
- `AccountingJournalPort.commit(accounting): void`: synchronous durable write
  before dispatch. Unknown reservations restore conservatively as retained.
- `ManagedChildLauncherPort.launch(input, signal)` returns one fenced
  `ManagedChildPort`: readiness, drain, stop, termination proof and announcement.
- `ManagedChildAppPort`: application-side readiness/drain/stop/logout/announce.
- `ReleaseManagerPort`: status/start/logout/stop/offer/rollback. No gameplay,
  player-supplied artifact path, vault access or arbitrary shell hook.
- `ServerControlBridgePort.start(target, signal)/close/status`, with the single
  `ServerControlTargetPort.handle(request)` consuming UUID-verified, scoped,
  fresh, generated on/off/status requests. A typed field alone is not identity
  proof: the bridge owns authoritative server verification.

`SemanticDirectiveCheckpoint` deliberately excludes old connection/session/
interruption epochs. It preserves the original outcome, admission baseline,
travel anchor, counters/caps/deadline and verified lineage as non-executable
data. Unsupported continuation stays visibly interrupted; no fresh-baseline
resubmission. Persisted schema validation and safe export/import are still to
be implemented at the canonical checkpoint/core seams.

Companion contracts/imports require coordinator approval of exact SHAs. No
companion commit is imported at this milestone. The core needs a reviewed
`SpendLedger` export/restore/durable-before-dispatch seam in
`src/decision/spend.ts` plus decision attempt/disabled-state restoration in
`src/decision/jev-adapter.ts`; those paths are outside this worker's narrow
ownership until the coordinator grants them or supplies accepted commits.
No replacement ledger or private companion module will be added.

## Checks and boundaries

Checks use Node `/opt/homebrew/Cellar/node@24/24.21.0/bin` first and the
coordinator's two-slot stdlib guard. Logs stay under ignored
`var/offline-integration/`.

Contract typecheck first run: **exit 1**, wrong `ControlLatch` import;
`contracts-typecheck.log` retained. Corrected typecheck: **exit 0**,
`contracts-typecheck-r2.log`. Diff whitespace check: **exit 0**.

All world/provider/live-update/control acceptance is deferred to the
coordinator: fixture leases are absent on both versions, no key injection is
authorized, no source is registered as a release and no child has been launched.
Accepted playing artifact `64e2609` is separate and untouched. App entry-point
wiring, adverse composition tests, build/full-suite/both read-only doctors and
final source/build digests remain ahead.
