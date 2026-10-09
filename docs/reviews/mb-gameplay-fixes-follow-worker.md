# Follow worker (L) role review — L-H12 opaque frontier-handle privacy oracle

Worker L: native Claude Opus 5.5 (local DSH), worktree `gameplay-follow`, branch `chunkbot/gameplay-follow`.

| Item | Value |
| --- | --- |
| Starting HEAD | `e767d6535acb73a7a7462eb1a357845e24a8e4d7` (clean) |
| Source fix commit | `b758e9b45808dc9c0960b8041586a1fb1c5e0a9d` (parent `e767d65`) |
| This review | separate documentation commit on top of `b758e9b` |

**Scope.** L-owned oracle, harness and test paths only. No application source, shared harness (`ordinary-goal-live-check.ts`), fixture, RCON, provider, credential or live operation was touched. The retained 262 report stays a failure (overall exit 1); nothing here relabels it.

## Observed failure (immutable, read-only)

- **Report:** `var/gameplay-fixes/acceptance-planner/var/live-check/2026-10-08T20-16-21-009Z-26.2-locator-ordinary/report.json`, SHA-256 `efe14029db2d39087fa91b52c7d354415359da83643eea3b161c8dad1c5aa056` (matches the recorded value). Provenance head `dd0b5a8`.
- **Result:** the only failed result is `PRIVACY`. It contains four findings in O4 `planner_prompt` at `atMs 1791490815854`: paths `observation.frontiers[1..4].handle`, values `2016`, `2017`, `2018`, `2019`, reason `hidden current coordinate in model-visible text`.
- **Model text:** `fault-planner/prompts/0003-1791490815854.txt`, SHA-256 `7c1b09a4025d37da0aa99da8aa2ddff5bcdba639509566980c2d18cea424955d`. Its frontiers are `frt-2015` … `frt-2022`, each with a separate `.at` point. The hidden owner (O4 `ownerFarNorth`) was at server x 2017.5, z 1737.5. The oracle's window is floor/round ±1, i.e. {2016, 2017, 2018, 2019} and {1736 … 1739}.
- **Mechanism:** the generic string scan `(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])` treats `-` as a boundary, so `frt-2016` yields the number 2016.

## Faithful pre-fix reproduction

Retained input → `tests/fixtures/locator-lh12-privacy.json`, SHA-256 `b818d6f2c43d8823c6bf04e377ac6c135db5fbe3bdc4974b2fd2575806a4c3c6`. It was extracted read-only by a throwaway script (`/tmp/l12-extract.ts`, not committed) and contains:
- **Prompt:** the verbatim prompt text; the test re-hashes it to the value above.
- **Journal rows:** the verbatim run journal rows `connection_ready` ×2 and `planner_request` / `planner_turn_started` of `req-c94ff4fe815a`.
- **Server sample:** the report sample nearest the prompt, chosen by the harness rule (`atMs 1791490815745`; bot 2000.5,−60,2000.5; owner 2017.5,−60,1737.5).
- **History rows:** for each remembered prompt entry, the FIRST observation-journal line whose `verifiedHistory` proof satisfies the oracle's own predicate — exactly what the oracle's `find` uses. Lines 6, 8–22, 49, 70 and 78 of `observations.jsonl`. Each snapshot is projected to `id, connectionEpoch, goalEpoch, takenAtMs, dimension, self, owner, entities, remembered`; the extraction throws if any projection changes a proof.
- **Recorded result:** the report's recorded findings and allowed rows for this prompt.

I then ran the UNMODIFIED oracle at `e767d65` over this input, using the harness context (sample, ready connection, history; owner not visible) via `/tmp/l12-repro.ts`:
- **Exit:** 1. Log SHA-256 `4c9c3f3d7acdfadc3c71ffd01d56b67040d59a7a71cabc520076487ccc778d82`.
- **Result:** the prompt hash matches; there are exactly the four recorded findings; the 21 allowed rows equal the report's 21. This is an exact reproduction.

## Producer → consumer proof (no application leak)

