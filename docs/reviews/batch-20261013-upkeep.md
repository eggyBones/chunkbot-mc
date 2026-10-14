# Oct13 upkeep worker delivery — R6/R7

Status: owned source implemented and committed; shared integration and real acceptance remain pending. Nothing was deployed or connected to Minecraft. Jake's accepted release `64e2609` is separate.

## Checkout and native session

- Worktree: `/Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-upkeep`.
- Branch: `chunkbot/batch-20261013-upkeep`.
- Recorded initial base and initial clean HEAD: `2b9255c25e75519c06c94602d5ac60224a3c0521`.
- Reflog subsequently records an external preparation fast-forward at 2026-10-13 19:41:12 Arizona to `9ca70cbaba438033fbfd35d4097ab69339ba612d`. Those coordinator document changes are preserved. This worker did not run that merge or import a companion commit. Owned changes are measured from `9ca70cb`.
- Actual rollout metadata: native thread/session `01a13845-d904-72a2-bb36-1b352549b1b9`, originator `dsh_provider_codex`, CLI `0.162.1`, assigned cwd, model `gpt-6.1-sol`, effort `xhigh`, `danger-full-access`, approval `never`, home `/Users/jakewilcox/.codex`. The coordinator-provided initialize/account-read (`refreshToken:false`, ChatGPT/prolite)/model-list gate is account evidence; this worker did not inspect credentials or repeat it.
- Gameplay planner model/effort, CLI `0.160.0` pin, tools and isolation are unchanged.

## Focused commits and owned paths

1. `d37ddf49e9f6f6f947f9088e23ab6f6db6ec4ce2`: scoped task-context API and conservative owned-gear selection; 118 added lines across four owned paths. Published immediately with typecheck/test exits.
2. `d40c82dd835b1b3ce5ebe2823f759609b600584a`: service bindings, policies, actual skills and execution/composition tests; 796 additions/175 deletions across ten owned paths.
3. `0dd890e2231e4339b8ee0a6989e8fff684b682ae`: refuses unbound automatic furnace/equipment operations and protected implicit mining-tool selection, and clarifies rest-window evidence; 12 additions/5 deletions across three owned paths.

Source ownership: `src/survival/{upkeep,policy,service,tracker,wiring,items}.ts` and `src/skills/survival.ts`. Tests: `tests/{batch20261013-upkeep,survival-upkeep,survival-skills,survival-helpers}.ts`. This review is the only worker-edited documentation path. Common contracts, app/CLI/config, coordinator plans/supervision, manifests, lockfile and vendor inputs were not edited by this worker.

## Behavior and actual entry points

[SurvivalService.assess](../../src/survival/service.ts) remains the sole policy entry. Its proposals flow through the existing supervisor's `submitSupportTask`/`submitAutomatic` admission, `onSupportAdmitted`, TaskRuntime and the fenced executor. [SkillRuntime](../../src/app/skill-runtime.ts) already registers `survivalSkills(this.survival)` into its one registry. The new dedicated test instantiates the actual SkillRuntime without a game session or provider and verifies these capabilities in that catalog. No alternate scheduler, executor, catalog or application controller was added.

R6 food execution requires server-backed full inventory, safe ordinary food, real hunger and a current owned snapshot. It rechecks after hand selection and inventory resync; a threat arriving there prevents use. Hunger gain is claimed only from server health packets. Risky, precious, named, enchanted and unknown stacks remain excluded, including a protected duplicate of an otherwise ordinary key. The existing low-health allowance remains bound to the admitted task/owner/epochs; rest allowance now also respects configured action and TTL ceilings.

Rest checks food and threats at dispatch and during observation through the existing perception service. A goal's sustained windows share cumulative rest/no-gain budgets. A settled window without gain is labeled unconfirmed; it is never goal completion. Code still requires the configured server health threshold. Damage, loss of food, threats, cancellation, no regeneration and the finite budget end honestly.

R7 gear selection uses server durability and exact supplied harvest sets. Every potentially selected duplicate of a key must be healthy and ordinary; unknown durability is not a healthy spare. It selects an appropriate owned tool before replacement and healthy ordinary armor without overwriting protected gear. Replacement planning is finite, requests one ordinary capable tool and binds completion to the original requirement. Adding an unsuitable spare does not satisfy it. No repair/enchanting primitive was invented.

Inventory room uses a code-built task restricted to `move_to_approved_storage` and `store_surplus`. Storage is a durable active owner-designated container fact, frozen at admission. Each use rechecks that exact fact/location, goal, connection, life and dimension. Movement retains the original travel bounds and refuses incidental loot on the route. Only visible in-reach chests/barrels at that exact location can be opened. Deposits preserve tools, armor, safe food, reserves, valuables, unknown keys, protected duplicates and supplied task materials.

