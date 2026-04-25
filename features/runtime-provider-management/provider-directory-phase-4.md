# Runtime Provider Management - Phase 4 Provider Directory

Status: accepted for planning

Scope: orchestrator CLI contract, OpenCode adapter, desktop frontend feature
slice, provider management popup UX.

Feature flag: `RUNTIME_PROVIDER_MANAGEMENT`

Accepted option: Progressive provider directory
🎯 9   🛡️ 9   🧠 6
Estimated changed lines: 900-1,500.

## Problem

The provider management popup currently looks too small compared with what
OpenCode can actually provide. The user sees roughly 8 OpenCode providers,
while a live OpenCode `1.14.19` server in this workspace returned 115 providers
from `GET /provider`.

The current behavior is not because OpenCode lacks the list. It is because the
desktop feature calls:

```text
runtime providers view --runtime opencode --json --compact
```

`--compact` intentionally filters the provider list to connected, recommended,
or directly connectable providers. This is good for fast first paint, but bad as
the only discoverability surface.

The product needs a provider directory that exposes OpenCode's dynamic provider
catalog without turning the initial popup into a noisy, slow list of 100+
providers where most rows cannot honestly be connected inline.

Key correctness constraint: OpenCode's full provider payload is runtime data,
not a UI contract. The app must sanitize and normalize it at the adapter
boundary before any CLI, IPC, or renderer code sees it.

## Facts Checked

Local OpenCode runtime checked in this workspace:

- `opencode --version`: `1.14.19`
- `GET /provider`: status `200`, about `3,076,244` bytes, `115` providers,
  `2` connected providers in the sampled unmanaged server.
- `GET /provider/auth`: status `200`, `6` provider keys in the sampled runtime:
  `openai`, `github-copilot`, `gitlab`, `poe`,
  `cloudflare-workers-ai`, `cloudflare-ai-gateway`.
- `GET /config/providers`: status `200`, `2` configured providers in the
  sampled runtime: `openai`, `opencode`.
- Existing app-managed view currently returns 8 providers in compact mode:
  `openrouter`, `opencode`, `openai`, `anthropic`,
  `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `gitlab`, `poe`.

OpenCode documentation checked:

- Providers are exposed through OpenCode provider support, including AI SDK and
  Models.dev-backed catalogs.
- `/connect` is the user-facing flow.
- The server API exposes provider/config endpoints.
- Config can define providers and default models.
- Auth may be API-key, OAuth, environment, provider-specific, or manual config
  depending on provider.

Sources:

- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/models/
- https://opencode.ai/docs/cli/

## Chosen UX

Use progressive disclosure:

1. Keep the initial popup fast and focused.
2. Show connected and recommended providers first.
3. Add a directory mode for all OpenCode providers.
4. Load the full directory lazily when the user searches globally or opens
   `Browse all providers`.
5. Keep actions honest. Do not show `Connect` unless the runtime advertises a
   supported auth method or the provider is a curated supported seed.

### Why Not Show All Providers Immediately

OpenCode's `/provider` payload is large. Showing all 115 rows immediately would:

- slow first popup open,
- bury connected providers under catalog noise,
- make many rows appear broken because only a minority advertise inline auth
  methods through `/provider/auth`,
- force users to scan providers that require manual environment/config setup.

### User-Facing Layout

Default popup:

```text
OpenCode runtime
Ready   v1.14.19   3 connected providers   OpenCode default: openrouter/...

Search providers

Connected
  OpenRouter       Connected     174 models     managed
  OpenCode Zen     Connected       6 models     managed
  OpenAI           Connected      12 models     env

Recommended setup
  Anthropic        Configure manually
  Cloudflare AI    Connect
  GitLab Duo       Connect
  Poe              Connect

Browse all OpenCode providers
  115 providers available from OpenCode
```

Search behavior:

- The default search first filters already-loaded compact providers.
- If the query has 2+ characters and has no compact match, show an inline
  action: `Search all OpenCode providers for "<query>"`.
- Pressing Enter in the search field when the query has 2+ characters opens the
  directory with that query.
- The directory has its own search field after it opens.

This avoids two competing search boxes on first paint while still making the
dynamic catalog discoverable.

Directory mode:

```text
All OpenCode providers
Search by provider, model, auth method...