| Hop | Evidence |
| --- | --- |
| Producer | `src/perception/perception.ts` (byte-identical to canonical `dd0b5a8`). `nextHandle(prefix)` is the ONLY mutator of `handleCounter` (grep: declaration line 254, update line 705): `counter = (counter % 999_999) + 1`, returns `${prefix}-${counter}`. Used for `blk`, `grp`, `drp`, `ent` and `frt`. Frontiers: `cells.map(c => nextHandle('frt'))` in production order; `findFrontiers` returns at most 8 (`slice(0, 8)`). The coordinates go into separate `.at`. No coordinate is an input to the counter. |
| Contract | `ObservationHandleSchema = /^[a-z]{1,8}-[0-9]{1,6}$/`. |
| Renderer → planner | `renderObservation` emits `frontiers: s.frontiers.map(f => ({ handle: f.handle, at: pos(f.at), … }))`, verbatim and in order. `renderRequest` produces the stdin text. `CodexPlanner` journals `planner_turn_started.promptDigest = sha256(prompt).slice(0, 12)` together with `snapshotId` / `snapshotTakenAtMs` / goal and connection epochs / subject. |
| Renderer → Jev | `snapshotSummary` renders frontiers only as a count (`frontiers: s.frontiers.length`), so frontier handles never reach Jev. |
| Retained binding | The journal row of `req-c94ff4fe815a` has `promptDigest 7c1b09a4025d`, the prefix of the captured text's SHA-256, and `snapshotId snap-6a57c1217564` / `snapshotTakenAtMs 1791490815750` / `goalEpoch 7` / `connectionEpoch 1`, equal to the prompt's observation. |

**Conclusion:** `2016..2019` are counter identities that coincide with the owner's x by chance. There is no actual coordinate leak, so no P request is needed.

## Fix (`b758e9b`; L-owned files only)

**`scripts/lib/locator-ordinary-oracles.ts`:**
- **`plannerPromptBinding(text, observation, events, ctx)`** selects only `planner_turn_started` rows whose `promptDigest` equals `sha256(text).slice(0, 12)`. It then validates them with the existing `modelObservationBinding`: same run, snapshotId, takenAtMs ≤ row time ≤ prompt, goal epoch, connection epoch, and subject present.
- **`frontierHandleProof(input, binding, ctx)`** grants a proof only when ALL of the following hold; otherwise it proves nothing:
  - The bound row is this run's planner turn, and the prompt's planning subject is that row's subject: an admitted `goalId`, or a preparing `intentId` (the retained O4 replacement prompt 0004 is a preparation turn).
  - The observation's snapshotId, takenAtMs, goal epoch and connection epoch equal the binding's.
  - The dimension equals an INDEPENDENT `journalDimension` (last `connection_ready.info.dimension`), never the model text.
  - The list has 1–8 entries; every handle exactly matches `^frt-([1-9][0-9]{0,5})$` (≤ 999 999, no padding) and has a point `.at`.
  - The handles form one consecutive counter run in rendered order (allowing the 999 999 → 1 wrap).
  - No frontier counter value is reused by a `blk`/`grp`/`drp`/`ent` handle.
- **`privacyOracle`** accepts optional `promptBinding` and `journalDimension`. Only at path `observation.frontiers[i].handle`, and only when the string EXACTLY equals the proven handle at that same index, are the matching numbers recorded as `allowed` with reason `producer-proven opaque frontier handle (counter identity, not a coordinate)` and the producer proof. Every other path, including the handle's own `.at`, every other text field, `state.observation` (Jev) and the remembered/visible/self/local rules, is scanned exactly as before.

**`scripts/locator-ordinary-live-check.ts`:** for planner prompts it passes the digest binding (computed from the run journal) and `journalDimension`. Jev requests get no binding. No change to the motion radius 32.2, position tolerance 0.18, time 1 500, owner/cue/monotonic/cumulative brackets or visibility rules.

## Tests (`tests/locator-lh12-privacy.test.ts`, 33)

- **Retained input:**
  - The prompt is hashed and bound to the journal row's digest.
  - Without a binding, exactly the four recorded findings and 21 allowed rows appear.
  - With the real journal binding: findings 0; allowed = the 21 recorded rows unchanged plus exactly the four handles, carrying proof `{req-c94ff4fe815a, snap-6a57c1217564, 1791490815750, goal-ad3c5e163312, 7, 1, first 2015, count 8}`.
  - A frontier `.at.z 2017.5` is still judged by the coordinate rule.
- **Binding refusals:**
  - One changed character, a foreign run, or a wrong journal digest binds nothing.
  - A snapshotId, takenAtMs, goalEpoch, connectionEpoch, goalId or dimension mismatch proves nothing.
  - Subject identity: a preparing intent bound to its intent row passes. Crossed or other intents, and a status mismatch, are refused.
  - A foreign-run row or a non-planner row handed directly to `frontierHandleProof` proves nothing.
- **Malformed IDs** at `frontiers[2]`: `frt-02017`, `frt-2017.5`, `frt-2017 `, `␠frt-2017`, `frt-2017x`, `FRT-2017`, `frt--2017`, `frt-2017-1`, `frt-1000000`, `frt-0`, `blk-2017`, `frt-2017,frt-2018`.
  - The whole list then proves nothing, and every other colliding handle stays flagged.
  - The malformed field itself is scanned as plain text: it is flagged exactly when it contains a standalone owner-window number.
