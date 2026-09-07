# Cursor recovery handoff to local Claude Code

## User instruction and current state

Continue the minimal Cursor/OpenCode integration end-to-end, autonomously within the accepted scope. The user wants a working integration and a quick release, not a generic process-control framework. This is an unfinished checkpoint, NOT a release-ready fix. The previous agent stopped at the user's request. Do not assume that passing component tests proves product E2E.

Primary runtime checkout, with this task's changes synchronized as UNCOMMITTED files:
`/Users/belief/dev/projects/claude/agent_teams_orchestrator`
Base before synchronization: `3bf24764f25dfd7588b9c8b23748fa0891fd85df`, branch `fix/opencode-session-relaunch-followup`. It was clean before copying our changes. Preserve that branch's existing committed work. Source implementation checkpoint was `a16da080808d6a1ea99775a6b3fbf252124a93c2` in `/Users/belief/dev/projects/claude/_worktrees/agent-teams-orchestrator-cursor-strict-launch`. The pre-edit SessionBridge file matched between these checkouts.

User's frontend checkout: `/Users/belief/dev/projects/agent-teams-ai/old-agent-teams-frontend`, HEAD `690390af772017fb16327c6f4842803f84379a24`, branch `fix/dashboard-card-interactions`. This has substantial unrelated uncommitted announcements/localization/UI work. DO NOT reset, overwrite, stash indiscriminately, or merge another entire tree into it. No Cursor frontend code was changed in the current phase.

The cleanly scoped frontend used for this feature is `/Users/belief/dev/projects/claude/_worktrees/agent-teams-ai-opencode-dialog-readiness-recovery`, HEAD `242d5598f0ef3b0402dfbf907f3862acfc82f465`. Its `resources/pricing.json` changes are unrelated; `docs/RELEASE.md` was an earlier owned documentation edit. Use it for dev verification, or integrate only explicitly owned hunks into the user's checkout after inspecting current differences.

## Non-negotiable safety and scope

- Read AGENTS.md, CLAUDE.md, AGENT_CRITICAL_GUARDRAILS.md, the team runtime debugging runbook and relevant architecture guidance first.
- NEVER run teams, provisioning, terminals, tasks, or agent actions on real user projects. Every test uses a new /tmp sandbox or explicitly test-only existing project. This applies even to preflight/PONG and opening a runtime.
- Do not read/copy/log auth tokens, keychain data, or credential files. Native CLI can use the user's existing login normally. Never print full process argv/comm; earlier process titles contained MCP secrets. Use numeric pid/ppid/pgid/state/birth only.
- Preserve foreign HOME MCP registrations and project configs. An app-owned unique MCP registration is allowed only through ownership-aware merging; no overwrite or credential migration.
- Dev verification: frontend `pnpm dev:mcp`, renderer CDP9222, runtime source launcher `/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source`. Do not confuse it with packaged CDP9223. No Computer Use/native folder picker. Only sandbox test APIs and renderer CDP.
- Do not repeatedly package. After source/DevMCP acceptance, build runtime once with `bun run build`, use `cli` (not cli-dev), then one final local packaged frontend E2E. Leave the user's app open. No GitHub release/draft/tag mutation, fork, package publication, commit, PR, or merge without separate authorization.
- No global OpenCode cache edits. No root dependency install into a symlinked node_modules. The plugin build dependencies are isolated under `scripts/cursor-plugin`.
- Keep Kiro and other providers unchanged. Do not revert the whole strict-launch protection commit. No universal OS tracer, new host-per-member architecture, VM/container system, broad refactor, or unrelated UI work.

## Critical blocker - RESOLVED, see the evidence note first

Read `docs/cursor-handoff-evidence/managed-stop-live-e2e.md` before anything else. It
supersedes the NO-GO below and the ledger's last section for the nested-detach gap.

Summary: the nested `shell -> Node -> spawn({ detached: true }).unref()` escape is closed by
an inherited scope marker (`CURSOR_OWNER_SCOPE`), swept from `ps -Eww -ax` at teardown.
Exec-time environment survives `setsid`, double forks and reparenting to pid 1, so it does
not need the lineage reconstruction that libproc and the unsupported Darwin `NOTE_TRACK`
could not provide. A neutered-sweep negative control fails, so the regression gate is real.
Remaining honest limitation: a descendant that re-execs with a scrubbed environment drops
the marker; `cleanupCompleted` is defined accordingly and `scopeSweep.remaining` is part of
it. Do not restate this as whole-session containment.

