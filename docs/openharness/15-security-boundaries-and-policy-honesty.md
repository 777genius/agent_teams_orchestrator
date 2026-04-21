# OpenHarness Security Boundaries And Policy Honesty

## Short judgment

Security thinking exists in OpenHarness.

The best local security taste is decent.
The weakest part is boundary honesty.

## What is good

### Sensitive-path hard deny exists

`permissions/checker.py` includes built-in patterns for:

- SSH
- AWS
- GCP
- Azure
- GPG
- Docker config
- kube config
- OpenHarness credential stores

This is a real positive signal.

### Permission checker has a coherent local story

It has:

- explicit allowed tool list
- explicit denied tool list
- path rules
- denied command patterns
- permission modes
- plan-mode blocking
- confirmation flow for mutating tools

This is much better than a completely ad hoc permission prompt layer.

### Platform capability narrowing is honest

`platforms.py` narrows features per platform instead of pretending parity exists everywhere.

### ohmo remote admin has guarded power

`ohmo/gateway/runtime.py` only allows remote admin commands when:

- the command opts in
- gateway config allows remote admin
- the command name is on the allowlist

That is a good guarded-power pattern.

## What is weak

### Docker sandbox policy honesty gap

Issue `#150` is serious because `sandbox/docker_backend.py` only checks whether `allowed_domains` is non-empty.

If it is non-empty, networking becomes:

- `--network bridge`

without enforcing the actual allowlist or denylist contents.

That means runtime behavior is weaker than the surface suggests.

### Personalization crosses a secret boundary

`personalization/extractor.py` extracts:

- `export NAME=value`
- endpoints
- paths
- IPs

Then `prompts/context.py` injects the resulting local rules back into future system prompts.

That makes issue `#149` architecturally real:

- one shell snippet can become durable prompt-side secret replay

### Sandbox coverage is not the same as whole-tool isolation

Issue `#120` itself showed a design tension:

- shell commands can be sandboxed
- some file tools and direct Python I/O paths still require separate boundary logic

This is not automatically fatal.
But it means "sandbox" is not a simple blanket truth.

### Prompt-side instructions are still doing security work

Some capability limitations still depend too much on:

- prompt wording
- mode semantics
- implicit role obedience

That is not the same as a hard security boundary.

## Main lesson

OpenHarness is worth studying for:

- local permission discipline
- explicit deny patterns
- guarded power on remote/admin surfaces

But it is also a strong warning:

- do not promise a safety boundary unless runtime truly enforces it
- do not let local memory become a secret replay path
- do not treat prompt-side narrowing as equivalent to real capability enforcement
