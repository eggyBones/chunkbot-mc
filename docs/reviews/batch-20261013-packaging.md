# Oct 13 packaging worker — MB-OPS-001 U-G1/U1/U5

Status: **implemented; owned packaging/offline artifact checks passed; latest full-suite and doctor gates remain open; unaccepted and undeployed**. The dedicated packaging entry point produces a complete read-only candidate with its actual CLI and installed dependencies. Real fixture operation, managed readiness/rollback and coordinator promotion remain pending.

## Checkout, route and owned history

- Checkout: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-packaging`.
- Branch: `chunkbot/batch-20261013-packaging`.
- Intake HEAD/common base: `2b9255c25e75519c06c94602d5ac60224a3c0521`; clean, no staged or unstaged diff.
- The reflog records an external preparation fast-forward to `9ca70cbaba438033fbfd35d4097ab69339ba612d` before the first worker commit. Its seven roadmap/supervision/plan changes were preserved. This worker did not edit or import those paths. Use the individual owned commits for integration, rather than treating every change since the intake base as packaging work.
- Actual native session/thread `01a13845-efca-7281-879c-1017ddc82493`, originator `dsh_provider_codex`, CLI `0.162.1`, cwd as above, `gpt-6.1-sol` / `xhigh`, `danger-full-access`, approval `never` were verified from whitelisted native session/turn metadata. The coordinator-provided `relay-codex` / `codex:codex-default` ChatGPT/prolite App Server gate was preserved. No account/route/global setting changed.
- `be019da557881a2b84beb59a8120a99d290edf09`: private identity/schema and safe filesystem proposal.
- `6f10d7676833707c5641ce7283d19545b891d968`: complete package/validate API and dedicated script.
- `f3743476eb815647739d109702e0add6e84f3792`: responsive validation, concurrent mutation rejection, canonical Unicode/local vendor paths.
- `90b995676bc17452d32b414d7ea513607197fc2d`: direct committed Git blob/mode proof, including index-masked changes and disabled Git replacement objects. This is the final application code and frozen candidate source commit.
- This review is a subsequent documentation-only commit. Its exact SHA is reported in the chat handoff; the frozen candidate deliberately retains the code commit above.

Owned diff: `git diff 9ca70cbaba438033fbfd35d4097ab69339ba612d..HEAD -- src/updates/artifacts scripts/package-release.ts tests/update-artifacts.test.ts docs/reviews/batch-20261013-packaging.md`. No package.json/lock/vendor/operator profile/shared-contract/CLI/roadmap edits were made by this worker. No companion commit was imported or approved.

## Implementation and actual entry points

Source: [private model](../../src/updates/artifacts/model.ts), [filesystem boundary](../../src/updates/artifacts/files.ts), [packager](../../src/updates/artifacts/package.ts), [validator](../../src/updates/artifacts/validate.ts), [exports](../../src/updates/artifacts/index.ts), [dedicated CLI](../../scripts/package-release.ts), [named tests](../../tests/update-artifacts.test.ts).

```ts
inspectRelease(options: Omit<PackageReleaseOptions, 'outputDir'>): ArtifactManifest
packageRelease(options: PackageReleaseOptions): Promise<ArtifactManifest>
validateArtifact(directory: string): Promise<VerifiedArtifact>
validatePromotableArtifact(directory: string, policy: PromotionPolicy): Promise<PromotableArtifact>
```

`PackageReleaseOptions` requires an explicit source directory, a new output directory, and coordinator-declared durable data versions `{ checkpoint, session, memory }`. Output is restricted to a new direct child of that source checkout's ignored `var/packaging-artifacts/`; an existing destination is never adopted or replaced. The application entry point is exactly `dist/cli.js`.

The manifest binds the clean source commit and full tracked source inventory, build inventory, installed dependency inventory, exact-version mechanics/data inventory, public build/vendor inputs, Node build version/platform/architecture, exact Minecraft profiles, durable schema declarations and unchanged gameplay planner pin. File identity includes canonical relative path, byte count, SHA-256 and executable bit. Inventories and the complete manifest have deterministic identities independent of output location and timestamps.

Tracked source bytes and executable modes are checked directly against the committed Git blobs, with replacement objects disabled. `assume-unchanged`/`skip-worktree` flags cannot conceal different source behind a clean status. The packager requires exact compiled JS/source-map membership for tracked application TypeScript; missing/stale/extra outputs fail. Package declarations, v3 lock entries and installed package versions must agree. All four admitted vendored packages require their recorded builds/markers, tarball sha512 lock integrity and installed patch-result sha256s. Unlocked nested packages, linked installs and unsafe local dependency paths fail. These checks capture identity; they do not fabricate evidence that a build or gameplay acceptance succeeded.

Payload is limited to compiled application files, regular installed dependency files, package/lock/tsconfig/.gitignore and tracked public vendor tarballs/metadata/patches. npm `.bin` symlinks are omitted. Configs, ignored runtime data, auth caches, fixtures/worlds and source working files are excluded. Credential filenames/metadata and credential-bearing dependency URLs fail before publication. Relative traversal, noncanonical paths, symlinked roots/ancestors/files, hardlinks, case/Unicode collisions and file/directory conflicts are refused. There is no archive extraction or arbitrary hook execution.

Inputs are re-inspected after copying. New files are fsynced and read-only; directories are sealed read-only. The completion manifest is written only after payload copying, and incomplete/writable copies fail verification. Every file is verified before the API returns. Failure removes only the task-created directory whose inode/dev identity is still proven. A process crash can leave an incomplete directory; that directory remains unpromotable and cannot be overwritten by a retry.

`validateArtifact` yields during large inventory scans so manager control handlers can run, then rechecks file identity/timestamps/modes before returning. It rejects changes during a yielded scan, unlisted directories/files, missing payload, writable files/directories and checksum edits. It executes no candidate code.

`PromotionPolicy` requires **trusted external** `acceptedReceipts`, explicit nonempty `requiredCriteria`, an exact supported Minecraft version and expected durable versions. Exactly one matching coordinator receipt must bind the full artifact digest and cover every required criterion with evidence identities and exit 0. An artifact's own acceptance field is forbidden, and module tests never write a production acceptance registry. Receipt provenance and required real criteria must come from coordinator-controlled manager composition. The API assumes that trust boundary; it does not cryptographically authenticate a caller who supplies arbitrary policy objects.

The following are the installed dedicated commands; no npm alias or shared CLI change is necessary:

```sh
node scripts/package-release.ts inspect --source /absolute/clean-checkout --data-versions '{"checkpoint":1,"session":1,"memory":1}'
node scripts/package-release.ts create --source /absolute/clean-checkout --output /absolute/clean-checkout/var/packaging-artifacts/candidate --data-versions '{"checkpoint":1,"session":1,"memory":1}'
node scripts/package-release.ts verify --artifact /absolute/artifact
```

The example versions above are explicit offline test declarations, not approved checkpoint/session compatibility. The script always reports `promotable:false`. Start the real CLI with Node 24 at the returned absolute entry point and an absolute **external** configuration path. Mutable config/auth/data stay outside the artifact. Promotion, startup ownership and rollout controls are manager/integration responsibilities.

## Frozen genuine candidate and provenance

Final candidate: `var/packaging-artifacts/offline-90b99567/`; 8,284 payload files, 544,696,256 bytes. Created and fully verified from final code commit `90b995676bc17452d32b414d7ea513607197fc2d` using the worktree's own separately installed dependencies and built dist. No playing artifact was read or modified. Earlier `var/packaging-artifacts/offline-6f10d767/` and `var/packaging-artifacts/offline-f3743476/` are retained separately.

| Identity | SHA-256 |
| --- | --- |
| Complete final candidate | `76be5fbe032a556875488503c924e497f78a36ed13054a3e1f750e24cfb4fee7` |
| Full tracked source inventory | `9ecb5189b55d9d8d120edae8431d2a74a7fd4708d42b17e418c0880bd5f6672c` |
| Build inventory | `01379311c8844ed41f718636ac043510f7a3d8825d5527246064c1555241de26` |
| Installed dependencies | `47648c5f79d3fa00473b32eb8fc956116507b23d614575b7cf4478421942fc5b` |
| Exact-version data | `e4cfbaf22a89a9ac5d79e5f8d864b070835673dcb0a826d57804ff637d27a59d` |
| Public build/vendor inputs | `81fa32095768dc559ed5345b98bdd73019e0cb0b9f919b893ce8055e6c1eb901` |
| package-lock.json bytes | `f76999bfbb47cc908034597678cbf2e802113e22ae1eb32929f794f683ab46e2` |

Build Node `24.21.0`, darwin/arm64; Minecraft `26.1.2`/775 upstream-tested and exactly `26.2`/776 local `MB-SERVER-001`; gameplay planner remains CLI `0.160.0`, `gpt-6.1-sol`/`low`. Checkpoint/session/memory declarations are `1/1/1` for this unaccepted offline candidate, pending coordinator schema approval. No acceptance receipt exists for it.

The genuine packaged `dist/cli.js` ran from **the candidate directory as cwd**, with a child environment containing PATH only and external credential-free inference-disabled example configs:

- `catalog --config <source>/config/examples/fixture-inference-free.json --json`: exit 0, foundation catalog `skills-20-16f587b80d7a`, 20 capabilities. The existing CLI notes that this is the foundation catalog; it does not establish all configured in-run adapters.
- `knowledge '{"kind":"recipe","output":"minecraft:furnace"}' --config <source>/config/examples/fixture-26.2-inference-free.json`: exit 0, official 26.2 recipe dataset selected.
- Dedicated `verify --artifact <candidate>`: exit 0, same identity, `integrityVerified:true`, `promotable:false`.

There was no Minecraft connection, inference, auth/cache/vault operation, manager launch, deployment or live-control invocation. These actual offline entry points prove independent path/dependency/data resolution; they do not close the real U-G1 gate.

## Direct checks and retained failures

All heavy jobs used the coordinator's exact external stdlib guard, with Node 24 first in PATH:

```text
python3 -B /Users/jakewilcox/code/repos/minecraft-buddy/var/parallel-20261013/check-slots.py
  --cwd /Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-packaging -- <argv>