Two findings changed the shape of the work. OpenCode, not cursor-agent, executes tools in
`TOOL_LOOP_MODE=opencode`, so the barrier covers what cursor-agent itself spawns. And the machine-global proxy port
32124, pinned in the curated catalog and bound by the upstream plugin, let any stale or
foreign holder take a profile's traffic. That is fixed: a managed profile retains its own
port, the managed config points the provider at it, and the plugin binds exactly that port
with no silent fallback. Verified against a hostile squatter on 32124.

## Implemented, not yet fully integrated

1. `src/services/opencode/cursor-native/`: native root + direct detached groups registered before effects through authenticated private socket and small C gate; ownership/birth checks; TERM/KILL, parent death, ACK, streaming. macOS only. C helper compiled at build time, never on an end-user machine. The nested-detach P1 is closed by the scope-marker sweep in `scope-sweep.mjs`; see the evidence note.
2. `scripts/cursor-plugin/`: pinned upstream `@rama_nigg/open-cursor@2.5.2`, isolated bun.lock, reviewed downstream cancellation/control patch, deterministic bundled artifact builder and native asset builder. Latest2.5.8 was inspected earlier and did not solve the integration issue. Pin integrity is checked. No package fork/publish.
3. Managed control registry: `chat.headers` supplies trusted session/message identity; each HTTP request gets a UUID before awaiting body/spawn, with separate child env. Terminal Stop uses authenticated begin(seal)->OpenCode abort->wait(cleanup ACK). Late admissions rejected, siblings untouched, normal completion/follow-up not sealed. Only terminal team Stop seals a session; relaunch creates a new session ID, bootstrap resume does not.
4. `OpenCodeCursorStopControl.ts` and Cursor-only `OpenCodeSessionBridge.abort` hook implement the client side. Missing/stale ACK or control descriptor must not become success. ACK requires version1, matching UUID/PID, private file, empty failures/remaining and observed non70 numeric supervisor exit.

Now wired, gated on verified staging (`AGENT_TEAMS_CURSOR_MANAGED_ASSETS`): managed plugin artifact selection, the supervisor bridge wrapper, and the managed control environment. `resolveOpenCodeCursorManagedAssets` fails closed, so anything unverified keeps the upstream plugin and today's launch path.

Native App MCP config is NOT missing: the frontend already writes it through
`CursorMcpConfigWriter` on Cursor launches, and spikes on the real CLI confirm a
home-registered server is visible to the agent with the plugin's existing `--force`.

Native auth authority and the readiness fingerprint are now wired
(`OpenCodeCursorNativeAuthority.ts`, published as `AGENT_TEAMS_CURSOR_READINESS`), with a
changed account or replaced binary invalidating readiness at once.

STILL NOT wired: readiness fingerprint binding, build/release asset delivery for the compiled `gate`, and final UI permission-mode handling. Cursor does not support the app's OpenCode manual approval UI; reject unsupported saved/manual modes honestly rather than silently enabling force/auto.

## Evidence and verification truth

Durable snapshots are saved beside this document in `docs/cursor-handoff-evidence/`: original plan, execution ledger, release notes, nested escape report/verdict/feasibility and SHA256 sync manifest. These survive /tmp cleanup. The ledger is chronological; its latest NO-GO section supersedes earlier PASS/approval entries. All24 synchronized code files were byte-identical to the implementation worktree at handoff.

