# MB-SERVER-001 — Minecraft Java 26.2 compatibility (worker evidence)

Worker: native Claude DSH session `session-1d547f0f-eccd-4429-9b8e-56b4c91fe0fe` (Opus 5.5). Date: 2026-10-06 (UTC). Includes **MB-SERVER-002** (attribute IDs and physics consumer), which root recorded before the correction. This is worker evidence. Codex performs independent acceptance, real-provider (Jev) acceptance and the live join.

Coordinator reconciliation at04:33 UTC: Jake deferred live joining until his next play session; current acceptance stays local. Numerical C3/C5 figures and the earlier harness/test explanations below have been corrected against the actual retained reports and test source. The original visible worker response remains in `var/compatibility/worker-final-response.txt`.

**Not touched:** Jake's live server, his PrismLauncher client/game/world (PIDs 99668/99698 untouched), `chunkbot.config.json`, `var/bot-signin.config.json` and auth caches. No probe, harness, bot or RCON connected to any non-loopback endpoint. No keys, vault or `bw` were used, and no interactive auth was started. Git was not initialised.

## Outcome

- Chunkbot's **built CLI** admits **exactly Minecraft 26.2 (protocol 776)** through a **local compatibility profile** (`local-compat`). The profile is:
  - a pinned, vendored, integrity-locked PrismarineJS stack;
  - verified against Mojang's official 26.2 data-generator reports;
  - exercised end to end on a distinct local vanilla 26.2 fixture.
- 26.1.x retains **upstream-tested** protocol support, with the MB-SERVER-002 attribute correction also applied to that version. 26.2.x point releases, 26.3 and later are rejected before any connection.
- 26.2 support is **not** an upstream release and **not** Mineflayer-tested. Doctor, status, connect-check and run evidence all say so (`support=local-compat`).

## Upstream investigation (2026-10-06)

Released npm "latest" is already installed: mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, prismarine-chunk 1.41.0, prismarine-physics 1.11.1. None of them supports 26.2.

