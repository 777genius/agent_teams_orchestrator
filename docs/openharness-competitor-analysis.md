# OpenHarness Competitor Analysis

Date: 2026-04-16
Studied local revision: `78160047` on `origin/main`
Studied local clone: `competitors/OpenHarness`

## Verified repo facts

- Repo: `HKUDS/OpenHarness`
- Created: `2026-04-01`
- Latest observed push: `2026-04-16`
- Stars at study time: `10008`
- Forks at study time: `1703`
- Latest release: `v0.1.6`
- Latest release published: `2026-04-10`

## Short verdict

OpenHarness is a very interesting new competitor because it already has real local multi-agent infrastructure:

- coordinator mode
- persistent team lifecycle
- mailbox communication
- worktree isolation
- headless worker mode
- multiple teammate backends

That makes it much more serious than a typical "week-old AI shell" repo.

⚠️ But it is still a young harness, not a calm mature orchestration platform.

The biggest current architectural risks are:

- dual team truth
- prompt/env-driven coordinator semantics
- file-based control plane weight
- sandbox policy honesty gap
- personalization boundary weakness
- provider-specific assumptions in built-ins

## High-level scorecard

| Axis | Score | Why |
| --- | ---: | --- |
| Local coding harness quality | 9.0/10 | Strong local primitives, serious worktree story, real swarm experimentation |
| Multi-agent coordination primitives | 8.4/10 | Coordinator mode, mailbox, team lifecycle, in-process plus subprocess backends are real |
| Durable orchestration engine | 6.1/10 | Useful runtime substrate, but durable task truth is not the center of the system |
| Contract closure | 5.8/10 | Too many seams still depend on env flags, prompt framing, dual protocols, and file control planes |
| Security boundary quality | 5.4/10 | Some good local hardening, but key safety surfaces still over-promise |
| Provider portability | 6.4/10 | Provider registry is good, but built-ins and inheritance seams still leak provider assumptions |
| Long-session continuity | 8.8/10 | Auto-compaction and continuity carryover are unusually serious for such a young project |
| Test surface | 8.0/10 | Real targeted tests exist across swarm, compact, sandbox, UI, API, and ohmo |
| Surface maturity | 6.3/10 | Product breadth is growing fast, but several surfaces are still soft or partially closed |
| Maintenance pressure | 6.6/10 | Healthy issue-driven hardening, but growth is already creating contract pressure |

## What is genuinely strong

### 1. Worktree isolation

`swarm/worktree.py` is one of the strongest subsystems in the repo:

- strict slug validation
- path-traversal rejection
- stable branch naming
- resumable worktrees
- symlink reuse of heavy local directories

This is a real coding-agent primitive, not just a README idea.

### 2. Headless worker split

`ui/app.py` and the subprocess teammate flow separate worker execution from the interactive TUI.

This is exactly the right lesson from issue `#97`.
Background workers should not pretend to be terminal UIs.

### 3. Auto-compaction and continuity

`services/compact/__init__.py` is unusually serious for such a young project.

It already has:

- microcompact
- reactive compaction on prompt-too-long
- session-memory compaction
- full compaction
- carryover artifacts
- explicit `compact_checkpoints` and `compact_last`

This is one of the strongest lessons in the whole repo.

### 4. Quiet local engineering

The project hardened several boring but important local surfaces early:

- atomic writes
- file locking
- metadata allowlisting in session persistence
- `contextvars` isolation for in-process teammates

That is above-average engineering taste for a project this young.

### 5. Provider registry and lower-level provider normalization

`api/registry.py` and `api/openai_client.py` are stronger than the higher-level orchestration/provider contract.

There is real effort around:

- provider identity
- base URL normalization
- OpenAI-compatible support
- thinking-model handling
- retry behavior

## What is architecturally weak

### 1. Dual team truth

There is:

- old in-memory `TeamRegistry`
- newer persistent `TeamLifecycleManager`

and the project explicitly allows them to coexist.

