# Cursor Agent Support

Status: proposed

Scope: runtime, CLI, provider registry, session bridge, feature architecture.

## Problem

Add Cursor Agent as a first-class runtime provider while preserving the user's
Cursor environment: local auth, user and project MCP configuration, rules,
AGENTS.md, and Agent Skills. The integration must not silently rewrite Cursor
user configuration or auth stores.

## Research Snapshot

- Cursor Agent is available as a local CLI path. Official docs describe
  `cursor-agent`/`agent` usage, print mode, and `--output-format json|stream-json`.
- `stream-json` print mode is NDJSON and includes system, user, assistant,
  tool_call, and terminal result events. This is enough for a one-shot runner,
  similar to the current Codex native `exec --json` path.
- The inspected package reports `--output-format` default as `text`; headless
  fallback must always pass `--output-format stream-json` explicitly and should
  not depend on docs defaults.
- Cursor also exposes ACP mode with `agent acp`, a JSON-RPC-over-stdio server
  intended for editor/agent clients. This is the better fit for a durable
  teammate/session integration.
- Cursor is listed in the official ACP Registry. Its registry entry uses
  `cursor-agent` with `args: ["acp"]` on macOS, Linux, and Windows.
- The Windows x64 ACP Registry package was downloaded to a temp folder and
  inspected without installing it. The package reports
  `2026.03.30-a5d3e17`, contains its own `node.exe`, `rg.exe`,
  `cursorsandbox.exe`, and exposes `cursor-agent.cmd acp`.
- Cursor's January 2026 changelog says `agent` is now the primary CLI
  entrypoint and `cursor-agent` remains a backward-compatible alias. Discovery
  should support both, and the registry-managed package still uses
  `cursor-agent`.
- Real ACP `initialize` against the registry package returned protocol version
  `1`, `loadSession: true`, `promptCapabilities.image: true`, audio and
  embedded context disabled, and MCP HTTP/SSE capabilities. It also returned a
  `cursor_login` auth method.
- `session/new` before ACP authentication returns `Authentication required`.
  Calling `authenticate` without an existing login attempts the browser login
  flow. The orchestrator must not call it silently.
- Cursor CLI MCP uses Cursor's MCP configuration and can list/login/disable MCP
  servers. Cursor docs state CLI discovers configured MCP tools automatically.
- Cursor rules include project `.cursor/rules`, user rules, root `AGENTS.md`,
  and legacy `.cursorrules`.
- Cursor Agent Skills are supported in Cursor 2.4+ editor and CLI via
  `SKILL.md` packages. The stable path is to let Cursor load them from its own
  supported directories rather than translating app-specific skills in-process.
- The package contains support for `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR`.
  These are useful for isolated probes/tests, but production must leave them
  unset by default so user settings, MCP, rules, auth, and skills load normally.
- Cloud Agents API is not the right first path for this feature because MCP and
  local user settings are not as directly controlled as in the local CLI path.

Deep implementation notes:

- `acp-design-notes.md`
- `architecture-fit.md`

Sources checked on 2026-04-28:

- Cursor CLI usage: https://docs.cursor.com/en/cli/using
- Cursor CLI output format: https://docs.cursor.com/en/cli/reference/output-format
- Cursor CLI MCP: https://docs.cursor.com/cli/mcp
- Cursor ACP: https://cursor.com/docs/cli/acp
- ACP protocol docs: https://agentclientprotocol.com/protocol/overview
- ACP TypeScript SDK docs: https://agentclientprotocol.com/libraries/typescript
- ACP registry Cursor entry:
  https://github.com/agentclientprotocol/registry/blob/main/cursor/agent.json
- ACP Registry public index:
  https://agentclientprotocol.com/registry/index
- Cursor January 2026 CLI changelog:
  https://cursor.com/changelog/cli-jan-08-2026
- Cursor rules / AGENTS.md: https://docs.cursor.com/context/rules-for-ai
- Cursor 2.4 skills changelog: https://cursor.com/changelog/2-4
- ACP TypeScript SDK version checked with npm: `@agentclientprotocol/sdk@0.20.0`
  modified 2026-04-23.

## Existing Architecture Fit

The project already has two useful runtime integration patterns:

