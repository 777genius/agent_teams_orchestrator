# Cursor option 1 execution ledger

Goal: implement selected option 1 from /tmp/cursor-release-minimal-options-plan.md, through DevMCP E2E and one final packaged test. Not complete.

## Repository state

Runtime: /Users/belief/dev/projects/claude/_worktrees/agent-teams-orchestrator-cursor-strict-launch, HEAD a16da080808d6a1ea99775a6b3fbf252124a93c2, clean at start. Production build recipe now added under scripts/cursor-plugin; Stop agent owns only new src/services/opencode/cursor-native assets/tests.
Frontend: /Users/belief/dev/projects/claude/_worktrees/agent-teams-ai-opencode-dialog-readiness-recovery, unrelated dirty resources/pricing.json and earlier owned docs/RELEASE.md. Do not touch those during Cursor work.

## Config go/no-go: PASS for compatible native policy

Positive report: /tmp/cursor-managed-config-v2.qnKoAU/report.json.
One actual MCP receipt call, native file equals unpredictable returned nonce, explicit writePermissionDenied on canonical blocked path, no blocked file, native auth remains ready, existing HOME MCP entries unchanged, project config unchanged.
Native output: native-output.jsonl. Fourteen supervisor reports all cleanupCompleted=true, no remaining processes. Exact temporary HOME MCP registration removed, preserving other entries.

Negative report: /tmp/cursor-managed-config.8NvsK9/report.json. Project allow:[] replaces managed allow, so tools discovered but MCP invocation rejected. Native Write(blocked.txt) does NOT match canonical absolute path; test wrote its own blocked.txt. These are fixture/policy semantics, not proof of bypass with correctly configured absolute deny. Native-source isolated audit confirmed both.
The negative test left helper processes; exact sandbox-owned PIDs55852/55941/56127 subsequently verified and cleaned. process-cleanup.json says none alive. Its own registration cleanup initially used mcp.port after server.stop and failed; separate cleanup.ts safely removed exact owned registration. No project/user config secrets stored as artifacts.

Implementation requirement: effective native project permission arrays replace global arrays. Respect project override; fail explicitly if App MCP is not allowed, never silently rewrite/override project policy. Preserve deny rules. Do not use generic /rejected/ as denial evidence: check writePermissionDenied for the test path.

## Stop go/no-go: NO-GO (production implementation paused per plan)

Disposable supervisor: /tmp/cursor-supervisor-97gKmY/supervisor.mjs; ~106 LOC before pending correction. Synthetic orphan, TERM-ignore, sibling, parent exit and pipe forwarding pass.
Actual OC + patched plugin + supervisor: /tmp/cursor-supervisor-native-9tRuC3/report.json. Write stopped 1->1 through24s, all owned processes gone by2306ms, shared host stayed alive. ACK false because signalGroup EPERM on macOS exiting process ended polling early. Some detached native groups briefly existed after abort, all then exited. This run does not prove long shell cancellation or a detached-process leak.
EPERM correction is /tmp/cursor-supervisor-97gKmY/supervisor-v2.mjs + group-cleanup.mjs, 129 LOC. Deterministic EPERM-disappearing/still-live tests pass.

Definitive long-shell result: /tmp/cursor-supervisor-shell-NfAU56/report-scoped.json and verdict.md. One actual prompt executed pre-created sandbox sh script. At >=3 heartbeats OpenCode abort returned true; native root/own PGID90189 exited and supervisor claimed cleanup=true, BUT detached shell PGID93032 (PID93032/93040, sleep94950) remained PPID1 and heartbeat rose3->53 during24s. Shared host and independent fake sibling unaffected. This disproves group-only request cleanup, not merely a theoretical escaped-process gap. All test PIDs and host89368 were cleaned after evidence; main verified only user app86005 remains among checked PIDs.

No model retries after this failed gate. Stop component needs rescope before production implementation. Agent /root/cursor_release_minimal_plan asked for bounded read-only ownership correction assessment. Do not enable strict Cursor launch or package the known-unsafe supervisor.

## Rescope awaiting user direction

Read-only xhigh audit confirms installed native Shell executor explicitly spawns detached:true (index.js byte9051336), helper Ee byte9036411 has its own AbortSignal->group cancellation but root SIGTERM exit path byte1965923 does not trigger it. Dedicated host alone would not solve detached commands either.
Proposed additional bounded phase: request-owned preload at existing native NODE_OPTIONS injection, capture actual detached command ownership before effects with registration barrier/live handles, supervisor completion ACK for all owned groups. A simple post-spawn PID log or polling-only ownership is insufficient. Preliminary delta150-280 production LOC +120-220 tests,4-8 person-hours, conditional on first60-90min proof. This is not yet approved or implemented. Alternative is keep existing Cursor block for release, but that does NOT complete the active restoration goal.