| Prerequisite | Upstream state | Used |
| --- | --- | --- |
| 26.2 data | [minecraft-data#1298](https://github.com/PrismarineJS/minecraft-data/pull/1298) **merged into the first-party `pc_26_2` branch** (not master, not released). Branch head = merge commit `68ea7b59e7aa318be86cf265be45ee1b79572528`. The branch is 3 commits ahead of / 18 behind master. | 26.2 files only, by exact commit and git blob SHA-1 |
| chunk mapping | [prismarine-chunk#333](https://github.com/PrismarineJS/prismarine-chunk/pull/333), open; head `e3424f6308677fb3910d6b846394ec7055159445` | exact hunk |
| physics feature | [prismarine-physics#143](https://github.com/PrismarineJS/prismarine-physics/pull/143), open; head `7d697da70bffb3a24732f65a201bd5cb1f2a3c2b` | `lib/features.json` hunk (the test file is not shipped) |
| mineflayer version gate | [mineflayer#4121](https://github.com/PrismarineJS/mineflayer/pull/4121), open; head `206986b4c10da0212e3d7301c21a82ea5c7c127d` | exact hunk; treated as a local admission only |
| nmp server `sessionId` | [node-minecraft-protocol#1529](https://github.com/PrismarineJS/node-minecraft-protocol/pull/1529), merged 2026-10-03, unreleased | **not needed**: it changes only the nmp *server*; Chunkbot is client-only and the client has no version allowlist |
| 26.1 attribute ids | [minecraft-data#1254](https://github.com/PrismarineJS/minecraft-data/pull/1254), merged to master `23303d2350177f2084f94cd38e5d7c8e54dfc8d3`, unreleased | only the 26.1 `protocol.json` + `latest/proto.yml` hunks |

- `node-minecraft-protocol#1546` returns 404 and was not used.
- The Complexity-ML forks were not adopted: the first-party sources above were sufficient and reviewable.
- Each patched chunk/physics/mineflayer file is **byte-identical to its PR head** (git blob equals the PR-head blob, recorded in `vendor/compat-sources.json`).

## Dependency provenance and clean install

`vendor/` contains four `npm pack` tarballs, each built by `scripts/vendor-compat.ts` from pinned inputs only:

1. The released registry tarball, verified by sha512 (the same integrity the original lockfile had).
2. Upstream files fetched by commit and verified by git blob SHA-1.
3. Recorded patches applied with `patch --forward --batch --fuzz=0`. Every patched file must match its recorded git blob before **and** after patching.

| Tarball | sha512 (also in package-lock.json) | Changed files |
| --- | --- | --- |
| `minecraft-data-3.117.0+chunkbot.26.2.1.tgz` | `8r1dWaVnfL+eTo7kbE+12Jq1JteiCR1jxiCm4VRPWWp5FEYXiAq7ajXyroCbKYoSz40uUgEjucATglXUYRHejg==` | +`pc/26.2/*` (19 upstream files, plus proto.yml from upstream `pc/latest`), +`pc/1.20.3/windows.json`; `dataPaths.json` (`pc."26.2"` inserted, `proto` → `pc/26.2`); `common/versions.json` (+26.2); `data.js` regenerated; attribute mapper patches for 26.1 and 26.2 (below); `prepare` script removed |
| `prismarine-chunk-1.41.0+chunkbot.26.2.1.tgz` | `VXW78vLrA6BkpoOH8cQ+0mmbFX9IVZjV+kDWzacbjlCZ962nZgghOK7Aokag9I0YfP1oYgWuDcIyiG4Er+EGsw==` | `src/index.js` (#333) |
| `prismarine-physics-1.11.1+chunkbot.26.2.1.tgz` | `+b7VTH6LcQ1p4foeYHXnNLXhflzcIbRbkFDYV3Bbq99BCFDEGw7EhPiwjCD4UVa8sQWhG/nRCQlU+vAKGV3liw==` | `lib/features.json` (#143) |
| `mineflayer-4.39.0+chunkbot.26.2.1.tgz` | `rYj6KekUNyEV4JjN+bfhrJIIqchT8s+eWMpzhNN0gsUaj2gTeWv6vKi7b1zd/gludMJFGEw+WcFOon0VJG4ALA==` | `lib/version.js` (#4121), `lib/plugins/entities.js` (MB-SERVER-002) |

Deliberately **not** applied from `pc_26_2`:

- README;
- `features.json` (the branch re-adds `entityActionUsesStringMapper`, which 3.117.0 removed);
- the move of 26.1's proto source.

26.1 data stays exactly as released except for the #1254 attribute hunks.

npm installs the tarballs through `file:` specs and `overrides` (minecraft-data, mineflayer, prismarine-chunk, prismarine-physics; minecraft-protocol and prismarine-auth as before), so every transitive consumer gets **one** deduplicated copy.

minecraft-data's `prepare` script regenerates files from devDependencies that are not installed. npm treats it as an install script for `file:` sources, so it is removed from the vendored package.json and recorded under `removedInstallScripts`. A registry install never runs it.

`package.json`/`package-lock.json` diff against the baseline copy is minimal: 4 dependency specs, 3 overrides, 3 scripts (`vendor-compat`, `verify-version-data`, `compat-live-check`), and 4 lock entries (version, resolved, integrity).

Reproducibility evidence:

- `node scripts/vendor-compat.ts --check` rebuilds all four tarballs and finds them byte-identical to `vendor/` and `vendor/compat-lock.json` (exit 0).
- Isolated clean install `var/compatibility/ci-probe/`: a copy of package.json, lock, vendor, src, tests, scripts and config, installed with `npm ci --cache <fresh>`.
  - exit 0, with no install-script or integrity warnings;
  - `npm ls` shows one deduped copy of each patched package (`ls.log`);
  - its vendored package files are **byte-identical** to the project's `node_modules`;
  - its doctor on the 26.2 config exits 0.
  - Its first full `npm run check` showed 296/297. The one failure was `tests/app.test.ts` "death and dimension change …": its 2 s wall-clock `until` wait timed out during concurrent live checks. Concurrent load is a hypothesis, not a proved cause. The case passed three isolated reruns, and a fresh quiet full run (`var/compatibility/ci-probe-final/`) passed 297/297. The final main-project full check also passed297/297; application lifecycle code was unchanged.
- Tamper control `var/compatibility/ci-tamper/`: one changed line in the vendored mineflayer tarball makes `npm ci` fail with **`EINTEGRITY`**, exit 1, and nothing is installed.

## Codec, registry and data verification (independent of minecraft-data)

`scripts/verify-version-data.ts` runs Mojang's data generator (`net.minecraft.data.Main --reports`) from each SHA-1-pinned jar in a scratch directory. It writes compact digests to `tests/fixtures/official-reports-{26.1.2,26.2}.json` and compares them with the **installed** stack:

- every block state, decoded through the installed prismarine-block: 32,366 for 26.2, 29,873 for 26.1.2;
- block, item, entity, particle and data-component id order;
- the codec mapper ids: SlotComponentType, Particle, attribute key, recipe book category, SlotDisplay and command parsers;
- every packet id in every phase, aligned by name through the accepted 26.1.2 codec. The only new 26.2 packet, `spectator_action`, replaces `spectate_entity` at the same id and is the single reviewed new-packet entry.

**Result: 22/22 for 26.1.2 and 22/22 for 26.2, exit 0, with no exceptions.**

There is no prefix normalisation and no rename heuristic. Label-only differences are admitted only through the explicit `LABEL_ALIASES` table (`scripts/lib/official-reports.ts`). Each entry carries its evidence, and comparison then requires exact per-id equality:

- **attribute:** legacy library-facing labels such as `generic.armor` and `generic.movement_speed`.
- **particle:** `trial_spawner_detection` → `trial_spawner_detected_player`, plus the ominous variant.
- **SlotDisplay:** `dyed` → `dyed_slot_demo`.
- **command parser:** `nbt_compound_tag` → `nbt`, and `team_color` (26.2's rename of `color`) → `color`.
  - Official `ArgumentTypeInfos.bootstrap` bytecode in both jars registers these as `SingletonArgumentInfo.contextFree` (no payload), and the codec decodes them as `void`.

A negative-control unit test proves that a shifted id list fails even when every label has an alias, and that an unreviewed label fails.

## MB-SERVER-002 — attribute ids and the physics consumer

**Defect.** Both data sets carried a stale 31-entry `entity_update_attributes` key mapper:

| Version | Official attributes | Mapper entries | Official `movement_speed` id | Mapped to `generic.movement_speed` |
| --- | --- | --- | --- | --- |
| 26.1.2 | 35 | 31 | 22 | id 20 |
| 26.2 | 40 | 31 | 26 | id 20 |

Separately, prismarine-physics reads `entity.attributes['minecraft:movement_speed']` (`registry.attributesByName.movementSpeed.resource`). Mineflayer stores only the decoded label `generic.movement_speed`. Every server movement-speed value or modifier was therefore ignored and physics fell back to 0.1. Upstream master has the same consumer mismatch.

**Correction** (smallest reproducible set, all recorded in `vendor/compat-sources.json`):

1. **26.1:** the exact upstream #1254 hunks for `pc/26.1/protocol.json` and `pc/latest/proto.yml`. Before blobs: `40ec5c78…`, `fa11b541…`. After blobs: `88005197…`, `28380309…`, which equal upstream's post-commit blobs.
2. **26.2:** `vendor/patches/minecraft-data-26.2-attribute-ids.patch`. This is a LOCAL correction.
   - Entry *i* is the attribute with `protocol_id` *i* in the official 26.2 `registries.json` (40 entries).
   - Labels follow the #1254 convention: legacy `generic.*`/`player.*`/`zombie.*` labels are kept, and attributes without one (including the five new in 26.2) use the bare name.
   - Blobs: `d669defc…` → `b6c2ec86…` (protocol.json), `f763d535…` → `d6a5a8df…` (proto.yml).
3. **Consumer:** `vendor/patches/mineflayer-mb-server-002-attribute-resource-keys.patch` (LOCAL), in `entities.js` `updateAttributes`.
   - Each decoded attribute is **also** stored under its exact registry resource, when that resource exists for the connected version and differs from the label.
   - The two keys share **one** object, so physics' sprint-modifier edits stay consistent.
   - The legacy key remains for other consumers, such as `explosion.js`'s `generic.armor`.
   - Blob `9fcb6f9c…` → `5d3893ff…`.

**Proof:**

- **Unit** (`tests/version-compat.test.ts`), for each version:
  - the official id (22 / 26) with value 0.0375 decodes through the production deserializer to `generic.movement_speed` = 0.0375, consuming every byte;
  - the production serializer re-encodes it byte-identically;
  - the vendored mineflayer handler stores the same object under `minecraft:movement_speed`;
  - a prismarine-physics tick walking on stone gives exactly **0.375×** the default speed.
- **Live** (`scripts/compat-live-check.ts`, built CLI, both fixtures):
  - **C1:** 20 attributes set by RCON to distinct values are all server-synced, and each decoded value equals the server's `attribute … get` under both the legacy label and `minecraft:<id>`.
  - **C2:** a live speed change reaches the physics key.
  - **C3:** production `/diag move_near` through mineflayer-pathfinder and prismarine-physics, over 22 blocks:
    - 26.2: half server speed → travel time **×1.92** (5,161 ms → 9,903 ms);
    - in every trial the server confirmed the position and logged zero moved-wrongly/too-quickly corrections;
    - 26.1.2: ×1.94 (5,159 ms → 10,004 ms).
    - Physics ignoring the server value would give about ×1.0.

## Application changes (source → built `dist/` → running CLI)

- `src/config/versions.ts`: support levels.
  - `upstream-tested` is the released Mineflayer testedVersions minus the locally admitted entry.
  - `local-compat` is exactly 26.2, admitted only when all four vendored builds and their `chunkbotCompat` markers are installed.
  - `checkVersionSupport` fails closed otherwise. Config loading gates on it before any connection.
- `src/game/codec-audit.ts` (new) and `connection.ts`: a per-epoch codec audit wraps the client deserializer and re-wraps it on every protocol-state change.
  - It counts decoded, trailing-byte and failed packets by name. These are silently dropped or ignored under `hideErrors`.
  - It only observes. It is logged at connection end and exposed through `codecHealth()`.
- `src/cli.ts`: `connect-check` prints `support=… codec=decoded:N,trailing:T,failed:F`. `status` adds a `network:` line. Run facts record the vendored package versions and `supportLevel`.
- `src/app/doctor.ts`: understands `file:vendor` pins, reports upstream-tested versions and the local profile, and checks the fixture profile matching the config (25566 vs 25567).
- `src/knowledge/knowledge.ts` and `src/knowledge/data/vanilla-26.2.ts` (generated): exact-version mechanics dispatch.
  - 26.2: 1,585 recipes, 224 item tags, 64 fuels, from jar `823e2250…` (inner jar `86765a58…`).
  - `vanilla-26.1.2.ts` regenerates byte-identically. 26.1/26.1.1/26.3 stay `unavailable`, and no release borrows another's facts.
- `src/app/fixture-layout.ts`, `scripts/fixture.ts`: fixture profiles. The default is 26.1.2 (unchanged). `--fixture 26.2` selects the distinct fixture. Start refuses when the game or RCON port is already in use; no unrelated process is ever killed.
- `scripts/extract-version-data.ts`, all four live harnesses: `--fixture <profile>`, defaults unchanged. Version-specific expected lines are derived from the profile. Live-check L3 now also requires clean codec health.
- New: `scripts/vendor-compat.ts`, `scripts/verify-version-data.ts`, `scripts/lib/official-reports.ts`, `scripts/compat-live-check.ts`, `tests/version-compat.test.ts`, `tests/codec-audit.test.ts`, `tests/fixtures/official-reports-*.json`, `config/examples/fixture-26.2{,-inference-free}.json`, `vendor/**`.
- `tests/config.test.ts`: the old "26.2 is rejected" expectation is replaced by 26.3 / 26.2.1 rejection, and exactly 26.2 is admitted.
- Docs: `README.md`, `AGENTS.md`.
- Unchanged: contracts, catalog (`skills-20-16f587b80d7a`, identical for both versions), skills, perception, execution, goal engine, planner (gate, isolation, transport, model `gpt-6.1-sol`/low, subscription only), the Jev adapter (route, price, spend ledger), and model and billing routes.

## Fixtures

| | 26.1.2 (accepted, untouched) | 26.2 (new, MB-SERVER-001) |
| --- | --- | --- |
| Endpoint / RCON | 127.0.0.1:25566 / 25576 | 127.0.0.1:25567 / 25577 (confirmed free before setup and start) |
| Directory | `var/fixture/` | `var/fixture-26.2/` (own world, `server.properties` mode 0600 with its own RCON password, own `server.pid`) |
| Server jar | sha1 `97ccd4c0…` | official manifest `26.2.json` (sha1 `c7868781…`) → server sha1 **`823e2250d24b3ddac457a60c92a6a941943fcd6a`** (sha256 `cdacdfb2…`) |
| JRE | Temurin 25.0.4.1 sha256 `5b02bcc9…` | the same archive, copied read-only from `var/fixture/downloads/` and re-verified sha256 `5b02bcc9…` (26.2 requires Java 25) |
| PID | 31385 (running throughout; jar, config, world and version unchanged) | 15009 |

The EULA acceptance carries forward. Each fixture is flat, peaceful, offline, and loopback-only.

## Runs (direct exit statuses; built `dist/` after the final source edits)

All runs used `PATH=/opt/homebrew/Cellar/node@24/24.21.0/bin:$PATH` from the repository root.

| Command | Exit | Result / report |
| --- | --- | --- |
| `npm run check` (final) | 0 | 297/297 tests (baseline 286; +11: version-compat 9 incl. negative control, codec-audit 2; config test updated) |
| `node scripts/vendor-compat.ts --check` | 0 | 4/4 tarballs rebuilt byte-identical |
| `npm run verify-version-data` | 0 | 26.1.2: 22/22 — `var/compatibility/verify-26.1.2-2026-10-06T04-29-06-983Z.json` |
| `npm run verify-version-data -- --fixture 26.2` | 0 | 26.2: 22/22 — `var/compatibility/verify-26.2-2026-10-06T04-29-07-326Z.json` |
| clean `npm ci` probe + `npm ls --all` + `npm run check` (`var/compatibility/ci-probe-final/`, fresh cache) | 0 / 0 / 0 | 297/297; one deduped copy of each patched package |
| tampered-tarball `npm ci` (`var/compatibility/ci-tamper/`) | 1 | `EINTEGRITY` (expected) |
| `node dist/cli.js doctor --config config/examples/fixture.json` | 0 | 26.1.2 upstream-tested |
| `… doctor --config config/examples/fixture-26.2.json` / `fixture-26.2-inference-free.json` | 0 / 0 | 26.2 local-compat |
| `… doctor --config chunkbot.config.json` (read-only, no connection) | 0 | live config 26.2 local-compat; Microsoft cache present for label `eggyBot69` (existence only); previously exit 1 because 26.2 was unsupported |
| `node dist/cli.js connect-check --config config/examples/fixture-26.2-inference-free.json` | 0 | first true 26.2 login/spawn: `support=local-compat codec=decoded:99,trailing:0,failed:0` |
| **26.2** `npm run live-check -- --fixture 26.2` | 0 | **16/16** — `var/live-check/2026-10-06T04-10-06-123Z-26.2/` (doctor, config/auth failures, connect-check with clean codec, run idle, owner chat, controls, spoof rejection, terminal, death/dimension, kick + `/reconnect` rejoin, SIGINT, restart, join cancellation) |
| **26.2** `npm run skills-live-check -- --fixture 26.2` | 0 | **33/33** — `var/live-check/2026-10-06T04-14-31-013Z-26.2-skills/` (perception/occlusion, knowledge from the 26.2 jar, hand/tool mining, crafting 2x2/3x3, furnace smelting, chest, drops, entities, placement, movement/follow, travel bounds, stop during navigation/mining/crafting/interface, window acknowledgements) |
| **26.2** `npm run jev-live-check -- --provider fault --fixture 26.2` | 0 | **12/12** — `var/live-check/2026-10-06T04-17-55-936Z-26.2-jev-fault/` (harness validation only; NOT Jev acceptance) |
| **26.2** `npm run planner-live-check -- --jev fault --fixture 26.2 --only P0,P1,P9,P10` | 0 | **4/4** — `var/live-check/2026-10-06T04-19-58-142Z-26.2-planner-jev-fault/` (REAL Codex subscription planner gate/turns, fault Jev; owner-chat "come here"; stone via furnace with 26.2 recipes; unsupported mechanic) |
| **26.2** `npm run compat-live-check -- --fixture 26.2` | 0 | **6/6** — `var/live-check/2026-10-06T04-12-53-326Z-26.2-compat/` (C1 20 attributes; C2; C3 ×1.92; C4 sulfur blocks; C5 `codec=decoded:1299,trailing:0,failed:0`) |
| 26.1.2 `npm run compat-live-check` | 0 | **5/5** — `var/live-check/2026-10-06T04-13-44-357Z-compat/` (C3 5,159 → 10,004 ms, ×1.94; C4 is 26.2-only) |
| 26.1.2 `npm run live-check` (final build) | 0 | **16/16** — `var/live-check/2026-10-06T04-23-00-978Z/` |
| 26.1.2 `npm run skills-live-check` (final build) | 0 | **33/33** — `var/live-check/2026-10-06T04-23-41-264Z-skills/` |
| 26.1.2 `npm run jev-live-check -- --provider fault` (final build) | 0 | **12/12** — `var/live-check/2026-10-06T04-26-55-645Z-jev-fault/` |

Notes:

- Earlier failing runs are retained under `var/live-check/` and `var/compatibility/work/`:
  - `…04-11-43-042Z-26.2-compat` 4/6. The failures were harness assumptions: a default max_health value was absent from the initial client attributes, and the observing bot was too far from the new blocks. The corrected harness sets non-default attributes before requiring server/client equality (including max_health) and moves the observer close enough to receive the blocks.
  - The first probe check was 296/297 because of the load-timed test noted above.
- The full 19-case real planner suite was not repeated, because planner gate, transport and isolation code are unchanged. `planner-check --probe` was not re-run for the same reason.
- The 26.2 runs used the same source as the final build. `src` was unchanged between the pre-run build and the final `npm run check` rebuild.

## Real-provider checks for root (not run by the worker)

Prerequisites:

- the 26.2 fixture is running (`npm run fixture -- status --fixture 26.2`);
- `npm run build` has been run;
- `OPENROUTER_API_KEY` is injected by root's credential helper.

The worker never ran real Jev.

```sh
# 1. one live Jev decision through the real adapter (route/model/price only)
node dist/cli.js jev-check --config config/examples/fixture-26.2.json
# 2. real Jev controller scenarios on 26.2 (movement, mining, crafting, placement, tool mining, feedback, stop, follow)
npm run jev-live-check -- --fixture 26.2
# 3. integrated real Codex planner + real Jev on 26.2: gate, owner-chat "come here", empty-inventory resource chain, stone via furnace, unsupported mechanic
npm run planner-live-check -- --fixture 26.2 --only P0,P1,P2,P9,P10
```

Reports go to `var/live-check/<stamp>-26.2-jev-real/` and `…-26.2-planner-jev-real/`.

Read-only live-config doctor, after acceptance, by root:

```sh
node dist/cli.js doctor --config chunkbot.config.json
```

The worker ran this read-only (see the runs table); it does not connect. Do not run `connect-check`/`run` against the live server until root's acceptance.

## Limits and open items

- **Support honesty.** 26.2 = local compatibility, verified locally. It is not an upstream release, and upstream PRs #333/#143/#4121 remain open. When PrismarineJS releases 26.2 support, replace `vendor/` with released versions and re-run these checks.
- **Not upstream.** The 26.2 attribute mapper and the mineflayer resource alias are LOCAL corrections (MB-SERVER-002). Recommendation: offer both upstream (the minecraft-data 26.2 mapper; mineflayer/prismarine-physics key reconciliation).
- **Pre-existing, unchanged on both versions:**
  - Mineflayer writes sprint `entity_action` ids 3/4, which in modern codecs mean horse-jump.
  - Chunkbot disables sprinting (`allowSprinting: false`), so this is inert for Chunkbot. It is not fixed here.
- **Codec scope.** Codec health counts decode completeness, not semantic field correctness. Semantic correctness for blocks, items, inventory, windows, entities, attributes and movement is covered by the RCON-checked live scenarios above.
- **Real Jev on 26.2** is not run by the worker. Root owns it (argv above).
- The live join is root's and is deferred by Jake until his next play session; no remote check or bot launch is part of tonight's remaining work.

## Final state at handoff

- **Source:** `src` SHA-list (`find src -type f | sort | xargs shasum -a256 | shasum -a256`) `5bd800962c30236d56d521d6f6764c710147c864682dd8082d673a161ec82ff6`.
- **Built:** `dist` SHA-list (same method) `e231bd72e1831bd3ff41bbac75b19c1f37989cba8e53e24475d8576f6c785bdd`, from the final `npm run check`.
- **Catalog:** `skills-20-16f587b80d7a`, unchanged.
- **Running:**
  - No Chunkbot app, harness, test bot or planner process is running.
  - Fixture 26.1.2 is running (PID 31385, 0 online) and fixture 26.2 is running (PID 15009, 0 online). Both are left up for coordinator rechecks.
  - Jake's Prism processes (99668/99698) kept running, untouched.
- **Baseline:** the original 179-file copy remains at `var/compatibility/mb-server-001-baseline/` for diffing. The project is still not a Git repository.
- **For root to reconcile:** `docs/live-server-connection-plan.md` (MB-SERVER-001/002 delivery state), `docs/agent-supervision.md`, `feature-plans.md`. The worker did not edit them.
