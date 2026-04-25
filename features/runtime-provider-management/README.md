# Runtime Provider Management

Status: accepted for planning

Feature flag: `RUNTIME_PROVIDER_MANAGEMENT`

Accepted implementation option:

Hybrid feature module with existing OpenCode services
🎯 9   🛡️ 9   🧠 6
Estimated changed lines: 1,300-2,300.

## Scope

Build a reusable provider-management popup that can manage nested runtime
providers, starting with OpenCode. The first implementation targets the
frontend application surface and the app-managed OpenCode profile.

## Architecture Decision

Use a feature module for the product boundary and existing OpenCode services for
runtime infrastructure:

```text
src/features/runtimeProviderManagement/
  domain/
  application/
  ports/
  adapters/opencode/
  ui/
  index.ts
```

This keeps the feature UI generic and reusable while avoiding a rewrite of
working OpenCode inventory, host, profile, and diagnostics services.

## Boundary Rules

- UI imports the feature entrypoint, use cases, and view models only.
- Application use cases depend on ports and domain types only.
- OpenCode-specific services are imported only inside
  `adapters/opencode/`.
- Runtime responses are validated and mapped before reaching domain/UI code.
- Managed writes target the app-managed OpenCode profile only.
- Local OpenCode user config and auth are observed or explicitly synced, never
  silently mutated.
- Raw secrets never enter diagnostics, logs, snapshots, or persistent view
  models.

## Documents

- Frontend plan: `frontend.md`
