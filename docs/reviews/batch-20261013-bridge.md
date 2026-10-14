# October 13 vanilla bridge worker review

Source checkout: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-bridge`, branch `chunkbot/batch-20261013-bridge`, base `2b9255c25e75519c06c94602d5ac60224a3c0521`. Initial staged/unstaged status was clean. This report uses the newer narrow prompt's exact review path; the preparation brief's older review filename is superseded.

Native metadata: session/thread `01a13846-63fe-7a13-b6aa-410df2b5e865`, originator `dsh_provider_codex`, CLI `0.162.1`, provider `openai`, exact `gpt-6.1-sol`, `xhigh`, assigned cwd, `danger-full-access`, approval `never`. Safe fields were read from this session's native metadata only. Coordinator supplied the passed installed App Server initialize/account-read (`refreshToken:false`, ChatGPT/prolite)/model-list gate. No account refresh, inference, route/global edit or credential read was performed.

## First contract milestone

`src/server-controls/types.ts` proposes this integration-owned manager adapter boundary:

```ts
interface BridgeManagerPort {
  submitIntent(request: BridgeIntentRequest, signal: AbortSignal): Promise<BridgeIntentReceipt>;
  readStatus(signal: AbortSignal): Promise<BridgeManagerStatus>;
}
```

The bridge owns no manager, process, budget, checkpoint or gameplay behavior. A submit is a bounded admission acknowledgment, not a wait for joining/cleanup. The request binds owner UUID/world/bot/installation/version, bridge session, server generation/owner session, expiry and expected manager instance/intent generation. The shared manager must compare these against the same authority used by local logout and updates, deduplicate delivery, and synchronously revoke older start/update intent on off. Read status exposes bounded current child/socket/spawn evidence; queued acknowledgment alone cannot become online/offline feedback. Types remain a proposal until coordinator approval; no companion SHA has been imported.

Fixed-command encoding admits only namespace-owned functions with typed macro arguments; no player-supplied command, hostname, path, prose or coordinates. The narrow SNBT decoder rejects duplicate keys, unknown envelopes, invalid UUID arrays and trailing data. Installation command generation is separate from runtime consumption and is never automatically executed.

First checks (Node 24 first in PATH, external provider-key variables unset, coordinator two-slot wrapper): focused `node --test --test-reporter=spec tests/server-controls.test.ts` exit 0, 3/3; `npm run typecheck` exit 0. Application implementation/build/full-suite gates follow after the complete owned entry points. All fixture leases and real-provider acceptance remain absent.

## External delivery gates

Common manager/config/CLI/composition/controller wiring is integration-owned and requested through the coordinator. No approved shared manager API or companion SHA was supplied at this milestone. Source work continues in owned paths.

Vanilla pack loading, non-operator triggers, UUID/session identity, expiry/order/heartbeat and exact command semantics require coordinator C-G1/C-G2 proof on 26.2 and 26.1.2. Actual private RCON/tunnel/online-mode topology and installation are C-G3 coordinator work. Shared lifecycle/update/logout/provider cleanup, budget/history and spawn/socket evidence are C-G4/C1–C6 integrated acceptance. Verified setup and final README/workflow procedure are integration/coordinator C7 work. No datapack installation, server/client/fixture access, credentials, process signalling or live controls were used. Accepted running release `64e2609` is separate.

## Owned implementation and actual entry-point wiring

First focused API commit: `c6a1f0b5519a0d8fcdf6e77f046c8f90beed236f`. The delivery commit contains the subsequent complete owned implementation and this expanded report; exact delivery SHA is reported in the DSH handoff. No companion commit was imported, merged or cherry-picked; no shared contract/manager/app/config/CLI/controller/manifest/vendor file was edited. Coordinator approval is still pending, so the port is an explicit proposal, not an approved integration claim.

Changed paths are five files under `src/server-controls/` (`types.ts`, `protocol.ts`, `bridge.ts`, `rcon.ts`, `index.ts`), the named `tests/server-controls.test.ts`, this review, and 26 files under `assets/datapacks/chunkbot-control/` (pack metadata, README, two vanilla function tags, and 22 `chunkbot_control` functions). Build output is separate ignored `dist/`; no accepted release or real runtime was changed.

The public owned entry point is:

```ts
startManagedVanillaBridge(options: ManagedBridgeOptions): Promise<ManagedBridgeHandle>

