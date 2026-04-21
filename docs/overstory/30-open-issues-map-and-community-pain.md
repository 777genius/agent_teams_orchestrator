# Open Issues Map And Community Pain

## Issue shape

As of `2026-04-16`:
- total issues reviewed: `86`
- closed: `71`
- open: `15`

Most informative labels:
- `bug`
- `area:runtimes`
- `area:coordination`
- `area:agent-lifecycle`
- `area:infrastructure`
- `focus:reliability`

## Most architecturally revealing open issues

### `#85` - Switch spawning from interactive tmux TUI to headless mode

`🎯 10   🛡️ 9   🧠 6`

This is probably the single strongest direction signal in the open queue.
It confirms that the maintainers themselves know:
- headless is the cleaner destination
- tmux is still a transitional substrate

### `#105` - Coordinator cannot properly handle sub-agents across subdirectories / multi-repo boundaries

`🎯 10   🛡️ 9   🧠 6`

This is the deepest federation warning.
It exposes the limit of repo-local truth.

### `#131` - Reviewer under-reviews, lead trusts it, coordinator merges

`🎯 10   🛡️ 9   🧠 5`

This is the strongest role-contract honesty signal in the tracker.

### `#134` - Agent definition refinements

`🎯 9   🛡️ 8   🧠 5`

Very important because it shows the maintainers already know the role layer is not fully closed:
- reviewer identity
- builder timing
- merger mulch behavior
- mixed-runtime awareness

### `#132` - MCP server processes not terminated on session end

`🎯 9   🛡️ 8   🧠 4`

This is a classic lifecycle leak signal:
- runtime breadth is growing
- process cleanup contract is not yet uniformly sealed

### `#138` - Add support for Cursor hooks

`🎯 8   🛡️ 8   🧠 4`

This is a capability parity signal.
It shows that the adapter seam is useful, but runtime parity is still uneven.

### `#141` and `#142` - path normalization and tmux/socket/container edges

`🎯 9   🛡️ 8   🧠 4`

These confirm the substrate tax from two different angles:
- path security on Windows
- tmux/PID/socket assumptions in containerized environments

## What this says about the project

The community pain is not random.

It clusters around:
- runtime parity
- coordination boundaries
- lifecycle cleanup
- substrate assumptions
- role quality

That is a very coherent architecture signal.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 3`

Steal:
- treat issue history as architectural telemetry, not just bug backlog

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- ignoring the pattern when many open issues all point at the same seam

## Architect takeaway

**`overstory`'s open issues form a clean map of its real architectural frontier: headless transition, federation, role closure, lifecycle cleanup, and runtime parity.**
