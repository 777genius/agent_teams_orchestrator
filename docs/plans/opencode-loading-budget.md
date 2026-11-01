# OpenCode loading budget

Related report: agent-teams-ai PR #1042, comment 6515790829. On a slow Windows
machine, 21–24 seconds of integrity checks plus approximately 23 seconds of
native server initialization exhausted one shared 30-second deadline.

## Scope

Use one 180-second cold-loading/catalog allowance, still clipped to the original
caller's remaining time. Align the read host, its child watchdog, V2 inventory,
read-only HTTP transport and Settings adapter. Do not reset the budget at each
request. Retain every source/architecture/hash check and join owned cleanup.

Audit adjacent startup paths: V1 host health, first instance/plugin/model load,
V2 owner readiness and its pre-start watchdog. Windows/macOS V2 initialization
already allows 300 seconds; keep that longer budget. Linux gets 180 seconds.
Keep Stop/cleanup, lock expiry, cache TTL, ordinary model execution, OAuth and
unrelated providers outside this change. Explicit shorter caller overrides win.

The paired desktop patch must let its CLI and UI wait beyond runtime loading
and cleanup. The existing scoped-provider catalog lease is 240 seconds; desktop
wrappers must not shorten that already-longer allowance.

## Validation and delivery

Reproduce the 24s validation + 23s startup failure under a virtual clock through
the real acquisition function, then verify slow and near-limit success, shorter
caller timeout, expiration, cancellation, integrity refusal and cleanup. Exercise
catalog transport's shared deadline and late-body cancellation. Run these with
the existing native packaged lanes, without model credentials or user projects.

Current-head CI and independent review are required before merging. A source
merge does not alter published runtime 0.0.147: user delivery requires a new
qualified runtime release and an exact desktop manifest/lock update. Results
must distinguish simulated timing, native packaging and published acquisition.
