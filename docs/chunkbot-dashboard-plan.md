# MB-UI-001 — Local Chunkbot dashboard for a second monitor

Reported: 2026-10-06. Status: **Implemented by native Opus 5.5 and integrated in [batch001](feature-batch-001-plan.md); final coordinator acceptance in progress.**
Parent: [companion upgrades](companion-upgrades-plan.md).

### MB-UI-001-C8 — Peaceful health-change sampling acceptance

Reported 2026-10-06 09:04 UTC; coordinator investigation/native harness correction assigned. Final combined build `dd51a4c` passed memory 13/13 and handoff 9/9 on both fixtures. Dashboard runs `09-00-12-961Z-dashboard` and `09-00-13-966Z-26.2-dashboard` passed 12/13; only D2-health timed out. Both RCON commands reported applying 3 damage, and after the assertion waits both server and dashboard correctly read 20. The assertion requires a published sample <=17 despite its stated allowance of one Peaceful regeneration step and the 2 Hz publisher. Hypothesis: an 18 HP sample is missed by that threshold; this is not yet a reproduced packet fact. Inspect the assertion and actual health source, preserve the sub-second command-to-file/SSE requirement, record baseline/server truth and changed samples, and compare within the admitted regeneration tolerance. Never turn a static/full-health sample into a pass. No production behavior change or fixture access is assigned to the worker. Coordinator reruns the corrected check under the existing exclusive leases; original failures remain evidence.

## Outcome and happy path

Jake starts a small local dashboard, opens it on a second monitor and watches Chunkbot while playing. It shows hearts/health, inventory, levels, current directive/task, gameplay token usage and OpenRouter spend. It remains useful when Chunkbot is offline by clearly distinguishing the last known state from live state.

Confirmed: local dashboard and the listed information. Jake additionally requested remaining Codex subscription usage if a straightforward supported integration is available. Coordinator defaults: one bot, read-only initial delivery, loopback binding on this Mac, and a compact display suited to leaving open during Minecraft.

## Scope and proposed state contract

A bounded application-owned status projection includes:
- Bot name, connection state, world profile/dimension, connection epoch and update time.
- Current/max health, hunger, equipment, XP level and fractional progress when actually available.
- Slot-based inventory with item name/count, selected hotbar slot and equipment. Distinguish inventory from an open container.
- Owner versus progression mode, paused/recovering/blocked state, top-level directive, active task and verified recent result.
- With [MB-FLOW-003](survival-routines-plan.md), show the active survival routine and reason, recovery phase/attempt, death location with source/freshness, verified regained versus missing/unknown belongings and blockers. Keep the interrupted owner directive visible; reading the dashboard cannot start recovery.
- Pending handoff/next preparation, clarification and its reference, exact blocker or terminal reason.
- Run/logical-session identity, model adapter readiness, Jev input/output tokens and verified USD charges, and Codex planner token/turn usage with coverage/freshness.
- Local session budget remaining, retained ambiguous charges and in-flight reservations as distinct values. Optional backend-fetched OpenRouter key/account and Codex quota snapshots have explicit source, scope, update time and unavailable/stale state.
- Home/project/memory summaries and owner locator direction after their respective features are delivered, with provenance and freshness.

Display server-backed values when available and label client estimates, unknown values and stale readings. Do not convert an unknown level to zero, stale inventory to current stock, or an interpreted goal to completed work. Health display uses the actual maximum when known.

No model private reasoning, auth material, unrelated player positions/chat, world edits or gameplay command injection. Remote hosting, public exposure, authentication/multi-user roles, map renderer, inventory editing and a command console are separate expansions.

## Token usage, OpenRouter spend and optional Codex allowance

These additions belong to MB-UI-001; the dashboard remains a read-only observer.

### OpenRouter gameplay usage

