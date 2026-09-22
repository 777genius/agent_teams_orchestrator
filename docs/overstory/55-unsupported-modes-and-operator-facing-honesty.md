# Unsupported Modes and Operator-Facing Honesty

Issue `#13` is one of the better small architectural signals in `overstory`.

The user diagnosed a root-mode failure correctly:
- tmux server exits
- `claude` rejects `--dangerously-skip-permissions` as `root`
- later operations hit a dead tmux socket

The maintainer response is notable.

The project did **not** choose:
- more configurability
- a misleading partial workaround
- silent fallback into a worse mode

The response was effectively:
- running as `root` is not a supported configuration
- the real fix is to run as a non-root user
- the product should improve the error message so the failure is honest

## Why this is good

This is operator-facing honesty.

There is a real difference between:
- making a system look more permissive
- making a system more understandable and safer

Sometimes the architecturally correct move is:
- keep the unsupported boundary unsupported
- improve preflight and diagnostics instead

## The broader pattern

This matters beyond `root` mode.

It is a useful principle for:
- unsupported container assumptions
- unsupported shell environments
- unsupported runtime adapters
- partially implemented headless paths

The product should be honest about them before it tries to be flexible about them.

## Best lesson to steal

Steal:
- honest unsupported-mode boundaries
- better preflight checks
- better failure messages instead of misleading permissiveness

Avoid:
- adding config switches that only turn explicit failure into silent bad behavior
- treating operator convenience as more important than truthful runtime boundaries
