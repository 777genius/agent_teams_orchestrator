# GoClaw Execution Modes and Run Contract

## Core claim

GoClaw's runtime modes are not first-class execution contracts.
They are path-specific bundles of flags and wrappers.

## The visible names

The system uses names like:

- `notification`
- `announce`
- `delegate`

At first glance, that looks like a clear execution-mode model.

## The deeper problem

Those modes are not carried as one canonical runtime contract.
Instead they are assembled from different pieces:

- `RunKind`
- `HideInput`
- parent trace wiring
- `PendingTeamDispatch`
- metadata propagation
- sender/role restoration

## `RunKind` is soft

In practice:

- tools reliably see `notification`
- observability reliably sees `announce` and `delegate`
- tools do not reliably see `announce` and `delegate` the same way

So mode truth is split.

## Two run-kind channels

The system effectively has:

- a tool-context run-kind channel
- a request/event/tracing run-kind channel

These are not strongly unified.

That means:

- one subsystem may think a run is special
- another subsystem may behave as if it is normal

## Announce is not one mode

Teammate announce and subagent announce do not carry the same execution envelope.

They differ in:

- preserved identity
- post-turn dispatch behavior
- side-effect continuation

So the same mode label does not guarantee the same semantics.

## History confirms the seam

This was not fixed once.
It has been hardened via a sequence of propagation patches:

- sender
- then role
- then dashboard dispatch
- then deferred paths

That is a sign of a distributed contract, not a sealed one.

## Practical lesson

If a new orchestrator uses modes, each mode should define together:

- identity envelope
- trace semantics
- history semantics
- tool visibility
- side-effect policy

If those things are split across separate flags and wrappers, the mode is only a label.