Filters:
[All] [Connectable] [Configured] [Connected] [Manual setup] [Has models]

OpenRouter            Connected       174 models    managed
DeepSeek              Manual setup    62 models     from OpenCode catalog
GitHub Copilot        Connect         models unknown
Cloudflare Workers    Connect         models unknown
Amazon Bedrock        Configure       requires environment/config
...
```

Provider detail states:

- `Connected`: OpenCode reports the provider as connected or the app-managed
  profile has a credential/config path proving ownership.
- `Connect`: the provider has an advertised auth method that the app supports
  now, currently API-key only unless a future phase adds OAuth.
- `Configure manually`: the provider exists in OpenCode but does not have a
  supported app-managed inline auth path.
- `Requires environment`: the provider appears to require env/project config or
  provider-specific fields that are not represented by the current API-key-only
  form.
- `Available`: models are visible but no connection proof exists.
- `Unsupported inline setup`: provider exists but cannot be managed safely by
  the current app.

Important UX rule: docs may say many providers support `/connect` with an API
key, but the app should not assume `PUT /auth/{providerID}` accepts the same
minimal `{ type: "api", key }` body unless the live runtime advertises that
shape or the provider is explicitly curated and tested.

## Implementation Options Considered

1. Progressive provider directory  
   🎯 9   🛡️ 9   🧠 6  
   Estimated changed lines: 900-1,500.  
   Chosen. Keeps first paint fast, exposes all OpenCode providers on demand,
   and prevents misleading actions.

2. Always load and show all providers in `view --compact`  
   🎯 6   🛡️ 7   🧠 4  
   Estimated changed lines: 350-700.  
   Rejected. Easier but noisy, slower, and makes many providers look broken.

3. Keep curated-only providers and improve copy  
   🎯 4   🛡️ 8   🧠 2  
   Estimated changed lines: 100-250.  
   Rejected. Reliable but hides the core OpenCode value: a broad provider
   catalog.

## Architecture

The existing hybrid feature module remains correct:

```text
Orchestrator:
src/features/runtimeProviderManagement/
  domain/
  application/
  ports/
  adapters/opencode/

Frontend:
src/features/runtime-provider-management/
  contracts/
  core/domain/
  core/application/
  main/
  preload/
  renderer/
```

The full provider directory is a new read-side capability, not a mutation
feature. It should be a separate use case and CLI contract from `view`.

Dependency rule:

```text
Frontend renderer -> feature API -> Electron main IPC -> CLI adapter
CLI adapter -> orchestrator command -> application use case
use case -> ProviderDirectoryQueryPort
OpenCode adapter -> OpenCode /provider, /provider/auth, /config/providers
```

No UI layer should parse raw OpenCode provider payloads.

## Orchestrator Plan

### 1. Domain Types

Add provider directory domain models:

```ts
export type ProviderDirectoryFilter =
  | 'all'
  | 'connected'
  | 'configured'
  | 'connectable'
  | 'manual'
  | 'has-models'

export type ProviderSetupKind =
  | 'connected'
  | 'connect-api-key'
  | 'configure-manually'
  | 'requires-environment'
  | 'available-readonly'
  | 'unsupported'

export type ProviderDirectorySource =
  | 'opencode-provider'
  | 'config-provider'
  | 'inventory'
  | 'seed'

export type ProviderDirectoryEntry = {
  providerId: string
  displayName: string
  state: ProviderConnection['state']
  setupKind: ProviderSetupKind
  ownership: ProviderOwnership[]
  recommended: boolean
  modelCount: number | null
  authMethods: ProviderAuthMethod[]
  defaultModelId: string | null
  sources: ProviderDirectorySource[]
  sourceLabel: string | null
  providerSource: string | null
  detail: string | null
  actions: ProviderActionDescriptor[]
  metadata: {
    hasKnownModels: boolean
    requiresManualConfig: boolean
    supportedInlineAuth: boolean
  }
}

