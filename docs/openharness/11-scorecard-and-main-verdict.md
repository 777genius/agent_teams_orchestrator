# OpenHarness Scorecard And Main Verdict

## High-level scorecard

| Axis | Score | Why |
| --- | ---: | --- |
| Local coding harness quality | 9.0/10 | Strong local primitives, strong worktree story, serious multi-agent experimentation |
| Multi-agent coordination primitives | 8.4/10 | Coordinator mode, mailbox, team lifecycle, in-process + subprocess backends are real |
| Durable orchestration engine | 6.1/10 | Useful runtime substrate, but durable task truth is not the center of the system |
| Contract closure | 5.8/10 | Too many seams still depend on env flags, prompt framing, dual protocols, and file control planes |
| Security boundary quality | 5.4/10 | Some good local hardening, but important safety surfaces still over-promise |
| Provider portability | 6.4/10 | Provider registry and OpenAI-compatible client are good, but built-ins and teammate spawn paths still leak dialect assumptions |
| Long-session continuity | 8.8/10 | Auto-compaction and continuity carryover are unusually serious for such a young project |
| Test surface | 8.0/10 | A lot of targeted tests exist, especially around swarm, compact, sandbox, UI, and ohmo |
| Surface maturity | 6.3/10 | Product breadth is growing fast, but several surfaces are still soft or partially closed |
| Maintenance pressure | 6.6/10 | Healthy issue-driven hardening, but growth is already creating contract pressure |

## Main verdict

OpenHarness is already a real competitor, but it is not strong for the same reasons as GoClaw.

The center of gravity is:

- local-first execution
- coding-oriented swarm ergonomics
- worktree isolation
- background worker runtime
- compaction and session continuity

It is not yet:

- a calm durable orchestration engine
- a store-backed coordination truth system
- a fully closed multi-provider orchestration platform

## Short comparison in plain language

- GoClaw is stronger as a durable orchestration engine
- our stack is stronger as a coding cockpit and operator surface
- OpenHarness is stronger as a fresh local harness with serious swarm primitives

## Strongest subsystems

- `swarm/worktree.py`
- `ui/app.py` headless worker split
- `services/compact/__init__.py`
- `utils/fs.py` plus `utils/file_lock.py`
- `swarm/in_process.py`
- `api/openai_client.py` and `api/registry.py`

## Weakest seams

- coordinator mode contract
- dual team truth
- dual permission sync protocols
- Docker sandbox policy honesty
- personalization secret boundary
- provider inheritance across built-in subagents
- in-memory task manager truth

## Architect-grade conclusion

OpenHarness is best read as:

- a strong local harness with very reusable coding-swarm ideas
- a warning against letting prompt semantics, env flags, file protocols, and runtime fallbacks quietly become the real control plane