- **Correct ID in a wrong field:** `frontiers[1].direction`, `blocks[0].handle` and `goal.ownerInstruction` are each flagged, while the genuine handles stay proven.
- **Owner coordinates elsewhere:**
  - The owner point placed at a proven handle's `.at` is flagged (x 2017.5, z 1737.5).
  - Owner numbers in `blockSummary` text and in `locator.note` are flagged.
- **Producer-invariant breaks:** swapped handles, a counter value reused by an entity, a 9th frontier, a missing `.at`, and a skipped counter value each prove nothing. The counter wrap is accepted; `frt-1000000` is not; a missing journal dimension proves nothing.
- **Real producer/renderer control:**
  - The actual `PerceptionService` (fake flat world, as in `perception-frontier.test.ts`) yields frontier handles that form a consecutive run.
  - The actual `renderRequest` renders them verbatim and in order.
  - The journal row uses the real `subjectRef` and the planner's digest formula.
  - A collision manufactured ONLY on the owner side (owner x = second handle value + 0.5) is flagged without the binding and proven with it.
  - An owner coordinate inserted into `goal.ownerInstruction` remains a finding.

**Mutation checks** (each mutant applied, run, then restored; `cmp` 0 after each):

| Mutant | Result |
| --- | --- |
| Consecutive-run check removed | exit 1 (2 fail) |
| Journal-dimension check removed | exit 1 (2 fail) |
| snapshotId scope removed | exit 1 (1 fail) |
| takenAtMs scope removed | exit 1 (1 fail) |
| goalEpoch scope removed | exit 1 (1 fail) |
| connectionEpoch scope removed | exit 1 (1 fail) |
| goalId/subject check removed | exit 1 (1 fail) |
| reuse check removed | exit 1 (1 fail) |
| always-grant | exit 1 (27 fail) |
| `j.run` check removed | exit 1, after adding the direct test |

The per-index exact-string equality is an equivalent mutant (exit 0). The proof is computed from the same list and already requires every entry to be producer-shaped, so the equality is defense in depth that no input can separate.

**Replay over every retained real planner prompt** (`/tmp/l12-replay.ts` SHA-256 `fe617e4e…`, log `eecbdb51c0d02a4aecce2d7cd790f99cbd896aefd0f523bdd03c46f0e8cb1e0e`):
- **Scope:** 8 retained locator-ordinary reports, 90 prompts, 83 of them with frontiers.
- **Current-source reports (`20-16-21-002Z` 261 and `-009Z` 262):** all 20 frontier-bearing prompts are digest-bound and producer-proven, across admitted, preparing and exhaust-run turns, with zero unproven.
- **Older-source reports:** the other 63 come from reports whose journals predate the P `28796a1` snapshot metadata, so they bind nothing and fail closed.

## Checks (Node 24.21.0; each output redirected to a log and `$?` captured immediately; no pipelines)

| Check | Exit | Result | Log SHA-256 |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | — | `54f8c884…` |
| `npm run build` | 0 | — | `1537c3e2…` |
| `npm test` | 1 | 1364/1365 pass, 1 fail | `34a31e2e…` |
| All 20 `tests/locator-*.test.ts` | 0 | 374/374 | `7bec58a3…` |
| Privacy/oracle/visibility/harness-guard/origin family | 0 | 191/191 | `6791caa1…` |

**The one `npm test` failure is pre-existing and unrelated:**
- **Test:** `tests/survival-route.test.ts` R5 "oversized_partial" (expects `{}`, actual `{ 'minecraft:bread': 4 }`; S-owned survival accounting).
- **Proof it predates this work:** the identical failure (5/6, exit 1) occurs on an untouched `git archive` of the starting HEAD `e767d65` (log `0913b7b7…`).
- **Treatment:** it was not modified or weakened. The root baseline of 1530 passes is on root source; this branch keeps that older shared-source failure.

## Limitations and remaining evidence

- **Frontier handles only.** The other handle kinds (`blk`/`grp`/`drp`/`ent`) are rendered in sorted or truncated order with no comparable per-list invariant, so a counter collision there still fails closed (flagged). They were not exempted speculatively.
- **Connect-time dimension.** `journalDimension` comes from connect-time `connection_ready`. A bot dimension change after connecting would make the proof fail closed (never open). The locator harness never moves the bot to another dimension.
- **Old reports are not re-scored.** Older-source prompts (without snapshot metadata) still bind nothing. No old report is re-scored or relabeled.
- **Root owns the rerun.** Root owns the next actual O4 / full locator fixture trial on a frozen build containing `b758e9b`; that trial alone can show the 262 PRIVACY result under the corrected oracle. The retained `efe14029` report remains a failed overall exit 1 record.