export type ProviderDirectoryView = {
  runtimeId: 'opencode'
  totalCount: number
  returnedCount: number
  query: string | null
  filter: ProviderDirectoryFilter
  limit: number
  cursor: string | null
  nextCursor: string | null
  entries: ProviderDirectoryEntry[]
  diagnostics: string[]
  fetchedAt: string
}
```

Use `modelCount: null` when OpenCode reports a provider but model data is not
available or not cheap to count.

`authMethods` must be a sanitized app-domain representation, not OpenCode's raw
auth schema.

Do not include raw OpenCode provider `options`, headers, env values, API keys,
base URLs, or provider model config bodies in `ProviderDirectoryEntry`.

### 2. Application Use Case

Add:

```ts
loadProviderDirectory(input: {
  runtimeId: ProviderManagementRuntimeId
  projectPath?: string | null
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
  refresh?: boolean | null
}): Promise<ProviderManagementResult<ProviderDirectoryView>>
```

Rules:

- default `limit`: `50`
- max `limit`: `100`
- default `filter`: `all`
- query matches provider id, display name, auth methods, setup kind, and known
  model ids when already present in payload.
- cursor can be a simple offset cursor for Phase 4.
- `projectPath` must be passed through consistently with `loadView`, because
  OpenCode provider/config state can be project-sensitive.
- `refresh: true` bypasses the directory cache and re-reads the live OpenCode
  endpoints.

### 3. Port Contract

Extend query port:

```ts
export interface ProviderManagementDirectoryQueryPort {
  loadDirectory(input: LoadProviderDirectoryInput):
    Promise<ProviderManagementResult<ProviderDirectoryView>>
}
```

Keep this separate from `loadView` so compact startup remains fast and stable.

### 4. OpenCode Adapter

Adapter fetches:

- `GET /provider`
- `GET /provider/auth`
- `GET /config/providers`
- current inventory snapshot
- server capabilities from `/doc` when available

Merge policy:

1. Provider ids from `/provider.all` are authoritative for the full catalog.
2. Provider ids from `/config/providers.providers` override display/config
   details when present, but only for safe public fields.
3. Provider ids from `/provider.connected` and inventory connected providers
   mark connection state.
4. Provider ids from managed auth store can mark managed ownership only when
   connection can be proven or when the provider was accepted by OpenCode auth.
5. Seeded providers fill gaps only if OpenCode cannot start or does not return
   a catalog.
6. Model count can use `/provider.all[*].models` when present, but model config
   details must be discarded before returning DTOs.
7. If `/provider` succeeds but `/provider/auth` fails, the directory still
   renders providers with manual/configure actions and includes a scoped
   diagnostic.
8. `sources` should preserve every source that contributed to the final entry
   instead of collapsing to one precedence winner.

Action policy:

- `connect`: only if `authMethods` includes `api` and app-managed auth is
  supported for this provider, or the provider is an explicitly curated API-key
  seed.
- `forget`: only for managed credentials and only if runtime capability confirms
  `DELETE /auth/{providerID}`.
- `configure`: for providers with no supported inline auth.
- `use/test`: only when connected and models are known to exist, or when the
  selected provider can lazy-load models. Do not hide model actions solely
  because `modelCount` is `null`; treat `0` as the only known empty state.

Important: Do not infer API-key support from provider env variable names alone.
Env names are useful copy, not a safe mutation contract.

Normalization and fault tolerance:

- Treat OpenCode response shapes as external input. Validate minimum fields and
  map unknown provider/auth fields to safe defaults.
- A malformed provider row should be skipped with a diagnostic count; it should
  not fail the whole directory unless the top-level endpoint is unusable.
- Unknown auth method values must not become connectable actions.
- Unknown setup states must render as `Configure manually` or `Unsupported
  inline setup`, never as `Connect`.
- Redact command output and diagnostics before they cross CLI/IPC. This includes
  stderr from OpenCode, auth errors, config snippets, env values, URLs that carry
  tokens, and provider option values.

Performance policy:

- Do not call `opencode models` as part of the directory path if a live
  `/provider` payload is available. `/provider` already contains enough catalog
  information for directory rows.
- Reuse the existing managed host/profile lifecycle, but avoid extra CLI probes
  beyond what is needed to determine OpenCode availability and profile
  ownership.
- Normalize provider entries once per directory read and paginate/filter the
  normalized list.

### 5. CLI Contract

Add:

```text
runtime providers directory \
  --runtime opencode \
  --json \
  [--project-path <path>] \
  [--query <query>] \
  [--filter all|connected|configured|connectable|manual|has-models] \
  [--limit <n>] \
  [--cursor <cursor>] \
  [--refresh]
