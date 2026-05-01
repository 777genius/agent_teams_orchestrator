# ACP Architecture Fit

Status: research decision note

Checked: 2026-04-28

## Short Decision

ACP fits this orchestrator, but not as a Cursor-only implementation detail.
The clean fit is:

```text
feature/use cases
  -> runtime/provider ports
    -> generic ACP runtime service
      -> provider profile: cursor, opencode-acp, codex-acp, gemini-acp, etc.
```

For Cursor, build Cursor support as the first ACP provider profile, while the
process protocol, stream parsing, JSON-RPC lifecycle, permission bridge,
session store, and event translation live in a generic ACP runtime layer.

Recommended shape:

1. Generic `src/services/acpRuntime/` plus Cursor profile
   🎯 9   🛡️ 8   🧠 7
   Estimated changed lines: 1,600-2,800.

2. Cursor-only ACP adapter with a hidden generic interface
   🎯 8   🛡️ 7   🧠 5
   Estimated changed lines: 1,000-1,800.

3. Universal ACP registry integration for all agents now
   🎯 6   🛡️ 6   🧠 9
   Estimated changed lines: 2,800-5,000.

Use option 1. Option 2 is acceptable only for a very fast Cursor MVP. Option 3
is too broad for the first safe slice because ACP agent quality, auth behavior,
MCP behavior, and session persistence differ by runtime.

## Why ACP Fits

ACP's runtime shape is close to the existing OpenCode integration, not the
current Codex native path.

OpenCode already has the concepts ACP needs:

- runtime host/session lifecycle
- durable session records
- app-owned MCP readiness checks
- stale-session classification
- permission answering
- transcript/event projection
- runtime-specific adapter boundaries

Codex native is useful as a fallback pattern only:

- one-shot CLI process
- JSON stream projection into `SDKMessage`
- sandbox/permission mode mapping
- direct QueryEngine routing

Cursor ACP is stateful and bidirectional. It has to receive callbacks from the
agent, not just parse stdout. That makes it a session bridge, not a simple
runner.

## Hard Fit Matrix

| Area | Fit | Required change |
| --- | --- | --- |
| Feature architecture | Strong | Put product use cases in `src/features/cursorAgentSupport/` or `src/features/acpRuntimeSupport/`; keep SDK/process details out of domain. |
| Runtime ownership rules | Strong | Leave Cursor config/auth/MCP/rules/skills user-owned by default. Never set `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR` in production unless user requests isolated profile. |
| Runtime provider registry | Partial | Current backend ids are Codex/Gemini-only. Add agent backend ids or make backend ids provider-scoped. |
| QueryEngine direct path | Partial | Works for one-shot fallback. Not the right first home for durable ACP teammate sessions. |
| OpenCode session bridge | Strong | Best local pattern for ACP process/session lifecycle, app MCP checks, stale state, and event projection. |
| OpenCode provider management feature | Weak to partial | Its UI/domain is for OpenCode LLM providers, not agent runtimes. Reuse patterns, do not cram ACP into it. |
| Permissions | Partial | Existing permission modes can map to ACP permission decisions, but ACP also has runtime-provided options and callback methods. |
| MCP control plane | Strong with probe | ACP supports `mcpServers` at session setup, but Cursor had recent MCP regressions. Team launch must require an active probe. |
| Process utilities | Strong | Existing portable CLI and process-tree kill utilities fit ACP stdio process management well. |
| Skills/rules/settings | Strong | ACP lets Cursor remain the owner, so user settings can load naturally through the Cursor agent process. |

## Current Architecture Pressure Points

### RuntimeBackendId Is Too Narrow

Current types are:

```text
RuntimeProviderId = anthropic | codex | gemini | opencode
RuntimeBackendId = GeminiRuntimeBackendId | CodexRuntimeBackendId
```

That means OpenCode is already outside the backend-id model, and ACP would make
this worse. Cursor needs at least:

```text
cursor-cli-acp
cursor-cli-headless
```

ACP later may need:

```text
opencode-acp
codex-acp
gemini-acp
claude-acp
```