- Codex native is a local CLI one-shot runner:
  `codex exec --json`, JSONL mapping, sandbox mapping, MCP config overrides,
  and transcript projection under `src/services/codexNative/`.
- OpenCode is a managed host/session runtime:
  CLI host lifecycle, HTTP client, app-owned MCP attach/verification, session
  store, stale-session handling, and provider management adapters under
  `src/services/opencode/` and `src/features/runtimeProviderManagement/`.

Cursor should follow the same shape:

- Runtime/provider registration lives in `src/services/runtimeBackends/`.
- Cursor-specific process, ACP, output parsing, settings probing, and session
  translation live in `src/services/cursorAgent/`.
- Product boundary and feature-specific use cases live in
  `src/features/cursorAgentSupport/`.
- Planning and rollout stay in this `features/cursor-agent-support/` folder.

## Recommended Option

Accepted recommendation for implementation:

Local Cursor CLI through ACP first, using the official ACP TypeScript SDK on
the app side, with a local redacted stdio stream adapter and headless
`stream-json` as a diagnostic or fallback path.

🎯 9   🛡️ 8   🧠 7

Estimated changed lines: 950-1,600 for MVP, 1,600-2,600 for production-grade
session persistence, permissions, and recovery.

Why:

- It uses the official local Cursor runtime instead of reverse-engineering
  Cursor internals.
- The Cursor process is still the source of truth. The SDK is only our typed
  client wrapper for ACP JSON-RPC, not a replacement for Cursor Agent.
- A custom stream adapter avoids leaking malformed stdout lines that can contain
  tool args or MCP env values into logs.
- It is the best chance to preserve user settings, MCP, rules, AGENTS.md, and
  skills because Cursor itself remains the host that loads them.
- ACP gives a real client/server interaction model for prompts, updates,
  approvals, cancellation, and session state.
- It fits the existing app architecture as a new runtime adapter instead of a
  UI-specific hack.

## Option Comparison

1. `agent acp` / `cursor-agent acp` plus official
   `@agentclientprotocol/sdk` and local redacted stream adapter
   🎯 9   🛡️ 8   🧠 7
   Estimated changed lines: 950-1,600 MVP, 1,600-2,600 robust.

   Best long-term path. Build a JSON-RPC stdio client, initialize the ACP
   server, create sessions, send prompts, translate session updates, surface
   approvals, handle cancellation, and persist enough runtime identity to
   recover or mark sessions stale honestly. Pin the SDK version exactly because
   it is still pre-1.0.

2. `cursor-agent acp` plus a custom JSON-RPC client
   🎯 7   🛡️ 7   🧠 8
   Estimated changed lines: 1,200-2,100.

   Avoids a new dependency and can use the existing JSON-RPC tooling, but we
   must implement method routing, schema validation, request correlation,
   cancellation, and compatibility handling ourselves. This is only better if
   the SDK blocks Bun/Node stream integration or ships a breaking regression.

3. Local Cursor CLI headless print mode (`agent -p --output-format stream-json`)
   🎯 8   🛡️ 6   🧠 4
   Estimated changed lines: 450-800.

   Fastest MVP and closest to the Codex native pattern. Good for one-shot turns
   and smoke tests. Weaker for durable teammate sessions, approval flows,
   resumability, and precise control over interactive state.

Rejected path: Cursor Cloud Agents API / remote SDK-style integration
🎯 4   🛡️ 4   🧠 6
Estimated changed lines: 700-1,300.

Not recommended for this feature. It may be useful later for background cloud
work, but it does not naturally satisfy "use my local Cursor settings, MCP,
rules, and skills". It also creates a separate auth and repository execution
surface.

## ACP Deep Dive

ACP means Agent Client Protocol. It is the same architectural idea as LSP, but
for coding agents:

- the app/editor/orchestrator is the ACP Client
- Cursor Agent is the ACP Agent
- the client launches the agent as a subprocess
- stdin/stdout carry newline-delimited JSON-RPC 2.0 messages
- stderr is only diagnostics/logging

The core flow:

```text
spawn cursor-agent acp
client -> agent: initialize
agent -> client: protocol version, capabilities, auth methods
client -> agent: authenticate, if required
client -> agent: session/new with absolute cwd and MCP servers
agent -> client: sessionId
client -> agent: session/prompt
agent -> client: session/update notifications
agent -> client: session/request_permission requests
client -> agent: permission decision
client -> agent: session/cancel, when needed
agent -> client: final stopReason
```