```

Direct exits were captured before log summarization. Logs remain in this worktree's ignored `var/packaging-checks/`; no unchanged full pass/failure was rerun. Fresh full suites were required after the responsive-validation and committed-source-proof source changes.

| Check / log | Direct exit and evidence |
| --- | --- |
| `node --test --test-reporter=spec tests/update-artifacts.test.ts`, `milestone-focused.log` | 1: initial non-erasable constructor parameter property; corrected explicitly |
| Same milestone, `milestone-focused-fixed.log` | 0: 3/3 |
| `npm run typecheck`, `milestone-typecheck.log` | 0 |
| Named tests, `implementation-focused.log` | 1: fixture cleanup attempted nonrecursive directory removal; corrected test cleanup |
| Named tests, `implementation-focused-fixed.log` | 0: 14/14 |
| Typecheck/build, `final-typecheck.log`, `final-build.log` | 0 / 0 |
| First `npm test`, `final-full-tests.log` | 1: 1,677/1,679; existing planner-transport child-start assertion and safety-defense deadline failed; all packaging tests passed |
| `node --test --test-reporter=spec --test-concurrency=1 tests/planner-transport.test.ts tests/safety-defense.test.ts`, `isolated-existing-failures.log` | 0: 18/18; no changes to those tests/services |
| Responsive typecheck, `responsive-typecheck.log` | 1: fs lstat overload inferred possibly undefined; changed snapshot type to explicit `Stats` |
| Responsive `npm run typecheck`, `responsive-typecheck-fixed.log` | 0 |
| Responsive named tests, `responsive-focused.log` | 0: 16/16 |
| Responsive `npm run build`, `responsive-build.log` | 0 |
| Responsive `npm test`, `responsive-full-tests.log` | 0: **1,681/1,681**, 324 suites |
| Final named tests, `provenance-focused.log` | 0: 17/17, including a genuinely clean-status masked edit |
| Final `npm run typecheck`, `provenance-typecheck.log` | 0 |
| Final `npm run build`, `provenance-build.log` | 0 |
| Final `npm test`, `provenance-full-tests.log` | 1: **1,681/1,682**; the same existing planner child-start assertion failed again. Latest full gate is not closed; all 17 packaging tests passed. |
| Both required read-only doctors, `doctor-26.1.2.log`, `doctor-26.2.log` | 1 / 1: resolved `/opt/homebrew/bin/codex` is development CLI 0.162.1; unchanged gameplay gate requires 0.160.0 |
| Diagnostic-only PATH retries, `doctor-26.1.2-pinned.log`, `doctor-26.2-pinned.log` | 1 / 1: proposed `/opt/homebrew/Caskroom/codex/0.160.0/codex-path/codex` is absent, so resolution still selected 0.162.1; no fallback/installation/global changes |
| Earlier real inspect/create, `real-inspect.log`, `real-create.log` | 0 / 0; earlier identity `901f008e45b23f8cc6a594040032cfc411da891ef7d10d9aada32223f90b3435` |
| Responsive real create/verify, `responsive-real-create.log`, `responsive-real-verify.log` | 0 / 0; retained earlier candidate |
| Final real create/verify, `provenance-real-create.log`, `provenance-real-verify.log` | 0 / 0; final identity above |
| Actual final candidate cwd catalog/knowledge, `provenance-artifact-catalog-cwd.log`, `provenance-artifact-knowledge-cwd.log` | 0 / 0; PATH-only child env, no inference or connection |
| `git diff --check`, owned-path diff/content/link review | 0 |

The catalog log contains JSON stdout followed by the existing foundation-only stderr note. An initial JSON-only summarizer failed on that trailing note; `JSONDecoder.raw_decode` confirmed the valid catalog and direct CLI exit 0. This was a summarizer failure, not an application failure. Earlier failing evidence has not been overwritten or represented as a pass.

Adverse fixtures are generated in `tests/update-artifacts.test.ts` under ignored, unique, credential-free worktree scratch directories. They include incomplete/extra builds, dependency/version/patch/tarball drift, source dirt/index-masked source edits, traversal/collisions/links, credential-bearing metadata, changed/missing/extra/writable payload, forged manifests and receipt substitution, incompatible schema/profile declarations, controlled startup crashes and not-ready output, and edits during asynchronous validation. Dummy receipts are explicitly marked DUMMY and apply only to dummy component fixtures.

## Remaining coordinator dependencies and acceptance

1. Approve the exact private manifest/API proposal (public schema/ports remain integration-owned), then adapt shared manager composition to `validatePromotableArtifact` with **trusted coordinator** receipts and the actual required real acceptance criteria. No shared edits were made or companion SHA assumed approved.
2. Provide approved checkpoint/session schema declarations and expected memory compatibility for an integrated production candidate. Packaging requires these explicitly; the offline `1/1/1` declarations do not establish migration compatibility. A changed integrated source/build/data declaration needs a new artifact identity and affected acceptance.
3. Provide the existing pinned gameplay CLI 0.160.0 executable path or run both doctors in its approved environment. Workers must not install a substitute, change the isolation pin, refresh login or alter the native development route to turn these failures green.
4. Resolve or independently assess the repeatable-under-full-suite existing `tests/planner-transport.test.ts:117` timing/ordering failure. It passed the isolated 18-test run and the intermediate full run, but the latest final-source full suite exited 1. This worker cannot edit that unowned test/service.
5. Grant coordinator-owned exclusive fixture leases and run genuine packaged CLI sessions on both 26.1.2 and 26.2 with external config/auth/data. U-G1 remains partial. U1 still needs independent A-playing/B-testing evidence. U5 still needs integrated manager startup/readiness failure, single rollback, second-failure stop and no-two-child evidence.
6. Coordinator must perform the applicable real gameplay subscription/Jev acceptance, frozen artifact recheck and explicit acceptance receipt before any promotion. No live/world/provider gates were run by this worker. Release `64e2609` remains separate.

Recommendation: review/integrate the four focused code commits and this documentation commit, approve the shared contract/durable versions, package the frozen integrated checkout, then perform coordinator acceptance. This lane's independent implementation and offline entry-point work is complete. It is ready for review, not a deployed gameplay feature.
