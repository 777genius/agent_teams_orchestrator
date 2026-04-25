# Runtime Provider Management Popup - Frontend Plan

Status: accepted for planning

Scope: frontend application surface for managing nested runtime providers,
starting with OpenCode.

Feature flag: `RUNTIME_PROVIDER_MANAGEMENT`

Accepted architecture: hybrid feature module with existing OpenCode services.

## Goal

The main Providers surface should show OpenCode as a runtime and summarize its
nested providers. A dedicated popup should let the user inspect, connect, test,
ignore, and select defaults for OpenCode providers without modifying local
OpenCode configuration by default.

## Current Repo Signals

- Runtime provider status already exists in
  `src/services/runtimeBackends/registry.ts`.
- OpenCode inventory/provisioning already exists in `src/services/opencode`.
- OpenCode currently reports providers and models through inventory/probe
  services, but the UI does not expose provider management actions.
- There is no existing first-class `features/` planning standard in this repo.
  `FEATURES.md` is a compile-time feature flag audit, not a feature plan store.

## OpenCode Facts Checked

- Local OpenCode version checked here: `1.14.19`.
- Latest npm package checked on 2026-04-25: `opencode-ai@1.14.24`.
- OpenCode supports 75+ providers through AI SDK and Models.dev.
- Provider credentials are stored in `~/.local/share/opencode/auth.json` when
  configured through OpenCode.
- The OpenCode server exposes `/provider`, `/provider/auth`,
  `/config/providers`, `/config`, and `/global/health`.
- The OpenCode server accepts `PUT /auth/:providerID` with
  `{ "type": "api", "key": "..." }` for API-key auth in the active profile.
- The current app-managed OpenCode profile already isolates `HOME`,
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and uses
  `OPENCODE_CONFIG_CONTENT`.

Sources:

- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/docs/cli/

## Main Providers Surface

Target summary row:

```text
OpenCode   Ready   OpenAI, OpenCode Zen - 18 models   [Providers]
```

States:

- `Ready` - OpenCode CLI detected, managed profile healthy, at least one
  usable provider/model.
- `Needs auth` - OpenCode CLI is available but no connected provider works.
- `Needs setup` - OpenCode CLI missing or managed profile cannot start.
- `Degraded` - provider inventory exists, but model execution probe fails.

The row should not expose raw nested provider config. It should show:

- connected provider count
- model count
- selected default model if one is set
- a `Providers` action that opens the popup

## Popup UX

Default view:

```text
OpenCode Providers

Runtime
CLI              Ready       /opt/homebrew/bin/opencode
Managed profile  Active      local OpenCode config is not modified
Local auth       Synced      4 min ago

Providers
> OpenRouter     Not connected      Recommended      Connect
  OpenCode Zen   Not connected      Recommended      Connect
  OpenAI         Connected          Local + env       Use
  Anthropic      Available                           Add key
  Ollama         Local detected                       Test

Default for teams
Auto: prefer verified connected provider
Current: openai/gpt-5.4-mini-fast

Enter connect/use - t test - r resync - i ignore - Esc close
```

Ownership badges:

- `Managed` - app-owned OpenCode profile.
- `Local` - user's local OpenCode auth/config copied or observed.
- `Env` - environment or project `.env`; read-only in UI.
- `Project` - project `opencode.json` or `.opencode`; read-only by default.
- `Ignored` - explicitly disabled in the app-managed profile.

Popup subviews:

- Provider list
- Provider detail
- API-key connect form
- Model picker for a selected provider
- Test result panel
- Confirm ignore
- Confirm forget managed credential

## Clean Architecture Shape

The UI talks to use cases, not OpenCode.

```text
ui/
  ProviderManagementDialog
  ProviderList
  ProviderDetail
  ApiKeyConnectForm
  ModelPickerPanel
application/
  loadProviderManagementView
  connectProviderWithApiKey
  forgetManagedProvider
  ignoreExternalProvider
  testProviderModel
  setDefaultProviderModel
ports/
  ProviderManagementQueryPort
  ProviderManagementCommandPort
adapters/
  OpenCodeProviderManagementAdapter
domain/
  ProviderConnection
  ProviderOwnership
  ProviderAction
  ProviderManagementView
```

Dependency direction:

```text
UI -> application -> ports -> adapter -> OpenCode services
domain has no dependency on UI or OpenCode
```

## Accepted Code Locations

Hybrid structure:

```text
src/features/runtimeProviderManagement/
  domain/
  application/
  ports/
  adapters/opencode/
  ui/
  index.ts
```

Integration points:

- Main provider row imports only the feature UI entrypoint.
- OpenCode adapter reuses existing `src/services/opencode/*`.
- Runtime registry can optionally include a compact nested-provider summary, but
  the popup should load its detailed view through the feature use case.
- Generic popup shell stays reusable; OpenCode-specific copy/actions live behind
  the OpenCode adapter/view-model mapper.
- No UI component imports `src/services/opencode/*` directly.
- No application use case imports `src/services/opencode/*` directly.

## Port Contracts

