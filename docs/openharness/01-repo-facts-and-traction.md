# OpenHarness Repo Facts and Traction

## Verified facts

- Repository: `HKUDS/OpenHarness`
- URL: `https://github.com/HKUDS/OpenHarness`
- Studied local revision: `78160047`
- Default branch: `main`
- Repository creation date: `2026-04-01`
- Latest observed push: `2026-04-16`
- Stars at study time: `10008`
- Forks at study time: `1703`
- License: MIT
- Latest release: `v0.1.6`
- Latest release title: `v0.1.6 - ohmo Personal Agent & Auto-Compaction`
- Latest release publish date: `2026-04-10`

## Why the traction matters

This is a very unusual profile:

- extremely young
- already unusually visible
- shipping fast
- attracting issue traffic immediately

That usually means two things at once:

- there is real product energy and strong idea pull
- correctness pressure will arrive faster than architecture closure

## What the README claims

The README is not modest. It claims:

- core lightweight agent infrastructure
- tools, skills, memory, permissions, hooks, MCP
- multi-agent coordination
- team registry and task management
- background task lifecycle
- `ohmo` as a long-session personal agent
- support for Claude Code and Codex subscription-backed usage

Most of those claims are not pure vapor. The important caveat is that some of them are at different maturity levels.

## What the release notes signal

The `v0.1.6` and `Unreleased` notes emphasize:

- auto-compaction and long-session continuity
- subprocess teammates in headless worker mode
- Docker sandbox backend
- more providers and OpenAI-format compatibility
- React TUI polish
- channel-facing `ohmo` features

This is a strong clue about where the project is investing:

- local harness experience
- background tasks
- provider breadth
- channelized personal-agent surface

## Issue pattern

The issue tracker is already showing classic early-harness fault lines:

- provider assumption bugs
- TUI/process spawning bugs
- persistence corruption bugs
- sandbox policy honesty problems
- secret/personalization boundary leaks

Representative examples:

- `#153` - hard-coded `haiku` model breaks non-Anthropic subagents
- `#150` - Docker sandbox domain policies do not actually affect runtime behavior
- `#149` - personalization persists raw exported secret values into future prompts
- `#129` - persistent state corruption on crash or concurrent access
- `#137` - parallel tool turns could brick the session when a tool raised
- `#97` - subprocess teammate path crashed by trying to mount Ink raw-mode TUI on non-TTY stdin

## Maturity interpretation

The right mental model is:

- traction is real
- architecture is promising
- maturity is early

This is not yet a "quiet mature platform".
It is a fast-moving local-first harness that is still hardening its execution contract in public.
