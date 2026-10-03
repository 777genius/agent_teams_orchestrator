# S6 TEST client transport prerequisite

Only this folder and `../opencode-generation-client-contract-spike.ts` are owned.
The entrypoint creates a fresh marked TEST Git package before executing clients,
builds, registry requests or HTTP transport. Child environments are explicit
allowlists with isolated HOME/XDG/Windows/cache/temp paths and exact test identities.
No production dependencies, sources, public pins or default OpenCode service are changed.

Use the pinned `.task-inputs/toolchain/bun` executable. Set `S6_OUTPUT_DIR` to this
job's persistent `tmp/agent` path, then run:

```sh
bun test scripts/opencode-generation-client-contract
```

The outer test executes the same relative test command inside the new TEST package.
It selects exact `@opencode/client@2.0.21` and
`@opencode/client-v2-floor@npm:@opencode/client@2.0.0`, refreshes official registry
metadata, verifies tarball SRI, installs without lifecycle scripts, retains its
disposable lock, and repeats installation with `--frozen-lockfile`. Production's
package.json/bun.lock are untouched. Registry egress may be passed as
`S6_REGISTRY_PROXY`, restricted to a credential-free HTTP loopback proxy, and is
removed before loopback clients run.

The equivalent direct entrypoint accepts `--evidence-dir <persistent-path>`.
Normal mode requires official registry access; it does not silently substitute
reference copies or another package. Every attempt gets a new evidence directory.

If registry access is rejected, `S6_REFERENCE_ONLY=1` or the direct entrypoint's
`--reference-transport-only` explicitly executes read-only staged official Promise
roots as source inputs in fresh TEST cwd. No SDK implementation is copied or
modified. This mode marks registry/SRI refresh, actual npm alias, installed
schema/protocol separation and frozen-lock gates **MISSING**, even if all executable
transport tests pass. It cannot qualify installation or full S6.

Minimal source/minified/compiled fixtures prove import composition only. Build
loads and source hashes distinguish Promise runtime imports from optional installed
Effect dependencies. The source's compiler is never run as an owner release build.

The controlled HTTP fixture and an independent Node loopback proxy observe requests,
mutation effect files, body bytes and downstream connection closure. Proxy children
use the same isolated allowlist, are disposed through their owned stdin handle, and
report exact process/port/cleanup receipts. Synthetic transport frames and tagged
fault bodies are authored contract inputs, never native server/event proof.

Each test records the observable regression that turns it red and why existing V1
coverage misses this official V2 boundary. Cases cover cancellation before/after
fetch and during actual body reads, stalled 200 bodies, byte/frame boundaries,
compressed/multibyte/misleading lengths, all actual SDK ClientError reasons,
floor plain tagged objects/current tagged Errors, allowlisted canary-safe failures,
SSE corruption/split framing, full 8/32/128MiB consumed-byte response caps and
8MiB error-body cap on export, full 16MiB frame boundaries, a 129MiB legitimate
SSE lifetime, and shared SDK lazy/late/overflow live/RPC peer behavior. EOF backlog,
new-source recreation and old/local subscriber cancellation use public SDK iterators
and independently observed downstream closures. Large bodies are generated with
backpressure and constant-size fixture chunks; every consumed byte is measured.

Installed-package integrity and native event/RPC facts, application revocable
epochs/delayed lists/overlap and admission fences, app queue and cursor
reconciliation, full operation/native-tag registry, native server and five native
OS/release-wrapper qualification remain explicit gates. Native cases await the
controller's immutable Q0 S0 receipts. No production bounded fetch may be promoted
from this candidate before that prerequisite decision.

`report.md`, `client-transport.json`, `artifact-manifest.json`, package/import
proofs, per-case counters, hashes and command logs are written under persistent
evidence and copied into `.task-output`. The controller exports the untracked
binary-safe patch, applies it at exact owner base and reviews the integrated SHA.

Destination guards run before evidence/project directory creation and before any
child build/request. They resolve existing ancestors and reject overlapping
owner source, linked owner checkout, product and immutable reference roots,
including external symlink aliases and parent traversal. Final `.task-output`
export is a separate authorized path with containment checks. Guard regressions
use disposable TEST source/sentinel fixtures; the predecessor writes directories
before rejecting, while the corrected implementation leaves no children.

Git lock preflight records its actual result (`PASS`, `EXISTING_LOCK` or
`UNAVAILABLE`) and resolved lock path/error code. It creates an exclusive lock
only when linked metadata exists, and removes only its newly owned inode.
The immutable controller NORMAL receipt is preserved as predecessor evidence;
it is not approval or an installed-package rerun of the corrected patch.
