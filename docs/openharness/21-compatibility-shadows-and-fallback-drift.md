# OpenHarness Compatibility Shadows And Fallback Drift

## Why this seam matters

OpenHarness is still young, so fallback and backward-compatibility layers are not surprising.

The important architectural question is different:

- are these fallbacks narrow and temporary
- or are they becoming a second contract surface

In OpenHarness, both patterns already exist.

## Good fallbacks

Some fallbacks are healthy and local:

- `swarm/registry.py` falls back from pane-native execution to subprocess or in-process execution
- `tools/grep_tool.py` keeps a Python fallback for portability
- `channels/impl/mochat.py` visibly falls back to polling workers
- `ui/react_launcher.py` keeps launcher fallbacks so the terminal UI can still start

These are reasonable because they mostly affect:

- operator ergonomics
- portability
- degraded-but-observable behavior

They do not pretend to be the main domain truth.

## Dangerous compatibility shadows

Other fallbacks are much more important because they sit on contract seams.

### 1. Flat settings vs profile layer

`config/settings.py` already has a stronger provider-profile model:

- `ProviderProfile`
- `active_profile`
- merged built-in profiles
- profile-specific auth and base URLs

But it also still has to project back into old flat fields:

- `provider`
- `api_format`
- `base_url`
- `model`

Methods like:

- `materialize_active_profile()`
- `sync_active_profile_from_flat_fields()`
- `_profile_from_flat_settings()`

show that the new contract is real, but the old carrier is still alive.

That is useful during migration.
It is dangerous if it lasts.

### 2. TeamRegistry vs TeamLifecycleManager

This is the clearest compatibility shadow in the project.

- `coordinator/coordinator_mode.py` still exposes an in-memory `TeamRegistry`
- `swarm/team_lifecycle.py` adds the stronger persistent `TeamLifecycleManager`

The persistent layer is better.
But the old one is still present and explicitly "kept for backward compatibility".

This is exactly how dual truth starts.

### 3. Permission sync uses two protocols

`swarm/permission_sync.py` supports:

- file-based pending/resolved directories
- mailbox-based request/response

It also exposes a legacy `PermissionResponse` type.

That is useful during evolution.
But it means the permission bridge contract is not yet singular.

### 4. Compaction keeps legacy aliases

`services/compact/__init__.py` still contains:

- backward-compat aliases
- "legacy" helpers for older compact behavior

This is a smaller problem than the team seam, but it shows the same pattern:

- a stronger subsystem is emerging
- old entry points are still being kept alive

## Where tests make this more serious

The strongest signal is when a fallback is not only in code, but already normalized by tests.

Two important examples:

- `tests/test_sandbox/test_docker_backend.py` explicitly expects Docker `--network bridge` whenever `allowed_domains` is non-empty
- `tests/test_personalization/test_extractor.py` explicitly confirms extraction of `export NAME=value`

That means some controversial behavior is already becoming de facto contract.

## Main lesson

Steal:

- narrow, operator-visible fallbacks for portability
- explicit migration helpers with clear target direction

Avoid:

- letting compatibility carriers become the long-term architecture
- keeping old and new coordination truths alive at the same time
- allowing tests to quietly ratify weakened boundary semantics

## Final verdict

OpenHarness does not yet suffer from compatibility pressure at the GoClaw level.

But the early warning signs are already present:

- stronger new subsystems
- older carriers still alive
- tests beginning to normalize soft behavior

This is exactly the moment where a project either closes the seam or carries it for years.
