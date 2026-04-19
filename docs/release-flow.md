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

## 2. `claude_agent_teams_ui` release

Purpose:
- public delivery channel for Electron builds
- public delivery channel for runtime binary assets used by `pnpm dev`

What lives there:
- Electron app assets
- runtime archives like `agent-teams-runtime-darwin-arm64-v0.0.3.tar.gz`
- runtime manifest and checksums

Important:
- UI release tag and runtime version do not have to match
- example: UI release `v1.2.0` can carry runtime assets `v0.0.3`

## Current contract

- `agent_teams_orchestrator` tag identifies the source revision used to build the runtime
- `claude_agent_teams_ui` release tag identifies where users download runtime artifacts
- `claude_team/runtime.lock.json` binds these two together:
  - `sourceRef` = private runtime source tag
  - `releaseTag` = public UI release that stores binary assets

## Source-only orchestrator release

Use this when you want a fresh private release without touching the UI release cadence.

Steps:
1. Bump `package.json` version in `agent_teams_orchestrator`
2. Verify the runtime still compiles
3. Commit to `main`
4. Push `main` to `private-origin`
5. Create and push an immutable git tag like `v0.0.3`
6. Create a private GitHub Release for that tag

This does **not** publish new runtime assets to `claude_agent_teams_ui`.

Important:
- a private source release alone does **not** update what end users download
- if `claude_team` is still pinned to an older runtime in `runtime.lock.json`, users will keep bootstrapping that older binary

## Publish runtime assets into an existing UI release

Use this when the runtime binary must be refreshed for public `pnpm dev` or packaged app flows.

Run the private workflow `release-runtime.yml` with:
- `source_ref` = runtime source tag, for example `v0.0.3`
- `runtime_version` = runtime version, for example `0.0.3`
- `target_release_repo` = `777genius/claude_agent_teams_ui`
- `target_release_tag` = existing public release, for example `v1.2.0`

This builds the runtime from the private repo and uploads the versioned archives into the chosen public UI release.

After publishing assets, also update `claude_team/runtime.lock.json` to the new runtime version if you want `pnpm dev` and packaged app flows to start using it.

## Recommended rule

- create a private orchestrator release whenever you want a clean source milestone
- publish runtime assets into `claude_agent_teams_ui` only when the public app/dev delivery path actually needs new binaries
- if the new runtime adds commands or behavior expected by the UI, do **both**:
  - publish the runtime assets into the UI release
  - bump `claude_team/runtime.lock.json`
