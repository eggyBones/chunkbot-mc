# V1 research and implementation gates

Researched: 2026-10-04. Owner: Codex. These findings support the [V1 architecture](v1-architecture-plan.md); they are not application delivery evidence. Recheck alpha APIs, prices, releases, and installed capabilities when implementation starts.

## Findings supported by primary sources

**Java control is feasible through an existing bot library.** Mineflayer exposes Java player connection, chat, inventory, entities, blocks, digging, and crafting APIs. Its current README lists a broad version range, but that does not prove a particular server/pathfinder combination works. Microsoft and explicitly selected offline auth routes are documented. [Mineflayer README](https://github.com/PrismarineJS/mineflayer), [official API source](https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/docs/api.md).

**Visibility needs an application boundary.** Mineflayer's block searches read loaded world data; filtering is required before model exposure. The API includes visibility/reach helpers and digging/control-stop methods. A dig may be interrupted, so block break and inventory pickup need independent evidence. The proposed line-of-sight policy is a design decision, not a claim of exact human camera perception. [Mineflayer API](https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/docs/api.md).

**Pathfinding defaults need deliberate restriction.** The documented movement configuration permits digging by default. The normal pathfinder stop waits for a movement node; clearing the goal is the documented immediate-stop path. These details motivate explicit movement policy and actuator cleanup checks. [Pathfinder API and movement options](https://raw.githubusercontent.com/PrismarineJS/mineflayer-pathfinder/master/readme.md).

**General planning needs recipe knowledge before prerequisites exist.** Mineflayer's currently craftable recipe query is inventory-dependent, and its broader query still filters recipes requiring a table when no table is supplied. The underlying recipe library exposes ingredients, outputs, and table requirements. The knowledge adapter must distinguish what is possible after gathering/setup from what is executable now. [Crafting implementation](https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/lib/plugins/craft.js), [recipe library](https://github.com/PrismarineJS/prismarine-recipe).

**Player interaction APIs cover the proposed general mechanisms.** The official API includes crafting, furnace input/fuel/output state, container transfer, placement/use, equipment, and entity events. Availability does not establish safe cancellation or server-confirmed results; those remain live capability gates. [Mineflayer API](https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/docs/api.md).

**Jev selects finite decisions.** OpenRouter documents an alpha decisions endpoint, choice questions with criteria, a returned choice/distribution/confidence, and provider/model/usage metadata. It takes textual/structured state; it is not a visual controller or script generator. The request's question key is bookkeeping, so the instruction must contain the complete question. Raw HTTP and SDK envelopes need separate verification. [OpenRouter Jev guide](https://openrouter.ai/blog/insights/what-is-jev/), [TypeSafe API reference](https://docs.typesafe.ai/api).

**The initial Jev model can be pinned.** OpenRouter currently lists `typesafe/jev-1.13`, a 32k context window, and input pricing of $0.042 per million tokens with no output-token charge. Use the exact returned model and reported usage/cost in evidence. These are dated provider facts, not guaranteed local latency or future prices. [OpenRouter model page](https://openrouter.ai/typesafe/jev-1.13).

For scale only: 2,000 input tokens once per second for one hour is 7.2 million input tokens, approximately $0.30 at that listed input price. This arithmetic excludes other charges and does not estimate actual Chunkbot usage. The planned event-driven loop should call less often when state is stable; Codex subscription turns have separate limits.

**A local Codex subscription route exists.** Official Codex auth documentation distinguishes ChatGPT subscription sign-in from API-key billing. Codex exposes programmatic integrations and noninteractive structured output. This supports investigating a local gameplay-planner adapter, without assuming general API credits or account-specific entitlement. [Authentication](https://learn.chatgpt.com/docs/auth), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

The supported app-server provides a more extensive lifecycle/account surface if the smaller CLI adapter cannot meet isolation/cancellation needs. Its installed protocol must be inspected before use. Separate Sign in with ChatGPT plan-usage integrations also exist, but are not necessary to assume for the initial managed Codex route. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [plan-usage app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

**Node.js 24 is a maintained baseline.** The release table lists Node 24 as LTS. This is the proposed application baseline, subject to installed dependency compatibility. [Node.js release table](https://nodejs.org/en/about/previous-releases).

## Planning-time local observations, separate from source claims

The following observations describe the original planning-only task, before Jake authorized implementation. Current gate evidence follows below.

- The project directory contains the standing workflow and repository instructions, now extended with these plans. It is not a Git repository; Git was not initialized.
- Read-only commands found `/opt/homebrew/bin/codex`, version `0.160.0`, and ChatGPT sign-in status.
- Installed CLI help supports structured-output and ephemeral noninteractive runs. No gameplay planner prompt, account/model entitlement test, or tool-isolation probe was run.
- No Chunkbot package/dependencies, Minecraft connection, Jev request, DSH worker, or running application was established by this planning task. Local DSH and Minecraft runtime state were not inspected; this is not a claim that they are absent or idle.

## Prior art and alternatives

[JevCraft](https://github.com/nthclrd/jevcraft) is a directly relevant source project combining a planning LLM, Jev decisions, and Mineflayer. Its architecture is useful evidence that these pieces have been explored together. Its README claims are not independently verified behavior, and it is not a dependency or acceptance shortcut for Chunkbot. Inspect licensing and exact code before any deliberate reuse.

OpenAI's DevDay announcement describes a Decisions API as another finite-answer model interface. It remains a deferred adapter option; Jev is Jake's V1 selection, and access to that API through his subscription has not been established. [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/).

A screenshot/keyboard Minecraft client would require visual perception and a different control stack. Jake selected bot-library control with player-like visibility, so V1 uses bounded symbolic observations and reliable game skills. The proposed skill catalog supports model-chosen combinations of player mechanisms. Existing frameworks may contain useful ideas, but a canned resource progression does not establish open-ended goal planning.

## Bounded gates

Run probes only when implementation/setup is assigned. Record question, exact method, result, and resulting decision under the responsible plan and supervision checkpoint. Do not repeatedly research a settled capability.

| Gate / owner plan | Question | Bounded probe | Decision it resolves |
| --- | --- | --- | --- |
| G-00 / MB-V1-00 | Can local DSH execute Claude Code Opus 5.5 through Jake's subscription? | Inspect actual integration SDK/model resolution, auth route, workspace and permissions; one separate smoke conversation plus read-only tool turn | Verified local worker configuration, or exact missing setup/login/model prerequisite |
| G-01 / MB-V1-01 | Which exact Java/version/library combination works in the intended test world? | Inspect Jake's target version/auth, choose pinned packages, then join and run a short movement/dig/pickup/disconnect smoke in a separate test area | Supported V1 compatibility profile and any bot-account prerequisite |
| G-02 / MB-V1-03 | Does this OpenRouter account/model support the documented decisions wire format? | One tiny real choice request; capture redacted raw shape/model/usage/status; validate fixture | Adapter schema, pinned model, cost accounting, or exact account/alpha-access blocker |
| G-03 / MB-V1-04 | Can the local subscription route produce isolated, bounded gameplay plans? | One small strict-schema turn; inspect route/model/config/instruction sources/tools; cancel an app-owned probe; compare supported app-server only if CLI is insufficient | Transport, model/effort, isolation and cleanup settings, observed latency, or exact unsupported capability |
| G-04 / MB-V1-02 | Can observations honor the declared line-of-sight boundary? | Visible/behind-wall blocks, entities and drops in a tiny controlled scene; inspect snapshots/candidates | Installed visibility implementation and honest documented perception limits |
| G-05 / MB-V1-02 | Can general skills execute, verify effects, and stop safely? | Conservative navigation plus representative mining/crafting/placement/furnace/interface operations; cancel/replace and inspect late subcommands/cleanup | Actual capability coverage, server-confirmed predicates, interaction leases, and measured cleanup |
| G-06 / MB-V1-02 and MB-V1-04 | Can the planner discover prerequisites without item-specific goal scripts? | Query a tool/armor recipe while ingredients/table are absent; check harvest/fuel/output rules; compare resource plans with empty versus prepared inventory | Knowledge source/coverage, prerequisites exposed to the LLM, and proof that task decomposition is model-owned |

G-01's first join belongs to foundation; its full physics slice is completed in MB-V1-02 before real model-driven play. Independent fixtures, schemas, and diagnostics continue if access to a live provider/world is missing. A failed gate does not authorize changing Jake's provider/player decisions.

## Product clarification

Jake explicitly clarified that log/follow/armor examples are illustrations, not hardcoded user goals. V1 must accept broad instructions, let the LLM generate smaller steps, and let Jev choose the next action within those steps. The skill catalog, recipe knowledge, exploration, and extensible outcome contracts implement that distinction. Crafting and armor are included through general mechanisms; no goal-category whitelist is planned.

## Current implementation gates

Updated during authorized implementation on 2026-10-04. [Supervision](agent-supervision.md) records the live assignment and runtime.

| Gate | Current evidence / remaining work |
| --- | --- |
| G-00 | Accepted: local DSH native Claude subscription route resolves to Opus 5.5, with high effort/full access; coordinator continuation and native tools verified. |
| G-01 | Foundation join/version/lifecycle accepted against the separate vanilla 26.1.2 fixture. Movement/dig/pickup are accepted with MB-V1-02. Jake's eventual shared-play server and Microsoft bot-account details remain pending. |
| G-02 | [Real account/wire probe passed](reviews/g-02-jev-wire.md): pinned Jev, raw HTTP shape, actual model and usage/cost captured. Application controller and real skill choices remain MB-V1-03 work. |
| G-03 | [Subscription transport/isolation/cancellation probe passed](reviews/g-03-codex-transport.md). Selected model identity is distinguished from server-resolved identity, which the CLI stream does not echo. [Production planner and real gameplay acceptance](reviews/mb-v1-04-coordinator-review.md) passed MB-V1-04; final delivery remains MB-V1-05. |
| G-04 / G-05 | Assigned to the active MB-V1-02 worker; no acceptance claimed yet. |
| G-06 | Exact26.1.2 knowledge is accepted with MB-V1-02; model-owned prerequisites and differing real empty/prepared plans are accepted with MB-V1-04. |

The separate local fixture lets ready implementation continue while final connection details are pending. Real Codex/Jev/Minecraft goals are accepted with MB-V1-04; final varied delivery remains MB-V1-05.
