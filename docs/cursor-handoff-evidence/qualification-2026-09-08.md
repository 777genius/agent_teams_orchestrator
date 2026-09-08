# Cursor qualification, 2026-09-08

This record supersedes the initial handoff status, not its historical evidence. Native acceptance and fixture evidence are kept separate. No release is published by this work.

## Scope and isolation

- Orchestrator branch `feat/cursor-managed-launch-and-stop`, starting SHA `f943fa0399149aad190e33d3f2d6a0c4e8a02fdd`, PR #67.
- Desktop branch `fix/cursor-launch-budget`, commit `d76545741`, draft PR https://github.com/777genius/agent-teams-ai/pull/611.
- Disposable project `/tmp/cursor-e2e-20260908/project`; isolated Claude root, Electron user data, managed data/cache and Cursor data. Native HOME retained for account access.
- Desktop `pnpm dev:mcp`, CDP discovered only from the isolated `DevToolsActivePort`; source launcher points at this orchestrator worktree's `cli-source`. Shared `cli-dev` rebuilds are not native evidence.
- Do not touch the unrelated user teams cursor-team, ct4, ct5 or duo. Only the owned team `cursor-e2e-duo-0908` was controlled here.
- Native Cursor also discovers global MCP servers independently of `CURSOR_CONFIG_DIR`. Sandbox-only `CURSOR_DATA_DIR` project disabled-server lists and project MCP deny permissions were staged; no user config was rewritten. Only global server identifiers were read for the sandbox list, not endpoints or credentials.

## Review and corrective work

Hosted subscription-runtime Astra workers used isolated source snapshots, explicit model/effort and fast tier. Initial critique/review found defects in request-tree cancellation, nested asset validation, concurrent port allocation, stale native authority, Stop cleanup authority and runtime payload delivery. Corrections include content-based native binary identity and supplied-environment account probing, strict scope stability without compatibility-marker dependence, full host generation identity, legacy persisted desktop capability support for Stop, and complete runtime asset caching.

The independent final follow-up reviewed orchestrator snapshot `1f98258071c839dea4ee7e1a0e81ac38f7b036b1` and frontend snapshot `a589932139787b6f1116344216f31c2425466225`. R1-R5 were resolved with no new actionable regression; eight independent offline probes passed. This review explicitly did not certify native product acceptance. The frontend delivery commit differs from its review snapshot only by final hook formatting.

## Completed verification before native MCP follow-up

- Desktop: 22 focused bridge tests, four payload-cache tests, project typecheck and changed-file lint passed.
- Orchestrator: 21 transport/assets/port tests (135 assertions); reproducible plugin build test (six assertions); managed fake E2E (21 assertions); 80 task-change-ledger tests (385 assertions); `bun run build:dev` passed.
- Final focused identity/bridge/legacy set: 208 tests passed. A pending-host health-budget regression was then fixed and all 54 HostManager tests passed.
- Earlier 441-test identity run was not wholly green: two fixture/scope failures were corrected and rechecked; four timing-sensitive profile cases passed separately. Do not describe split reruns as a fresh green 441-test suite.
- Repository-wide TypeScript checking still reports broad existing source/dependency errors; it is not claimed green.

## Native product evidence

Evidence artifacts are under `/tmp/cursor-e2e-20260908/evidence` on the test machine.

1. Native model test returned `ok: true`, `Model probe passed`, after 164 seconds. The prior attempt failed during cold plugin inventory; inventory warmup required no model call.
2. Team creation from the desktop API launched lead plus coder with `cursor-acp/auto`, run `74cc763c-1142-4d19-89b1-7894fdcf094d`, `clean_success` after approximately 194 seconds. Renderer screenshot confirmed Running with both members. Coder bootstrap was confirmed alive.
3. A single user message (`b10f2814-0211-42f9-8e65-75e7664cb1d3`) was accepted with durable ledger identity. The lead created `lead.txt` containing exactly `LEAD_OK`.
4. The lead then repeatedly attempted to discover a callable Agent Teams tool. No coder request or reply was recorded. This exposed missing managed MCP dispatch instructions; a registered tool list and a shipped mcptool binary alone do not establish usable native tool access.
5. The looping run was stopped through the desktop `teams.stop` API in under one second. Both members became inactive. This is not yet a delayed-write native-shell Stop proof.
6. SHA-256 hashes of user `.cursor/mcp.json` and `.cursor/cli-config.json` remained unchanged from the qualification baseline through this run. The older session baseline had already changed externally before the first model call; it was not restored or attributed to this run.

## Managed MCP correction and subsequent native evidence

The plugin now emits an absolute, shell-quoted mcptool command with explicit scoped OPENCODE_CONFIG. The command works from the OpenCode bash executor without inheriting the native wrapper environment. Full and incremental prompts receive the instructions; a composition regression verifies that discovered MCP summaries do not reintroduce the contradictory native full-name call route. Unmanaged guidance remains intact. Independent review found precisely this summary conflict in the first patch; it was corrected and the actual composed-prompt regression passes.

With the corrected staged plugin, team `cursor-e2e-sibling-0908`, run `48a71596-d3ec-4fc5-9876-2440740453a4`, accepted message `5ed133d0-e10a-4aa9-b293-268224b95af7`. Native Cursor called App MCP task_list through mcptool, created `sibling.txt` containing exactly `SIBLING_OK`, and sent exactly one `E2E-SIBLING-ACK` (`808e4751-2929-41bf-b337-829532b4aae9`) with matching relayOfMessageId. A subsequent delegation attempt produced a correctly correlated error reply: the default virtual `solo` bootstrap session is not a configured message recipient. This is a harness limitation, not evidence of a successful two-member exchange.

The updated plugin also passed all 12 transport tests and the managed fake E2E with 21 assertions. The offline dispatch test is runnable against the pinned installed dependency or a supplied reviewed source archive; it performs no installation.

Stop/relaunch exposed a separate desktop ledger defect: an old accepted message retained its old runId while being retried against the new session. The owned team was stopped again to prevent repeated effects. A hosted worker is correcting run eligibility and Stop cancellation; native restart acceptance remains pending that fix.

## Remaining acceptance

Fix and independently review native managed MCP dispatch, then prove a file-changing lead/coder exchange, a same-session follow-up, Stop during an active command with no delayed write, sibling isolation, and restart without replay. The fake E2E hardcodes mcptool invocation, so its prior pass did not cover the discovered instruction defect. Keep both PRs draft until current-head checks and native acceptance support readiness.
