# Native prompt causality measurements

This S1a harness records native observations for the four qualified Linux x64 bundled pins: V1 1.16.0/1.18.34 and V2 2.0.0/2.0.21. It does not qualify full S1 or enable production V2 support.

Run with Bun 1.3.11. The CLI requires explicit generation, pin, scenario, fresh TEST root/evidence paths, the accepted S3a receipt and SHA256, the independently accepted per-pin controller receipt and SHA256, the official cached artifact bundle, selected binary, and platform metadata SHA256. See `scripts/opencode-causality-spike.ts` for exact flags. All inputs are verified read-only before creating roots or spawning a host. Roots must be fresh, canonical, mutually disjoint, and outside source, Git projects and selected reference/binary containers.

The deterministic loopback model supplies provider decisions only. The official native binary creates sessions, runs tools, emits events and persists data in isolated HOME/XDG/data/cache/tmp roots. Never run this harness on a real user project.

Supported measurement selectors:

- `default`, `queue`, `resume-false`, `resume-true`
- `same-id-same-body`, `same-id-conflict`
- `admission-response-loss`, `create-loss-before`, `create-loss-after`

Unsupported native contracts are recorded as MISSING. Loss selectors suppress the caller observation after forwarding at most once; they do not prove TCP loss, exactly-once effects or native persistence by themselves. There is no automatic mutation replay.

Evidence files have an increasing five-digit filename prefix. Keep raw requests, responses, durable cuts, transcript pages, model requests, disk observations and owned-process cleanup with `prompt-causality.json`. Health readiness uses bounded 500ms attempts within the overall deadline; other requests retain the normal deadline. Only exact spawned process handles or verified PID birth identities authorize cleanup.

V2 raw completed assistant candidates are never treated as causally attributed terminal responses. Full S1 remains MISSING until admission, queue/control, cancellation, late admission, multiple steps, compaction/child behavior and an accepted finite causal proof are measured and independently reviewed.

Portable regression checks, without real OpenCode or model services:

```sh
bun --no-install test scripts/opencode-causality-spikes
bun --no-install build scripts/opencode-causality-spike.ts --target=bun --outdir=/tmp/TEST-opencode-causality-build
```

The tests use disposable TEST files, dummy localhost HTTP responses and owned fake subprocess handles. Old-source regressions demonstrate stalled readiness and unsafe preflight behavior; clean-checkout tests do not require private historical captures.