interface ManagedBridgeOptions extends Omit<BridgeOptions, 'transport'> {
  rcon: PrivateRconOptions;
  signal: AbortSignal;
  onHealth?: (health: BridgeHealth) => void;
}
interface ManagedBridgeHandle {
  status(): BridgeHealth;
  done: Promise<void>;
  stop(): Promise<void>;
}
```

`index.ts` constructs the real private transport and bridge, starts the installation-bound mailbox handshake, runs 250 ms polls, and aborts/closes its fenced session on manager lifecycle teardown. It is not a separate launcher/demo. The named entry-point test runs **that exported production function** over a credential-free dummy loopback TCP peer and the typed fake manager: bot absent → on → joining → verified online → off → logging out → verified offline, while the bridge remains available; stop closes only its session. Built `dist/server-controls/index.js` exports and composes these same functions.

`bridge.ts` validates exact profiles, owner/bot UUID separation and installation binding; clears stale startup flags; rejects active-bridge adoption; single-flights start/poll/stop; checks monotonic wake gaps and bounded manager freshness; re-reads UUID/session/current request after manager I/O; consumes ambiguous admission once without retry; correlates receipts; and uses confirmed child/socket/spawn/bot-UUID evidence for feedback. New off is delivered as a prompt shared-manager admission, never held behind join/provider completion. No child/process, gameplay plan, credential lookup, budget allocation or checkpoint implementation exists here.

`rcon.ts` copies and validates a literal loopback endpoint, uses bounded authenticated Source RCON frames with command IDs and a fixed namespace read fence, rejects malformed/correlation/auth/timeout/encoding replies, and exposes only open/sample/ack/heartbeat/close. It never exposes arbitrary commands. Function prose is ignored; effects are read back. Heartbeat read-back confirms the session, lease, status code, blocker and manager generation, so a positive old lease cannot validate a failed new online publication. Password/error text is never emitted. Install/uninstall remain reviewed admin material, excluded from this runtime transport.

The datapack creates only `chunkbot_on`, `chunkbot_off`, `chunkbot_status`, `cb_ctl`, `cb_leave` and two namespace storage roots. Tick processing selects the configured player UUID and copies the server entity UUID into the request. Presence plus the server leave-game statistic supplies the owner-session fence; fixture feasibility is still required. Each request carries bridge session, bounded generation, tick TTL and the manager intent generation from the last pulse. Advancing local logout/update authority clears stale on scores/mailboxes without erasing off. Separate vanilla trigger flags have **off precedence**, not a invented last-command timestamp. The off latch opens only after actual verified offline, not a queued ack. Reload/server restart clears transient requests; 100-tick heartbeat expiration independently suppresses cached online feedback and disables on/off. Status stays available to the bound owner when the bridge is absent. Counter exhaustion and unknown state fail closed. No coordinates/inventory/hidden world lookup is used.

The bridge admits exact `26.1.2` and `26.2` installation profiles. Pack metadata uses `[101,1]` to `[107,1]`; the runtime binding refuses other versions, despite that broad pack-format compatibility range. Primary references are linked in the pack README. Those sources prove format/macro metadata only; they do not establish this pack's actual vanilla command parsing, RCON message envelope, permissions, ordering or UUID/logout-session behavior. NBT path predicates use the single token `state{...}`. Static asset tests check function reference closure/owned objectives and prohibited world/admin commands; they are explicitly not a vanilla parser emulator.

## Concrete integration requests and blockers

1. Integration must adapt **the same shared manager** to `BridgeManagerPort`, or provide an approved replacement contract through the coordinator. Match the installation's owner/world/bot/version authority, manager instance/intent generation and expiry before admission; durable duplicate receipt/child/budget ownership stays there. Synchronously revoke old join/provider/gameplay/update reconnect ownership for off. A port that waits for readiness or cleanup before returning is incompatible with rapid off. Current read status must expose actual spawn/identity and child/socket absence with fresh epoch evidence. No approved companion SHA/API has arrived in this chat.
2. In the integration-owned manager composition, create `startManagedVanillaBridge` once with an external reviewed binding/private RCON endpoint/key and the manager lifetime abort signal. Keep it alive across child off. Publish safe health and stop/wait it during manager teardown. Add common config/CLI/controller wiring through that single lifecycle; ordinary `src/cli.ts run` still has no manager/bridge integration in this branch. Therefore the feature is **not yet reachable from the ordinary operator CLI** and C1–C6 are not closed by this branch.
3. Packaging/coordinator must retain/version the datapack installation material with its exact digest and binding, not silently install it from a child release. Verify C-G1/C-G2 with a named world lease on 26.2 first and 26.1.2 regression. Verify ordinary owner non-op permission, objective re-arming, leave-game session behavior, locale-specific storage reply shape, stale/wake/server reload, same-tick conflicting flags, delayed acknowledgments, expired heartbeat and unauthorized/unsupported inputs.
4. Coordinator C-G3 must establish the real verified-online world/owner/bot installation receipt and private tunnel/RCON/server properties, including any explicitly authorized restart. Bridge labels cannot independently prove a host/world or server login mode. No private topology or live installation has been assumed.
5. Integrated C-G4/C2/C6 must prove actual join/provider/update/drain/socket/process cleanup and stop/logout/budget/history fences using the frozen accepted candidate. This branch's fake peer/port tests prove bridge plumbing only. C7's final root README/workflow and real setup/start/status/stop procedure remain coordinator/integration-owned until verified; the pack README provides proposed exact installation/uninstallation material and the composition call.

## Checks, retained failures and digests

All heavy commands use the coordinator's exact ignored two-slot wrapper with this checkout, Node 24 first in PATH, and provider-key environment variables unset. No dependencies were reinstalled; each command's direct exit is retained. Ignored local evidence is in `var/bridge-checks/`.

- First focused contract tests: exit 0, 3/3; first typecheck: exit 0 (native output retained in DSH).
- `focused-01.log`: exit **1**, 24/25. A broad `/install/` test matched the valid `installation` macro field. Corrected to the actual function command name; no production restriction was weakened. This failed log remains intact.
- `focused-02.log`: exit 0, 25/25 after the assertion fix and mailbox re-read.
- `focused-03.log`: exit 0, 28/28 including owner-session/newer-off revalidation, stale status read-back and idempotent teardown.
- `focused-04.log`: exit 0, 29/29 including request-stamped local logout generation. Final full-suite evidence also covers endpoint-copy mutation protection added after this focused run.
- Intermediate typecheck/build passes all exited 0. Earlier complete `full-suite-final.log`: exit 0, **1692/1692** before the final status-publication and manager-generation race fixes. New source concerns justified the final affected/full check rerun; unchanged failures were not repeated.
- Final source `typecheck-04.log`: exit 0. Final `build-02.log`: exit 0.
- `doctor-26.1.2.log`: exit **1**, read-only. Installed global CLI resolves `0.162.1`; the isolated gameplay planner requires exactly `0.160.0`. The planner correctly fails closed. Fixture JRE/jar absence is a warning. No connection, setup, model call, login refresh, auth modification, CLI/global change or pin relaxation was made. This failure was preserved and not repeated unchanged. Coordinator must supply the accepted gameplay pinned executable/configuration for later acceptance; the development route stays 0.162.1.

- Final `full-suite-02.log`: exit **0**, **1694/1694**; includes the final 29 named bridge cases, endpoint immutability and all existing regressions. No inference or Minecraft peer was used by bridge tests.
- `doctor-26.2.log`: exit **1**, read-only, with the identical global `0.162.1` versus isolated planner `0.160.0` pin failure. Config, installed compatibility stack, exact-version knowledge and owner checks pass. Missing isolated fixture JRE/jar are warnings; no setup/connection was attempted.
- `git diff --check`: exit 0; owned document relative links checked successfully. The complete owned diff against the common base is retained as ignored `var/bridge-checks/owned.patch` and is also directly available from Git. After the delivery commit, Git status is clean; ignored `dist/` and check evidence remain.

Digest algorithm: sort relative POSIX paths, form one `sha256(file bytes) + two spaces + path + newline` row per file, then sha256 the concatenated rows. `var/bridge-checks/digests.json` contains:

| Inputs/output | Files | SHA-256 |
| --- | ---: | --- |
| All `src/**/*.ts` application inputs | 179 | `40925453497e6cfac6e5a158c09d8d791d8f466484e2e0d7b64bf99fcefae99d` |
| Owned `src/server-controls/*.ts` | 5 | `b1b43ba23bec240cf6aca5b8212a114b8bdb070747437759427e2089a48c5d57` |
| Entire datapack including README | 26 | `ed4555ddedc56f5dce279f20ca274707a69f3250ef2fdb58a0381aa64dcb5299` |
| Full local `dist/` | 358 | `0fc73341d50e821ead15924a3ee395a238a70d105f7cc35bddf64d6fbfdcefd4` |
| Owned `dist/server-controls/` | 10 | `05c975aab0392b806ff8edda14f3cb7f72e6be4aaac2b4b344f97b3e6a4cb911` |

These are source and worker build fingerprints, not accepted artifact manifests or running-release digests. All real C1–C7 acceptance remains open for the explicit dependencies above. No deployment, fixture/RCON/world/client access, real child, model/provider inference, account/route change, secrets, broad staging/push/PR/main merge or subagent/worker launch occurred. After owned commit, expected dirty work is empty; ignored build/check logs remain. Recommendation: review the complete owned diff and proposed port, integrate once through the manager, then grant separate both-version/world/provider acceptance. The running accepted `64e2609` release stays unchanged.
