# Cursor qualification, 2026-09-08

This record supersedes the initial handoff status, not its historical evidence. Native acceptance and fixture evidence are kept separate. No release is published by this work.

## Scope and isolation

- Orchestrator branch `feat/cursor-managed-launch-and-stop`, starting SHA `f943fa0399149aad190e33d3f2d6a0c4e8a02fdd`, PR #67.
- Desktop branch `fix/cursor-launch-budget`, commit `d76545741`, draft PR https://github.com/777genius/agent-teams-ai/pull/611.
- Disposable project `/tmp/cursor-e2e-20260908/project`; isolated Claude root, Electron user data, managed data/cache and Cursor data. Native HOME retained for account access.
- Desktop `pnpm dev:mcp`, CDP discovered only from the isolated `DevToolsActivePort`; source launcher points at this orchestrator worktree's `cli-source`. Shared `cli-dev` rebuilds are not native evidence.
- Do not touch the unrelated user teams cursor-team, ct4, ct5 or duo. Only the owned teams `cursor-e2e-duo-0908` and `cursor-e2e-sibling-0908` were controlled here.
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

With the corrected staged plugin, team `cursor-e2e-sibling-0908`, run `48a71596-d3ec-4fc5-9876-2440740453a4`, accepted message `5ed133d0-e10a-4aa9-b293-268224b95af7`. Native Cursor called App MCP task_list through mcptool, created `sibling.txt` containing the line `SIBLING_OK` (with a trailing newline), and sent exactly one `E2E-SIBLING-ACK` (`808e4751-2929-41bf-b337-829532b4aae9`) with matching relayOfMessageId. A subsequent delegation attempt produced a correctly correlated error reply: the default virtual `solo` bootstrap session is not a configured message recipient. This is a harness limitation, not evidence of a successful two-member exchange.

The updated plugin also passed all 12 transport tests and the managed fake E2E with 21 assertions. The offline dispatch test is runnable against the pinned installed dependency or a supplied reviewed source archive; it performs no installation.

Stop/relaunch exposed a separate desktop ledger defect: an old accepted message retained its old runId while being retried against the new session. The owned team was stopped again to prevent repeated effects. The desktop now fences accepted deliveries by run before requeue, preserves cancellation, and cancels recoverable pending records across captured lanes during ordinary Stop. Independent review additionally caught early lock release on ledger failure and skipped secondary lanes on cancellation failure. Both error paths now await all owned work and retain representative errors; focused tests exercise deferred Stop and later-lane cleanup.

## Completed native pair and restart evidence

On orchestrator `3aa273df8229513121acff553747a391c465b391` and desktop `8bc80a44fdb04245714cd4f13c5fdc991f9baf03`, run `da5ef15e-9ef6-41f1-bee2-bf77f02f39eb` completed the real lead/coder chain. User message `967db599-ed1e-485e-af71-cfb42759b06b` was previously unsent, then accepted once. Lead created `lead-v2.txt` with `LEAD_V2` plus a newline, created task `fdbbc3bd-7734-502c-8814-9dcb473ae3bb`, and sent coder request `128ff55e-3326-46db-81c5-c4cbf5a971e8`. Coder wrote exact bytes `CODER_V2` to `coder-v2.txt`, completed the task, and sent ACK `91c44a4c-8657-415d-9a7f-94695f03807d` correlated to the request. Lead delivered final completion `a8ee2ba1-af2e-450d-87fa-f321b7097d58`. Evidence: `pair-complete.json` and visually inspected `pair-complete.png`.

The old accepted `b10f2814-0211-42f9-8e65-75e7664cb1d3` and direct coder message `8c9bd198-c67b-4c18-b37d-78896599a938` retained their original run identities and attempt counts (3 and 1). They were not replayed during this restart. This distinguishes legitimate unsent inbox delivery from replay of already accepted effects.

## Current integration verification

Orchestrator merged current authority changes at `14691e47ee762090efc30225fe5292d3e1c404e3`: 527 focused tests and 3,049 assertions passed. Desktop merge plus Stop fixes passed 118 focused tests; latest main integration at `9f56d9427f6ce3abaf42fa55b3d47f94ef430ee5` passed 157 focused tests and project typecheck. Native launch on the preceding desktop head exposed cross-domain manifest counter comparison before bootstrap; latest main already fixes this precise launch condition. The failed main-team launch did not repeat an agent action; the independently started sibling did bootstrap and was explicitly stopped.

## Final native shell Stop qualification

The first active-shell attempt exposed a real defect: desktop Stop aborted the host tool, but the plugin shell and ordinary child remained alive and wrote the delayed completion marker. The plugin now forwards the trusted host tool context abort signal into its shell executor. The executor owns only its invocation process group, terminates ordinary children, escalates resistant children after 500 ms, and clears cancellation resources on normal completion. It never kills the shared host or searches unrelated processes. Explicitly daemonized descendants that leave the group remain outside this contract.

