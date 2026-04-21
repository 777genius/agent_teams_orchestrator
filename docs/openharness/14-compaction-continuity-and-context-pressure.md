# OpenHarness Compaction, Continuity, And Context Pressure

## Why this matters

Most young agent projects ignore long-session continuity until they are already broken by it.

OpenHarness took this problem seriously early.
That is one of the clearest signs that the project is more than a UI shell.

## What is genuinely strong

`services/compact/__init__.py` is a serious subsystem with:

- microcompact for cheap shrinking
- context collapse before full compact
- session-memory compaction
- full LLM compaction
- compaction checkpoints
- boundary marker messages
- preserved attachments
- preserved hook results
- preserved discovered tools
- preserved task focus and carryover metadata
- reactive compaction on prompt-too-long failures

This is unusually mature for a project this young.

## Why it is architecturally good

The compaction system is not only "make the chat shorter".

It explicitly tries to preserve operational continuity:

- what tools were discovered
- what the task focus currently is
- what the important carryover state is
- where the conversation boundary now lives

That is exactly the right mindset for agents expected to live across long sessions.

## Session storage also learned the right lesson

`services/session_storage.py` does a useful thing:

- it persists only a known allowlist of tool metadata

That is much better than blindly dumping arbitrary runtime state.

It shows some contract discipline even inside a still-young system.

## The shadow risk

This subsystem is good, but it already shows a future risk:

- too much behavioral continuity can move into `tool_metadata`
- too much control can move into compaction heuristics and thresholds

That can become a shadow policy plane if not kept honest.

## Reasoning controls add another soft layer

OpenHarness exposes:

- effort
- passes
- auto-compact threshold
- context-window overrides

This is useful for operator control.

But it also means there is a growing class of behavior steered through:

- settings
- CLI flags
- prompt annotations
- heuristic thresholds

That is fine as a tuning layer.
It becomes dangerous if it starts carrying correctness.

## Issue signal worth remembering

Issue `#103` matters because it shows how easy it is to lie to the model with stale environment/system prompt state after restore.

That is exactly the kind of bug you get when continuity becomes partially semantic and partially reconstructed.

## Architect takeaway

The compaction subsystem is a real positive reference.

Steal:

- staged compaction
- continuity artifacts
- explicit boundary markers
- carryover allowlists
- reactive retry strategy

Do not copy:

- too much hidden behavioral dependence on heuristics
- unbounded carryover metadata
- restore flows that can replay stale environment truth
