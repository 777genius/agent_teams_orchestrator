# OpenHarness Security and Boundaries

## Overall judgment

Security thinking exists in OpenHarness, but the boundary discipline is uneven.

There are some good local patterns.
There are also some very real honesty gaps.

## What is good

### 1. Platform capability gating

`platforms.py` explicitly disables some features on native Windows:

- no swarm mailbox
- no sandbox runtime
- no Docker sandbox

That is better than pretending everything works everywhere.

### 2. Session snapshot metadata is narrowed

The session-storage allowlist is a small but useful boundary.

### 3. Docker and sandbox availability are checked explicitly

The system at least distinguishes:

- enabled
- available
- fail if unavailable

That is operationally useful.

## What is weak

### 1. Docker sandbox policy honesty gap

This is one of the clearest red flags.

In `docker_backend.py`, `allowed_domains` only switches networking from:

- `none`
- to `bridge`

But the actual allow/deny contents are not enforced.

That means the product surface says:

- domain-aware sandbox policy

while the runtime currently behaves like:

- unrestricted bridge networking when allowlist is non-empty

This is exactly the kind of over-claimed safety boundary we should never copy.

### 2. Personalization crosses a dangerous trust boundary

`session_hook.py` extracts facts from session text and persists them into local rules, and those local rules are injected back into later system prompts.

The extractor includes:

- `export KEY=value`
- endpoints
- hosts
- paths

That makes issue `#149` very serious:

- a one-off shell export can become durable prompt-side secret replay

This is not just a privacy nit.
It is a semantic-boundary failure.

### 3. Coordinator safety is partly prompt-only

The coordinator prompt clearly instructs workers and leaders.
That is useful.

But prompt instructions are not the same as:

- hard capabilities
- hard side-effect policy
- hard isolation

The architecture still relies too much on prompt-mediated obedience for critical behavior.

## Distilled security lesson

OpenHarness already contains some good local safety patterns.

But the most important lesson is negative:

- do not market or design a safety boundary that runtime does not actually enforce

That applies especially to:

- sandbox network policy
- personalization and secret persistence
- prompt-only restrictions presented as capability boundaries
