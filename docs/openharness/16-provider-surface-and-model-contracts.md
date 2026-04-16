# OpenHarness Provider Surface And Model Contracts

## Overall verdict

Provider support in OpenHarness is stronger than in many young harnesses, but provider portability is not fully closed at the orchestration layer.

The lower layers are often better than the higher ones.

## What is good

### Provider registry is a real subsystem

`api/registry.py` is one source of truth for:

- provider identity
- env keys
- default base URLs
- gateway classification
- local vs cloud classification
- OAuth vs API key classification

This is the right architectural direction.

### OpenAI-compatible client has serious compatibility work

`api/openai_client.py` shows real engineering effort:

- base URL normalization
- model-sensitive token parameter selection
- tool conversion
- reasoning-content replay for thinking models
- retry behavior
- streaming assembly into internal message format

Issue `#107` also shows they are closing real compatibility bugs, not only demo-paths.

### Gateway/provider-profile thinking is already present

`ohmo` and the auth/config layers clearly think in terms of:

- provider profiles
- runtime model selection
- profile-specific auth
- session reuse

That is a good product and runtime instinct.

## Where the contract still leaks

### Built-in subagents still leak Anthropic assumptions

Issue `#153` is one of the clearest architectural warnings in the project.

Built-ins like:

- `Explore`
- `claude-code-guide`

still hard-code `model="haiku"`.

That means the built-in orchestration surface is not fully provider-neutral.

### Model inheritance is not fully honest yet

`spawn_utils.py` forwards `OPENHARNESS_MODEL`, but `build_inherited_cli_flags()` still passes any `model` value verbatim via `--model`.

That is why the sentinel value `"inherit"` currently leaks as literal CLI state instead of remaining a semantic instruction.

This is a very valuable lesson:

- "inherit" needs to be a first-class contract, not a string convention

### Agent task defaults are still Anthropic-biased

`tasks/manager.py` defaults local agent subprocesses to:

- `ANTHROPIC_API_KEY`
- `python -m openharness`

unless an explicit command override is provided.

That is a practical local default.
It is not a truly provider-neutral orchestration substrate.

## Main takeaway

Steal:

- provider registry as one source of truth
- serious OpenAI-compatible normalization
- explicit provider-profile thinking

Avoid:

- built-ins that smuggle provider assumptions
- string-sentinel inheritance contracts
- orchestration surfaces that are less portable than the lower-level provider client
