# Runtime Provider Onboarding

This note explains how to add a new runtime provider to
`agent_teams_orchestrator`, and how desktop should integrate with it.

The short version: desktop can expose provider UI, settings, and launch controls,
but the orchestrator is the runtime authority. A provider is not first-class
until the orchestrator can report status, list models, validate auth, and execute
work through a concrete runtime path.

## Current Provider Layers

There are two provider layers. Do not merge them accidentally.

### 1. Top-level runtime providers

These are agent execution runtimes that can run team work:

- `anthropic`
- `codex`
- `gemini`
- `opencode`

The orchestrator owns these contracts in `src/services/runtimeBackends`.

A top-level runtime provider must answer this question:

> Can this runtime launch and observe agent work by itself?

If yes, it needs status, auth, model catalog, launch, transcript, stop/reconcile,
diagnostics, and tests in the orchestrator.

### 2. Nested runtime/model providers

These are model/API providers inside another runtime. Today this is mostly the
OpenCode provider-management surface under:

- `src/features/runtimeProviderManagement`
- `src/services/opencode`

A nested provider answers a different question:

> Can an existing runtime, usually OpenCode, use this API/model provider?

If yes, team launch still uses top-level `providerId: "opencode"`. The selected
model is provider-scoped inside OpenCode, for example
`openrouter/moonshotai/kimi-k2.5`.

## Research Snapshot - Kilo Code, 2026-05-18

Checked sources:

- Kilo Gateway docs: <https://kilo.ai/docs/gateway>
- Kilo Gateway models: <https://kilo.ai/docs/gateway/models-and-providers>
- Kilo Gateway API reference: <https://kilo.ai/docs/gateway/api-reference>
- Kilo Gateway auth: <https://kilo.ai/docs/gateway/authentication>
- Kilo CLI docs: <https://kilo.ai/docs/code-with-ai/platforms/cli>
- Kilo architecture docs: <https://kilo.ai/docs/contributing/architecture>
- OpenCode custom provider docs: <https://opencode.ai/docs/providers>
- npm package metadata for `@kilocode/cli@7.3.0` and `@kilocode/sdk@7.3.0`
- unpacked `@kilocode/sdk@7.3.0` package types and runtime JS

Verified facts:

- Kilo Gateway is an OpenAI-compatible API at
  `https://api.kilo.ai/api/gateway`.
- Gateway chat endpoint is `POST /chat/completions`.
- Gateway model catalog is `GET https://api.kilo.ai/api/gateway/models`.
- The model catalog does not require authentication.
- The model response uses `data[]` with fields such as `id`, `name`,
  `context_length`, `top_provider`, `pricing`, `supported_parameters`,
  `preferredIndex`, `isFree`, and `opencode`.
- Current important model ids include:
  - `kilo-auto/frontier`
  - `kilo-auto/balanced`
  - `kilo-auto/free`
  - `anthropic/claude-opus-4.7`
  - `anthropic/claude-sonnet-4.6`
  - `openai/gpt-5.4`
  - `moonshotai/kimi-k2.6`
- Kilo auto models support `x-kilocode-mode` for routing hints such as `plan`,
  `architect`, `orchestrator`, `debug`, `build`, `explore`, and `code`.
- Kilo CLI is a fork of OpenCode and supports OpenCode-style config.
- Kilo CLI supports at least:
  - `kilo`
  - `kilo run [message..]`
  - `kilo run --auto "Implement feature X"`
  - `kilo serve`
  - `kilo acp`
  - `kilo models [provider]`
  - `kilo auth`
- Kilo architecture docs say the CLI engine exposes HTTP + SSE and that clients
  communicate with it through `@kilocode/sdk`.
- `@kilocode/cli@7.3.0` exists, is MIT licensed, and exposes binaries:
  - `kilo`
  - `kilocode`
- `@kilocode/sdk@7.3.0` exists, is MIT licensed, and exports:
  - `createKilo()`
  - `createKiloServer()`
  - `createKiloClient()`
  - `createKiloTui()`
  - v1 and v2 typed clients
- `@kilocode/sdk` does not appear to bundle the CLI binary. Its server helper
  shells out to `kilo serve`, so the orchestrator must still resolve/install the
  `kilo` binary.
- The SDK default server helper starts `kilo serve` on `127.0.0.1:4096`, passes
  config through `KILO_CONFIG_CONTENT`, and waits for `kilo server listening on
  <url>`.
