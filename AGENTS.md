# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Common commands

```bash
# Install dependencies
bun install

# Standard build (./cli)
bun run build

# Dev build (./cli-dev)
bun run build:dev

# Dev build with all experimental features (./cli-dev)
bun run build:dev:full

# Compiled build (./dist/cli)
bun run compile

# Run from source without compiling
bun run dev

# Source launcher used by app live/dev smoke tests
./cli-source
```

Source catalog execution resolves a complete native binary pair in this order:
existing `target/release`, then existing `target/debug`. On a clean checkout run
`./cli-source --prepare-native-catalog` once; this performs only the two locked,
offline debug Cargo builds and never installs packages or accesses the network.

Run from source with `./cli-source` for live/dev smoke loops; it executes `src/entrypoints/cli.tsx` directly through Bun and cannot go stale behind source edits. This is the default launcher the desktop app live tests should use unless a test explicitly validates packaged output. The source launcher normalizes an inherited `NODE_ENV=production` to `NODE_ENV=development` so source smoke does not accidentally exercise production-only runtime behavior. Set `CLAUDE_TEAM_SOURCE_LAUNCHER_PRESERVE_NODE_ENV=1` only when intentionally debugging that edge. Source-mode teammate startup can be slower than bundled startup, so source smoke harnesses may raise `CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS` and `CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS` when validating source behavior instead of watchdog latency.

For release or production-like app smoke checks, build first with `bun run build`, then point the app or test at `./cli` via `CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH`. `./cli` reads `dist/local-cli/cli.js`; `./cli-dev` reads `dist/local-cli-dev/cli.js` and is not the production wrapper. Set `ANTHROPIC_API_KEY` in the environment or use OAuth via `./cli /login`.

## High-level architecture

- **Entry point/UI loop**: src/entrypoints/cli.tsx bootstraps the CLI, with the main interactive UI in src/screens/REPL.tsx (Ink/React).
- **Command/tool registries**: src/commands.ts registers slash commands; src/tools.ts registers tool implementations. Implementations live in src/commands/ and src/tools/.
- **LLM query pipeline**: src/QueryEngine.ts coordinates message flow, tool use, and model invocation.
- **Core subsystems**:
  - src/services/: API clients, OAuth/MCP integration, analytics stubs
  - src/state/: app state store
  - src/hooks/: React hooks used by UI/flows
  - src/components/: terminal UI components (Ink)
  - src/skills/: skill system
  - src/plugins/: plugin system
  - src/bridge/: IDE bridge
  - src/voice/: voice input
  - src/tasks/: background task management

## Build system

- scripts/build.ts is the build script and feature-flag bundler. Feature flags are set via build arguments (e.g., `--feature=ULTRAPLAN`) or presets like `--feature-set=dev-full` (see README for details).
