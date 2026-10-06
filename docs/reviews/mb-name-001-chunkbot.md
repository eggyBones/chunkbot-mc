# MB-NAME-001 Chunkbot rebrand review

Status: complete; branding and public initial push independently verified, with the existing J1 fixture limitation documented. Reported 2026-10-05 America/Phoenix.

Jake chose Chunkbot and authorized a public repository at `eggyBones/chunkbot-mc`. Native Claude Opus 5.5 performed the main implementation through the verified local DSH subscription route; Codex reviewed the complete diff and owns acceptance and publication.

## Scope and independent review

The package and repository slug are `chunkbot-mc`; the executable/npm script is `chunkbot`, owner chat uses `!chunkbot`, and local configuration uses `chunkbot.config.json` / `CHUNKBOT_CONFIG`. Application/config names, prompts, logs, test fixtures, tool scripts and documentation agree. The planner's neutral directory is `chunkbot-planner-<uid>`. Local compatibility packages use `+chunkbot.26.2.1` and `chunkbotCompat`; their upstream base versions and compatibility behavior remain unchanged.

All 46 changed application/tooling/test/example files match the reviewed mechanical name mapping. Existing tests remain; no extra rename-only test was retained. Both generated vanilla knowledge datasets are byte-identical to the preserved baseline. The dependency set is unchanged apart from the 4 renamed local package builds. Vendor artifacts were regenerated through the existing script, with the comment-only patch blob recorded accurately; no node_modules hand-editing.

The private default configuration was migrated locally, preserving the actual Microsoft bot identity, server, storage and token cache. The live bot remains logged out. Both vanilla loopback fixtures were used serially; no live Minecraft world was changed.

## Completed checks

| Check | Result |
| --- | --- |
| Final typecheck, build, unit tests | Exit 0;297/297 |
| Isolated fresh-cache npm ci, then check | Both exit 0;297/297 |
| Doctor, both fixture profiles | Both exit 0 |
| Vendor byte-identical rebuild | Exit 0;4/4 |
| Official version facts, both releases | Both exit 0;22/22 each |
| Connection checks,26.1.2 and 26.2 | Both exit 0;16/16 each |
| Skill checks,26.1.2 and 26.2 | Exit 0;33/33 each after one 26.2 rerun |
| Fault-controller checks, both releases | Both exit 0;12/12 each |
| Compatibility checks | Exit 0;26.1.2:5/5,26.2:6/6 |
| Actual CLI help, config environment override and migrated default | Exit 0 |
| Markdown relative links |52 files,212 links,0 broken |

Raw evidence remains in ignored runtime storage: `var/rebrand/worker-checks.json`, `source-review.json`, `interface-checks.json` and `documentation-link-check.json`, plus linked fixture reports and direct logs.

The first 26.2 skill attempt failed 31/33: an earlier crafting scenario placed a table on the later staging cell, allowing its grass floor to become dirt; X4/I1 then failed their pretrial grass-floor assertions. Placement variability existed before the rebrand. The failed report is retained; one bounded rerun passed 33/33. This existing fixture weakness was not expanded into unrelated implementation work.

The initial Git whitespace check reports existing baseline EOF whitespace and verbatim vendor patch context. Those source files/patches are unchanged, except the reviewed vendor branding comment and its matching blob index; no new formatting defect was introduced by this task.

## Coordinator planner/provider checks

Both managed-subscription planner probes passed the renamed neutral-directory, restricted tools, mode-only auth and in-flight cancellation gates. Both releases passed all 19 planner scenarios with real Codex and the loopback fault-Jev provider. The full real-Codex/real-Jev suite passed 19/19 on 26.1.2; the 26.2 counterpart also passed 19/19. Both real Jev diagnostics passed model/provider/price/usage validation.

Both full real-Jev controller suites passed 11/12. J1 timed out in the movement scenario; the remaining cases, including mining/crafting, follow, replacement and provider cancellation, passed. This is an inherited fixture/behavior issue: a separately installed/built copy of the preserved pre-rebrand source also failed the bounded J0/J1 probe, and one renamed recheck reproduced it. Both versions offered the same initial 6 exploration actions and `move_near:no_grounded_destination`; their first 3 model choices matched. The supposedly visible chest is not visible at that starting point. No name-related policy/code difference was found; no unrelated gameplay/harness fix was made. Failed reports remain under ignored runtime storage. Do not claim all existing real-Jev scenarios are green.

Evidence: `var/rebrand/coordinator-checks.json`, `coordinator-remaining.json`, frozen `source-review.json` and `accepted-build.json`; full logs and fixture report paths are recorded directly. Root used only existing loopback worlds, with one driver per world and separate report/runtime outputs. The live bot remains stopped.

## Publication protection

Private configs, Microsoft caches, runtime data, node_modules, dist, `.env*`, `.codex/` and `.claude/` are ignored and excluded from the explicit staged paths. All 218 staged blobs and 1,514 regular files inside the 4 vendor archives passed branding and credential-pattern checks. The same bytes were compared in memory against 20 actual credential values from Microsoft, OpenRouter, Codex and GitHub:0 matches, with no values or matching lines written to evidence. Bot-account sign-in email and private profile screenshot references were removed from publishable historical prose.

Repository-local commit identity uses eggyBones's GitHub noreply address. The initial commit contains only the reviewed files, with no earlier private runtime history. [https://github.com/eggyBones/chunkbot-mc](https://github.com/eggyBones/chunkbot-mc) is public, owned by eggyBones, with default main. Local and remote SHA `d5eb2fa7826f783354c3a65081cbff151267eb50` match; push verified at2026-10-06T07:19:47.950245Z. Evidence: ignored `var/rebrand/publication.json`.