Resupply keeps low/high thresholds, per-reserve cooldowns, unchanged-blocker suppression, finite proposal ceilings and hourly admission caps. Non-food reserves require fresh task applicability; absent/stale context cannot trigger unrelated torch/fuel/material stockpiling. The small configured safe-food reserve retains its existing emergency policy. The approved-storage path restricts the task to movement, `inspect_approved_storage` and `withdraw_reserve`. The resolver offers only fresh inspected ordinary stock; execution reinspects it, checks raw server metadata against the correlated window, recomputes the real shortfall, and verifies both source and destination changes. It transfers one whole fitting stack per action (maximum 64); oversized sources block instead of using a split cursor stack that could over-acquire on cancellation. No items are thrown away.

Recovery incident/drop classification, regain/foreign/uncertain attribution, durable attempt authority, interrupted-outcome/baseline semantics and episode accounting remain in the existing service. The full regression suite covers those unchanged seams. This is offline evidence, not renewed real recovery acceptance.

## Exact shared integration requests

Two shared hooks are prepared but not wired by this worker, because their callers are integration-owned. No approval of companion SHAs was requested or received; none was imported.

```ts
// Both CreateSurvivalOptions and SurvivalServiceOptions accept this:
upkeepTaskContext?: () => UpkeepTaskContext | undefined;

type UpkeepTaskContext = {
  connectionEpoch: number;
  dimension: string;
  observedAtMs: number;
  harvest: { block: string; tools: string[] }[];
  retain: string[];
  reserveKeys: string[];
  requiredFreeSlots: number;
};

SurvivalService.checkUpkeepCandidate(
  fence: { goalId?: string; goalEpoch: number; connectionEpoch: number; dimension: string },
  choice: { capability: string; parameters: Record<string, unknown> },
  recipe?: { inputs: readonly string[]; outputCount: number },
): { allowed: true } | { allowed: false; reason: string; detail: string };
```

The context must describe an accepted task's actual requirements, obtained from registry/recipe facts and cleared on supersession/completion; never infer it from phrases. It is runtime-validated, same-connection/dimension, no older than five seconds, with bounded lists and space. Shared composition passes it through `createSurvivalService`; the owned wrapper already forwards it and assessment/predicates consume it. Without that callback, existing emergency/worn-tool/storage routines work, but task-specific preparation is deliberately unavailable.

Shared TaskRuntime/executor integration must call `checkUpkeepCandidate` after fresh choice revalidation and before dispatch, deriving crafting ingredient keys and output batch size from exact VersionKnowledge facts. Do not accept those facts from model parameters. That guard refuses general container/drop/pickup/use/equip/combat operations during these support goals, protected/unknown recipe ingredients, excess replacement/reserve batches, unbound furnace transfers, and general mining when its implicit tool selection could wear protected/unknown tools. Its rejection must become ordinary bounded feedback, not a retry bypass. The hook is required for acceptance of planner-driven replacement and no-storage acquisition; today those additional policy restrictions are callable and tested but not enforced by the shared caller.

No new shared schema or common capability enum is required for the registered skills: their descriptors/params feed the existing catalog. Integration can add the five owned `UPKEEP_CAPABILITIES` keys to canonical documentation/constants if desired, without creating a second registry.

## Supported blockers and limits

- No approved/durable in-bound storage: `no_designated_storage`; moved/removed/no-longer-durable approval: `storage_approval_changed`.
- Protected or task-required inventory only: `no_surplus`; unknown/correlated raw window facts absent: `window_metadata_unknown`; existing cursor: `cursor_not_empty`.
- No fitting whole reserve source: `reserve_stack_exceeds_shortfall`; no destination space: `storage_full_or_unavailable`; newly arrived stock can revoke the withdrawal as `reserve_no_longer_needed`.
- Unknown/protected duplicate gear, no valid harvest tool, unavailable regeneration, damage/threats, low health and unchanged failed conditions remain blockers rather than guard bypasses or endless restocking.
- Automatic furnace stock is not approved/bounded by the current upkeep seam. General mining with protected/unknown tools is conservatively refused by the prepared shared guard because that general skill chooses its own tool. Explicit ordinary owner work retains its existing policy. These are supported limitations, not claims that those Minecraft mechanics are absent.
- A crafting output batch exceeding the actual shortfall is refused, including rounding (e.g. five missing items with a three-item recipe would make six). No relaxed reserve threshold or invented fractional recipe is used.
- R8 beds/spawn, lighting and replanting remain outside this slice.

