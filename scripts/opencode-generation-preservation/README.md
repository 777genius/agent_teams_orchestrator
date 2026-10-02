# S5a preservation characterization

Run with `.task-inputs/toolchain/bun` (exact 1.3.11):

```
.task-inputs/toolchain/bun scripts/opencode-generation-preservation-baseline.ts --trace
.task-inputs/toolchain/bun test scripts/opencode-generation-preservation
```

The first command writes `store-preservation-baseline.json`, `report.md`, original/after byte exports, case observations and `artifact-manifest.json` in this job's persistent tmp/agent and a self-contained copy in `.task-output`. It initializes new marked TEST Git projects outside source/reference inputs; children get an explicit TEST environment. No agent/provider/native OpenCode process is launched. Every operation gets a fresh file copy. Unknown-authority writes/prunes/claims and lease cleanup are attempted only on expendable TEST copies. Original fixtures stay outside each copy. TEST projects and terminated reader receipts are retained; there is no broad process cleanup.

The product runner bundles actual immutable manifest evidence, manifest store and VersionedJsonStore classes plus their actual utilities. Alias resolution maps `@main/*` to that immutable source, without rewriting readers or mocking I/O. Owner readers load the actual source classes. Owner dependency installation uses the owner frozen lock with pinned Bun; missing dependencies yield MISSING. Do not replace missing classes with replicas, module mocks or a source-text oracle. Unreadable requires privilege drop and an actual nonroot EACCES probe; privilege denial yields MISSING. Root chmod alone cannot qualify the case.

Authored fixtures independently specify V1 envelopes/authority records, a future version42 containing opaque unknown operations/outbox data, partial ownership rows, malformed bytes and truncated JSON. These are file-reader inputs, not native runtime projects or captured native storage. `future-envelope` keeps known manifest data inside an unknown outer envelope to expose a version-blind evidence boundary. The generic VersionedJsonStore uses the real manifest validator/default factory. Host public lease/endpoint boundaries have explicit fake identity transport and forbidden spawn/network/profile/kill tripwires; this qualifies file-reader behavior only. Native host reconciliation/tree cleanup and dead-owner reclaim stay explicit boundary gaps.

The executable artifact audit checks complete case selection, exact byte exports, raw child receipt/observation agreement and selected source hashes before handoff. Audit success establishes evidence consistency only; negative tests alter an exported byte file and remove a matrix cell to prove rejection. Product constructor clocks use the real `clock` option.

OBSERVED means the public call executed and its exact return/throw and bytes were captured. FAIL means detected pre-change preservation failure, including empty fallback, silent partial filtering or quarantine. MISSING is unexecuted qualification, never PASS. Exit0 means capture completed; it does not mean preservation passed. The focused test gate verifies actual reader behavior and evidence honesty separately. Full S5a is incomplete while required readers/access cases/audits remain MISSING. Full dual-generation/native support is not claimed.

Next: make the frozen owner dependencies available under the sandbox policy, rerun the identical script/tests, obtain actual unprivileged EACCES and permitted syscall audit, then review the complete facts before O1a/O4a/A2a preserve-only namespace/read-veto changes. S5b repeats old-reader downgrade against final V2 namespaces and proves actual native disk history. The root controller independently exports the owned untracked sources, checks the exact base and source preservation, and creates mechanical commits after review. This worker never commits or publishes.
