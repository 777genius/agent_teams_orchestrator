# Cursor ACP Design Notes

Status: research notes

Checked: 2026-04-28

## Current Recommendation

Use `cursor-agent acp` as the runtime, and use
`@agentclientprotocol/sdk@0.20.0` behind a local adapter boundary.

Refinement after deeper research: use the SDK for typed protocol methods and
schema validation, but prefer a local ACP stream adapter instead of directly
using SDK `ndJsonStream`. The SDK parser writes malformed stdout lines to
`console.error`; in this project malformed runtime output should be redacted and
classified as diagnostics because MCP config and tool args can contain secrets.

🎯 9   🛡️ 8   🧠 7

Estimated changed lines: 950-1,600 MVP, 1,600-2,600 robust.

## Protocol Facts

- ACP protocol version is currently `1` in the TypeScript SDK schema.
- ACP transport is newline-delimited JSON-RPC 2.0 over stdio.
- The client launches the agent subprocess. For Cursor this is
  `cursor-agent acp`.
- Cursor is listed in the official ACP Registry with platform-specific
  `cursor-agent` binaries and `args: ["acp"]`.
- The latest core ACP release found through GitHub is `v0.12.2`, published
  2026-04-23.
- The latest official TypeScript SDK found through npm is `0.20.0`, published
  2026-04-23. It is Apache-2.0 and has only a `zod` peer dependency compatible
  with the repo's `zod@4`.
- Cursor's January 2026 CLI changelog says `agent` is now the primary CLI
  entrypoint and `cursor-agent` is a backward-compatible alias. The ACP
  Registry package still exposes `cursor-agent`.

## Verified Cursor Package Behavior

The official ACP Registry Windows x64 archive was fetched from the registry
URL into a temp directory and inspected without installing it globally.

Observed package facts:

- Version: `2026.03.30-a5d3e17`.
- Entrypoint: `dist-package/cursor-agent.cmd`.
- ACP command help: `cursor-agent.cmd acp --help` prints "Start the Cursor
  Agent as an ACP (Agent Client Protocol) server".
- The package carries its own `node.exe`, `rg.exe`, `cursorsandbox.exe`,
  SQLite native module, and bundled JS runtime.
- `cursor-agent.cmd --help` reports command name `agent`, which matches the
  newer CLI naming.

Observed help flags relevant to this integration:

- `--api-key <key>` and `CURSOR_API_KEY`.
- `-p, --print` for non-interactive mode.
- `--output-format text|json|stream-json`.
- The inspected package shows `--output-format` default as `text`, so the
  headless fallback must explicitly pass `--output-format stream-json`.
- `--mode plan|ask` and `--plan`.
- `--model`, `--list-models`, `models`.
- `--force` / `--yolo`.
- `--sandbox enabled|disabled`.
- `--approve-mcps`.
- `--trust` for print/headless mode.
- `--workspace <path>`.
- `--worktree [name]`.

Real ACP `initialize` result from the package:

- `protocolVersion: 1`.
- `agentCapabilities.loadSession: true`.
- `agentCapabilities.mcpCapabilities.http: true`.
- `agentCapabilities.mcpCapabilities.sse: true`.
- `agentCapabilities.promptCapabilities.image: true`.
- `agentCapabilities.promptCapabilities.audio: false`.
- `agentCapabilities.promptCapabilities.embeddedContext: false`.
- `authMethods` contains `cursor_login`.

Important auth finding:

- `session/new` before authentication returns `Authentication required`.
- Calling ACP `authenticate` with `cursor_login` without an existing login tries
  to start the browser login flow. The app must never call this silently during
  provider status probing or background team launch.
- A status/auth probe must be timeout-bound and classified as
  `authentication-required`, `unknown`, or `ready` without logging login URLs or
  auth challenges.

Package string inspection also found:

- `CURSOR_CONFIG_DIR` overrides the default config root.
- `CURSOR_DATA_DIR` overrides the default data root.
- Cursor reads `~/.cursor/mcp.json` and `<workspace>/.cursor/mcp.json`.
- Cursor watches/loads `.cursor/rules/**/*.mdc`, `AGENTS.md`, `CLAUDE.md`,
  `CLAUDE.local.md`, and `.cursorrules`.
- Cursor discovers `SKILL.md` files.

Production implication: do not set `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR`
by default. Use them only for isolated probes/tests where we intentionally do
not want to touch user state.

## Client And Agent Roles

In this project:

```text
agent_teams_orchestrator = ACP Client
cursor-agent acp         = ACP Agent
```

