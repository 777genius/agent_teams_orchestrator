# Runtime Interface Honesty and Capability Drift

`overstory` has one of the best runtime seams in the space.

It also provides one of the clearest lessons in interface honesty.

## Why the seam is strong

`src/runtimes/types.ts` is architecturally very good.

The `AgentRuntime` contract gathers in one place:
- interactive spawn
- headless print
- config deployment
- readiness detection
- transcript parsing
- transcript discovery
- env shaping
- optional connection semantics

This is exactly the kind of seam a serious orchestrator should want.

## Why honesty matters

The strength of the interface can create a false impression:
- that all runtimes are equally mature
- that all methods are equally closed
- that all runtime capabilities are production-grade if they implement the same shape

That is not true in `overstory`.

## The best warning example: OpenCode

Current `main` still has a clearly soft `OpenCodeRuntime`:
- `instructionPath` explicitly marked unverified
- `detectReady()` stubbed to `loading`
- `parseTranscript()` returns `null`
- `getTranscriptDir()` returns `null`
- comments openly document the gap

At the same time, there was a serious attempt to close this properly:
- closed PR `#140` proposed a far fuller adapter with guard plugin and tests

That gives a very useful competitor lesson:
- the team knows what a stronger closure would look like
- but that knowledge is not yet the same thing as `main` reality

## The healthier reading of the interface

The correct way to read `AgentRuntime` is:
- as a unifying architecture seam
- not as a promise of uniform maturity

That is why the `stability` field matters.

The interface is honest when readers remember:
- the seam is shared
- the closure level is not

## Architect takeaway

Steal:
- one strong runtime interface
- explicit stability levels
- unified runtime vocabulary

Avoid:
- presenting one interface as proof of one maturity level
- letting documentation or issue closure imply parity that `main` does not yet implement
