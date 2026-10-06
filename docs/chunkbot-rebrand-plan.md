# Chunkbot rebrand and public repository

ID: MB-NAME-001. Reported: 2026-10-05 America/Phoenix. Owner: Codex. Status: complete; public initial push verified, with the inherited J1 fixture limitation documented.

## Outcome and Jake's decisions

Jake chose **Chunkbot** as the project name and authorized renaming the codebase, including every occurrence of the old project name, and creating a new **public** GitHub repository at `eggyBones/chunkbot-mc`. At intake, GitHub CLI was authenticated as eggyBones, the destination did not exist, and this checkout had no Git history. The reviewed initial commit is now published.

## Scope and coordinator assumptions

- Package/repository slug: `chunkbot-mc`. CLI executable and npm script: `chunkbot`. Default owner chat prefix: `!chunkbot`. Default private configuration: `chunkbot.config.json`; configuration environment variable: `CHUNKBOT_CONFIG`.
- Rename branding in source, tests, fixtures, prompts, documentation, tooling and compatibility provenance. Keep existing behavior, bot-owned Microsoft identity, MB issue IDs and accepted feature scope. Refresh generated vendor artifacts, integrity pins and builds through their existing tools.
- One native Claude Opus 5.5 worker owns application/tooling/configuration/manifest/vendor implementation. Codex owns documentation, supervision, review, Git initialization, publication and acceptance. A single implementation worker avoids overlapping mechanical edits and shared installs/builds; documentation and GitHub preparation proceed independently.
- Keep the active registered checkout accessible during the task. Use relative paths in maintained documentation instead of embedding workstation-specific project names. Historical evidence remains identified as historical; local artifacts are excluded from publication.
- Private configuration, authentication caches, fixtures, node_modules, generated dist, provider credentials and runtime evidence stay ignored. Review the complete publication file set before the first commit/push. Existing UNLICENSED/private npm settings remain as configured; this task only changes GitHub visibility.
- No gameplay launch, live server reconnect, unrelated roadmap implementation or harness upgrade belongs to this assignment.

## Acceptance and delivery

1. No old product branding remains in publishable source/documentation, filenames, or embedded local compatibility artifacts. Example configs, npm commands, CLI help, logs, chat routing and planner prompts agree on the new name.
2. Run the required affected checks from AGENTS.md with Node 24. Record direct exit codes and report paths. Use only the two existing loopback fixtures for gameplay regressions; serialize scene resets within each fixture. Separate existing fixture worlds may have independent drivers after source is frozen. Regenerated vendor artifacts must reproduce byte-for-byte, official version facts must still verify, and an isolated clean npm installation must pass.
3. Review changes against a preserved pre-rebrand snapshot. Inspect documentation links and new default configuration handling. Preserve the live bot's signed-in identity and stopped state.
4. Initialize main locally, commit only the reviewed publishable files, create and push the public `eggyBones/chunkbot-mc` repository, then verify its owner, visibility and remote commit. Record the resulting URL, commit and local/runtime state in supervision.

## Current evidence

- Initial Git status: exit 128, no repository initialized.
- GitHub CLI authenticated eggyBones with repository permissions; destination lookup returned HTTP 404.
- DSH is running locally at 127.0.0.1:3080. Existing project workers are idle. Both loopback fixtures are running; the live application is stopped.
- Integration-loaded SDK0.3.280 freshly resolves `opus[1m]` to `claude-opus-5-5[1m]` on the local Claude Team subscription. Worker `session-cb088f14-b97d-4fe4-a578-5aca4d18d5ee` performs the main implementation; one cleanup continuation is queued.
- Private default configuration migration is complete and preserves the real Microsoft identity, server and token cache. Candidate source and every regular entry in the four vendor archives passed credential-pattern scans. Jake reiterated the explicit exclusion of Minecraft, OpenRouter and Codex credentials; exact staged contents will be compared with actual credentials in memory before pushing.
- Final source and isolated clean-install checks pass 297/297. Both doctors, vendor byte-rebuild, official data and connection/skills/fault-controller/compatibility checks pass. The initial 26.2 skills setup failure passed one bounded rerun. Independent real subscription isolation/cancel probes, both fault-Jev planner suites 19/19 and both real-Jev planner suites 19/19 pass. Both real Jev diagnostics pass; each full real controller suite is 11/12 due to the inherited J1 finding below. Source and built bytes stayed frozen. [Independent review](reviews/mb-name-001-chunkbot.md). Publication is verified: [https://github.com/eggyBones/chunkbot-mc](https://github.com/eggyBones/chunkbot-mc), public owner eggyBones/default main, initial local/remote commit `d5eb2fa7826f783354c3a65081cbff151267eb50`. No credentials or private runtime files were included.

## Validation finding MB-NAME-001-C1

Observed during coordinator acceptance: the 26.1.2 real Jev J1 movement trial timed out after 240 seconds while selecting exploration actions; J0 and J2 through J6 have passed so far. The same frozen source passed all 19 real-Codex/fault-Jev planner cases. All code changes still match the mechanical rename mapping. The preserved pre-rebrand source independently reproduced the bounded J0/J1 failure; one renamed recheck did too. Both versions offered the same initial 6 exploration candidates, no grounded movement destination, and the same first 3 choices. This is a pre-existing movement-fixture/behavior limitation. Both full real-Jev suites pass the other 11 cases. Failed evidence is retained; no name-related policy/code difference or general gameplay fix is claimed. No general gameplay/harness fix is assigned by this rename request.
