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
