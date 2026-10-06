# MB-SERVER-001/002 — independent local acceptance

Accepted locally by Codex on 2026-10-06 at 04:37 UTC. Minecraft Java **26.2 / protocol 776** now works through the built application on a separate vanilla fixture. The attribute ID and physics-consumer defect (MB-SERVER-002) is corrected for both 26.1.2 and 26.2. **Live joining is deferred by Jake until his next play session.** No live bot login or application launch occurred.

The implementation came from one native local DSH Claude subscription worker, `session-1d547f0f-eccd-4429-9b8e-56b4c91fe0fe`. Loaded SDK 0.3.280 resolved `opus[1m]` to `claude-opus-5-5[1m]`, with high effort and full access. Full [worker evidence](mb-server-001-compatibility.md) and the visible final response were reviewed. The session is idle at sequence 2438, both queues empty; no follow-up implementation is assigned.

## What was accepted

Four reproducible tarballs extend the released PrismarineJS stack with immutable first-party 26.2 changes and two recorded local attribute corrections. npm locks their integrity and deduplicates transitive consumers. Support is reported honestly as **local-compat**, rather than an upstream release or Mineflayer-tested version. Exactly 26.2 is admitted; unverified point releases/later versions remain refused. Exact 26.2 recipes, tags and fuels come from its own checksum-verified official jar.

Codex reviewed the actual version gate, application/CLI wiring, packet audit, exact-version knowledge dispatch, fixture separation, lockfile/vendor inputs and documentation changes. The existing contracts, goal engine, gameplay planner/isolation, task controller, skills, perception, execution and Jev route are unchanged from the accepted baseline. All 1,527 installed files across the four vendored packages independently compare byte-identically with a fresh-cache clean installation. No files from the original 179-file baseline were deleted; no Git repository, commit, push or PR was created.

The independent raw incoming attribute-packet probe uses official numeric movement-speed IDs, production deserialization, the actual Mineflayer entity handler and physics lookup. Both versions deliver the non-default 0.0375 value to the correct resource key. Independent recipe comparison checks every raw recipe against both official inner jars. Evidence:

- `var/compatibility/coordinator-attribute-consumer-fixed.json`
- `var/compatibility/coordinator-mechanics-provenance.json`
- `var/coordinator-review/2026-10-06T04-32-14Z-26.2-local/report.json`

## Tests and real gameplay

Worker direct results reviewed on the final source/build:

| Check | 26.2 | Retained 26.1.2 |
| --- | --- | --- |
| Foundation connection, identity, chat and lifecycle |16/16|16/16|
| Perception, knowledge, skills, interfaces and cancellation |33/33|33/33|
| Controller with fault Jev |12/12|12/12|
| Attribute/physics/codec compatibility |6/6|5/5|
| Official registry, block-state and packet-ID comparison |22/22|22/22|

Main-project typecheck/build/test and a separate fresh-cache clean-install full check both exit 0, **297/297 tests**. The initial 296/297 timing failure remains documented; isolated and fresh quiet full reruns passed. Fault Jev is harness validation, not real-provider acceptance.

Codex independently ran the actual built doctors for both fixtures (exit 0), then the real Jev diagnostic (exit 0) and real Codex/real Jev gameplay subset:

```sh
node dist/cli.js jev-check --config config/examples/fixture-26.2.json
node scripts/planner-live-check.ts --fixture 26.2 --only P0,P1,P9
```

The credential helper injected the key only into these processes. The key was never printed, saved in configuration or given to a worker. Both runs had a USD 1 cap. The integrated run exited0 and passed **3/3**:

- **P0:** normal built CLI has the isolated subscription planner and real Jev ready.
- **P1:** owner chat “come here” completed; code verified proximity and RCON measured 1.14 blocks.
- **P9:** “make me two stone” used exact-version knowledge, crafting/table/furnace placement and server-confirmed loading, fuel, waiting and collection. The planner used 4 turns and 2 windows; all 7 tasks completed. Code verified 2 newly acquired `minecraft:stone`, and RCON confirmed exactly 2 stone in inventory. No in-trial intervention occurred; 70 pretrial setup commands are recorded.

Report: `var/live-check/2026-10-06T04-32-17-843Z-26.2-planner-jev-real/report.json`; application journal: `var/runs/run-9956ce044469/events.jsonl`. All 8 gameplay responses came from dated `typesafe/jev-1.13-20260917` / `TypeSafe`; reconciled spend USD 0.00043302, zero retained/outstanding. Including the separate diagnostic, 9 responses cost USD 0.000452718. The application decoded 16,656 packets with zero trailing bytes or parse failures and shut down cleanly.

The unchanged 19-case planner suite and earlier isolation/cancellation acceptance were retained rather than repeated. This targeted 26.2 acceptance does not claim a new full 19/19 run or MB-V1-05 acceptance.

## Built and running state

Source/manifest/vendor and built JavaScript digests were unchanged before/after independent gameplay:

- Source/dependency digest: `031d6b91f007a2d478b93b1bf2957119124867077fa1208eb037bf94ea6e47d7`
- Built JavaScript digest: `bdaec112ef835f126b39078716feb25ce76cd7b11691401968b6d41368f119a1`

The aggregate specifies the SHA256 path/NUL/bytes/NUL algorithm; these differ intentionally from the worker's `shasum` list digests. The built CLI journal records the expected installed package versions, protocol 776, local-compat profile and unchanged 20-skill catalog.

Both fixtures remain running and idle: 26.1.2 PID 31385 at 127.0.0.1:25566 and 26.2 PID 15009 at 127.0.0.1:25567; final status checks exit 0 with 0 online. No Chunkbot gameplay application or owned test/planner process remains. The prepared live configuration and Microsoft cache for `eggyBot69` are preserved; the temporary live launcher is disabled. Online joining, whitelist/access and real-server behavior remain unverified by instruction. The application would run on this Mac; no deployment to the other laptop occurred.

Next shared-play step belongs to Jake's next session: after he asks to join, use the existing bot cache and prepared config for a bounded online connection check and idle launch. Follow the latest [live connection plan](../live-server-connection-plan.md). MB-V1-05 remains a separate unassigned phase.