So the architecture should move to provider-scoped backend ids:

```ts
type RuntimeProviderId =
  | 'anthropic'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'

type RuntimeBackendId =
  | GeminiRuntimeBackendId
  | CodexRuntimeBackendId
  | OpenCodeRuntimeBackendId
  | CursorRuntimeBackendId
  | AcpRuntimeBackendId
```

Do not use an uncontrolled string like `acp:${string}` in domain UI state. Use
typed provider profiles internally, then expose stable backend ids in status.

### Runtime Status Diagnostics Need More Dimensions

Current external diagnostics are close to binary checks. ACP needs separate
readiness dimensions:

- binary discovery
- protocol initialize
- auth state
- provider settings visibility
- user MCP visibility
- app-owned MCP probe
- session load/resume support
- permission callback support
- filesystem/terminal callback support

This does not mean the existing status model is wrong. It means Cursor ACP
should publish richer diagnostics under `externalRuntimeDiagnostics` and
`runtimeCapabilities`, while keeping the top-level status simple.

### Runtime Provider Management Is Not The ACP Feature

`src/features/runtimeProviderManagement/` is OpenCode-specific today:

```text
ProviderManagementRuntimeId = 'opencode'
```

That feature manages model providers inside OpenCode. ACP support manages agent
runtimes themselves. These are different concepts:

- OpenCode provider management: "which LLM provider/model does OpenCode use?"
- ACP runtime support: "which coding agent process can the orchestrator launch?"

The UI patterns are reusable, but the domain should not be reused directly.

## Correct Layering

### Generic ACP Runtime Service

```text
src/services/acpRuntime/
  acpAgentProfile.ts
  acpClient.ts
  acpConnection.ts
  acpEventTranslator.ts
  acpMcpProbe.ts
  acpPermissionBridge.ts
  acpProcess.ts
  acpSessionBridge.ts
  acpSessionStore.ts
  acpStream.ts
  acpTypes.ts
```

Responsibilities:

- spawn and kill ACP subprocesses
- validate newline-delimited JSON-RPC
- initialize protocol and cache capabilities
- create/load/resume sessions only after capability probes
- pass app-owned MCP config through `session/new` where supported
- translate ACP updates into canonical app events
- answer permission requests from app policy
- reject filesystem and terminal callbacks until policy is implemented
- persist runtime identity and mark stale sessions honestly
- redact malformed stdout, stderr, auth URLs, tokens, and MCP env values

### Cursor Provider Profile

```text
src/services/cursorAgent/
  cursorAgentProfile.ts
  cursorAuthProbe.ts
  cursorCliDiscovery.ts
  cursorHeadlessRunner.ts
  cursorMcpStatusProbe.ts
  cursorRuntimeResolver.ts
  cursorSettingsProbe.ts
  cursorStreamJsonMapper.ts
```

Responsibilities:

- discover `agent` and `cursor-agent`
- reject regular editor `cursor agent acp` unless a smoke test proves ACP
- classify auth without silently starting browser login
- detect Cursor settings/rules/skills/MCP as read-only diagnostics
- run headless `--output-format stream-json` as fallback or smoke path
- provide Cursor-specific defaults, labels, and degraded reasons

### Cursor Feature Module

```text
src/features/cursorAgentSupport/
  domain/
  application/
  ports/
  adapters/
  index.ts
```

Responsibilities:

- product language and readiness view
- launch/send/cancel use cases
- provider-specific user actions, for example "open Cursor login"
- no direct SDK imports
- no raw child process operations

### Optional Generic Feature Later

After Cursor works, promote shared product surfaces into:

```text
src/features/acpRuntimeSupport/
```

This should happen only after one real provider proves the contracts. Otherwise
the generic feature will become speculative.

## Core Contracts

Use local contracts between feature/application and service adapters. Hide ACP
SDK types behind services.

```ts
type AcpAgentProfile = {
  agentId: string
  displayName: string
  backendId: string
  discovery: AcpAgentDiscoveryPolicy
  auth: AcpAgentAuthPolicy
  settings: AcpAgentSettingsPolicy
  supportsHeadlessFallback: boolean
}
```

