# MB-V1-05 — Open-ended hybrid gameplay acceptance and delivery

Created/updated: 2026-10-04. Status: **Planned; unassigned.** Depends on MB-V1-01 through MB-V1-04. Read [architecture](v1-architecture-plan.md), [contracts](v1-contracts.md), and [supervision](agent-supervision.md).

Acceptance refinement recorded 2026-10-06 Arizona: Jake requires **no follow-up questions**. [MB-PLAN-006](v1-planner-plan.md#mb-plan-006--act-without-follow-up-questions) supersedes the old clarification-based product criteria. Far-follow/water/recovery additions in [the live gameplay intake](live-gameplay-fixes-plan.md) need their own module and real ordinary-goal evidence; none is accepted or assigned by this plan update. The installed accepted release still has its previous clarification behavior.

## Outcome and scope

Jake can launch Chunkbot, give differing natural-language goals, and see the Codex subscription planner decide prerequisites/steps while Jev chooses grounded actions and Minecraft code verifies results. Stop remains responsive. The app reports real completion, partial progress, missing information/capability, or bounded failure.

Acceptance tests use examples to demonstrate generality. A logs/follow-only bot or switch statement for the test phrases does not satisfy V1. Ordinary combinations of installed capabilities must work without another intent handler or code change.

Proposed owned paths: `src/app/`, `src/goals/`, integration tests, README/config examples, and `docs/reviews/`. Codex coordinates catalog/provider corrections and shared contracts/manifests.

## Integrated behavior

One goal engine handles natural-language intake, reasonable grounded interpretation, accepted outcome contract, knowledge queries, rolling task windows, Jev decisions, execution leases, predicates, recovery, and limits. Both chat and terminal use it. Stop/status bypass providers. The target MB-PLAN-006 policy refuses owner-facing clarification and uses bounded repair or declarative blockers.

Idle is quiet, active planning/repair is stationary, and execution reports verified progress. Safe current work may continue during handoff preparation. No goal waits for a solicited owner answer. Task completion is distinct from goal completion. Persistent behaviors remain active. Exhausting a plan window requests continuation; missing ingredients/tools produce prerequisite feedback rather than a scripted resource handler.

Explicit planned mining/placement/interaction can change the world. Navigation must not modify it silently. Hidden resources/player positions cannot become targets through protocol-data shortcuts. A lost owner can use a remembered waypoint, but an owner-proximity outcome requires actual owner observation.

Stop/replacement/death/disconnect/world change clears ownership and interfaces. Late results and old cleanup cannot affect replacements. Restart/respawn stays idle. Partial inventory/world effects persist and are reported honestly.

## Milestones and acceptance

1. **V1-1 — Real launch/control.** Launch the built artifact from README, verify owner admission and chat/terminal controls. Record actual versions, route/model identity, catalog version, and launch/check commands.
2. **V1-2 — Varied real goals.** Execute movement, resource acquisition with prerequisites, exact-item crafting/smelting, and an armor/equipment example in a controlled survival fixture. Use real Codex and Jev, verifying outcome predicates and recording interventions.
3. **V1-3 — Generality.** Repeat the resource goal with different inventory/world prerequisites and confirm a materially different valid plan. Choose a new composition of existing skills without changing code/prompts for that phrase. Inspect source for intent-specific demo handlers.
4. **V1-4 — Recovery/interruption.** Change/remove a target or prerequisite, verify outcome-preserving replanning, and stop during each provider/skill family. Meet the control-clear target and verify lease/interface cleanup.
5. **V1-5 — Delivery.** Document actual supported capabilities, gaps, limits, interpretations, and operator instructions. Independently verify running behavior and reconcile plans/evidence.

## Example scenarios and evidence

These are a representative suite; they do not define the allowed command language.

| Scenario | Surface | Required outcome/evidence |
| --- | --- | --- |
| “Come here” and “follow me” | Real world + real models | Correct finite versus persistent interpretation; observed owner target; movement/stop |
| “Collect cobblestone” from empty inventory | Controlled survival world + real models | Planner-chosen wood/tool/workstation prerequisites and actual new cobblestone; quantity interpretation shown |
| Same resource goal with a suitable tool already owned | Real world | Different plan omits unnecessary prerequisites and uses existing inventory correctly |
| “Get four stone blocks” without Silk Touch | Real world with accessible resources | Stone items verified; valid mining/fuel/furnace/smelting steps rather than confusing cobblestone |
| “Make and equip an iron helmet” with suitable ingredients available | Real world | Queried recipe, workstation if needed, crafted helmet, observed equipment slot |
| Resource not initially visible | Controlled world | Bounded survey/exploration finds it or reports actual resource/path limit; no hidden-world shortcut |
| New composition chosen at acceptance, e.g. two item goals then return | Real models/world; no code changes | New task window/predicates composed from catalog, all requested outputs preserved |
| Already-owned items, ingredient consumption, full inventory | World + fixtures | Acquisition/possession/final-output baselines and space handling are correct |
| Ambiguous quantity/output/destination and nearby deictic targets | Real planner + policy/grounding fault fixtures | Reasonable grounded assumption and action, or one precise declarative blocker; zero follow-up/confirmation questions or answer waits |
| Unsupported mechanic/capability | Catalog/provider fixture | Exact missing capability; no keyword-based blanket rejection or false success |
| Removed target/missing tool/workstation/recipe change | Controlled world + fixtures | Revalidation and grounded replan preserve the original goal |
| Stop during navigation/mining/crafting/furnace waiting | Real world | Prompt control clear, closed interfaces, accurate partial effects |
| Stop/replacement during either provider | Delayed fixtures + real transport cancel probe | Stale response ignored and old cleanup cannot stop new work |
| Stable follow/processing/blocked wait | Real world + call counter | Healthy waiting, no false no-progress failure, unanswered question or repeated inference |
| Hidden target/other-player/spoofed chat | World + identity fixtures | No hidden observation or unauthorized goal/model call |
| Bad schema/unknown skill/invalid selector/impossible recipe | Provider/catalog fixtures | Rejected before action, bounded repair/replan |
| Timeout/auth/payment/quota/model errors | Provider fixtures | Bounded handling, honest usage reservation, no planner billing fallback |
| Death/disconnect/dimension change/restart | Safe lifecycle checks + fixtures | Handles invalidated, control released, restart idle |
| Turn/request/task/deadline/cost limits | Fake clock/provider | Bounded work, preserved progress, honest terminal reason |

Do not count intervened runs as autonomous success. Complete at least three autonomous resource trials across differing prerequisites, plus the other required scenario families. Record planner proposals/revisions, real Jev requests/choices, skill results, and final predicates rather than test counts alone.

Use a separate fixture with accessible resources for repeatability. Do not break Jake's live auth/profile or alter his live world to simulate faults. Representative mechanic tests are enough; no exhaustive audit of every Minecraft item is required.

## Checks and delivery evidence

Run actual build/typecheck, affected tests, and doctor after final changes with direct exit statuses. Live checks must use the intended built artifact. Record source versus built versus running state and repeat checks only when changes/findings justify it.

Create `docs/reviews/v1-delivery.md` with acceptance IDs, exact commands/statuses, model/routes/catalog/compatibility, interpreted goals and task evidence, intervention counts, cancellation timing, actual supported skills/predicates, and remaining gaps. Redact secrets/account identifiers/private reasoning.

Codex independently inspects entry-point wiring, general task construction, catalog use, prerequisite handling, predicates, cancellation, and real provider evidence. Correct consolidated findings through the assigned worker, then recheck current files and relevant live behavior.

Update [roadmap](../feature-plans.md) and [supervision](agent-supervision.md). Distinguish implemented, locally verified, built, running-verified, and committed/reconciled. This plan does not imply a commit/push.

Remaining evidence: every integrated milestone. Foundation and local fixture are accepted, but model-driven gameplay is not delivered yet; broad planning must not be claimed from a canned demonstration.

## Offline assignment authorization — 2026-10-13 Arizona

Status: **authorized / preparing; not accepted; no worker launched.** Jake starts only the scopes below using native local DSH preset `relay-codex`, existing `codex:codex-default` ChatGPT subscription, exactly `gpt-6.1-sol` / `xhigh` / `danger-full-access` / approval `never`. The current CLI 0.162.1 read-only native gate passed; gameplay planner configuration and all historical evidence remain unchanged. Source implementation/entry-point wiring is authorized for the later coordinator-launched workers, while this preparation performs coordination documents/worktrees/dependency installs only. No live deployment/join is authorized; all fixture leases are **ABSENT**. World/provider/vault/key/live-control work is coordinator-only and requires a later explicit grant.

| Prepared lane | Existing scope | Ownership / dependency |
| --- | --- | --- |
| acceptance | MB-V1-05 V1-1 through V1-5 acceptance preparation | `scripts/v1-integration-live-check.ts (new)`, `scripts/lib/v1-integration/ (new dedicated helpers)`, `tests/v1-integration-harness.test.ts (new)`; Reuse existing ordinary CLI/harness helpers through typed seams: no duplicate harness framework and no companion harness rewrites. Dedicated new helpers are thin scenario/oracle adapters. Frozen integrated artifact and approved ports are required; real inference/world acceptance waits for a named exclusive coordinator lease/key injection. |

Complete outcomes/exclusions, exact owned tests/paths and source/build/live boundaries are in [the preparation checkpoint](agent-supervision.md#offline-parallel-preparation--2026-10-13-arizona) and the ignored per-lane briefs. No shared schema/predicate/CLI/composition edit is accepted by proposal alone. Dedicated local role review: `docs/reviews/mb-20261013-<suffix>-worker.md`; acceptance instead owns `docs/reviews/mb-v1-05-20261013.md`. Coordinator approval of exact contract/companion commits precedes cross-branch imports.