Main final will request direction because agreed initial Stop go/no-go failed. Goal remains active, not complete; no blocked status on first occurrence. Do not proceed to broader ownership implementation until user approves the rescope.

## Approved rescope and new evidence (supersedes paused status above)

User explicitly approved request-owned detached command cleanup. New registration-before-effects C gate, native preload and supervisor proved actual long-shell cancellation: /tmp/cursor-request-owned-live-ttYTKS/report.json, heartbeat3->3 through24s, owned processes gone, shared host and independent sibling unaffected. This proves ownership cleanup, NOT session-to-request mapping: fixture requestId was accidentally literal and needs separate focused coverage.

Main added isolated reproducible plugin build recipe scripts/cursor-plugin with pinned upstream2.5.2/sourceSHA, cancellation patch, lockfile and deterministic artifact test. One test/6 assertions PASS. No shared OpenCode cache/root dependencies mutated. Latest upstream2.5.8 checked; pin intentionally retains previously proven source. Build pipeline/ProfileManager/strict launch are NOT wired yet.

Remaining gates: review/integrate ownership assets; session-correlated cleanup ACK with late-request handling; native auth/policy/MCP authority; narrow Cursor strict guards; focused tests; DevMCP actual team task/followup/Stop/relaunch; one final packaged verification. No release or all-fixed claim yet.

## Latest independent review: whole-tree Stop remains NO-GO

Request-owned native root/direct detached groups are implemented and focused-tested. But a shell command can itself start a nested Node detached/unref child (or setsid in another executable), outside the native-root preload. Actual no-model reproduction /tmp/cursor-request-owned-nested-i2Rl3C/report.json: heartbeat4->31 after Stop while ACKcleanupCompleted=true. Exact fixture group was cleaned. This invalidates whole-session Stop acceptance, not the earlier direct native shell proof.

Bounded macOS feasibility: libproc unique parent identity survives reparent, but reaped intermediate parents are no longer queryable, so final scan cannot reconstruct unobserved multi-hop ancestry. Darwin NOTE_TRACK/NOTE_CHILD unsupported; no universal small race-free correction established. Do not enable strict Cursor guards or package as fixed. Larger containment decision needed; no silent OS tracing/platform expansion.

Production additions in this turn: raw owner assets; build-time native helper staging; reproducible patched plugin+session control registry; OpenCodeCursorStopControl and Cursor-only SessionBridge.abort linkage. ProfileManager/build workflow/strict capability still NOT enabled. All changes uncommitted. Focused results: nativeowner3tests11assertions; SessionBridge75tests324assertions; runtimecontrol5tests23assertions; plugincontrol22tests72assertions; pluginbuild+unmanagedtransport5tests24assertions; nativeassetstage1test10assertions. Latest managed full transport fixture pending. Focused TS7 for new control/build code passes. Earlier test-only patch whitespace/type assertions were corrected before passing checks.

## Guardrails

All actions only new /tmp sandbox projects. User packaged app untouched; no releases, commits, forks or GitHub writes. No native auth secrets read/copied. Main uses code-tool-router/code-impact-analysis and plan-start. Production implementation begins after bounded config+Stop acceptance; if actual long shell leaves detached workers, stop and rescope rather than silently expand.

## Containment correction and live E2E (supersedes the NO-GO above)

The nested detach escape is closed by an inherited `CURSOR_OWNER_SCOPE` marker swept at
teardown, with a neutered-sweep negative control proving the regression gate. The pending
managed transport test was only missing `scripts/cursor-plugin/node_modules`; it now passes
5/5 standalone and in suite. Product integration is gated on verified staging, so an
unavailable artifact keeps the upstream plugin. Two consecutive live E2E runs with real
Cursor calls proved managed transport, follow-up, Stop of an active turn with zero
surviving supervised processes and no late output, repeated Stop, and a sibling session
with no replay. Full detail and the two open issues: `managed-stop-live-e2e.md`.

Still open: native App MCP config writer, native auth authority and readiness fingerprint,
Electron/DevMCP UI run, packaged verification, and the shared proxy port hijack.