```

Response:

```json
{
  "schemaVersion": 1,
  "runtimeId": "opencode",
  "directory": {
    "runtimeId": "opencode",
    "totalCount": 115,
    "returnedCount": 50,
    "query": null,
    "filter": "all",
    "limit": 50,
    "cursor": null,
    "nextCursor": "50",
    "fetchedAt": "2026-04-25T15:30:00.000Z",
    "entries": []
  }
}
```

Error response follows existing provider management error DTO.

CLI implementation rule: include optional args only when values are present.
Never emit literal `undefined`, `null`, or empty strings into argv.

### 6. Caching

The directory can be cached briefly because `/provider` is large.

Policy:

- In-memory adapter cache: `30s`.
- Bypass cache when user clicks refresh.
- Do not persist the full provider payload to disk in Phase 4.
- Store only normalized entries in memory, not raw OpenCode payload.
- Cache key must include project path, runtime id, OpenCode version when known,
  profile root key, and resolved config fingerprint when available.
- Config fingerprint must be derived from redacted public identity only, such as
  provider ids, default model ids, and non-secret config metadata. Do not hash or
  persist raw env values, tokens, headers, or provider option bodies.
- A successful connect/forget should invalidate the directory cache for the
  affected runtime/project.

## Frontend Plan

### 1. Contracts

Extend `src/features/runtime-provider-management/contracts/`:

- `RuntimeProviderDirectoryEntryDto`
- `RuntimeProviderDirectoryResponse`
- `RuntimeProviderDirectoryFilterDto`
- `loadProviderDirectory(input)`
- IPC channel:
  `runtime-provider-management:directory`

Keep DTOs close to orchestrator JSON but renderer-safe.

### 2. Main Adapter

Extend the existing CLI client:

```ts
loadProviderDirectory(input) {
  const args = [
    'runtime', 'providers', 'directory',
    '--runtime', input.runtimeId,
    '--json',
  ]

  appendOptionalArg(args, '--project-path', input.projectPath)
  appendOptionalArg(args, '--query', input.query)
  appendOptionalArg(args, '--filter', input.filter)
  appendOptionalArg(args, '--limit', input.limit == null ? null : String(input.limit))
  appendOptionalArg(args, '--cursor', input.cursor)
  if (input.refresh) args.push('--refresh')

  return execCli(binaryPath, args)
}
```

Rules:

- Do not include secrets.
- Do not include optional args unless their values are present.
- Parse JSON error responses from stdout/stderr as already done for model test.
- Preserve useful stderr details for degraded runtime diagnostics only after
  redaction.

### 3. Renderer State

Add state:

```ts
directoryOpen: boolean
directoryLoading: boolean
directoryError: string | null
directoryEntries: RuntimeProviderDirectoryEntryDto[]
directoryTotalCount: number | null
directoryNextCursor: string | null
directoryQuery: string
directoryFilter: RuntimeProviderDirectoryFilterDto
directoryLoaded: boolean
directoryRefreshing: boolean
directorySelectedProviderId: string | null
```

Actions:

- `openDirectory()`
- `closeDirectory()`
- `setDirectoryQuery(query)`
- `setDirectoryFilter(filter)`
- `loadMoreDirectory()`
- `refreshDirectory()`
- `selectDirectoryProvider(providerId)`
- `searchAllProviders(query)`

Debounce search by `200-300ms`.
Use request sequencing or an abort controller so slow responses cannot overwrite
newer search/filter results.

### 4. Popup UI

Default panel:

- Runtime summary.
- Provider search filters visible compact providers and offers global directory
  search when the query has 2+ characters.
- Connected providers section.
- Recommended setup section.
- `Browse all OpenCode providers` button with count hint when known.

Directory panel:

- Header with back button:
  `All OpenCode providers`
- Search input.
- Filter chips:
  `All`, `Connectable`, `Connected`, `Configured`, `Manual setup`, `Has models`.
- Scrollable provider list.
- `Load more` when `nextCursor` exists.
- Empty state:
  `No providers match this search.`
- Error state:
  show provider-directory scoped error, not global green success.

Provider rows in directory:

- Whole row clickable.
- Hover highlight.
- Logo/initial.
- Provider name.
- State badge.
- Model count if known.
- Setup kind badge.
- Source label such as `OpenCode catalog`, `configured`, or `seeded fallback`
  when useful.
- Primary action:
  `Connect`, `Configure manually`, `Select`, or none depending on policy.

### 5. Selection Behavior

When the user selects a provider from directory:

1. Set selected provider id.
2. If provider exists in compact `providers`, scroll/select that card.
3. If provider exists only in directory, render a selected provider detail card
   from the directory entry.
4. If it is connected and `modelCount !== 0`, lazy-load models using existing
   `loadModels`. A `null` model count means unknown, not empty.
5. If it is not connected, show setup guidance/actions.
6. If the selected directory provider later appears in compact state after
   connect/refresh, reconcile selection to the compact provider row.

This prevents users from searching a provider and then losing context because it
was not part of the initial compact list.

### 6. Visual States

Use direct colors or stable classes already present in the app:

- Connected: green badge.
- Connectable: blue/sky badge.
- Manual/config required: neutral zinc badge.
- Error: red badge.
- Recommended: amber star badge.

Do not show success banners at top for model/provider actions. Success/failure
should stay scoped to the affected provider/model card.

### 7. Provider Icons

Use a small, explicit frontend icon registry keyed by provider id:

- Prefer checked-in SVG/logo assets only when the source is verified and the
  brand usage is acceptable for an integration directory.
- Do not hotlink remote logos.
- Do not block the provider directory on missing logos.
- Unknown providers fall back to the current monogram/initial treatment.
- Popular curated ids can receive first-pass assets:
  `openrouter`, `opencode`, `openai`, `anthropic`,
  `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `gitlab`, `poe`,
  `github-copilot`, `google-vertex`, `deepseek`, `fireworks-ai`, `groq`,
  `ollama`, `lmstudio`, `xai`, `together-ai`, `moonshot-ai`.

