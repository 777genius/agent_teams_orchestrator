# Feature Planning Standard

This directory is for proposed and in-progress product features. It is separate
from `FEATURES.md`, which is a compile-time feature flag audit.

## Folder Layout

Each feature gets its own directory:

```text
features/<feature-id>/
  README.md
  frontend.md
  contracts.md
  rollout.md
```

Use only the files that are useful. Small features can keep everything in
`README.md`.

## Required Sections

Each feature plan should cover:

- Status - proposed, accepted, in-progress, shipped, paused.
- Scope - frontend, runtime, CLI, storage, or cross-cutting.
- Problem - what user pain this solves.
- User experience - screen placement, states, empty/error/loading behavior.
- Architecture - domain model, use cases, ports, adapters, ownership.
- Data contracts - request/response/view-model shapes and persistence.
- Non-goals - what this feature deliberately does not do.
- Rollout - flag, kill switch, migration, fallback behavior.
- Validation - unit, integration, UI, and manual checks.

## Clean Architecture Rules

- `domain/` owns feature language only. It must not import React, Ink, CLI
  process helpers, filesystem helpers, OpenCode clients, HTTP clients, or app
  service implementations.
- `application/` owns use cases. A use case coordinates ports and domain
  policies; it must not render UI and must not call runtime-specific services
  directly.
- `ports/` owns feature interfaces. Ports describe what the feature needs in
  domain terms, not how a runtime implements it.
- `adapters/` owns infrastructure translation. Adapters are the only layer that
  can import runtime-specific services, HTTP clients, filesystem access, or CLI
  process helpers.
- `ui/` owns rendering and input handling. UI imports feature use cases and view
  models only; it must not import adapters or runtime services.
- `index.ts` is the public feature API. External code should import from the
  feature entrypoint, not from internal folders.

Allowed dependency direction:

```text
ui -> application -> ports -> domain
adapters -> ports + domain + existing services
```

Forbidden dependency direction:

```text
domain -> application/ui/adapters/services
application -> ui/adapters/runtime services
ui -> adapters/runtime services
```

## SOLID Rules

- SRP: each file should have one actor/reason to change: rendering, use-case
  orchestration, domain policy, port contract, or adapter translation.
- OCP: adding a runtime or provider should primarily add a new adapter and
  registration, not modify generic UI branching.
- LSP: every adapter must honor the same port semantics, including degraded and
  unavailable states.
- ISP: split read, write, secret input, diagnostics, and testing ports when a
  caller does not need all capabilities.
- DIP: application/use-case code depends on ports, never concrete services.

## TypeScript Rules

- Use explicit exported domain/view-model types for every UI boundary.
- Prefer discriminated unions for state machines and action results.
- Use `type` imports for type-only dependencies.
- Validate external/runtime payloads at the adapter boundary before mapping into
  domain types. Prefer existing project dependencies such as `zod` when runtime
  responses are not fully trusted.
- Keep secrets as opaque inputs. Do not place raw secret strings in persistent
  domain state, logs, snapshots, diagnostics, or test fixtures.
- Return typed result objects for recoverable failures instead of throwing from
  use cases for expected runtime states.
- Use exhaustive `switch` checks for discriminated unions.
- Avoid rendering raw runtime responses. UI renders typed view models only.
- Do not add new dependencies for a feature without checking the latest stable
  version and justifying why existing dependencies are insufficient.

## Runtime Ownership Rules

- Keep state ownership explicit: local, env, project, managed, remote.
- Never silently mutate local user configuration or auth stores.
- Managed writes must target app-owned storage or app-owned runtime profiles.
- Local/env/project state is read-only unless the user explicitly chooses a
  destructive or mutating action.
- Keep failures honest. Do not convert unavailable runtime state into a green UI.

## Suggested Code Shape

For larger features, prefer a feature module with clean internal boundaries:

```text
src/features/<feature-id>/
  domain/
  application/
  ports/
  adapters/
  ui/
  index.ts
```

If the surrounding codebase already has a stronger local convention, keep the
public integration points in the existing locations and use the feature module
for the new domain/use-case boundary.

## Decision Scoring

When comparing implementation options, score them:

```text
🎯 confidence / 10   🛡️ reliability / 10   🧠 complexity / 10
Estimated changed lines: N-M
```
