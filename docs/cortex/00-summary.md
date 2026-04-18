# Cortex Summary

Studied revision: `38d505069113dc558654025e4fff91b08b35b34f`

## One-line verdict

Cortex is an unusually ambitious early-stage orchestrator with strong OTP instincts and genuinely interesting distributed ideas, but it is still too workspace-file-first to be called a calm durable engine.

## Strongest parts

- OTP decomposition and supervision taste
- clean DAG tiering and orchestration config flow
- mesh and gossip as real runtime modes, not only marketing labels
- gateway and sidecar path for external workers
- recovery mindset: resume, reconcile, parse logs, heal dead coordinators
- LiveView dashboards and telemetry surface

## Weakest parts

- orchestration truth lives heavily in `.cortex/` files, not only in a durable engine
- DB looks more like projection/history than primary state machine
- event log is subscriber-written, not atomic with the main state changes
- inter-agent messaging for local agents is still heavily file-bridge-based
- repo maturity and traction are much lower than the architecture story suggests
- breadth is already high for such a young one-author codebase

## Plain-language read

If `goclaw` feels like a growing platform product and `gastown` feels like a brilliant but unstable research lab, Cortex sits between them:

- more disciplined than Gastown
- more conceptually adventurous than many dashboard-first projects
- much less durable and battle-proven than GoClaw

## Main architect takeaway

The thing worth stealing from Cortex is not its exact truth model. It is its willingness to treat orchestration as a real concurrent systems problem.

The thing worth not copying is its current reliance on workspace files, derived projections, and poll-based bridges for too much of the real runtime truth.