- Show validated Jev input/output token totals, request/attempt counts and actual reported USD cost for the current session, plus bounded daily/recorded-history totals. Label history coverage and timezone; “recorded since” does not imply all account lifetime usage.
- src/decision/wire.ts already validates tokens/cost; JevDecisionAdapter records validated choices and charge outcomes, and SpendLedger.snapshot exposes reconciled, retained, outstanding and remaining amounts. Build a typed event projection from those sources, not a regex over terminal prose. Count retries and failed-but-charged attempts, deduplicate request/reservation identities and preserve known usage even when an action is rejected.
- Separate **confirmed charges**, **uncertain maximum retained**, **pending reservation** and **available local cap**. A timed-out request does not have a known exact token count or a zero-dollar cost. The conservative cap is application accounting, not the OpenRouter wallet balance.
- Use sufficient precision for tiny Jev costs rather than rounding everything to $0.00. Show missing token/cost fields as unknown; do not substitute estimated price multiplication for provider-reported charges or change the validated provider/pricing route.
- Keep compact versioned aggregate history outside release directories, under ignored runtime storage. Run journals are bounded/pruned, so they cannot be the sole lifetime ledger. Corrupt/incomplete telemetry must show incomplete coverage and cannot replenish the real spending allowance. Integrate session continuity with MB-OPS-001 without making dashboard aggregation the authority that permits spending.
- Optional API-key overview uses the backend's existing environment-supplied credential and a bounded cached GET /api/v1/key. Its daily/weekly/monthly usage and key allowance may include other tools using the same key; label it accordingly. A null limit means no reported key cap, not infinite wallet credit. [OpenRouter current-key documentation](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).
- Account wallet balance is a separate optional integration: the documented credits endpoint currently requires a management key. Do not obtain/store broader credentials merely to finish local token/spend reporting; show unavailable or link the operator to OpenRouter when that access is absent. [OpenRouter credits documentation](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

[OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) describes response tokens and charges. Chunkbot uses the distinct pinned Decisions wire, so add only fields it actually exposes; do not assume every chat-completion/cache/generation feature applies to Jev.

### Codex planner usage and remaining allowance

- Display this application's observed planner turns, completed/failed turns and input/output token totals from CodexPlanner.totals and the validated transport. Cached input and reasoning counts are breakdowns when present; verify subset semantics before calculating totals so they are not counted twice. Missing/cancelled-turn usage is unknown. Subscription activity is labeled as subscription usage, without an invented API dollar bill.
- Current official documentation exposes account/rateLimits/read with quota-window usedPercent, windowDurationMins and resetsAt, including primary/secondary and optional named buckets. A compatible adapter can show the corresponding remaining percentage and reset time. These are account-wide allowances, not tokens reserved for Chunkbot. [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- Treat this adapter as optional pending D-G4: the planner pins CLI 0.160.0 and a specific managed ChatGPT login/isolation profile. Documentation for the current app-server does not prove that the pinned binary/account exposes the same schema. No harness upgrade, account switch, API-key fallback or undocumented quota scraping belongs to this dashboard assignment.
- Fetch account metadata through a separate read-only operator adapter under the same proven account scope. Do not broaden the gameplay planner's allowed JSONL events/tools, start a thread/turn, expose account tokens to it or copy auth into browser state. Restrict the observer to initialization/account reads and quota notifications; it never logs in/out, purchases credits, consumes quota-reset credits or changes settings.
- Render only windows/buckets actually returned; do not invent a fixed message/token allowance or conflate remaining model context with subscription quota. Unknown/auth-required/unsupported reads display “Remaining Codex allowance unavailable” with last-check time, while observed Chunkbot usage still works. Account-wide activity may change because Jake uses Codex elsewhere.

Coordinator polling defaults for optional remote metadata: one shared backend fetch at most once per 60 seconds, a bounded timeout/backoff, and a stale badge after five minutes without a successful refresh. Multiple tabs/manual refreshes coalesce; reopening the viewer cannot trigger inference, turn loops or credential lookups. Local gameplay state retains its faster update target. Serve only normalized non-sensitive metrics; never raw auth/key/account envelopes, key labels, headers, prompts or private reasoning.

## Operating and persistence behavior

Coordinator proposal: a separately launched local viewer/service can run while Chunkbot is stopped. Chunkbot publishes an atomic, versioned, redacted status snapshot with heartbeat; the viewer serves it and a bounded live update stream. Choose the actual file/socket/HTTP transport in the research gate.

- Initial/empty: “No Chunkbot session yet,” not a fake live inventory.
- Loading: show connection and wait for the first valid snapshot without resetting last known facts to invented defaults.
- Live: aim for at least two updates per second for changing health/task/inventory, with throttling and batching.
- Offline/stale: explicit disconnected or missed-heartbeat badge and last update timestamp. Preserve last known values as historical; a killed process cannot leave a permanent green live indicator.
- Rejoin: discard transient references and resync authoritative state for the new connection epoch. Inventory reset/death/dimension changes cannot mingle old and new sessions.
- Publishing must not call a model, select a game action, acquire an actuator lease or open/resync interfaces just for a browser. Multiple tabs cannot multiply game/model activity.
- Correlated inventory updates should use existing evidence, not synthetic success. Pending interface actions may be shown as pending until server sync.
- Closing the dashboard stops only its own listener/stream; it does not stop Chunkbot or Minecraft. Chunkbot logout does not require closing the dashboard.
- Bind to loopback by default; use a selected free port and give a usable error if occupied. A Tailscale-hosted bot backend is a separately scoped option.
- Persist only the bounded public status snapshot/settings needed for the viewer. Reuse redaction and retention principles; do not expose raw run directories as a file server.

## Seams and bounded research gates

Inspect src/app/status.ts, src/app/app.ts, src/app/skill-runtime.ts, src/game/server-evidence.ts, src/game/connection.ts, src/perception/perception.ts, src/goals/goal-engine.ts, src/decision/wire.ts, src/decision/jev-adapter.ts, src/decision/spend.ts, src/planner/codex-planner.ts, src/planner/transport.ts, src/planner/codex-cli.ts, src/telemetry/run-store.ts, src/telemetry/planner-journal.ts, redaction and CLI/config composition.

The existing textual StatusInput is not a complete dashboard contract: XP, per-slot inventory and operating/preparation mode need explicit fields. Avoid parsing terminal prose or tailing unbounded raw logs as the sole state source.

Proposed ownership: dashboard status projection, local server/viewer assets, tests and operator documentation. Codex coordinates shared status schemas, CLI/config/package changes and app publishing. No visual redesign of other operator flows is required.

Gate D-G1: map health/max-health, XP level/progress, slot inventory/equipment and lifecycle events in the installed 26.2 libraries/evidence. Verify data provenance in an assigned fixture probe and define unknown/stale semantics.

Gate D-G2: compare a minimal local HTTP/SSE service reading atomic snapshots with an application-owned live endpoint plus an offline viewer. Select the smallest option supporting offline display, bounded updates, clean shutdown and a simple operator command; avoid introducing a framework/service solely for charts.

Gate D-G3: can the current Decisions and planner events produce complete, deduplicated token/spend rollups, including failed/aborted attempts and usage missing from a cancelled turn? Test ledger/event boundaries with fault providers, reset/restart/retention and tiny amounts. Set aggregate persistence, precision and coverage fields; optional account metadata must remain separate from the local spending authority.

Gate D-G4: does the pinned Codex CLI support the documented read-only quota protocol under the same managed ChatGPT account without weakening planner isolation or starting inference? Inspect its supported schema and run a bounded coordinator read during the assigned implementation. Verify bucket/model/account scope. If unsupported, report the evidence and ship an honest unavailable state alongside the core usage display; no incidental CLI upgrade or blocked dashboard delivery.

## Milestones and acceptance tests

| ID | Milestone / observable acceptance |
| --- | --- |
| D1 | Owner can start the viewer with a documented real command, open the local URL and read health, hunger, levels, inventory and task without inspecting logs. |
| D2 | Fixture health/XP/inventory/equipment changes reach the screen within one second under normal load; item counts/slots match server evidence and max-health display is correct. |
| D3 | Planning/executing/pending/clarifying/paused/blocked/completed states are distinct. Old-task continuation while a new draft loads is understandable; “next” does not imply it has started. When survival routines are integrated, their reason/recovery phase and interrupted owner intent remain distinguishable from goal completion. |
| D4 | Offline start, app crash, graceful logout, death/rejoin and stale/out-of-order updates never show old data as live. A new epoch replaces previous transient state. |
| D5 | No Chunkbot/model/actuator calls are introduced by viewing or refreshing. Multiple tabs use bounded resources. Closing the viewer leaves Chunkbot's process and server connection intact. |
| D6 | Local binding, occupied port, malformed status, redaction and shutdown are tested. No authentication token, API key or private reasoning appears in served state or error output. |
| D7 | Visual review at ordinary desktop and second-monitor sizes confirms readable hearts, inventory and directive with clear loading/empty/error states. Integrate real Chunkbot state rather than a static mock. |
| D8 | Known Jev/planner token/cost events produce exact session and dated aggregates. Tiny charges remain visible; retries, charged failures and duplicated/out-of-order events neither disappear nor double-count. Missing usage stays unknown. |
| D9 | A timed-out/aborted charge and an in-flight call display retained/pending amounts separately from confirmed spend and local remaining budget. Stop, restart, update/rollback and run-log pruning preserve correct coverage/history without resetting the spending cap. |
| D10 | Optional key/account/quota metadata is labeled with actual scope and timestamp. Returned Codex windows show remaining percentages/reset times; absent/auth-required/unsupported/stale data does not become a false zero or full allowance. Shared polling causes no inference or per-tab request multiplication. |
| D11 | Coordinator proves the supported Codex quota read under the pinned profile, or records its concrete unavailability and verifies the fallback. Core local token/OpenRouter-spend display is delivered either way, without exposing credentials or broadening gameplay tools. |

Run typecheck/build/test and doctor when app/CLI/config is touched. Run connection/lifecycle checks for publishing integration; skill checks if inventory/evidence paths change. Browser validation uses T3's collaborative preview when implementation is assigned. Add focused state-projection, stream/lifecycle and meaningful browser checks; a new test command must be implemented/documented before being required.

## Coordinator gate D-G4 — 2026-10-06

The installed CLI0.160.0 generated the documented account/rateLimits/read schema. A bounded coordinator probe under the same proven managed ChatGPT/file credential store sent only initialize, initialized, account/read with refreshToken:false, and account/rateLimits/read with reset-credit details excluded and reserve fallback disabled. It returned a codex primary quota window; no secondary window was fabricated. No thread, inference turn, login/logout or reset-credit consumption occurred. Raw account/auth envelopes were discarded; normalized source/scope/window/time evidence is under ignored var/batch001/codex-quota-proof.json. [Official protocol](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

The optional observer may use this supported route with bounded/coalesced polling and strict normalization; runtime auth/version/transport failures still display unavailable. Account-wide remaining percentage is observational and cannot authorize spending, model fallback or resumption. The feature worker receives the decision; adapter/browser acceptance remains pending.

## Review findings before acceptance — 2026-10-06

- **MB-UI-001-C1 (missing usage):** existing planner transport emits four zero counters when turn.completed contains no usage. Coordinator fault-only probe reproduces this; no inference occurred. Required correction: absent/invalid core usage stays null/unknown, missing cached/reasoning breakdowns stay unknown, and aggregates carry coverage without double-counting subsets.
- **MB-UI-001-C2 (history bounds/atomic aggregation):** at publisher milestone e218b15, 44 ordinary retained runs with512 event identities each produce1,069,568bytes; readHistory rejects that writer-produced file as too_large. A separate probe sees persisted ledger cursor20,000nanoUSD while the corresponding dated charge is still0 between setCursor and rollup mutation. Required correction: prune to the serialized reader bound with honest coverage, and commit cursor plus dated delta together. Known historical sums must not be discarded by an avoidable oversize reset. Evidence: ignored var/batch001/usage-review-proof.json.
- **MB-UI-001-C3 (charged-failure usage):** Jev wire validation can return trusted token/cost usage for a rejected answer, but the adapter discards those tokens before the failure event. D8 requires known usage to survive rejection. Add a whitelisted typed trusted-usage field; keep model/provider/pricing, reconciliation and rejection behavior unchanged. Dashboard must distinguish a validated response from a charged failure with known tokens.

These are observed source/probe findings within dashboard acceptance, not accepted feature behavior. The shared writer owns transport/decision hooks; the dashboard worker owns projection/history corrections and meaningful regression cases.

## Remaining delivery

Core status/usage publishing, bounded history, local viewer, honest offline state, supported quota/key reads and operator commands are installed. T3 actual-data review passes desktop/mobile layout, precise charges, bars and memory rendering. [Independent integration review](reviews/mb-batch001-coordinator-review.md) records results. C8 requires the final root health-sampling rerun before acceptance closes; automatic survival/update UI consumers remain conditional on their unassigned features.

### Real browser review — 2026-10-06T08:36:31.333132+00:00

Root's real Codex/Jev H7 trial on 26.2 completed two goal windows with both requested outputs independently confirmed by RCON, zero assistance. The lookahead was used (gap 1,936 ms, fresh revalidation 16 ms); one counted repair was honest. Evidence: `var/batch001/real-h7-26-2/report.json`. A journal counter-label error in the coordinator runner is being corrected from actual `goal_window` events; the terminal already records two windows.

A new T3 tab (`tab_8`) successfully captured the actual integrated dashboard at 1280×800, unlike the earlier tab's generic capture failures. Image inspected: `/Users/jakewilcox/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-muwfaft0-78498110.png`. **MB-UI-001-C4:** XP and quota fills use inline style attributes rejected by the server's `style-src 'self'` CSP on every refresh; XP 0% visibly shows a full green bar. **MB-UI-001-C5:** the confirmed tiny charge is horizontally clipped in its narrow three-column card; exact amount must be readable. Root resumes the UI owner for bounded browser/CSP/readability corrections and human-readable outcome summaries. Full screenshot evidence and served metadata stay ignored; no credential/auth contents were captured.

### Dashboard integrated-contract correction MB-UI-001-C6

Root merged reviewed `98bb0104b29701482732be3bdf5d6f99912d77bb` in source (the running gate build remains frozen), then ran `npm run typecheck`: exit 1, TS2366 at `src/dashboard/outcome-text.ts:27` and `:44`. The generic renderer was compiled on the UI-only branch and omits the integrated `memory_ref` selector and `memory_state` predicate. A memory goal would otherwise describe its condition as undefined. Authorize the UI owner to merge exact reviewed H dependency `88089893` (no shared edits), handle these variants truthfully in NEW renderer/tests, and check the combined types. Evidence: `var/batch001/ui-integrated-typecheck.log`.

### Real memory/browser acceptance (2026-10-06 08:48 UTC)

Final isolated-copy build at `a8b47cfbcac9e6922939586712744402b9379bc0`: check 483/483, exit 0. Real M6 on 26.1.2 passed: two actual CLI processes, durable home/chest recall, no replay, a shown memory_ref accepted, fresh inspect before withdrawal, four planks consumed, crafted table server-confirmed at205,-60,206 beside home; code verified3/3 conditions, zero assistance. Three memory views, max3,887chars. Recorded setup includes fixture max-health24 and XP level4/12points for browser observation; original health cap read/restored in teardown. `var/batch001/real-m6-26-1-2/report.json`.

T3 actual browser screenshot `/Users/jakewilcox/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-muwfr7d9-d6125e71.png`: live24/24health (12 hearts), hunger20, level4, XP80%; DOM fill228.60/286px equals80%; returned quota58% fill195.9/338px, exact charge$0.000229992 readable, no console CSP errors. T3 recording still fails generically (no video claimed). **MB-UI-001-C7**: the Memory panel uses a global max-content label column; long natural-language milestone labels leave metadata only~36px at1280px. UI owner will make memory rows responsive/readable without changing data or runtime hooks; root retests real state at desktop/mobile widths.
