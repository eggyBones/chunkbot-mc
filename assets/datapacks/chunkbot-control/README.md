# Chunkbot vanilla control protocol v1

This is source for coordinator fixture verification. It has not been installed or tested in a Minecraft world. It supports the bridge's exact configured profiles `26.1.2` and `26.2`; the latter retains the repository's local compatibility status. The metadata's format range does not admit other game versions. Integration must install this service in the **same application manager** that owns local start/logout and updates. There is no standalone daemon, Minecraft bot, dashboard write route or automatic sign-in here.

The non-operator owner's commands are:

```text
/trigger chunkbot_on
/trigger chunkbot_off
/trigger chunkbot_status
```

Only final trigger score `1` is consumed. The server reads the player entity's UUID, not a name. On/off objectives are enabled only for the configured owner while the bridge heartbeat is current. Status remains enabled for that owner when the bridge is absent and reports heartbeat expiry instead of cached online success. Other UUIDs' flags are cleared. Feedback is directed to that owner only.

## Installation material for coordinator C-G1–C-G3/C7

These are proposed exact commands, not a verified live procedure. First independently verify vanilla version, online-mode owner UUID, bot UUID, world/bot profile binding, datapack name collision absence, and private administration topology. An explicit trusted loopback offline fixture binding is a separate test authority, never an online identity claim. Do not enable general operator permissions for the owner.

Copy this pack directory into the separately authorized server world's datapacks directory as `chunkbot-control`, retaining `pack.mcmeta` at its root. Under that world's coordinator lease, the administration commands are:

```text
reload
datapack list enabled
```

Use `installationCommand(reviewedBinding)` exported from `dist/server-controls/index.js` to render the one fixed command with that reviewed binding's exact installation token, profile IDs and signed UUID words. Its shape is `function chunkbot_control:install {"installation":...,"world":...,"bot":...,"version":...,"a":...,"b":...,"c":...,"d":...}`. `26_1_2`/`26_2` is the internal injection-safe version spelling. This admin-only function resets prior flags and writes the installation binding. The runtime transport cannot call install or uninstall. Neither function requires nor contains a credential.

Read-back installation inspection is:

```text
data get storage chunkbot_control:bridge state
```

The storage response contains only fixed binding/session/counter fields and the owner UUID, never player positions, inventory, world scans, paths or commands. Profile identity and online-mode authority come from the coordinator's installation receipt; arbitrary storage labels alone cannot prove a particular host/world or online login mode. Rebinding requires another explicit reviewed installation, not a runtime fallback.

The RCON adapter requires literal loopback `127.0.0.1` or `::1`. The coordinator supplies an already-established private tunnel if the vanilla server is elsewhere. Enabling RCON, server properties, tunnel setup/restarts, credentials and live topology are outside this source assignment. Passwords are injected by the operator's external environment into `PrivateRconOptions`, never arguments, datapack storage, config artifacts, gameplay context or logs.

To remove under the same explicit server authority:

```text
function chunkbot_control:uninstall
datapack disable "file/chunkbot-control"
```

Then remove only this pack's installed directory. Uninstall removes `chunkbot_on`, `chunkbot_off`, `chunkbot_status`, `cb_ctl`, `cb_leave`, and the two `chunkbot_control:bridge` storage roots. It does not change player operator permissions, difficulty, game rules, blocks, entities, server/client processes or authentication.

## Managed application entry point

The integration-owned manager composition invokes the real owned entry point once for its lifetime, independent of the bot child:

```ts
import { startManagedVanillaBridge } from './server-controls/index.js';

const bridge = await startManagedVanillaBridge({
  binding: reviewedBinding,
  manager: managerBridgeAdapter,
  rcon: { host: '127.0.0.1', port: localForwardPort, password: externalRconPassword },
  signal: managerLifecycleSignal,
  onHealth: publishBridgeHealth,
});
// Bot off does not stop this handle. Manager teardown does:
await bridge.stop();
await bridge.done;
```