```ts
export type ProviderManagementRuntimeId = 'opencode'

export type ProviderManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderManagementError }

export type ProviderManagementError = {
  code:
    | 'runtime-missing'
    | 'runtime-unhealthy'
    | 'provider-missing'
    | 'unsupported-action'
    | 'auth-required'
    | 'auth-failed'
    | 'model-test-failed'
    | 'unsupported-auth-method'
  message: string
  recoverable: boolean
}

export interface ProviderManagementQueryPort {
  loadView(runtimeId: ProviderManagementRuntimeId):
    Promise<ProviderManagementResult<ProviderManagementView>>
}

export interface ProviderManagementCommandPort {
  connectWithApiKey(input: ConnectProviderApiKeyInput):
    Promise<ProviderManagementResult<ProviderConnection>>
  forgetManagedCredential(input: ProviderSelectionInput):
    Promise<ProviderManagementResult<ProviderConnection>>
  ignoreProvider(input: ProviderSelectionInput):
    Promise<ProviderManagementResult<ProviderConnection>>
  setDefaultModel(input: SetDefaultModelInput):
    Promise<ProviderManagementResult<ProviderManagementView>>
  testModel(input: TestProviderModelInput):
    Promise<ProviderManagementResult<ProviderModelTestResult>>
}
```

Adapter rule: OpenCode responses from `/provider`, `/provider/auth`,
`/config/providers`, and `/global/health` are parsed and normalized inside
`OpenCodeProviderManagementAdapter` before they enter the feature domain.

## View Model

```ts
type ProviderManagementView = {
  runtimeId: 'opencode'
  title: string
  runtime: {
    state: 'ready' | 'needs-auth' | 'needs-setup' | 'degraded'
    cliPath: string | null
    version: string | null
    managedProfile: 'active' | 'missing' | 'stale'
    localAuth: 'synced' | 'missing' | 'stale' | 'disabled'
  }
  providers: ProviderConnection[]
  defaultModel: string | null
  fallbackModel: string | null
  diagnostics: string[]
}

type ProviderConnection = {
  providerId: string
  displayName: string
  state: 'connected' | 'available' | 'not-connected' | 'ignored' | 'error'
  ownership: ProviderOwnership[]
  recommended: boolean
  modelCount: number
  defaultModelId: string | null
  authMethods: Array<'api' | 'oauth' | 'wellknown'>
  actions: ProviderActionDescriptor[]
  detail: string | null
}

type ProviderActionDescriptor = {
  id: 'connect' | 'use' | 'test' | 'set-default' | 'forget' | 'configure' | 'unignore'
  label: string
  enabled: boolean
  disabledReason: string | null
  requiresSecret: boolean
  ownershipScope: ProviderOwnership | 'runtime'
}

type ProviderOwnership = 'managed' | 'local' | 'env' | 'project'
```

## User Actions

MVP:

- Connect OpenRouter with API key to managed OpenCode profile.
- Connect OpenCode Zen with API key to managed OpenCode profile.
- Connect any provider that OpenCode advertises with `api` auth.
- Show `Configure manually` for custom providers without advertised API auth.
- Forget only app-managed provider auth when `/doc` advertises
  `DELETE /auth/{providerID}`.
- Keep test, default model, ignore, and resync as later-phase actions.

Non-goals:

- No silent writes to `~/.config/opencode/opencode.json`.
- No silent deletes from local OpenCode auth.
- No global OpenCode upgrade from this popup.
- No OAuth MVP unless the selected OpenCode auth method requires it.
- No `enabled_providers` by default. Use explicit ignore through
  `disabled_providers`.

## Architecture Options

1. `src/features/runtimeProviderManagement` vertical module
   🎯 9   🛡️ 8   🧠 7
   Estimated changed lines: 1,500-2,600.
   Best long-term boundary. Slightly new convention for this repo.

2. Existing folders only: `src/components/providers` + `src/services/*`
   🎯 7   🛡️ 7   🧠 4
   Estimated changed lines: 1,100-1,900.
   Fastest fit with current layout, but generic UI and OpenCode details can
   couple too easily.

3. Hybrid feature module with existing service adapters
   🎯 9   🛡️ 9   🧠 6
   Estimated changed lines: 1,300-2,300.
   Accepted. New feature owns UI/use cases/view models, existing OpenCode
   services remain the adapter substrate.

## SOLID Notes

- SRP: UI renders view state; use cases coordinate actions; adapters translate
  OpenCode.
- OCP: add Gemini/Codex provider management by adding adapters, not by changing
  generic popup branching.
- LSP: adapters must honor the same port contract, including honest failure
  states.
- ISP: split query, command, and secret-input ports so read-only surfaces do not
  depend on mutation methods.
- DIP: application depends on provider-management ports, not OpenCode client
  classes.

## Rollout

Phase 1 - Read-only popup:

- Add feature module and view model.
- Add OpenCode adapter read-only view.
- Add main provider row button.
- Render states, badges, diagnostics, and model counts.

Phase 2 - Managed API-key connect:

- Add API-key form.
- Add OpenCode `PUT /auth/{providerID}` adapter method.
- Add capability-gated `DELETE /auth/{providerID}` adapter method.
- Replace `primaryAction` with action descriptors.
- Add managed ownership metadata and secret-clearing UI state.

Phase 3 - Model default and test:

- Add model picker.
- Wire existing OpenCode execution probe.
- Store default/fallback model outside local OpenCode.
- Use selected model during OpenCode team launch.

## Validation

- Unit tests for view-model normalization and ownership precedence.
- Unit tests for available action descriptors per ownership/source.
- UI tests for loading, ready, missing CLI, no auth, ignored provider, and
  failed test states.
- Adapter tests that verify managed connect calls the managed OpenCode host only.
- Manual check with `opencode providers list`, `opencode models`, and OpenCode
  server `/provider`, `/provider/auth`, `/config/providers`, and `/doc`.
