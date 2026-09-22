# OpenHarness Tests, History, And Maturity

## Test surface snapshot

At study time the repo has:

- `83` Python test files

The densest test areas are:

- `test_swarm`
- `test_tools`
- `test_ohmo`
- `test_ui`
- `test_services`
- `test_api`
- `test_mcp`
- `test_sandbox`

That is a real test surface, not only decorative CI.

## What the test distribution implies

The project is clearly investing in:

- swarm behavior
- UI correctness
- provider compatibility
- compaction
- sandboxing
- `ohmo` runtime behavior

This matches the actual product and code shape.

## Direct targeted test runs

I ran targeted tests locally against the studied clone.

Passing targeted runs:

- `PYTHONPATH=src uv run pytest tests/test_swarm/test_worktree.py tests/test_swarm/test_mailbox.py tests/test_swarm/test_team_lifecycle.py tests/test_swarm/test_spawn_utils.py tests/test_utils/test_fs.py tests/test_services/test_compact.py tests/test_personalization/test_extractor.py tests/test_sandbox/test_docker_backend.py -q`
  - result: `109 passed in 5.75s`
- after a full project dev sync, `uv run pytest tests/test_engine/test_query_engine.py -q -k 'tool or compact or permission'`
  - result: `9 passed, 9 deselected in 4.18s`

Useful caveat:

- the first naive test attempt from outside the project layout failed with `ModuleNotFoundError: No module named 'openharness'`
- a second attempt before full sync also failed on missing `croniter`

Interpretation:

- the test surface is real and passes once the project environment is set up correctly
- the packaging and dev-setup surface is still a little rough, which fits the repo's age

## Tests also reveal what the team considers acceptable

Some tests do more than protect good behavior.
They also reveal which soft seams are already being normalized.

Important examples:

- `tests/test_sandbox/test_docker_backend.py`
  - explicitly expects `--network bridge` whenever `allowed_domains` is non-empty
- `tests/test_personalization/test_extractor.py`
  - explicitly validates extraction of `export NAME=value`

That is important architecturally because it means:

- the Docker sandbox policy gap is not only accidental runtime behavior
- the personalization secret-boundary issue is not only a parsing accident

## Churn hot spots

Recent churn since project creation clusters around:

- `README.md`
- `src/openharness/cli.py`
- `src/openharness/config/settings.py`
- `src/openharness/ui/backend_host.py`
- `src/openharness/ui/runtime.py`
- `src/openharness/engine/query.py`
- `ohmo/gateway/runtime.py`

Interpretation:

- the product surface and runtime settings are still moving quickly
- core seams are still cooling
- `ohmo` is already a hot growth area

## Issue history tells an honest story

The issue tracker is useful because it exposes foundational seams in public:

- `#97` subprocess/TUI mismatch
- `#103` stale restore environment/system prompt
- `#107` base URL regression
- `#120` Docker sandbox introduction and isolation trade-offs
- `#129` crash/concurrency persistence corruption
- `#137` parallel tool turn integrity bug
- `#149` personalization secret replay
- `#150` sandbox policy honesty gap
- `#153` non-Anthropic provider breakage in built-in agents

This is exactly how a real young systems project looks:

- the bugs are concrete
- the bugs are architecture-relevant
- the fixes often improve subsystem shape

## Maturity verdict

OpenHarness is:

- too young to be called calm
- already real enough to be taken seriously

It is not yet mature in the GoClaw sense.
But it is much more mature than a typical fresh AI shell because it already has:

- real swarm runtime pieces
- test coverage in the right places
- issue-driven hardening of important seams

## What confidence level this supports

Confidence is high for claims like:

- worktree isolation is real
- mailbox and team lifecycle are real
- compaction is serious
- local harness engineering quality is above average

Confidence is lower for claims like:

- fully closed durable orchestration
- honest sandbox guarantees across all advertised policy surfaces
- provider-neutral built-in subagent contract
- frictionless packaging and dev-environment closure

## Final reading

OpenHarness should be treated as:

- a serious young competitor
- a strong source of local-first design patterns
- a still-moving architecture that has not finished closing its most important contracts
