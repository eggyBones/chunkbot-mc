# Batch001 independent integration review

Date: 2026-10-06 UTC. Coordinator: Codex. Status: integrated implementation; final acceptance in progress. Public repository: [eggyBones/chunkbot-mc](https://github.com/eggyBones/chunkbot-mc).

## Delivered scope

Three native local DSH Claude Opus 5.5 subscription workers implemented MB-UI-001, MB-FLOW-002 and MB-MEM-001 in separate Git worktrees. The loaded SDK resolved `opus[1m]` to `claude-opus-5-5[1m]` at 07:27:17.882 UTC; each session used high effort and native bypassPermissions/full access. Codex controlled shared interfaces, reviewed corrections, merged dependency commits, and ran browser and real-provider acceptance. Source/build/fixture isolation and exact worker identities are in [supervision](../agent-supervision.md).

- **Dashboard:** a separate loopback read-only viewer displays actual server-backed vitals, XP and slot inventory, directive/task/preparation, memory and adapter state. Unknown/historical readings are explicit. Whitelisted publishing and bounded SSE do not issue gameplay actions. Exact local spending and observed token history stay separate from optional account-wide quota/key metadata.
- **Handoff:** a replacement prepares while the current task continues. Only the latest valid draft gains ownership after bounded cleanup, a fresh admission baseline/anchor and reference re-grounding. Lookahead prepares the next window within the existing immutable outcome and limits. Stop revokes active and pending work; bare resume clears only the automatic pause latch.
- **Memory:** opt-in explicit world/revision/bot scope, durable checksummed revisions, trusted facts versus notes, bounded fresh references, current contradiction handling, verified checkpoints and historical container contents. A real restart loads facts without action replay; memory alone never reconnects, unpauses or recovers gear.

Automatic progression, survival/death recovery, locator use, server control, deployment/update management and MB-V1-05 remain unassigned. Memory-side death evidence and reusable pause/project seams are included; their future consumers are not claimed as delivered.

## Frozen builds and checks

Final application source/build: `dd51a4c6c3814cbffd01539078cca4c3c9f2265f` (reviewed shared implementation `88089893`, memory correction `692f5773`, dashboard `042b2a0a`). Root `npm run check` exits 0: **483/483**, no skips/failures/cancellations. An isolated archive copy with independent node_modules also passes 483/483; clean `npm ci` exits 0. The manifest/lock dependency bytes are unchanged after that installation.

An earlier immutable root build `8d5f3174` was deliberately retained during the 26.2 foundation/skill/controller/planner regression run. Later changes were new memory-view sizing/telemetry and dashboard rendering; those were tested separately before the final build. No build was cleaned under an active harness.

| Evidence | Actual result |
| --- | --- |
| Native shared-writer 26.1.2 regression | Foundation 16/16, skills 33/33, fault Jev 12/12; all exits 0 on frozen `88089893` |
| Root 26.2 regression | Foundation 16/16, skills 33/33, fault Jev 12/12, compatibility 6/6; all exits 0 |
| Root planner isolation/cancellation | Both version configs exit 0; real subscription turn, empty tool self-report, owned-process cleanup with no remaining descendants |
| Root 26.2 planner with loopback Jev | 19/19, exit 0; real planner plus explicit planner-fault scenarios |
| Root final memory module/hook harness | 13/13 on each version; separate seed/recall processes, real packets/skills, no model calls |
| Root final handoff harness | 9/9 on each version, exit 0; scripted planner/loopback Jev |
| Root compatibility 26.1.2 | 5/5, exit 0; speed changes reach physics and measured movement |
| Vendored/official data checks | Byte-identical vendor rebuild, official registry/codec comparisons 22/22 on each version; exits 0 |

Private exact commands, direct exits, timestamps and paths: `var/batch001/final-root-check.json`, `final-copy-check-c7.json`, `final-clean-install.json`, `final-frozen-gates-26-2.json`, `final-feature-gates-26-1-2.json`, and `final-feature-gates-26-2.json`. Reports and logs remain ignored.

The two final real-planner regression processes use different Minecraft fixtures and unique run-store/journal directories, but the existing harness hardcodes the same root data directory for both. Their shared dashboard status/history file is therefore **not aggregate-history acceptance evidence**. Gameplay evidence is correlated to each unique run/goal and fixture. The actual dashboard/memory acceptance above uses distinct data directories. Subsequent parallel checks must use the isolated copy or distinct worktrees; preserve the root fixture-only aggregate as a private trial artifact after both drivers exit.

## Real ordinary-goal acceptance

**H7, 26.2:** one instruction, “Gather two new oak logs and two new cobblestone for me,” with one task per window. Actual Codex subscription planning and real Jev completed two windows under one immutable acquisition outcome. RCON confirmed both quantities, zero in-trial assistance. Lookahead was actually used; the measured gap was 1,936 ms with 16 ms fresh revalidation. This is reduced waiting, not a zero-latency claim. Report: `var/batch001/real-h7-26-2/report.json`.

**M6, 26.1.2:** ordinary remembered-home and inspect-chest goals completed in the first actual CLI process. It exited, the read-only memory command loaded the same scope, and a second CLI process made no action before a new instruction. “Go home and craft and place a crafting table beside home, using planks from the chest” then used an accepted shown memory reference, inspected the chest freshly before withdrawal, consumed four of twelve planks, crafted and placed the table beside home. Code verified all 3 conditions; RCON confirmed the table at 205,-60,206 and 8 planks left. Zero assistance. Three actual memory views, maximum 3,887 serialized characters. Report: `var/batch001/real-m6-26-1-2/report.json`.

**M6, 26.2:** the same actual CLI restart scenario also passed, with the table at205,-60,206 and8 planks left. Code verified3/3;5 actual memory views, maximum3,885 characters; fresh inspection before withdrawal and zero assistance. Report: `var/batch001/real-m6-26-2/report.json`.

Real Jev diagnostic commands pass on both configs. The final real-Jev suite passes12/12 on26.2 and11/12 on26.1.2: only the separately reproduced inherited J1 movement timeout remains. Full real-planner regression commands are still running; their outcomes must be read before acceptance is closed.

## Browser and observer evidence

T3 inspected actual integrated CLI data during the live M6 trial: 24/24 health represented as 12 hearts, hunger 20, level 4 and XP 80%; DOM bar width matched 80%. The returned Codex quota window and exact tiny Jev charge rendered correctly, with no CSP errors. Fixture-only max health was read before setup and restored in teardown.

Final layout C7 was independently inspected at **1280, 1366, 1920 and 390 px** using the real saved M6 data after graceful app stop. Readings were honestly historical. Memory metadata had 466/501/716/344 px of readable width; no page, memory-row or cost-card horizontal overflow. XP and returned quota bars matched their values; console entries were empty. Exact screenshots/geometry: `var/batch001/final-dashboard-browser-c7.json`. T3 screenshots succeeded; recording remained unavailable, so no video evidence is claimed.

Native 26.2 dashboard live evidence includes 15/15 with real hunger changing 20→17 under a bounded temporary Normal difficulty trial. The original Peaceful difficulty was restored in finally and independently rechecked. The first final root ordinary Peaceful runs passed 12/13 on each version; D2-health's <=17 sampling threshold timed out after 3 damage. Server and dashboard matched afterward. **C8** corrects the harness only (`38a285ad`): established baseline, decisive non-lethal damage, immediate server read, recorded file/stream health samples and command-to-observation latency. Root typecheck exits0 after integration; the sub-second rerun remains pending. These original failed reports are retained, not counted as passing.

The coordinator separately proved the pinned Codex quota adapter with only initialize/initialized, non-refreshing account/read, and rateLimits/read. No thread/turn/inference or auth refresh. Only returned windows were kept; account identity and raw envelopes were discarded. OpenRouter key overview was observed through its supported current-key GET. Tabs share bounded source polling; no account wallet balance is fabricated.

## Review corrections and incident handling

Root reproduced the planner serialization timeout, superseded-preparation cleanup race, memory reference/durability/view-bound defects, history size/atomicity, missing and charged-failure token coverage, CSP bar failure and narrow cost/memory layouts before issuing native corrections. The child plans retain stable C1–C8 records and worker evidence. Root rechecks prove one unsettled planner tail, bounded cleanup of superseded work, failed forget retaining durable home, and complete memory views at or below 8,000 characters with home preserved.

MB-BATCH001-I1 was an accidental import of an executable memory harness without a lease, disrupting the handoff fixture trial. That entire run was invalidated and rerun. The memory harness now refuses missing/invalid leases before password reads, writes or joins, and does nothing when imported. A native background reviewer was also stopped after violating the no-recursive-workers brief; none of its evidence was used for coordinator acceptance.

The inherited real-Jev J1 movement timeout **MB-NAME-001-C1** was reproduced before the rebrand. It remains a separately recorded baseline limitation; this feature batch cannot silently reclassify it as a pass. Final provider reports will distinguish it from any new failure.

## Publication and runtime

The initial public rebrand push was verified before worker launch. Feature code is locally integrated but not yet pushed. Final publication requires checking all outgoing Git-history blobs, current tracked files and vendored archive contents against actual Microsoft/OpenRouter/Codex/GitHub credentials and token/private-key patterns. Private configs, runtime data, caches, logs and screenshots stay ignored.

The live bot remains logged out/stopped. Acceptance used only separately leased loopback fixtures; Jake's client, live server and world were untouched. All three worker branches/worktrees remain available for review.