The independently reviewed patch SHA-256 is `f11c717ef275328b2b3fbc4f8e34a978508d95583c6238ede5863d6dffbef3f5`, committed in orchestrator `af45914613ca3af2ce2344885f0ea91bc8fa91c6`. The native app used desktop `504f6f60fbcf614f8f27a8efa1d9290c68774598`, OpenCode 1.18.29, Cursor CLI 2026.09.02-c22c1a3 and the reproducibly built artifact from that exact patch. The app uses source runtime; subsequent CI-only changes do not alter the loaded runtime.

A manual V2 attempt is explicitly excluded as active Stop evidence: its 45-second command completed four seconds before the click. Its independent sibling command did run for 75 seconds and delivered correlated MCP acknowledgement `02f0bcb9-7bbf-4fbd-b584-0788cd679aec`, demonstrating the requested long timeout on the final artifact. The original 30-second observation was not reproduced by the baseline 600000-ms offline control, so its precise cause is not claimed established.

The final V3 attempt used an automatic READY watcher to eliminate the manual race. Main run `4491b160-8af3-445b-8c94-47b584710be5`, message `44d75422-bbef-4924-9321-0ec791c45fe8`, started real foreground shell PID 74640 and child `sleep 60` PID 74649 in process group 74640. The watcher observed READY at Unix time 1788842292.088 and called the actual desktop `teams.stop` API at 1788842292380 ms. It returned at 1788842293877 ms (1.497 seconds). Both PIDs were absent immediately afterward. The completion marker remained absent more than 212 seconds after READY, beyond the 60-second scheduled effect. Evidence: `stop-v3-before.json`, `stop-v3-result.json`, `stop-v3-after.json`, `stop-v3-delayed-proof.json`.

Sibling run `7ac350ed-858f-46fe-8ed4-1822fbc03225` retained the same host PID 35239 and lead session `ses_f80ba033dffe6BPAHdWzgNLHiI` after this Stop. The single post-Stop MCP reply request `483052f8-8ef8-4451-a584-07acd4e31bca` received exactly one correlated response `23394ec0-6312-49c0-829c-8ed177ddde58`, text `E2E-POST-STOP-V3-ALIVE`, at 04:42:02 UTC. The durable delivery status is `responded` with the matching relayOfMessageId. No request was resubmitted. Evidence: `stop-v3-sibling-followup.json` and `stop-v3-sibling-response.json`. The owned sibling was then stopped for cleanup; the single dev app remains open.

Global `.cursor/mcp.json` still matches the qualification baseline. The later hash check found `.cursor/cli-config.json` had changed (mtime 07:25:19 local); this work did not explicitly write that file, but the actor is not established. Do not claim both global hashes remained unchanged throughout the final run, and do not restore a potentially user-owned change.

## Final review and checks

- Independent hosted review of the merged authority/Stop error paths found no actionable findings. A second review covered atomic wrapper publication and cache locking. A third reviewed the exact shell patch candidate and ran nine focused POSIX tests independently; native acceptance above supplies the host integration evidence missing from that offline review.
- Linux executable publication now writes/chmods a unique temporary inode before rename. This fixes the reproduced ETXTBSY race without changing matching wrappers or following target symlinks. Real Linux negative controls failed on the prior implementation.
- Desktop runtime cache version execution now occurs under the bootstrap lock. Five focused cache tests pass, including actual-function lock ordering.
- Desktop full CI is green at `504f6f60f`: lint, typecheck, both test shards, Windows ledger, platform bootstrap checks and CodeQL. External automated review status is tracked separately.
- Orchestrator CI at `af459146` passes Ubuntu selected-authority (697 cases), task ledger/build, both Ubuntu conformance versions, and the new pinned Cursor plugin job. Plugin regressions cover actual patched dispatch and shell cancellation, plus reproducible build. Windows initially failed a 5-second multi-refresh fixture, followed by a selected-auth failure consistent with its still-running environment restoration, and a separate read-endpoints conformance timeout. The multi-refresh test now has an explicit 20-second integration budget; its assertions and production authority gates are unchanged. The two affected local test files pass 12 tests / 128 assertions. Final Windows CI status is linked from the PR rather than predicted here.

## Delivery boundary

Both PRs remain draft while final Windows CI is collected. Native acceptance, including the post-Stop sibling response, is complete. The real pair/task/MCP proof belongs to the earlier explicit code heads above; final shell Stop proof belongs to the final patch and desktop head. These are complementary evidence, not a claim that the complete pair flow was repeated on every documentation or fixture commit. Repository-wide orchestrator TypeScript errors remain outside the focused CI qualification. No public release or updater publication is authorized by this work.
