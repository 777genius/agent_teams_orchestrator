# OpenCode Phase 0 regression tests

This directory is test-only. It never launches OpenCode, authenticates a provider,
starts a teammate or terminal, uses a socket, or touches a user project. Test paths
live below a disposable sandbox (with a workspace-local `TMPDIR` supported).

## Suites

- `FakeOpenCodeRegressionHarness.test.ts` proves the small fake CLI/host HTTP
  harness: command, write, plugin, PID/cleanup, deferred hang, cancellation, late
  completion, virtual timer, and retry-amplification journals.
- `PortableOpenCodeAcceptance.e2e.test.ts` is the green parameterized acceptance
  contract. Its status/catalog/launch adapter invokes injected callable ports. It
  covers purpose boundaries, selected-provider isolation, opaque proof capability,
  all identity mutations, canonical bytes, atomic persistence/restart/crash,
  controlled concurrent claims, real fake-PID liveness and TERM escalation, one
  monotonic deadline/retry coordinator, late authority suppression, schema-checked
  redacted ledger bytes, selected-route barriers, real deferred cancellation,
  forged-capability denial, strict ledger negative validation, and unsafe-adapter
  mutation sensitivity (including log-only cancellation).
- `OpenCodeStatusCatalogLaunch.regression.test.ts` contains production-composition
  assertions. The integrated Phase 1 implementation keeps Moth status passive,
  preserves #443 catalog containment, and exports the public purpose adapter.
- `BaseVsWipEvidence.json` records the revision and command. Its test creates two
  disposable git checkouts, applies the live tracked diff and untracked production
  files to a SHA-256-bound WIP snapshot, executes the unchanged regressions in both,
  and copies the live untracked production additions into the WIP checkout before
  comparing generated outcomes rather than comparing canned JSON.

## Focused safe commands

```bash
bun test phase0-opencode-tests/FakeOpenCodeRegressionHarness.test.ts \
  phase0-opencode-tests/PortableOpenCodeAcceptance.e2e.test.ts \
  phase0-opencode-tests/BaseVsWipEvidence.test.ts

bun test phase0-opencode-tests/OpenCodeStatusCatalogLaunch.regression.test.ts
```

At base revision `73993bad8ff96dc08086b5ecf125084e1df4a08f`, a disposable
git checkout plus the unchanged Phase 0 test bundle produces 0 pass / 3 fail:
Moth status, #443 catalog (`models --verbose` plus `catalog-prewarm`), and the
missing public composition seam. Current integrated WIP produces 3 pass / 0 fail.

Phase 1 must add the public status/catalog/launch composition seam, make passive
status avoid profile/lock/write/process work, and bind the production coordinator
to the acceptance contract's injected persistence, proof, supervisor, provider,
deadline, and member-claim ports.