This matters because ACP is bidirectional:

- We send agent methods: `initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/cancel`, optionally `session/load`,
  `session/resume`, `session/close`, `session/set_config_option`.
- Cursor sends client methods/notifications back to us:
  `session/update`, `session/request_permission`, optional filesystem methods,
  and optional terminal methods.

The adapter must therefore own both outbound requests and inbound callbacks.

## Runtime Flow

Preferred flow for a first robust implementation:

```text
discover cursor-agent
spawn cursor-agent acp
initialize(protocolVersion: 1, clientInfo, minimal clientCapabilities)
inspect agentInfo, authMethods, agentCapabilities
if auth required, expose terminal/agent auth setup state without starting login
authenticate only after an explicit user action or when a prior login is known
session/new({ cwd, mcpServers })
session/prompt({ sessionId, prompt: [{ type: "text", text }] })
translate session/update notifications into canonical events
answer session/request_permission from app permission policy
on cancel, send session/cancel and mark pending permissions cancelled
on final prompt response, map stopReason to durable turn state
```

## Capability Policy

Do not advertise capabilities before the app can enforce them.

Recommended phases:

1. Minimal ACP smoke
   🎯 9   🛡️ 8   🧠 4
   Estimated changed lines: 350-650.

   Advertise no filesystem and no terminal capability. Verify initialize,
   session/new, session/prompt, session/update, and final `stopReason`.

2. Permissions and event bridge
   🎯 9   🛡️ 8   🧠 6
   Estimated changed lines: 650-1,100.

   Implement `session/request_permission`, cancellation semantics, tool-call
   mapping, usage updates, plan updates, and durable turn status.

3. Controlled file/terminal callbacks
   🎯 7   🛡️ 7   🧠 8
   Estimated changed lines: 1,100-1,900.

   Advertise `fs.readTextFile`, then `fs.writeTextFile`, then `terminal`, only
   after path boundary checks, process cleanup, output truncation, and
   permission policy are wired.

Important risk: Cursor ACP may still have internal built-in Read/Write/Shell
tools even when the ACP client does not advertise filesystem/terminal
capabilities. Runtime probes must confirm whether all dangerous operations are
mediated through `session/request_permission` on the installed Cursor Agent.

## Permission Mapping

ACP permission options are runtime-provided choices:

- `allow_once`
- `allow_always`
- `reject_once`
- `reject_always`

Suggested mapping into existing app modes:

- `plan`, `default`, `auto`, `bubble`: do not auto-select dangerous options.
  Surface blocked state when Cursor requests permission.
- `acceptEdits`: allow file edits only if the request is clearly file-edit
  scoped and inside the workspace. Do not auto-allow arbitrary terminal.
- `dontAsk`, `bypassPermissions`: may select allow options, but still log the
  operation and enforce workspace/process cleanup boundaries.
- On cancellation: respond to every pending permission request with ACP
  `cancelled`.

Do not rely only on Cursor's permission prompts. `fs/write_text_file` and
`terminal/create` callbacks must enforce app policy even if Cursor does not
first call `session/request_permission`.

## MCP Strategy

ACP gives two MCP paths:

- Static Cursor config: Cursor's own `mcp.json` and user/project settings.
- Dynamic ACP config: `mcpServers` passed in `session/new`, `session/load`, or
  `session/resume`.

For this project:

- Preserve user settings by default. Let Cursor load its own config when it can.
- In production, keep Cursor's normal config/data roots. Do not set
  `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR` unless the user explicitly selects an
  isolated managed profile.
- Pass app-owned MCP servers through `mcpServers` only after converting to ACP
  shape and redacting all env values from diagnostics.
- Support stdio first because ACP requires stdio support from agents.
- Treat HTTP/SSE MCP as optional and only use if Cursor advertises and runtime
  probes prove it works.

⚠️ Critical probe requirement:

Cursor ACP had March 2026 reports where `mcpServers` and even static
`~/.cursor/mcp.json` were ignored in ACP mode, while capabilities still claimed
MCP support. A community follow-up on 2026-04-12 says MCP worked again. Because
of that, do not trust `initialize.agentCapabilities.mcpCapabilities` alone.

Probe plan:

1. Start a tiny app-owned MCP server with one deterministic tool.
2. Start `cursor-agent acp`.
3. `initialize`.
4. `session/new` with the test MCP in `mcpServers`.
5. Prompt Cursor to call the deterministic tool.
6. Verify server process connection or marker output.
7. Cache the result by Cursor Agent version and platform for a short TTL.

