# Hosted OpenCode container isolation contract

Status: post-v1 hostile-runtime profile. v1 uses the `trusted_process` host-local lane per owner decision 2026-09-25 (Product `docs/hosted-web-core-v1-scope-lock.md`, "Owner decisions 2026-09-25"). This design is not a v1 release gate.

Status: design only. No Owner runtime path is activated by this document.

## Current incompatibility

`OpenCodeHostManager` starts `opencode serve` as a direct child. Its host handle, persistent registry, cleanup, adoption, and effect authorization all assume that `child.pid` is the OpenCode process in the Owner PID namespace. `OpenCodeArtifactDigest` opens `/proc/<pid>/exe` and rehashes the executable at startup, adoption, and the final one-use effect token. The HTTP client uses `127.0.0.1:<port>` in the Owner network namespace.

Replacing the command with `docker run` would record the Docker client PID, not OpenCode. `docker inspect State.Pid` returns a host PID that may be invisible in Owner's PID namespace. A private container network also makes its loopback address different from Owner's. Existing process-tree kills cannot prove that all container descendants stopped. Therefore a generic `spawnHostProcess` adapter cannot safely activate this mode.

The current test-only `descriptor-launcher.py` starts Owner directly on the host as UID 1000. In that topology, a supervisor-reported host PID can be visible through Owner's `/proc`, and a port published only to host `127.0.0.1` can be reachable. Those facts must be checked in the disposable E2E environment; they are not a production topology contract. A future Owner container or PID/network namespace change requires the separate attestation and endpoint path below.

## Trust boundary

The Owner process must not receive a Docker socket, Docker API credentials, a privileged helper, or access to the supervisor's state. A separate trusted container supervisor owns the Docker API and all container lifecycle actions. The OpenCode container receives only a fresh, run-scoped workspace and a selected provider profile. It must not mount Owner trust/state, Product state, host home, the Docker socket, or unrelated project directories.

The supervisor, not Owner, authorizes each mount. Owner passes opaque workspace and profile lease IDs issued for the selected run. The supervisor resolves them against an independent allowlist and rejects stale, reused, symlinked, unexpected-device, or non-fresh mount sources. No Owner-supplied absolute path can become a Docker bind mount.

The container uses a pinned image and the exact official OpenCode v1.18.32 executable digest `sha256:513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080`. It runs without privilege escalation, with a private PID/mount/network namespace, read-only root filesystem, all capabilities dropped, no-new-privileges, a reviewed strict seccomp profile and AppArmor profile, bounded pids/memory/CPU, and writable mounts limited to the admitted workspace and profile. The supervisor must check effective Docker settings after creation. A requested setting is not proof that Docker applied it.

### Official profile environment and config

For official v1.18.32, the supervisor must start with a fresh, explicit environment rather than forwarding Owner's `process.env`. Set `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CONFIG_DIR` to a dedicated Owner-produced config mount, and isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` under the admitted run profile. Remove inherited `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`, provider keys/tokens, and unrelated credential or runtime variables. Pass only the selected provider's credential through the admitted profile and the few environment fields proven necessary for that provider. Do not use `--pure` as a substitute for this recipe.

The config directory must be outside the writable workspace/profile, contain the exact selected managed config, and be mounted read-only with stable file identity and digest. The supervisor attests the config mount's source lease, device/inode, content digest, target, read-only flag, and effective mount options after container creation. It also attests that `/etc/opencode` is absent or empty and cannot be populated through another mount or image layer. A host-side check of `/etc/opencode` is insufficient because the container has its own filesystem view. Until these attestations exist, `OpenCodeProfileManager` must not claim immutable config from its same-UID writable profile or activate the hosted official launch path.

## Narrow supervisor protocol

Use a local authenticated Unix socket with a length-bounded, versioned frame. Socket path ownership and mode are checked, but are not sufficient authentication by themselves: bind both peers to a deployment-scoped secret or equivalent kernel credential proof, with request nonce and response authentication. Unknown fields, versions, oversized frames, replayed request IDs, and unauthenticated responses fail closed. No shell command or arbitrary Docker option crosses this protocol.