```ts
type AcpRuntimeStatus = {
  agentId: string
  backendId: string
  state:
    | 'ready'
    | 'runtime-missing'
    | 'authentication-required'
    | 'mcp-degraded'
    | 'degraded'
    | 'error'
  binaryPath: string | null
  version: string | null
  protocolVersion: number | null
  authMethods: string[]
  capabilities: AcpRuntimeCapabilitySummary
  diagnostics: RedactedRuntimeDiagnostic[]
}
```

```ts
type AcpSessionRecord = {
  agentId: string
  backendId: string
  teamId: string
  laneId: string
  memberName: string
  projectPath: string
  processKey: string
  runtimePid: number | null
  acpSessionId: string
  agentVersion: string | null
  capabilityFingerprint: string
  settingsFingerprint: string | null
  authFingerprint: string | null
  lastKnownDurableState: string | null
  staleReason: string | null
  createdAt: string
  updatedAt: string
}
```

```ts
type AcpPermissionDecision = {
  requestId: string
  optionId: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'cancelled'
  reason: string | null
}
```

These contracts mirror the OpenCode session record pattern but avoid embedding
Cursor-specific names in generic runtime state.

## MCP Fit

ACP has a strong conceptual fit for the app-owned MCP control plane:

```text
session/new({ cwd, mcpServers: [...] })
```

But Cursor is the risky provider here. The ACP spec says clients can include MCP
servers and all agents must support stdio MCP transport. Cursor ACP had a March
2026 bug where `mcpServers` and static config were ignored in ACP mode; a user
confirmed it working again on 2026-04-12. That makes runtime probing mandatory.

Required behavior:

- do not trust `initialize.agentCapabilities.mcpCapabilities` alone
- start a deterministic app-owned test MCP
- pass it into `session/new`
- verify Cursor actually connects or calls the marker tool
- cache result by agent version and platform
- mark team launch degraded if app-owned MCP is not proven

This matches the OpenCode architecture, where the app-owned MCP is not assumed
present just because the runtime exists.

## Permission Fit

ACP permission callbacks can map to existing modes, but not one-to-one.

Recommended policy:

- `plan`, `default`, `auto`, `bubble`: do not auto-approve dangerous options
- `acceptEdits`: allow workspace file edits after path validation
- `dontAsk`, `bypassPermissions`: may auto-allow, but still enforce workspace,
  terminal cleanup, and audit logging
- cancellation: answer every pending ACP permission with `cancelled`

Do not advertise ACP filesystem or terminal client capabilities until the app
can enforce:

- absolute path checks
- project boundary checks
- write tracking
- terminal output truncation
- process-tree kill on cancel/release
- permission policy at callback level

## QueryEngine Fit

ACP can eventually drive a QueryEngine turn because QueryEngine already yields
`SDKMessage`. However, making Cursor ACP a primary QueryEngine branch first
would skip the hard parts of team sessions:

- durable teammate identity
- app-owned MCP proof
- runtime permissions
- stale-session behavior
- process retention and cancellation

Use QueryEngine integration only for:

- headless one-shot fallback
- future single-agent chat provider routing

For team launch, ACP should start in the bridge layer, closer to OpenCode.

## Why Not Replace OpenCode Direct With ACP

ACP should become an additional backend, not a replacement for direct OpenCode.

Direct OpenCode currently gives the app deeper provider-management and host
control than generic ACP:

- managed provider inventory
- provider auth setup
- runtime-specific model catalog
- HTTP host APIs
- direct MCP attach and status checks
- OpenCode-specific offline/stale recovery

ACP gives portability across agents, but generic portability means less
provider-specific control unless the agent exposes extensions. Later,
`opencode-acp` can be offered as a portability backend while keeping direct
OpenCode as the deeper native backend.

Recommended OpenCode position:

1. Keep direct OpenCode as default for OpenCode-specific workflows.
   🎯 9   🛡️ 9   🧠 3
   Estimated changed lines: 0-150 for status/label adjustments.