- Config positive: `/tmp/cursor-managed-config-v2.qnKoAU/{report.json,verified.json}`. Native App MCP receipt once, nonce file matches, canonical blocked path gives explicit writePermissionDenied, no foreign HOME/project config changes. Test registration removed. Project permission arrays REPLACE global arrays; respect overrides, preserve deny. Relative Write(blocked.txt) did not match the canonical path in the earlier negative fixture.
- Native MCP through pinned plugin: `/tmp/cursor-direct-mcp.7JQspU/proof.json`. TOOL_LOOP_MODE=opencode with ZERO executable OpenCode tools, native backend, bridges/forwarding/reuse/pooling/resume/force disabled. TOOL_LOOP_MODE=off leaks native tool parts into OpenCode and risks double execution; do not use it.
- Native ownership focused:3 tests/11 assertions passed after root birth checks and space-path fixes. This does NOT cover the nested escape as successful.
- SessionBridge:75 tests/324 assertions passed. Runtime StopControl:5 tests/23 assertions. Managed control:22 tests/72 assertions. Native build stage:1 test/10 assertions. Fresh plugin build + unmanaged transport:5 tests/24 assertions (port fallback, request-local cancel, buffered response,12s silent token). Focused TS7 passed.
- IMPORTANT: newest `managed-transport.test.ts` run timed out at30s after the final managed cancellation wiring change. Previous patch passed1 test/15 assertions in2.51s. Latest managed boundary verification is PENDING, not green. Its fixture was cleaned. Debug this test before reporting stable integration. No new model calls are needed for that diagnosis.
- No current full mixed-team E2E, no final production build proof, no claim that the opened app contains these changes.

## Remaining plan, in order

1. Verify local synchronized files/status; read the P1 evidence. Fix the latest managed transport timeout with a focused test, without broad redesign. Inspect last cancellation patch branch for recursion/abort/listener ordering rather than guessing.
2. Resolve the whole-tree containment go/no-go within the bounded scope above. If unresolved, stop feature enablement and provide the limitation/decision, not fake-green UI.
3. Only after go: deliver self-contained plugin/native artifacts with manifest digests, platform capability gate and no runtime compiler. Wire ProfileManager's existing Cursor native wrapper. Do not change Kiro. Check cold-cache import and occupied proxy port.
4. Preserve native auth authority: bounded native status and safe executable/account identity; dummy `cursor-agent` marker with30-minute TTL is not proof. Bind readiness to exact retained host, selected model, project config/native policy, App MCP endpoint/instance, plugin digest and fresh auth. Revalidate at launch; keep leases and run/session freshness/no replay.
5. Wire managed native MCP config via existing ownership writer and propagate failures explicitly. Do not edit project policy or auto-bypass denies. Cursor does not support the app's OpenCode manual approval UI; reject unsupported saved/manual modes honestly rather than silently enabling force/auto.
6. Focused tests for cancellation before spawn/body, false/missing/stale ACK, sibling isolation, repeated Stop, normal follow-up, terminal relaunch/new session, config/auth/model drift and zero executable OpenCode tool parts. Run applicable source-size/architecture guards and targeted typechecks.
7. DevMCP sandbox E2E: connect/model check -> mixed-team launch -> real App MCP task -> agent-produced file/result/reply -> follow-up -> Stop during an active task -> no late effects -> repeated Stop -> relaunch without replay. Other session remains unaffected. Use inexpensive normal models, no fast mode by default. Do not retry uncertain model side effects blindly.
8. Once all required evidence passes, one production-like runtime build and local frontend packaged E2E using exact artifact identities. Leave app open. Report remaining limitations honestly. Publishing is separate.

Useful commands from runtime root:
```
cd scripts/cursor-plugin
bun install --frozen-lockfile --ignore-scripts
cd ../..
bun test scripts/cursor-plugin/build.test.ts scripts/cursor-plugin/build-native.test.ts scripts/cursor-plugin/managed-control.test.ts scripts/cursor-plugin/transport.test.ts scripts/cursor-plugin/managed-transport.test.ts
bun test src/services/opencode/cursor-native/CursorNativeOwner.test.ts src/services/opencode/OpenCodeCursorStopControl.test.ts src/services/opencode/OpenCodeSessionBridge.test.ts
```
These component tests use disposable sandboxes/fakes. Keep the nested escape as a negative regression gate, not as a skipped problem. Frontend's pinned native TS7 command is `pnpm typecheck`. Runtime has no typecheck script; use focused `tsc7 --ignoreConfig --noEmit --skipLibCheck --module preserve --moduleResolution bundler --target esnext --types bun <new files>` for quick checks, plus documented project gates as appropriate.

The user's packaged `/Applications/Agent Teams AI.app` was intentionally not stopped. Previously PID86005/CDP9223; re-read numeric process identity before touching anything. Source and handoff copies must never imply that packaged app was updated.