`Start` request contains only:

- schema version, operation ID, run/team/lane identity, and short expiry;
- official runtime lock digest, image digest, executable digest, and selected config digest;
- supervisor-issued workspace and profile lease IDs;
- requested service intent (`opencode serve`) and a bounded readiness deadline.

`Start` response contains a supervisor-issued opaque container handle, exact image/config/executable digests, admitted mount identities, container creation generation, endpoint identity, and process evidence. Process evidence includes host PID, start ticks, executable inode/device/digest, PID namespace identity, and, if visible to Owner, the Owner-namespace PID. The response alone is not effect authority. The supervisor must independently reobserve these facts before signing them.

`Observe` returns a fresh, signed statement for the same container generation: running state, process identity, executable digest, selected config digest, endpoint identity, and timestamp/expiry. `Stop` and `Reconcile` accept only the opaque handle plus generation and run identity. They stop the exact container, confirm its process group/cgroup is empty, and return a signed completion or an explicit unresolved recovery state. A missing response never means stopped. All operations are idempotent for the same operation ID and generation.

The endpoint is a supervisor-controlled private transport. Owner must reach it through a narrowly bound socket or local proxy whose identity is tied to the container generation. It must not infer authority from a free TCP port or `127.0.0.1` alone. OpenCode's own port stays inside the container network namespace.

## Owner compatibility changes required before activation

Introduce a hosted container host handle separate from the direct-process handle. It carries the opaque container generation and authenticated endpoint rather than treating the Docker CLI or host PID as `OpenCodeHostHandle.pid`. Keep the direct child path for desktop and existing non-hosted modes.

For hosted adoption and cleanup, use supervisor `Observe`/`Stop`/`Reconcile` instead of `isProcessAlive`, PGID kills, or the current persistent PID record. Persist the opaque handle and generation so Owner restart can reconcile without creating a duplicate. A failed or uncertain stop retains a recovery veto.

For provider effects, replace the direct `/proc` one-use token with a supervisor-attested one-use effect capability. The capability binds operation ID, container generation, executable and config digests, endpoint identity, selected workspace/profile leases, and a short expiry. Owner must validate it immediately before sending the effect; the supervisor must atomically consume it while rechecking the live container/process and endpoint. A signed observation cached earlier is insufficient. If this atomic use cannot be placed on the effect transport path, hosted effects remain disabled. Merely exposing a host PID or a signed `Observe` result does not preserve the current time-of-check/time-of-use guarantee.

The existing `OpenCodeHostManager.verifyEffectHost` and `prepareEffectHostToken` must remain fail closed for a container handle until this replacement is complete. In particular, do not bypass `/proc` checks by returning a synthetic PID, digest, or successful token.

## Release gates

1. Build the isolated image from the official lock and prove the image, executable, and source identities at the exact release commit. Reject the deferred fork/manual-approval identity in this mode.
2. Review the supervisor's mount admission, Docker effective settings, authenticated protocol, private endpoint, and stop/reconcile semantics independently. Prove a hostile OpenCode process cannot read Owner state or the Docker socket using fresh sandbox fixtures only.
3. Add focused contract tests for malformed/replayed frames, stale generations, changed image/config/executable, PID namespace mismatch, endpoint reuse, mount substitution, uncertain stop, and supervisor loss. Tests must prove no provider effect occurs after each failure.
4. Run a disposable sandbox canary with a fresh workspace and test-only profile. Verify startup, selected provider effect, exact one-use capability consumption, restart adoption, stop, and zero surviving container processes. Do not use a real user project or profile.
5. Enable the hosted container path only after the exact artifact, focused CI, and sandbox canary pass. Until then, official runtime installation alone is not evidence that hosted OpenCode agent execution is isolated or production ready.