All values above are integration-owned inputs, not a new CLI/config schema. The manager adapter must admit on/off promptly, bind requests to its current instance/intent generation and profile/owner, check expiry, retain duplicate receipts, and share the same logout/update fence. Off revokes older joining/gameplay/provider/update reconnect intent. The manager preserves the gameplay stop latch, checkpoint/spend history and budget policy. The bridge does not allocate budgets or spawn/signal/adopt children.

The proposed port is in `src/server-controls/types.ts`. `readStatus` must report current owned child and connection evidence; online additionally requires verified spawn, connection epoch and matching bot UUID. Offline requires both child and connection absence. Queued/no-op/rejected receipts are acknowledgments only. Missing auth, whitelist/version/identity failures, unreachable server, pending cleanup and unavailable manager have bounded distinct feedback. Common manager/CLI/config/controller composition is still pending coordinator review.

## Ordering, expiry and persistence

Each bridge start uses a new random 128-bit session and clears pending flags before enabling controls. Server reload/restart closes the session and retains only installation binding. Manager restart, session mismatch, owner change/logout, regressed counters, unknown fields, expired request/heartbeat or a monotonic sample gap fail closed. Service stop aborts in-flight reads/admission and closes only its own session. Failed service does not reconnect/retry a command; explicitly restart it through the same manager after resolving the blocker. This fresh start clears old requests, including requests left while the Mac slept.

Vanilla separate trigger scores cannot prove command order within a tick. **Off wins** concurrent flags. Pending off discards on until a fresh manager pulse proves child/socket absence, then a new explicit on is needed. Requests superseded by off cannot be erased by an older acknowledgment. Pending on duplicates coalesce; manager on while joining/online remains idempotent. Neither status nor duplicate delivery creates a session.

The server clock assigns a request generation and owner session. Each request also carries the manager intent generation from the last verified pulse: an old on cannot become fresh merely because the bridge later observes a local logout. A pulse that advances that authority clears old on scores awaiting their tick and pending on mailboxes; it preserves off. Current presence plus the server `minecraft.custom:minecraft.leave_game` criterion fences an owner logout/rejoin between polls. Verify that criterion and quick reconnect semantics in both vanilla fixtures before acceptance. Counters stop before wrapping; exhausted state requires an explicit fresh bridge session. No request/state is replayed on bridge/server restart.

Requests expire at 60 server ticks (normally three seconds). Heartbeat expires at 100 server ticks (normally five seconds), independently of the bridge/manager process. Server tick rate affects these durations. The service polls every 250 ms, bounds each operation to at most 1 s, and rejects a monotonic observation gap above 2.5 s. After manager I/O it re-reads the owner mailbox before dispatch. A hung/failed admission or ambiguous acknowledgment is consumed once and never automatically retried. RCON function prose is not success evidence; storage effects are read back with correlated, bounded response frames.

If triggers are unavailable, use the existing local operator controls; do not sign in automatically or turn a missing heartbeat into an on attempt. Stale online feedback expires even if the manager is killed. A sleeping/unreachable bot machine cannot be powered on by these commands. No gameplay inference runs in the handler.

## Still required before delivery

Coordinator C-G1/C-G2 tests must load/parse every function and prove ordinary non-operator use, re-arming, disabled/altered/unauthorized triggers, same-tick off precedence, old acknowledgments, logout/rejoin, bridge/server/wake restarts and independently expired heartbeat on **26.2 first and 26.1.2 regression**. Offline tests use only a dummy loopback TCP peer; they do not establish vanilla syntax, RCON localization/permissions or identity feasibility. C-G3 must verify real private topology/installation. C-G4 and C1–C6 require the shared manager's actual child/provider/update cleanup and fresh spawn/socket evidence, including local logout/update races and budget/history. C7's final root README/workflow instructions belong to the coordinator after those checks. Source/build evidence is in [the worker review](../../../docs/reviews/batch-20261013-bridge.md).

Primary syntax/metadata references: [Mojang 1.21.9 pack metadata](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9), [Mojang 26.1](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1), [Mojang 26.1.2](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1-2), [Mojang 26.2](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2), [Mojang function macros](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a). These are metadata/syntax evidence, not this pack's world acceptance.