ACP is useful for this project because it gives structured events instead of PTY
scraping:

- assistant/user message chunks
- tool call lifecycle
- permission requests
- plan updates
- file-system requests
- terminal requests
- cancellation
- session creation/loading/resume when supported

Important implementation detail: ACP is bidirectional. We are not only sending
prompts to Cursor. Cursor can call back into us:

- `session/request_permission` must map to existing permission mode semantics.
- `fs/read_text_file` and `fs/write_text_file` should be implemented only if we
  are ready to enforce project boundaries and track writes.
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
  `terminal/kill`, and `terminal/release` should map to existing shell/process
  utilities so the orchestrator can observe and cancel commands.

MVP capability posture:

- Phase 1 should advertise minimal client capabilities, then run a smoke prompt.
- Phase 2 should add permission handling and read/write file methods.
- Phase 3 should add terminal methods and app-owned MCP injection.
- Phase 4 should attempt session load/resume only after runtime probes prove the
  installed Cursor Agent supports them correctly.

SDK decision:

- Use `@agentclientprotocol/sdk` for `ClientSideConnection`, schemas, and
  request correlation.
- Do not use SDK `ndJsonStream` directly in production logs. Wrap stdio in a
  local stream implementation that validates one newline-delimited JSON-RPC
  message per line and redacts malformed payloads.
- Keep it behind `src/services/cursorAgent/acpClient.ts`; domain/application
  code should never import the SDK directly.
- Pin the exact version tested, initially `0.20.0`, because the package is
  official but still pre-1.0.
- Keep a thin fallback abstraction around the process streams so we can replace
  the SDK with manual JSON-RPC if it breaks on Bun/Windows.

## Runtime Provider Changes

Expected provider registry changes:

- Add `cursor` to `RuntimeProviderId`.
- Add Cursor backend ids:
  - `cursor-cli-acp`
  - `cursor-cli-headless`
- Add a resolver, likely `cursorBackendResolver.ts`, with:
  - binary discovery for `CLAUDE_CODE_CURSOR_AGENT_BIN`, `agent`,
    `cursor-agent`, a managed ACP Registry package if explicitly enabled, and
    only then a verified `cursor agent` fallback
  - version detection
  - auth state classification
  - settings-readiness diagnostics
  - explicit degraded states when Cursor is installed but Agent CLI is missing
- Add provider capabilities:
  - `teamLaunch: true` only when ACP is ready
  - `oneShot: true` when print mode is ready
  - `extensions.mcp: read-only/provider-scoped`
  - `extensions.skills: read-only/provider-scoped`
  - `extensions.plugins: read-only/provider-scoped`
  - `extensions.apiKeys: read-only/provider-scoped`

## Feature Module Shape

Preferred implementation shape:

```text
src/features/cursorAgentSupport/
  domain/
    types.ts
    runtimeReadiness.ts
  application/
    loadCursorAgentStatus.ts
    launchCursorAgentSession.ts
    sendCursorAgentPrompt.ts
    cancelCursorAgentTurn.ts
  ports/
    CursorAgentPorts.ts
  adapters/
    cliAcp/
      CursorCliAcpAdapter.ts
    cliHeadless/
      CursorCliHeadlessAdapter.ts
  index.ts
```

Runtime services:

```text
src/services/cursorAgent/
  cliDiscovery.ts
  cursorRuntimeResolver.ts
  cursorSettingsProbe.ts
  cursorAuthProbe.ts
  acpProcess.ts
  acpStream.ts
  acpClient.ts
  acpSessionBridge.ts
  acpPermissionBridge.ts
  acpMcpProbe.ts
  acpEventTranslator.ts
  acpSessionStore.ts
  cursorHeadlessRunner.ts
  streamJsonMapper.ts
```

The feature module owns product language and use cases. Runtime services own
process, stdio, JSON-RPC, Cursor-specific settings probing, and event mapping.

## Settings, MCP, Rules, and Skills Policy

The default integration must be read-only toward user-owned Cursor state:

- Detect and report `~/.cursor/mcp.json` and project `.cursor/mcp.json`.
- Detect project `.cursor/rules`, root `AGENTS.md`, and legacy `.cursorrules`.
- Detect likely skill roots:
  - `.cursor/skills`
  - `.agents/skills`
  - `~/.cursor/skills`
  - `~/.agents/skills`
- Do not mutate these locations unless the user explicitly runs a setup action.
- Do not persist raw secrets from Cursor config, MCP env blocks, or auth stores.
- Do not claim MCP/skills are active only because files exist. Prefer probing
  via Cursor CLI commands when available, for example `cursor-agent mcp list`.
- Do not set `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR` during real user runs.
  Those env vars are valid for isolated tests/probes, but setting them in
  production would bypass the user's Cursor state.

App-owned MCP strategy:

- Preferred: let Cursor load user/project MCP naturally.
- If the app-owned `agent-teams` MCP must be injected, first try an explicit
  temporary Cursor MCP config path only if the Cursor CLI command supports it
  for the selected mode.
- If ACP does not honor runtime MCP injection reliably, require an explicit
  user-approved setup action that writes project-owned `.cursor/mcp.json`, or
  keep the provider in a degraded "MCP not attached" state.

## Important Risks

- ACP support is newer than print mode. Schema and event names may drift, so
  the adapter must ignore unknown fields and fixture-test transcripts.
- The official TypeScript SDK is still pre-1.0. Pin the exact version and hide
  it behind a local adapter boundary.
- Cursor Agent CLI may not be installed even when the Cursor editor is installed.
  On this Windows machine, `cursor` 3.0.16 exists, while `cursor-agent` and
  `agent` are not in PATH.
- Cursor ACP had recent MCP/session-load regressions reported in March 2026.
  Community follow-up says MCP was working again by April 12, 2026, but runtime
  probes must verify MCP and session-load behavior for the installed binary.
- ACP is bidirectional. Cursor may call back into the client for permissions,
  filesystem, and terminal operations. The adapter must not advertise
  capabilities until the app can enforce policy for them.
- The SDK `ndJsonStream` helper logs malformed stdout lines directly. Use a
  local stream adapter with redaction instead of letting raw runtime output reach
  diagnostics.
- Cursor Skills recently moved into stable/CLI support. Skill detection should
  be reported as observed/read-only, not as app-managed.
- Local user MCP config can contain secret environment variables. Diagnostics
  must show only counts, names, and paths, not raw env values.
- Headless print mode can require `--force` or configured approval rules for
  non-interactive MCP/tool execution. ACP is a better place to surface approvals.

## Non-Goals

- Do not reverse-engineer Cursor private APIs.
- Do not make Cloud Agents API the default implementation path.
- Do not silently convert Claude/Codex/OpenAI skills into Cursor skills.
- Do not silently edit global Cursor settings, auth, or MCP config.
- Do not block other runtime providers on Cursor availability.

## Rollout

- Add feature flag: `CURSOR_AGENT_SUPPORT`.
- Add environment override for backend selection, for example
  `CLAUDE_CODE_CURSOR_BACKEND=cursor-cli-acp|cursor-cli-headless`.
- Add binary override for testing and non-standard installs, for example
  `CLAUDE_CODE_CURSOR_AGENT_BIN`.
- Start with provider status and one-shot smoke path.
- Then enable ACP session launch behind the flag.
- Keep headless print mode as fallback and diagnostics even after ACP ships.
- Kill switch should remove Cursor from selectable launch targets without
  breaking existing Codex/OpenCode/Gemini/Anthropic flows.

## Validation

- Unit tests:
  - binary discovery and fallback order
  - auth/readiness resolver
  - settings probe with secret redaction
  - MCP/rules/skills status mapping
  - ACP JSON-RPC message parsing
  - stream-json event mapping
- Integration tests:
  - gated by detected Cursor Agent CLI
  - `cursor-agent mcp list` or equivalent status probe
  - headless smoke prompt in a temp project
  - ACP initialize/session/prompt/cancel transcript
- Manual checks:
  - project `.cursor/mcp.json` is observed
  - global `~/.cursor/mcp.json` is observed without leaking secrets
  - root `AGENTS.md` affects Cursor agent behavior
  - `.cursor/skills/<skill>/SKILL.md` is visible to Cursor when supported
  - provider registry marks missing binary/auth/MCP honestly