The directory should still be useful and visually stable if every provider uses
the fallback monogram.

## Provider Setup Copy

Examples:

- API-key connect:
  `OpenCode advertises API-key auth for this provider. The key will be stored in the app-managed OpenCode profile.`
- Manual setup:
  `OpenCode lists this provider, but this runtime does not advertise an app-managed API-key setup flow. Configure it in OpenCode or provider env/config.`
- Requires environment:
  `This provider usually needs environment or project configuration. Inline setup is not supported yet.`
- Read-only available:
  `Models are visible, but no connected credential was reported.`

Avoid promising that every provider listed by OpenCode can be connected from
the app. The provider directory is discovery plus safe setup where supported.

## Non-Goals

- Do not implement OAuth flows in Phase 4.
- Do not write to the user's local OpenCode auth/config.
- Do not install custom provider packages.
- Do not infer provider setup from env variable names as a write capability.
- Do not load or render all provider models in the directory upfront.
- Do not persist full OpenCode `/provider` payloads.
- Do not add a frontend virtualization dependency in Phase 4. Pagination and a
  bounded scroll area are sufficient for the current 100-200 provider scale.
- Do not support provider-specific multi-field setup forms in Phase 4.

## Testing Plan

### Orchestrator Unit Tests

- Directory use case returns all provider entries from `/provider.all`.
- Directory merges `/provider.connected`, inventory connected providers, and
  `/config/providers`.
- Directory preserves multiple source tags on a single provider entry.
- Directory sanitizes `options`, headers, env values, base URLs, and raw model
  configs out of returned entries.
- Directory sanitizes raw auth schemas into app-domain auth method values.
- Directory marks API-key connect only for providers with advertised `api` auth
  or curated supported seeds.
- Unknown/custom providers without supported auth become `configure`.
- Query filters by provider id and display name.
- Filters work:
  - `connectable`
  - `connected`
  - `configured`
  - `manual`
  - `has-models`
