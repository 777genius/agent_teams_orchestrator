# OpenCode Phase 0 regression tests

This directory is test-only. It never launches OpenCode, authenticates a provider,
starts a teammate or terminal, uses a socket, or touches a user project. Test paths
live below a disposable sandbox (with a workspace-local `TMPDIR` supported).

## Suites

- `FakeOpenCodeRegressionHarness.test.ts` proves the small fake CLI/host HTTP
  harness: command, write, plugin, PID/cleanup, deferred hang, cancellation, late
  completion, virtual timer, and retry-amplification journals.
- `PortableOpenCodeAcceptance.e2e.test.ts` runs 3/3 deterministic fakes through
  the production command-status route, provider-management catalog adapter, and
  launch production bridge/core. Only external time, HTTP, OpenCode, process, and
  persistence effects are replaced. The launch case reaches the production
  profile policy, Windows managed-directory guard, same-host fresh nonce proof,
  one-deadline coordinator, journal store, cleanup, and member commit ordering.
- `OpenCodeStatusCatalogLaunch.regression.test.ts` contains production-composition
  assertions. The integrated Phase 1 implementation keeps Moth status passive,
  preserves #443 catalog containment, and exports the public purpose adapter.
- `BaseVsWipEvidence.json` binds canonical base
  `73993bad8ff96dc08086b5ecf125084e1df4a08f` to reviewed commit/tree
  `6294d48`/`0b8ce218`. Its verifier records exact HEAD commit/tree/artifact hashes
  from a non-empty committed `base...HEAD` production-composer diff. The negative
  matrix rejects empty, unrelated, working-tree-only, wrong base/HEAD/tree,
  facade-only, and production-composer-bypass evidence; a clean worktree is valid.

## Focused safe commands

```bash
bun test phase0-opencode-tests/FakeOpenCodeRegressionHarness.test.ts \
  phase0-opencode-tests/PortableOpenCodeAcceptance.e2e.test.ts \
  phase0-opencode-tests/BaseVsWipEvidence.test.ts

bun test phase0-opencode-tests/OpenCodeStatusCatalogLaunch.regression.test.ts
```

The old miniature purpose adapter was removed: no production route called it.
Acceptance now imports the same concrete production entrypoints used by runtime
routing and relies on their existing narrow dependency-injection ports.