## Offline validation and retained failures

Every heavy command used Node 24 first in PATH and the coordinator's two-slot stdlib guard:

```text
python3 -B /Users/jakewilcox/code/repos/minecraft-buddy/var/parallel-20261013/check-slots.py \
  --cwd /Users/jakewilcox/code/worktrees/chunkbot-mc/batch-20261013-upkeep -- <argv>
```

Direct exits (no pipeline masking):

| Check | Exit / evidence |
| --- | --- |
| Milestone `npm run typecheck`; dedicated tests | 0; 3/3 |
| First implementation typecheck | 1; missing `ResolveContext` import, retained as `implementation-typecheck-1.log` |
| Corrected typecheck; affected tests | 0; 24/24 |
| Expanded execution tests | 0; 13/13, then 15/15 after additional storage cases |
| Production-entry-point test setup | 1 three times; incorrect imports, then `$comment` passed to inline parser. All logs retained. Corrected imports and production `loadConfigFile`, without weakening assertions |
| Corrected entry-point/dedicated tests | 0; 16/16 |
| Full suite before added entry-point case | 0; 1680/1680 |
| Full suite including entry-point case | 0; 1681/1681 |
| Final policy typecheck/build/dedicated/full suite | All direct exits 0; dedicated 16/16, full 1681/1681 (`typecheck-policy-final.log`, `build-policy-final.log`, `policy-entrypoint-final.log`, `full-tests-policy-final.log`) |
| Read-only doctor `config/examples/fixture.json` | 1; gameplay planner's exact CLI 0.160.0 gate rejects installed development CLI 0.162.1 |
| Read-only doctor `config/examples/fixture-26.2.json` | 1; same unchanged external pin mismatch |

Doctor keys were explicitly unset. Both confirmed config, packages, version knowledge and offline fixture identity and made no Minecraft connection or inference. Missing JRE/server files and absent scope/key warnings remain expected worker-environment observations. No pin/config/account change or fixture setup was performed to hide these failures. The unchanged doctor failure was not rerun.

All original logs remain in this worktree's ignored `var/upkeep-checks/`. Full owned and recorded-base patches, SHA-256 log manifest and source/build digests are recorded there. The additional full run after the entry-point test and final policy clarification verifies changed work; unchanged passes were not repeated as substitutes for live gates.

## Provenance and remaining acceptance

Final application source HEAD: `0dd890e2231e4339b8ee0a6989e8fff684b682ae`.

| Artifact | Files | SHA-256 |
| --- | --- | --- |
| Application source | 175 | `7333ea6c3c97d291140eb2723365a6e667067230e0294045f933f5df163f2d3b` |
| Own dist build | 350 | `4fe5182acea41882593fe0d09a619bcf948738c9809b5a5c0efa634038107a41` |
| Owned binary patch, `9ca70cb..0dd890e` | — | `410b730ef53cfce1c924f7c2a9dd7eacfc6ef94a7f106fd2c9975a21997be313` |
| Recorded-base binary patch, `2b9255c..0dd890e` (includes preserved preparation docs) | — | `d369a32e14d669f1403a1d3928dcb5f4219f6ec3f20db5f279f28f728ce18513` |

Source, build, runtime and acceptance are distinct: the above application bytes were built only here, no application run was started, and real acceptance remains pending. The deterministic tree digest hashes sorted relative path, NUL, bytes, NUL for every `src/**/*.ts` file (application) and every file under `dist/` (build). Neither digest contains credentials. Built output is this worktree's own ignored dist, not the registered playing artifact.

All fixture leases were absent throughout. No fixture/server/client/world query, connection, RCON, gameplay Codex/Jev turn, vault/key/auth-cache operation, live control, deployment, DSH change, worker launch, push/PR or merge was performed. Required real R6/R7 ordinary application acceptance, survival/recovery regressions, low-health/cancellation/safety trials and both-version fixture checks remain coordinator-owned and deferred. The current metadata gate and offline tests do not close those criteria.

Coordinator recommendation: review the owned commits and exact two shared hooks, wire them on the integration branch, preserve the gameplay isolation pin by selecting its separately verified CLI, then grant frozen-artifact, version-specific fixture/provider acceptance. Preserve the original failing doctor/test logs and accepted live release while doing so.

Final tracked state before this documentation-only review commit: only this review was untracked; all application/test changes were committed. Final diff/link review passed. The review commit does not change application or build digests. The final handoff reports its HEAD and clean/dirty status directly.
