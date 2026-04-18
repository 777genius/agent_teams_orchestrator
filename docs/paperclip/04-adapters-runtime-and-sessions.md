# Adapters Runtime And Sessions

## Strong positive design

Paperclip's adapter model is clean.

Officially and in code, adapters have three responsibilities:

- server execution module
- UI parsing/config surface
- CLI formatting surface

That is a good boundary.

## Adapter breadth

Built-in adapters include:

- `claude_local`
- `codex_local`
- `gemini_local`
- `cursor`
- `opencode_local`
- `openclaw_gateway`
- `process`
- `http`
- others around the local/runtime ecosystem

This is broader than our current project in adapter/product breadth.

## Session management

`packages/adapter-utils/src/session-compaction.ts` shows real thought:

- which adapters resume sessions
- which ones supposedly manage context natively
- default compaction policy
- explicit override parsing

This is good architecture on paper.

## Real weakness

Issue `#3813` is very important.

It shows how dangerous session-management classification mistakes are:

- if native context management is marked too optimistically
- sessions do not rotate
- prompt size grows unbounded
- cost becomes architecture

This is a powerful lesson for us.

## Prompt/wake shaping

`packages/adapter-utils/src/server-utils.ts` contains a lot of wake-payload shaping and inline context injection.

This is smart and useful.

But it also proves the cost profile:

- the adapter layer is doing heavy prompt assembly work
- the orchestration shell still leans on model-visible heartbeat context instead of maximally cheap control-plane decisions

## Runtime truth

Paperclip is very open about being:

- control plane, not execution plane
- local adapters can be unsandboxed
- agent runtimes often remain external

That honesty is good.

## Main lesson

Steal:

- adapter split
- explicit session-management declarations
- session resume thinking

Avoid:

- over-trusting adapter-level "native context management" flags
- letting prompt/wake assembly become the main cost sink of orchestration