- The SDK client has useful runtime methods:
  - `client.session.create()`
  - `client.session.prompt()` and `client.session.promptAsync()`
  - `client.session.messages()`
  - `client.session.status()`
  - `client.session.abort()`
  - `client.session.diff()`
  - `client.permission.list()`
  - `client.permission.reply()`
  - `client.permission.allowEverything()`
  - `client.question.list()`
  - `client.question.reply()`
  - `client.provider.list()`
  - `client.provider.auth()`
  - `client.event.subscribe()` over SSE

## Kilo Decision

Kilo has two different integration surfaces:

1. **Kilo Gateway** - a model/API gateway.
2. **Kilo CLI** - an agent runtime built on an OpenCode-like engine.

Those should not be represented the same way.

Kilo Gateway is the fastest low-risk API path because it is OpenAI-compatible
and can be wired through the OpenCode provider path that is already built into
the orchestrator. It may still appear as a separate nested provider in OpenCode
provider management.

Kilo CLI/SDK is the richer and more flexible integration surface. `kilo serve`
plus `@kilocode/sdk` can use an existing Kilo account/subscription and gives us
sessions, SSE events, permissions, messages, provider auth, and more runtime
control. That is the stronger long-term path when the product goal is a real
top-level Kilo runtime, but it still needs a matching orchestrator runtime
adapter. Desktop-only status and a plain model catalog are not enough.

## Recommended Path

### Option 1 - Kilo Gateway as an OpenCode nested provider

🎯 8.7   🛡️ 8.3   🧠 4.5 - roughly 120-320 LOC.

This is the fastest first implementation if the goal is API access to Kilo
Gateway models from our existing team runtime.

Team launch remains:

```json
{
  "providerId": "opencode",
  "selectedModel": "kilocode/kilo-auto/frontier"
}
```

The nested OpenCode provider id should be something stable like `kilocode` or
`kilo-gateway`. The model id should stay as the real Kilo model id, for example
`kilo-auto/frontier` or `anthropic/claude-sonnet-4.6`. The provider-scoped value
then becomes `kilocode/kilo-auto/frontier`.

This repository already handles nested slashes in OpenCode model ids:

- `src/services/opencode/OpenCodeModelResolver.ts` splits provider scope on the
  first slash only.
- `src/services/opencode/OpenCodeBridgeCommandHandler.test.ts` has coverage for
  provider-scoped ids such as `openrouter/moonshotai/kimi-k2`.

Required work:

- Add a Kilo Gateway provider inventory entry to OpenCode provider management.
- Fetch the Kilo model catalog from `GET /models` without requiring an API key.
- Use `name`, not `display_name`, for display names.
- Preserve model ids exactly, including nested slash ids.
- Map `context_length` / `top_provider.context_length` and
  `top_provider.max_completion_tokens` into model metadata where possible.
- Prefer `preferredIndex` for ordering, then name/id fallback.
- Store/use `KILO_API_KEY` for authenticated probes and launch.
- Optionally support organization routing through a header such as
  `X-KiloCode-OrganizationId`, but keep it out of the first implementation unless
  product needs it.
- Run `runtime providers test-model --runtime opencode --provider kilocode
  --model <model>` before saving a default.
- Keep `RuntimeProviderId` unchanged. This is still top-level `opencode`.

OpenCode config shape to validate with a live probe:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kilocode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kilo Gateway",
      "options": {
        "baseURL": "https://api.kilo.ai/api/gateway",
        "apiKey": "{env:KILO_API_KEY}"
      },
      "models": {
        "kilo-auto/frontier": {
          "name": "Auto Frontier",
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        }
      }
    }
  }
}
```

⚠️ Probe note: Kilo's own docs show Vercel `createOpenAI()` from
`@ai-sdk/openai`, while OpenCode's custom-provider docs recommend
`@ai-sdk/openai-compatible` for OpenAI-compatible chat-completions providers.
Use the OpenCode probe as the source of truth. If `@ai-sdk/openai-compatible`
fails against Kilo Gateway, try `@ai-sdk/openai` before changing the architecture.

Why this path is strongest:

- It matches what Kilo Gateway is: a gateway/model provider, not an agent runtime.
- It reuses the existing OpenCode host/session/projection/cleanup code.
- It avoids inventing a second OpenAI-compatible runtime contract in the
  orchestrator.
- It keeps desktop honest: launch is enabled only when OpenCode can actually use
  the provider/model.

Main risks:

- OpenCode package choice may need one live compatibility adjustment.
- Kilo auto/free models may route to providers with different data-handling
  policies. Do not silently choose free models for production team runs.
- Auth can look connected in desktop but not reach the OpenCode process if env
  injection is not wired into the managed OpenCode profile.

### Option 2 - Kilo CLI as a top-level runtime via `@kilocode/sdk` and `kilo serve`

🎯 7.5   🛡️ 7.2   🧠 8.0 - roughly 900-1,800 LOC.

This is the right path if the product needs Kilo's own agent runtime, sessions,
Gateway/team features, Kilo-specific tools, or Cloud/remote behavior.

This should be modeled as a sibling to the OpenCode adapter:

```text
RuntimeProviderId = "kilocode"
KiloCodeHostManager
KiloCodeSessionBridge
KiloCodeProvisioningProbe
KiloCodeTranscriptProjector
KiloCodeRuntimeAdapter
```

Use `@kilocode/sdk` as the first-class integration surface:

```ts
import { createKiloServer, createKiloClient } from "@kilocode/sdk"

