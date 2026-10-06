# MB-V1-02 independent coordinator acceptance

Accepted 2026-10-05 UTC (2026-10-04 America/Phoenix). Scope: SKILL-1 through SKILL-5 and MB-SKL-001 through MB-SKL-010. MB-FND-003 shared-check hardening is also verified. This accepts reusable mechanics and their application integration; real Jev/Codex gameplay remains MB-V1-03 through MB-V1-05.

The native Claude worker `session-53373eb0-67eb-4aa3-a5d6-ce77f5647eb2` completed turn4. Codex read the complete visible handoff through sequence 7962 without a pagination gap, read the refreshed [worker evidence](mb-v1-02-skills.md), and verified idle/empty queues before and after independent checks. Actual native transcript metadata identifies `claude-opus-5-5`; SDK 0.3.280 resolution, high effort, full access and registered workspace membership were verified separately. No worker or coordinator build/fixture run overlapped.

## Independent checks

[Aggregate report](../../var/coordinator-review/2026-10-05T04-03-08Z-skills/report.json) records all 26 checks and direct exit codes. Every check exited 0:

| Check | Result |
| --- | --- |
| All 22 coordinator source probes | Passed, including the unmodified predicted-visibility negative/positive and the admission-API anchor variants |
| `npm run check` | Typecheck, clean build and 170 tests passed |
| `npm run doctor -- --config config/examples/fixture.json` | Passed; exact mechanic-version scope and provider readiness reported truthfully |
| `npm run live-check` | [16/16 built-CLI scenarios](../../var/live-check/2026-10-05T04-03-25-702Z/report.json) |
| `npm run skills-live-check` | [33/33 built-CLI scenarios](../../var/live-check/2026-10-05T04-04-04-801Z-skills/report.json); CLI PID81938 exited 0 |

Source/package/lock/tests/scripts/config SHA-256 before and after: `8f6b6b3b0fd547bddffeacf1e8130d49002ed426f768eaed72327744e9dded30`. The source was unchanged during independent acceptance. Documentation reconciliation afterward does not alter that build.

Fixture: separate loopback vanilla Java 26.1.2, protocol 775, survival, task-local Java 25.0.4.1, PID 31385. Endpoint 127.0.0.1:25566; RCON 127.0.0.1:25576. Final status: running, zero players. Jake's PrismLauncher worlds/accounts were untouched. No Chunkbot process is retained after acceptance.

## Behavior accepted

Codex reviewed real CLI composition (`SkillRuntime` through `AppDeps.adapters`), synchronous goal admission before planning, lifecycle revocation, the registered catalog/resolver/executor path, target/parameter admission, authoritative observations and predicates, and interface/actuator ownership. Catalog `skills-20-16f587b80d7a` describes the same 20 definitions that generate and execute actions; there is no example-goal switch or hidden prerequisite progression.

- **SKILL-1:** geometric LOS hides wall-occluded ore/entities/drops and lava-occluded blocks; glass/water and alternate-side positives work. Recipes, tags and fuel come from the actual 26.1.2 jar; unverified patches return unavailable mechanics. Pending client predictions are opaque and unreported through `sessionWorld`; the connection tap marks real Mineflayer dig predictions. The independent live log breaks each confirm prediction marking and subsequent server resolution.
- **SKILL-2:** movement, meaningful visible following, bounded exploration, logs by hand, stone with a wooden pickaxe, and collection use shared skills. RCON confirms three logs and two cobblestone. Missing harvest tools are refused. The hidden-owner scene asserts occlusion before checking that no hidden position is used. Navigation neither digs nor places; radius 8 detours and dynamic owner departure stop within bounds.
- **SKILL-3:** queried shapeless/shaped 2x2 recipes, 3x3 table crafting, equipment selection and generated placement produce verified inventory/block effects. Missing ingredients/workstations are structured feedback. Named targets and admitted quantities stay binding across refreshed observations.
- **SKILL-4:** furnace crafting/placement/input/fuel/quiet processing/collection, chest transfer/inspection, observed owner receipt, milk/shearing and server-confirmed entity death work in the fixture. Named interactive supports use verified sneak semantics; occupied destinations and unsuitable faces are refused. Fresh container reads after predicate binding satisfy current outcomes; an earlier read returns unknown until a fresh inspection.
- **SKILL-5:** navigation, long dig, crafting, transfer, interface-open and furnace waits stop within the 250 ms control-clear target. Independent X3 reports 12 real sticks while correctly distinguishing local progress from unknown post-confirmation effects. Six late-open timings clean up owned windows and permit the next interface. Replacement movement survives old cleanup. Death invalidates ownership and respawn stays idle.

B5 independently verifies the actual intake hook: the anchor remains 199.5,-60,198.5 after Chunkbot is moved 6 blocks; replacement admission captures 205.5,-60,198.5. Goal-owned execution never creates or resets an anchor.

## Corrections and boundaries

All ten recorded [skill issues](../v1-perception-skills-plan.md) are verified fixed within this scope. Relevant regressions cover exact knowledge compatibility, fluid occlusion, admitted identity, timeout/replacement/lifecycle window ownership, stale/current named targets, hidden position use, initial/in-loop travel bounds, quantity/direction parameters, current server evidence/lifecycle/container freshness and interactive support placement. The new observation-authority probe also preserves confirmed-hole positives. The adapted anchor probe uses the implemented admission API without changing its preservation assertions; maintained tests and B5 cover real admission wiring.

MB-FND-003 now controls abandoned lookup resolution explicitly and gives the fake replacement 150 ms. Original timeout/no-extra-client/replacement-ready/epoch assertions remain; production join deadlines were not loosened. The worker's 10 isolated and 24 deliberately loaded checks passed, and Codex's fresh full 170-test check passed. Normal action totals use the actuator's monotonic issued counter while traces remain bounded.

Material limitations carried to the next assignments:

- Live authentication/identity testing used the trusted offline fixture. Eventual server/version and the bot's own Microsoft-account details remain unconfirmed; no account sign-in was performed.
- Version-correct recipe/fuel/tag evidence is exact 26.1.2. Protocol support for 26.1.x is a separate claim. Installed 26.2 is unsupported by the pinned stack.
- Perception is geometric local awareness, with labeled remembered observations. It does not simulate rendering, fog or lighting.
- Prediction marking depends on the installed Mineflayer 4.39.0 local-update seam. A future library change needs revalidation.
- Interface correlation relies on vanilla 26.1.2 sequence acknowledgements and its out-of-range abort-destroy handling. An unresolved request makes interfaces unavailable rather than permitting ambiguous ownership.
- Closed container contents are bounded evidence from a server-synced skill read after binding, at most 60 s old. They are not continuously tracked while closed.
- Navigation is conservative; attacks do not chase, and supported entity-interaction effect recognition is limited. Unsupported mechanics stay explicit.
- These scripts are labeled operator mechanic diagnostics with recorded setup/interventions. They are not autonomous natural-language goal trials. Normal intake truthfully reports `planner_not_ready` until the real gameplay planner is installed.

Next: archive the fully read idle worker, then assign the complete MB-V1-03 task-driven Jev controller on freshly verified local Opus 5.5/high/full subscription routing. Continue MB-V1-04 and MB-V1-05 under Jake's existing authorization.