That is a classic migration-drift smell.

### 2. Soft coordinator contract

Coordinator mode still depends too much on:

- `CLAUDE_CODE_COORDINATOR_MODE`
- prompt framing
- tool filtering conventions

That makes the mode real enough for local experimentation, but not yet a hard structural contract.

### 3. File substrate weight

The mailbox and permission bridges are inspectable and useful.
But the project is always close to letting file protocols become more than transport.

That is powerful locally and dangerous if mistaken for durable orchestration truth.

### 4. Security boundary honesty gap

The strongest example is issue `#150`.

`sandbox/docker_backend.py` only checks whether `allowed_domains` is non-empty.
When it is, the container gets `--network bridge`.

The actual allowlist or denylist contents are not enforced there.

Even more important, tests already codify this behavior:

- `tests/test_sandbox/test_docker_backend.py` explicitly expects `bridge`

That means this is not just an accidental bug.
It is already part of the de facto contract.

### 5. Personalization secret boundary weakness

`personalization/extractor.py` extracts `export NAME=value`.
`prompts/context.py` later injects local rules into the system prompt.

Issue `#149` is therefore architecturally real:

- one shell snippet can become durable prompt-side secret replay

And again, this is not only runtime behavior.
It is already normalized by tests:

- `tests/test_personalization/test_extractor.py` explicitly validates export extraction

### 6. Built-in provider assumptions

Issue `#153` shows the orchestration surface is less provider-neutral than the lower-level client layer.

Built-ins like:

- `Explore`
- `claude-code-guide`

still hard-code `model="haiku"`.

This is exactly the kind of portability drift that bites young harnesses as soon as they broaden provider support.

## What the code says

### 1. It already has real swarm primitives

This is not fake README surface.

The code really contains:

- `coordinator/coordinator_mode.py`
- `swarm/team_lifecycle.py`
- `swarm/mailbox.py`
- `swarm/worktree.py`
- `swarm/registry.py`
- `swarm/subprocess_backend.py`
- `swarm/in_process.py`

### 2. The best subsystem is probably worktree isolation

`WorktreeManager` is one of the strongest things in the repo:

- slug validation
- traversal rejection
- stable branch naming
- resumable worktrees
- optional symlink reuse of heavy local dirs

This is worth stealing.

### 3. The headless worker split is a real architectural win

`run_task_worker()` gives subprocess teammates a non-TTY worker path instead of forcing them through Ink/TUI.

This is exactly the right lesson from subprocess issue `#97`.

### 4. The project improved its boring persistence discipline fast

Issue `#129` led to:

- atomic write helpers
- file locking

That is a strong sign of engineering instinct.

### 4.5. Session metadata carryover is more disciplined than it looks

`services/session_storage.py` only persists an allowlisted subset of tool metadata:

- `permission_mode`
- `read_file_state`
- `invoked_skills`
- `async_agent_state`
- `recent_work_log`
- `recent_verified_work`
- `task_focus_state`
- `compact_checkpoints`
- `compact_last`

That is a very good pattern.
The continuity layer is not a random dump.

### 5. The coordination model is already drifting between old and new truths

This is the most important architectural warning.

There is:

- old in-memory `TeamRegistry`
- new persistent `TeamLifecycleManager`

And they explicitly coexist.

That is a classic migration-drift smell.

### 6. Permission routing also already has two protocols

`permission_sync.py` supports:

- file-based pending/resolved directories
- mailbox-based request/response

Interesting for experimentation.
Dangerous if left unclosed.

### 7. The runtime center is still local and partially in-memory

`BackgroundTaskManager` is useful and explicit, but task truth is not durable in the GoClaw sense.

It tracks:

- tasks
- processes
- waiters

in memory, while output logs go to disk.

That is a good local harness design.
It is not a durable orchestration engine yet.

### 8. ohmo is already a real second product surface

`ohmo/gateway/runtime.py` and the runtime pool are not cosmetic.
They already include:

- session-key routing
- runtime pooling per session
- restoration from workspace storage
- guarded remote admin
- provider-profile aware runtime reuse

This is strategically important because it means OpenHarness is already trying to become more than a CLI shell.

## What the issues say

Open issues worth taking seriously:

- `#153` - built-in subagents hard-code `haiku`, breaking non-Anthropic providers
- `#150` - Docker sandbox domain policy contents are not enforced
- `#149` - personalization stores exported secret values in local rules and re-injects them later
- `#102` - even adjacent work around OpenClaw is calling for a unified internal background task data model

Closed issues that show healthy hardening:

- `#129` - state corruption and concurrent write corruption
- `#137` - parallel tool turn contract breakage
- `#97` - subprocess/TUI raw-mode mismatch

Interpretation:

- the team is finding real seams quickly
- the fixes are often architecture-relevant
- but the project is still in the stage where foundational contracts are being closed in public

## Tests and maturity signals

The repo has a real test surface:

- `83` Python test files at study time
- dense areas include swarm, tools, UI, services, sandbox, API, and `ohmo`

I also ran targeted tests locally against the studied clone.

Passing runs:

- `PYTHONPATH=src uv run pytest tests/test_swarm/test_worktree.py tests/test_swarm/test_mailbox.py tests/test_swarm/test_team_lifecycle.py tests/test_swarm/test_spawn_utils.py tests/test_utils/test_fs.py tests/test_services/test_compact.py tests/test_personalization/test_extractor.py tests/test_sandbox/test_docker_backend.py -q`
  - result: `109 passed in 5.75s`
- after `uv sync --extra dev`, `uv run pytest tests/test_engine/test_query_engine.py -q -k 'tool or compact or permission'`
  - result: `9 passed, 9 deselected in 4.18s`

Useful maturity nuance:

- a naive first test run outside the project layout failed on `ModuleNotFoundError`
- a second attempt before full sync failed on missing `croniter`

Interpretation:

- the test surface is real
- the dev-setup surface is still a little rough
- this matches the repo's age and churn profile

## Best practices to steal

- headless worker execution path separate from TUI
- worktree isolation with strict slug validation
- simple explicit mailbox for local-first coordination
- atomic-write plus file-lock discipline
- structured compaction with continuity artifacts
- `contextvars` identity isolation for in-process workers
- metadata allowlisting for persisted continuity state
- guarded remote admin surfaces with explicit opt-in and allowlists

## Critical anti-patterns to avoid

- dual truth between old and new team/task models
- prompt/env-only coordinator contracts
- file-based control planes silently becoming the durable substrate
- sandbox surfaces that over-promise policy enforcement
- provider-specific built-in assumptions
- personalization that can persist secrets into future prompts
- compatibility shadows that linger too long around stronger new subsystems
- tests accidentally normalizing soft boundary behavior

## Compared with GoClaw and us

- `GoClaw` is still stronger as an orchestration engine
- our stack is still stronger as a coding cockpit
- OpenHarness is more interesting than mature

The best way to read it is:

- as a source of strong local swarm ideas
- not as a final orchestration architecture to copy literally

## Architect-grade conclusion

OpenHarness is strongest where it uses:

- explicit local primitives
- inspectable file/process contracts
- boring persistence hardening
- coding-oriented isolation
- serious compaction and continuity

OpenHarness is weakest where it uses:

- env flags as semantics
- prompt obedience as contract
- dual truths during migration
- safety surfaces that are stronger in product story than in runtime
- provider neutrality that is stronger in lower layers than in built-ins

The best way to use it as a competitor reference is:

- steal the local harness primitives
- steal the compaction seriousness
- steal the quiet engineering discipline
- do not copy its soft coordinator contract
- do not copy its dual-truth migration seams
- do not copy its policy surfaces when enforcement is not yet equally strong

## Structured companion

For quick lookup by seam, use:

- `docs/openharness/README.md`
