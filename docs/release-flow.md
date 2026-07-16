# Release Flow

This repo has two different release concepts. They should not be mixed.

## 1. `agent_teams_orchestrator` release

Purpose:
- source-of-truth version for the private runtime repo
- immutable source tag for a specific runtime build
- private GitHub Release for internal history and traceability

What lives here:
- source code
- commits
- tags like `v0.0.3`
- optional private GitHub Releases

What does **not** live here by default:
- public delivery binaries for app users

## 2. `agent_teams_orchestrator_binaries` release

Purpose:
- public delivery channel for runtime binary assets used by `pnpm dev`
- source for runtime assets staged into Electron builds

What lives there:
- runtime archives like `agent-teams-runtime-darwin-arm64-v0.0.3.tar.gz`
- versioned runtime manifest and checksums

Important:
- runtime source tag, public binary release tag, and runtime version must match

## Current contract

- `agent_teams_orchestrator` tag identifies the source revision used to build the runtime
- `agent_teams_orchestrator_binaries` release tag identifies where users download runtime artifacts
- `claude_team/runtime.lock.json` binds these two together:
  - `sourceRef` = private runtime source tag
  - `releaseRepository` = `777genius/agent_teams_orchestrator_binaries`
  - `releaseTag` = namespaced public binary release tag such as `runtime-v0.0.3`

## Tagged runtime release

Use this when you want to publish a runtime without touching the UI release cadence.

Steps:
1. Bump `package.json` version in `agent_teams_orchestrator`
2. Verify the runtime still compiles
3. Commit to `main`
4. Push `main` to `origin`
5. Create and push an immutable git tag like `v0.0.3`
6. Wait for the automatically triggered `release-runtime.yml` workflow

Pushing the version tag also triggers `release-runtime.yml`, which publishes the matching runtime
assets to `agent_teams_orchestrator_binaries` and verifies every asset is anonymously downloadable.

Important:
- the runtime tag publishes binaries but does **not** update the UI lock automatically
- if `claude_team` is still pinned to an older runtime in `runtime.lock.json`, users will keep bootstrapping that older binary

## Republish runtime assets manually

Use this when the runtime binary must be refreshed for public `pnpm dev` or packaged app flows.

Run the private workflow `release-runtime.yml` with:
- `source_ref` = runtime source tag, for example `v0.0.3`
- `runtime_version` = runtime version, for example `0.0.3`
- `target_release_repo` = `777genius/agent_teams_orchestrator_binaries`
- `target_release_tag` = matching public runtime release, for example `runtime-v0.0.3`

This builds the runtime from the private repo and uploads the versioned archives into the dedicated
public binary release.

After publishing assets, also update `claude_team/runtime.lock.json` to the new runtime version if you want `pnpm dev` and packaged app flows to start using it.

## Frontend-managed release

The preferred production flow is for the frontend release workflow to coordinate runtime delivery:

1. Push a frontend tag, for example `v1.3.0`.
2. The frontend workflow reads `claude_team/runtime.lock.json`.
3. If the runtime assets for that lock are missing from the public binary release, the workflow triggers this repo's private `release-runtime.yml` with `workflow_dispatch`.
4. The frontend workflow finds and polls the exact orchestrator run name:
   `runtime <runtime_version> -> <target_release_repo>@<target_release_tag>`.
5. After the orchestrator run succeeds, the frontend workflow verifies all runtime assets exist in the public binary release.
6. Platform packaging jobs download and unpack the matching runtime into `resources/runtime` before `electron-builder`.

This keeps the packaged Electron app self-contained while still keeping the runtime source private.

Required frontend secret:
- `RUNTIME_BUILD_DISPATCH_TOKEN` with permission to dispatch and read Actions runs in `777genius/agent_teams_orchestrator`.

Required orchestrator secret:
- `BINARIES_PUBLISH_TOKEN` with permission to upload assets into `777genius/agent_teams_orchestrator_binaries`.

## Recommended rule

- create a private orchestrator release whenever you want a clean source milestone
- publish runtime assets into `agent_teams_orchestrator_binaries` for every runtime version tag
- if the new runtime adds commands or behavior expected by the UI, do **both**:
  - publish the runtime assets into the public binary release
  - bump `claude_team/runtime.lock.json`