If the probe fails, mark Cursor as degraded for app-owned MCP instead of
silently launching teams without the required control plane.

## Settings, Rules, And Skills

Cursor should remain the owner of Cursor-specific state:

- user auth
- user rules
- project `.cursor/rules`
- project `AGENTS.md`
- project `CLAUDE.md` and `CLAUDE.local.md`
- legacy `.cursorrules`
- Cursor skills directories
- Cursor MCP config

The orchestrator should detect these as read-only diagnostics and should not
rewrite them silently.

The only acceptable write path is an explicit user-approved setup action. That
action should prefer project-owned config over global user config and must show
exactly what will be written.

For tests and runtime probes, the adapter may intentionally set
`CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` to temp directories. That must be
opt-in at the adapter call site so production runs cannot accidentally bypass
real user settings.

## Sessions

ACP supports session lifecycle methods, but Cursor-specific support must be
verified:

- `session/new` is baseline.
- `session/prompt` is baseline.
- `session/cancel` is baseline.
- `session/update` is baseline.
- `session/load`, `session/resume`, `session/list`, and `session/close` are
  optional or newer capability paths.

Recommended session strategy:

1. Long-lived process per active teammate/session
   🎯 8   🛡️ 8   🧠 6
   Estimated changed lines: 700-1,300.

   Most reliable first production shape. Avoids relying on `session/load` for
   every turn. Similar in spirit to OpenCode host/session retention, but with
   stdio process ownership instead of HTTP host ownership.

2. One shared ACP process per project with multiple sessions
   🎯 7   🛡️ 6   🧠 7
   Estimated changed lines: 900-1,600.

   Resource-efficient and aligned with ACP architecture, but increases blast
   radius if Cursor has per-process state bugs or one stuck session blocks the
   connection.

3. One process per turn with `session/load`
   🎯 5   🛡️ 4   🧠 5
   Estimated changed lines: 500-900.

   Attractive on paper, but currently too risky because Cursor ACP had recent
   `session/load` bug reports. Use only after runtime probes prove it.

## Event Translation

ACP `session/update` variants to map:

- `user_message_chunk`
- `agent_message_chunk`
- `agent_thought_chunk`
- `tool_call`
- `tool_call_update`
- `plan`
- `available_commands_update`
- `current_mode_update`
- `config_option_update`
- `session_info_update`
- `usage_update`

Map `PromptResponse.stopReason`:

- `end_turn` -> completed
- `cancelled` -> cancelled
- `refusal` -> refused/error-like user-visible stop
- `max_tokens` -> degraded/incomplete
- `max_turn_requests` -> degraded/incomplete

Known Cursor ACP caveat: March 2026 bug reports say some MCP tool-call events
had weak identity fields, for example generic titles or empty raw input. The UI
should render tool calls defensively and should not require tool name/raw input
for correctness.

## Binary Discovery

Recommended discovery order:

1. `CLAUDE_CODE_CURSOR_AGENT_BIN`
2. `agent` from PATH
3. `cursor-agent` from PATH
4. Managed ACP Registry binary, only if user explicitly opts into a managed
   install/download
5. `cursor agent` fallback only if a runtime smoke proves it actually starts ACP

Do not treat the regular Cursor editor CLI as sufficient. On this Windows
machine, `cursor` 3.0.16 exists, but `cursor-agent` and `agent` are not in PATH,
and `cursor agent acp --help` prints the editor CLI help instead of Agent ACP
help.

The resolver should verify the candidate by running `--version` and
`acp --help` with short timeouts. A candidate is usable only if `acp --help`
mentions ACP server mode or an equivalent recognized marker.

## SDK Integration

Use:

- `ClientSideConnection`
- exported ACP schema/types
- request/response validation

Avoid direct import outside:

```text
src/services/cursorAgent/acpClient.ts
src/services/cursorAgent/acpTypes.ts
```

Do not let feature domain/application import SDK types. Map SDK objects into
local domain types at the adapter boundary.

Implementation concerns:

- Node/Bun child process stdout/stdin are Node streams; SDK stream interfaces are
  WHATWG streams. The adapter must bridge them explicitly or provide a custom
  `Stream`.
- Custom `Stream` should redact malformed JSON lines before diagnostics.
- The connection must reject/settle pending requests on process exit.
- `stderr` should be captured separately with size limits and redaction.
- All `_meta` fields must be treated as untrusted opaque data.

## Proposed Service Shape

