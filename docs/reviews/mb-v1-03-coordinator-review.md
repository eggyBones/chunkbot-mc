# MB-V1-03 — Coordinator acceptance

Accepted 2026-10-05 05:36 UTC after independent source, build, regression and real-provider checks. This accepts the generic Jev task controller (JEV-1 through JEV-4). Natural-language planning and autonomous V1 delivery remain MB-V1-04/05.

Native worker `session-8a631413-f645-495a-aee7-ccff8c7051a3` used local DSH's Claude subscription route, Opus 5.5/high/full. Both completed turns and their full visible/documentary handoffs were read. Idle state and empty queues were verified before and after the independent checks. [Worker evidence](mb-v1-03-jev-controller.md).

## Independent checks

All **30 commands exited 0** in `var/coordinator-review/2026-10-05T05-28-27Z-jev/report.json`:

- 24 coordinator probes, including both unmodified Jev reproductions and the 22 accepted skill/foundation boundary probes.
- Fresh `npm run check`: typecheck, clean build, **232 tests passed**. Doctor passed.
- Built-CLI foundation **16/16**: `var/live-check/2026-10-05T05-28-46-377Z/report.json`.
- Skill regressions **33/33**: `var/live-check/2026-10-05T05-29-25-998Z-skills/report.json`.
- Real built-adapter `jev-check` and the full real-provider controller fixture, with the credential injected through the vault helper. No secret was sent to the worker or saved in a prompt/config/report.

The reviewed source/manifest/test/script/config digest was unchanged before and after: `193ad16ffcbb320ab13799c97c92a6379038ff3d9e0d61274fe355ae0a0a152c`. The clean build was used by the real CLI; the CLI exited 0. No Git initialization, commits, pushes or PRs occurred.

## Real Jev and Minecraft evidence

Vanilla **26.1.2 / protocol 775**, survival fixture at `127.0.0.1:25566`, Java PID 31385. Real-provider report: `var/live-check/2026-10-05T05-32-47-773Z-jev-real/report.json`. All **12/12** scenarios passed through the built CLI.

The diagnostic requested `typesafe/jev-1.13`, received `typesafe/jev-1.13-20260917` / TypeSafe, selected `wait`, reported 469 input tokens and USD 0.000019698, and completed in 605 ms. Its reservation reconciled to that actual reported cost. Exact redacted output is `var/coordinator-review/2026-10-05T05-28-27Z-jev/jev-check-real.log`.

The full run made **27 attempts**, with **26 validated responses**, all from that same snapshot/provider. Recorded response latencies were **167–934 ms**. Reported charges reconciled to USD **0.001446648**; the aborted request's charge was unknown, so USD **0.001344** remained conservatively retained. There was no outstanding reservation and USD 0.997209352 remained under the USD 1 application-run cap.

Evidence links requests and frozen IDs to actions, observed outcomes and final predicates:

- Movement reached the visible chest, verified by code and RCON. It used eight decisions, including exploratory moves; success does not imply optimal navigation.
- Hand mining acquired three new logs. Crafting produced twelve planks, a table, four sticks and a wooden pickaxe, with server-synced results.
- Placement produced an actual table at a generated site. Tool mining produced two server-confirmed stone breaks and two new cobblestone items; RCON confirmed cobblestone rather than stone items.
- Missing tool, missing table and hidden ore each produced structured resolver feedback with zero Jev calls.
- Stop during a recorded request cancelled the goal in 2 ms, aborted I/O and produced no action from the reply.
- About 32 seconds of following a moving visible owner used **one** Jev request and **two local continuations**. Replacement cancelled the old goal and captured a fresh admission anchor.
- Normal goal intake remained `planner_not_ready`; it and ten seconds of idle made zero Jev calls.

The harness recorded **41 pretrial setup commands** and **8 in-trial owner-movement interventions** separately. These are operator-authored task-controller trials, not autonomous natural-language trials.

## Corrections independently verified

**MB-JEV-001:** the adapter reserves the full verified serving-context maximum before each attempt, including retries. A USD 0.001 cap causes **zero dispatches**. Unverified configured models/providers are refused. Maintained boundary tests cover exact/below-cap calls, full-context usage, cross-goal accounting, retries and retained ambiguous charges. The real small request succeeded and reconciled correctly. On 05:28 UTC the public [endpoint metadata](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints) still reported TypeSafe, 32,000 context tokens and USD 0.000000042/input token; the scoped price filter had already been verified by G-02.

**MB-JEV-002:** post-await ownership checks precede all task-result publication. The controlled old reply leaves replacement `goal-0002/task-0002` active and `lastTask` unset. Maintained tests also verify late-after-stop rejection and ordinary current completion.

Source review confirmed one application-run ledger, one in-flight request, bounded retry/rate/size rules, registered resolver-based candidates, fresh revalidation, result identity checks, local maintenance/processing waits, and generic feedback. No goal keyword handlers or controller-owned prerequisite pipeline were introduced. The existing 20-capability catalog remains `skills-20-16f587b80d7a`.

## Scope and limits

This acceptance covers the separate offline fixture and the verified TypeSafe route profile. The conservative charge bound depends on that serving-context/price contract; another model/provider or changed mechanics requires fresh verification. Price filtering and post-response drift checks do not prove unchanged provider context indefinitely. Unknown aborted charges remain unknown.

The worker observed earlier fixture failures when a chest was absent from a filtered snapshot, and when J6's placement affected J7's stone/drop trial. The cause of every earlier omission is not independently proved. J7 now has an unobstructed stone pair as explicit pretrial setup; the current independent skill and real-controller runs passed. Observation remains conservative and bounded; unavailable targets produce feedback.

All prior skill-layer limitations remain. Low health/no-progress checks occur between actions, with each action's timeout and cancellation controls bounding its work. Healthy sustained continuation is installed for follow and furnace waiting. Eventual shared-server/version and Chunkbot Microsoft-account details remain unconfirmed; no online sign-in or shared-world test occurred.

Proceed to MB-V1-04, then MB-V1-05. Final V1 acceptance still requires the isolated subscription planner, real normal intake, varied autonomous prerequisites and novel composition.