const server = await createKiloServer({
  hostname: "127.0.0.1",
  port,
  config,
  signal,
})

const client = createKiloClient({
  baseUrl: server.url,
  directory: projectPath,
})

const session = await client.session.create({
  directory: projectPath,
  title: memberName,
  permission,
})

await client.session.promptAsync({
  sessionID: session.data.id,
  directory: projectPath,
  model: { providerID, modelID },
  parts: [{ type: "text", text: prompt }],
})
```

Required work:

- Add `kilocode` to `RuntimeProviderId` only after the adapter exists.
- Add CLI choices for `runtime status`, `model list`, and any verify commands.
- Resolve the `kilo` binary:
  - installed global `kilo`
  - project-local `node_modules/.bin/kilo`
  - explicit config path
  - later, maybe bundled binary
- Avoid port collisions. Do not hardcode `4096` for multiple teammates.
- Isolate config per managed profile. `KILO_CONFIG_CONTENT` is useful, but it
  does not remove the need to understand global `~/.config/kilo` and project
  `opencode.json` precedence.
- Ensure credentials reach the child process:
  - `KILO_API_KEY`
  - provider-specific BYOK keys, if supported
  - optional org header/config only if needed
- Subscribe to SDK SSE events with `client.event.subscribe()`.
- Project SDK events into our task log format.
- Bridge permission requests through `client.permission.reply()` or enforce a
  deterministic non-interactive permission policy.
- Bridge pending questions through `client.question.reply()` or explicitly fail
  with an actionable message.
- Implement reconcile/stop using `client.session.status()`,
  `client.session.messages()`, `client.session.abort()`, and process cleanup.
- Keep cleanup scoped to processes started by the adapter.
- Add launch artifacts, diagnostics, and redacted traces similar to OpenCode.

Why this path is viable:

- Kilo CLI is an actual agent runtime.
- The official SDK exposes sessions, prompts, messages, permissions, provider
  listing, and SSE events.
- The architecture docs explicitly describe CLI clients talking to `kilo serve`
  over HTTP + SSE using `@kilocode/sdk`.

Main risks:

- It duplicates a lot of OpenCode adapter concerns because Kilo is OpenCode-like.
- The SDK shells out to `kilo`, so dependency management is a real runtime issue.
- Kilo is moving quickly. Pin versions, probe capabilities, and record adapter
  compatibility in diagnostics.
- Permissions/questions must be handled deliberately. An autonomous team runtime
  cannot block forever on a TUI prompt.

### Option 3 - Direct Kilo Gateway as a top-level OpenAI-compatible API backend

🎯 5.8   🛡️ 5.7   🧠 7.0 - roughly 600-1,400 LOC.

This is tempting because Kilo Gateway is OpenAI-compatible, but it is not the
best fit for agent teams today.

A direct Gateway backend would be a model-turn executor, not a coding-agent
runtime. The orchestrator would need to provide or reuse all agentic behavior:
tool calls, file edits, shell execution, permissions, MCP, transcript projection,
task lifecycle, stop/retry/reconcile, and safety policy.

Use this only if we intentionally introduce a generic OpenAI-compatible
top-level backend, with Kilo Gateway as one configured endpoint. Do not add
`RuntimeProviderId = "kilocode"` for this alone unless product language clearly
means "Kilo Gateway API", not "Kilo Code agent runtime".

Why it is weaker:

- It bypasses existing OpenCode runtime work.
- It risks creating a second partial agent loop.
- It makes "provider" mean both runtime and API gateway again.

## `kilo run --auto` Assessment

`kilo run --auto "Implement feature X"` is useful for a spike or CI-style task,
but it should not be the default top-level adapter design.

🎯 6.2   🛡️ 5.9   🧠 6.0 - roughly 450-900 LOC if used as a native turn executor.

Pros:

- Simple process model.
- Clear exit codes: success, timeout, error.
- Good for a fast proof that Kilo can edit a workspace non-interactively.

Cons:

- We lose richer session/SSE observability.
- Permission and question handling becomes indirect.
- Transcript projection is weaker unless CLI emits stable structured output.
- Stop/reconcile is process-level instead of session-level.

Recommendation: use `kilo run --auto` only as a short spike. If Kilo becomes a
real top-level provider, use `kilo serve` plus `@kilocode/sdk`.

## Runtime Authority Contract

A top-level provider must be wired through these orchestrator surfaces:

- `src/services/runtimeBackends/types.ts`
  - Add the provider id to `RuntimeProviderId`.
  - Add provider-specific backend ids to `RuntimeBackendId` if the provider has
    selectable backends.
  - Ensure `RuntimeProviderModelCatalog.providerId` can represent the new id.

- `src/services/runtimeBackends/registry.ts`
  - Add a `build<Provider>Status()` function.
  - Return the provider from `getUnifiedRuntimeStatusPayload()`.
  - Fill these fields honestly:
    - `supported`
    - `authenticated`
    - `authMethod`
    - `verificationState`
    - `capabilities.teamLaunch`
    - `capabilities.oneShot`
    - `models`
    - `modelCatalog`
    - `backend`
    - `externalRuntimeDiagnostics`

- `src/cli/handlers/runtime.ts`
  - Include the provider in `runtime status --provider`.
  - Include it in text output ordering.
  - Add provider-specific verify/probe commands only if the runtime can execute
    a real probe.

- `src/cli/handlers/model.ts`
  - Include the provider in `model list --provider`.
  - Add `getProviderModels()` support.
  - Prefer dynamic catalogs when the provider exposes them, with a safe static
    fallback only for degraded/offline states.

- `src/main.tsx`
  - Add the provider to CLI option choices for `model list` and `runtime status`.
  - Add provider-specific subcommands only after the implementation exists.

- `src/utils/model/providers.ts`
  - `CLAUDE_CODE_ENTRY_PROVIDER=<provider>` must resolve to a real API provider
    or route to a provider-specific execution path.
  - Do not add an entry provider string that is silently ignored. That makes the
    desktop UI look correct while the runtime falls back to another provider.

- Query execution path
  - If the provider runs through the main Claude-compatible query loop, make the
    provider available through `getAPIProvider()`.
  - If the provider has a separate runtime path, add a dedicated branch similar
    to Codex native or OpenCode instead of relying on default Anthropic behavior.

## Launch Contract

The provider must support one of these execution shapes.

### Native turn executor

Good for CLIs that can run one prompt non-interactively and return structured
events or a transcript.

Required pieces:

- command/binary resolver
- auth resolver
- model resolver
- non-interactive turn executor
- normalized event/transcript mapper
- tool permission and workspace trust behavior
- tests for success, auth failure, timeout, and malformed output

For Kilo this means `kilo run --auto`, but that is not the recommended long-term
shape if `@kilocode/sdk` works.

### Managed runtime adapter

Good for stateful runtimes with their own server/session model, like OpenCode and
Kilo CLI.

Required pieces:

- host/session manager
- runtime readiness probe
- message delivery bridge
- bootstrap evidence
- liveness/reconcile/stop logic
- transcript/task-log projection
- cleanup rules for app-managed processes only

For Kilo this means `kilo serve` plus `@kilocode/sdk`.

### Nested provider inside OpenCode

Good for model gateways that OpenCode can already run through its provider
system.

Required pieces:

- provider inventory entry
- setup form or manual credential guidance
- model listing
- model execution probe
- default model selection
- desktop mapping from selected OpenCode provider/model to team launch model

For Kilo Gateway this is the recommended first path.

## Desktop Integration Rule

Desktop should not invent first-class runtime support before the orchestrator has
the runtime contract.

Expected flow:

1. Orchestrator adds the provider/runtime support and exposes it through:

   ```bash
   ./cli-dev runtime status --provider <provider> --json
   ./cli-dev model list --provider <provider> --json
   ```

2. Desktop consumes the orchestrator status/model catalog.

3. Desktop adds settings UI only for auth/config that the orchestrator launch
   path can actually use.

4. Desktop enables team launch only when orchestrator status says:

   - `supported: true`
   - `authenticated: true`
   - `capabilities.teamLaunch: true`
   - selected model is known or accepted by the runtime

For Kilo Gateway through OpenCode, desktop should not set
`providerId: "kilocode"`. It should select top-level `opencode` with the
provider-scoped OpenCode model.

## Common Failure Modes

- Desktop adds `TeamProviderId` before orchestrator adds `RuntimeProviderId`.
- Desktop sets `CLAUDE_CODE_ENTRY_PROVIDER=<provider>`, but orchestrator ignores
  it and falls back to Anthropic.
- `runtime status` does not list the provider, but desktop UI does.
- `model list --provider <provider>` is missing or returns a different model id
  format than team launch expects.
- Auth is checked in desktop only, but the spawned runtime cannot use that
  credential.
- Model catalog requires an API key even though the provider has a public model
  endpoint.
- A provider is added to a constant list but rejected by a type guard.
- Kilo Gateway models are stored with stale ids such as old Claude/GPT aliases
  instead of using the live Gateway catalog.
- Kilo Gateway response `name` is ignored, so UI shows raw ids where a display
  name exists.
- Kilo auto/free models are used as defaults without a clear policy around
  routing, cost, rate limits, and provider data handling.
- A top-level Kilo provider is added but only calls Gateway chat completions,
  leaving tool execution and workspace edits undefined.

## Acceptance Checklist

### For Kilo Gateway through OpenCode

- `runtime providers directory --runtime opencode --json` can show the Kilo
  nested provider.
- `runtime providers models --runtime opencode --provider kilocode --json`
  returns live Kilo Gateway model ids.
- Model listing works without `KILO_API_KEY`.
- Paid model probe fails cleanly without `KILO_API_KEY`.
- Probe succeeds with `KILO_API_KEY` for at least one stable model.
- Provider-scoped ids with nested slashes work, for example
  `kilocode/anthropic/claude-sonnet-4.6`.
- Team launch uses top-level `opencode`, not `kilocode`.
- OpenCode child process receives the credential source used by status/probe.
- Tests cover catalog mapping, no-auth listing, missing-auth probe failure,
  nested-slash selected models, and desktop launch mapping.

### For Kilo CLI as top-level provider

- `./cli-dev runtime status --provider kilocode --json` returns one provider.
- `./cli-dev runtime status --provider all --json` includes Kilo.
- `./cli-dev model list --provider kilocode --json` returns launchable model ids.
- `CLAUDE_CODE_ENTRY_PROVIDER=kilocode` is either honored by a real path or not
  used at all.
- Auth status and launch auth use the same source of truth.
- Missing `kilo` binary is reported before launch with install guidance.
- Missing auth fails before launch with an actionable message.
- Bad model selection fails before launch with an actionable message.
- A launch creates a Kilo session in the intended project directory.
- Prompt delivery is observable through SDK messages/events.
- Pending permissions/questions cannot hang the team indefinitely.
- Stop/reconcile only affects app-managed Kilo processes/sessions.
- Tests cover status, model list, provider routing, SDK server spawn failure,
  auth failure, model failure, event projection, and stop/reconcile.

## Contributor Guidance

If the current PR only adds Kilo status/model UI to desktop, it is not enough.
The missing work is in the orchestrator.

Suggested message to the contributor:

> Hi! Thanks for picking this up, this is a useful direction. One important
> architecture detail: provider launch authority lives in
> `agent_teams_orchestrator`, not only in the desktop app. Desktop can expose
> settings and model UI, but team launch should only become available after the
> orchestrator can report status, list models, validate auth, and execute work
> through the selected runtime.
>
> For Kilo there are two separate surfaces. `kilo serve` plus `@kilocode/sdk` is
> the richer and more flexible integration surface: it can use an existing Kilo
> account/subscription and gives us sessions, SSE events, permissions, messages,
> provider auth, transcript projection, and cleanup. That is the better
> long-term route for a real top-level Kilo runtime once the orchestrator adapter
> exists.
>
> Kilo Gateway is the faster API path because it is OpenAI-compatible and can be
> wired through the OpenCode provider support we already have. It can show up as
> a separate nested OpenCode provider, while team launch stays top-level
> `providerId: "opencode"`.
>
> Please avoid adding `kilocode` as a first-class desktop team provider until the
> orchestrator has the matching runtime contract. Otherwise the UI can look
> connected while the actual spawned runtime falls back to a different provider.

## Bottom Line

Recommended now:

1. For fast API access, add Kilo Gateway as a nested OpenCode provider.
2. Use the live Kilo model catalog without auth.
3. Require a real OpenCode model probe before saving/enabling launch.
4. For the fuller Kilo account/subscription experience, plan the top-level
   runtime around `@kilocode/sdk` + `kilo serve`.
5. Do not add top-level `RuntimeProviderId = "kilocode"` until that Kilo CLI
   runtime adapter exists.