- Pagination returns `nextCursor`.
- Directory falls back to seeds when OpenCode host cannot start.
- Directory cache key includes project/profile/config identity.
- Connect/forget invalidates the directory cache.
- Slow/stale directory responses cannot overwrite newer query/filter results in
  application or renderer state.
- Raw OpenCode payload is not leaked in errors.
- Malformed provider rows are skipped with diagnostics and do not fail the whole
  directory.
- `modelCount: null` still allows model lazy-load for connected providers.
- Redacted config fingerprints do not include env values, headers, tokens, or
  raw option bodies.

### CLI Contract Tests

- `runtime providers directory --runtime opencode --json`
- `--project-path <path>`
- `--query openrouter`
- `--filter connectable`
- `--limit 10`
- `--cursor 10`
- `--refresh`
- unsupported runtime returns typed error.
- optional args are omitted when absent; no `undefined` argv values.

### Frontend Main/IPC Tests

- IPC calls feature facade with query/filter/limit/cursor.
- CLI adapter builds args correctly.
- CLI adapter parses JSON error from stdout on non-zero exit.
- Directory failures do not become success banners.
- CLI adapter redacts stderr/stdout diagnostics before exposing them to the
  renderer.

### Renderer Hook Tests

- Opening directory lazy-loads first page.
- Pressing Enter in compact search opens directory for a 2+ character query.
- Search debounces and reloads directory.
- Filter chip reloads directory.
- Stale search responses are ignored.
- Load more appends entries.
- Selecting a directory-only provider renders detail card.
- Connectable provider starts existing API-key connect flow.
- Manual provider shows manual setup copy.

### UI Tests

- Default popup still shows compact providers first.
- `Browse all OpenCode providers` opens directory.
- Directory search can find a provider not in compact list, for example
  `deepseek` or `fireworks-ai` when available from OpenCode.
- Provider rows hover and whole-row click works.
- Long provider names and model ids do not overflow.
- Directory list remains bounded and scrollable.
- Directory does not render raw provider option values.
- Unknown provider icons fall back to monograms without layout shift.

### Manual E2E

1. Start desktop app with agent teams orchestrator CLI path.
2. Open OpenCode provider popup.
3. Confirm compact list opens quickly.
4. Click `Browse all OpenCode providers`.
5. Confirm count is close to OpenCode `/provider.all.length`.
6. Search `deepseek`.
7. Confirm row appears even if it was not in compact list.
8. Search `openrouter`.
9. Confirm connected state and model count remain correct.
10. Click OpenRouter, confirm existing model picker still works.
11. Test one OpenRouter model.
12. Confirm success/failure is scoped to the model card.
13. Refresh directory after connect/forget and confirm state changes without
    restarting the app.

## Rollout

- Behind existing `RUNTIME_PROVIDER_MANAGEMENT`.
- If directory command fails, keep current compact UI functional.
- If `/provider` returns a large payload or times out, show compact view plus
  scoped directory error.
- No migration needed.
- No local user OpenCode config/auth mutation.
- Kill switch is the existing feature flag. If the new directory command is not
  available in an older CLI, frontend should hide the directory affordance after
  receiving `unsupported-action` or `unknown command`.

## Acceptance Criteria

- The default popup remains fast and focused.
- The user can discover providers that are not in the compact list.
- OpenCode provider catalog is dynamic from `/provider`, not hardcoded.
- The UI does not offer fake connect actions.
- OpenRouter remains easy to connect and use.
- Directory search works over at least provider id and display name.
- Provider list is scrollable, keyboard reachable, and visually hoverable.
- Tests cover adapter merge policy, CLI contract, IPC, hook, and UI flows.
- Raw OpenCode provider payloads never cross the CLI/IPC boundary.
- Project-specific provider state is respected through `projectPath`.

## Open Questions For Implementation

- Whether to show `Browse all` as an inline section or a right-side directory
  panel on wide dialogs. Recommended: right-side panel on wide, stacked panel on
  narrow.
- Whether provider directory should expose model count from `/provider.all`
  immediately. Recommended: yes when cheap because `/provider` already contains
  model maps, but do not render model rows until provider selection.
- Whether to add a provider type filter by source, for example `custom`,
  `models.dev`, `env`. Recommended: not Phase 4 unless users ask for it.