2. Add `opencode-acp` later as compatibility backend.
   🎯 7   🛡️ 7   🧠 6
   Estimated changed lines: 500-1,000 after generic ACP exists.

3. Replace direct OpenCode with ACP.
   🎯 3   🛡️ 4   🧠 8
   Estimated changed lines: 1,200-2,200 plus behavior regressions.

Do not choose option 3.

## What Not To Do

- Do not put generic ACP protocol code inside `src/services/cursorAgent/`.
- Do not import ACP SDK types into feature domain/application.
- Do not use ACP Registry metadata as proof that an agent works for team launch.
- Do not silently call Cursor ACP `authenticate`; it can start browser login.
- Do not set `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR` during real user runs.
- Do not silently edit global Cursor MCP, skills, rules, or auth.
- Do not advertise filesystem/terminal callbacks before policy enforcement.
- Do not collapse direct OpenCode into ACP.

## Delivery Plan

### Phase 1: Runtime Types And Cursor Readiness

🎯 9   🛡️ 8   🧠 4

Estimated changed lines: 350-650.

- add `cursor` provider id
- add provider-scoped backend ids
- add Cursor binary discovery
- add ACP initialize smoke with timeout
- classify missing binary/auth/degraded states
- show Cursor settings/MCP/rules/skills as read-only diagnostics

### Phase 2: Generic ACP Process And Session MVP

🎯 9   🛡️ 8   🧠 6

Estimated changed lines: 650-1,150.

- add `src/services/acpRuntime/`
- spawn `agent acp` or `cursor-agent acp`
- use SDK behind a local adapter
- use local redacted NDJSON stream adapter
- implement initialize, session/new, session/prompt, session/cancel
- map session updates into canonical events
- persist enough session identity to mark stale state correctly

### Phase 3: Permissions And App-Owned MCP Probe

🎯 8   🛡️ 8   🧠 8

Estimated changed lines: 900-1,600.

- implement `session/request_permission`
- add pending-permission cancellation
- run deterministic app-owned MCP probe
- degrade team launch if probe fails
- add fixture tests for Cursor ACP transcripts
- redact auth URLs, MCP env values, tool args, stderr, and malformed stdout

### Phase 4: Controlled Filesystem/Terminal Callbacks

🎯 7   🛡️ 7   🧠 8

Estimated changed lines: 800-1,500.

- advertise `fs/read_text_file` after read policy exists
- advertise `fs/write_text_file` after write policy exists
- advertise terminal only after process cleanup and output caps exist
- reuse process-tree kill and shell utilities
- add out-of-workspace rejection tests

### Phase 5: Additional ACP Agents

🎯 7   🛡️ 7   🧠 7

Estimated changed lines: 400-900 per agent profile after generic ACP.

- add `opencode-acp` only as an optional backend
- add `codex-acp` only if it provides value over existing Codex native
- add `gemini-acp` only if auth/MCP/session probes are reliable
- keep each provider profile explicit

## Final Assessment

ACP is architecturally compatible with this project if it is treated as a
runtime protocol family. It is not architecturally clean if implemented as a
Cursor-specific stdout parser or buried inside runtime provider management.

The strongest path is generic ACP infrastructure plus one Cursor provider
profile. That preserves the current feature architecture, gives Cursor the
ability to load user-owned settings/MCP/rules/skills naturally, and creates a
future path for Codex/OpenCode/Gemini/Claude ACP agents without replacing the
native integrations that are already deeper.

## Sources

- ACP overview: https://agentclientprotocol.com/protocol/overview
- ACP transports: https://agentclientprotocol.com/protocol/transports
- ACP session setup and MCP: https://agentclientprotocol.com/protocol/session-setup
- ACP TypeScript SDK: https://agentclientprotocol.com/libraries/typescript
- ACP Registry: https://agentclientprotocol.com/get-started/registry
- Cursor ACP docs: https://cursor.com/docs/cli/acp
- Cursor CLI MCP docs: https://docs.cursor.com/cli/mcp
- Cursor skills and CLI changelog: https://cursor.com/changelog/2-4
- Cursor ACP MCP regression thread:
  https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623