```text
src/services/cursorAgent/
  cliDiscovery.ts
  cursorRuntimeResolver.ts
  acpProcess.ts
  acpStream.ts
  acpClient.ts
  acpPermissionBridge.ts
  acpMcpProbe.ts
  acpSessionBridge.ts
  acpEventTranslator.ts
  acpSessionStore.ts
  cursorSettingsProbe.ts
```

## Implementation Blueprint

Recommended delivery slices:

1. Provider readiness and real binary diagnostics
   🎯 9   🛡️ 8   🧠 4
   Estimated changed lines: 300-550.

   Add `cursor` provider ids, resolver, registry status, binary verification,
   version capture, and auth-required classification. No prompt execution yet.

2. ACP session MVP
   🎯 9   🛡️ 8   🧠 6
   Estimated changed lines: 650-1,050.

   Add process lifecycle, redacted newline JSON-RPC stream, SDK boundary,
   initialize/auth-state handling, `session/new`, `session/prompt`, update
   translation, cancellation, and transcript projection.

3. Control-plane hardening
   🎯 8   🛡️ 8   🧠 8
   Estimated changed lines: 900-1,600.

   Add permission bridge, app-owned MCP runtime probe, session store, stale
   process handling, defensive tool-call rendering, and controlled fs/terminal
   callbacks only after policy checks are implemented.

Implementation classes should mirror existing runtime patterns:

- `cursorRuntimeResolver` should look like `codexBackendResolver`, but with
  multiple candidate binaries and explicit managed-registry diagnostics.
- `acpSessionBridge` should look closer to `OpenCodeSessionBridge` than to
  `codexNative/turnExecutor`, because Cursor ACP is stateful and bidirectional.
- `acpMcpProbe` should reuse the OpenCode idea of proving the app-owned MCP
  connection before enabling team launch.
- `acpEventTranslator` should be small and test-heavy, similar to
  `OpenCodeEventTranslator` and `codexNative/jsonlMapper`.

## Validation Matrix

- Binary discovery on Windows/macOS/Linux.
- `cursor-agent --version` capture.
- `cursor-agent acp` process starts and exits cleanly.
- `agent acp` and `cursor-agent acp` are both supported when present.
- Regular editor `cursor agent acp` is rejected unless a smoke test proves ACP.
- `initialize` response protocol version is supported.
- Auth-required path is classified without leaking tokens.
- ACP `authenticate` is never called from passive status probing.
- Login URLs/challenges are redacted from diagnostics.
- `session/new` requires absolute cwd.
- `session/prompt` receives `agent_message_chunk`.
- `session/cancel` returns final `cancelled` stop reason.
- Permission request is answered once and only once.
- Pending permissions are cancelled on abort.
- Malformed stdout is redacted.
- Stderr is capped and redacted.
- App-owned MCP probe succeeds before enabling team control.
- `session/load`/`session/resume` are runtime-probed before use.
- File and terminal callbacks reject out-of-workspace paths.
- Terminal commands are killed by process tree on release/cancel.
- Tool-call events with missing raw input still render and persist.

## Sources

- ACP protocol overview: https://agentclientprotocol.com/protocol/overview
- ACP initialization and capabilities:
  https://agentclientprotocol.com/protocol/initialization
- ACP session setup and MCP: https://agentclientprotocol.com/protocol/session-setup
- ACP prompt lifecycle: https://agentclientprotocol.com/protocol/prompt-turn
- ACP permissions/tool calls: https://agentclientprotocol.com/protocol/tool-calls
- ACP filesystem callbacks: https://agentclientprotocol.com/protocol/file-system
- ACP terminal callbacks: https://agentclientprotocol.com/protocol/terminals
- ACP session config options:
  https://agentclientprotocol.com/protocol/session-config-options
- ACP extensibility: https://agentclientprotocol.com/protocol/extensibility
- ACP TypeScript SDK: https://agentclientprotocol.com/libraries/typescript
- Cursor ACP Registry entry:
  https://github.com/agentclientprotocol/registry/blob/main/cursor/agent.json
- ACP Registry public index:
  https://agentclientprotocol.com/registry/index
- ACP Registry auth requirements:
  https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md
- Cursor CLI overview: https://docs.cursor.com/en/cli
- Cursor January 2026 CLI entrypoint changelog:
  https://cursor.com/changelog/cli-jan-08-2026
- Cursor 2.4 skills and CLI changelog:
  https://cursor.com/changelog/2-4
- Cursor rules: https://docs.cursor.com/context/rules-for-ai
- Cursor ACP MCP bug/fix thread:
  https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623
