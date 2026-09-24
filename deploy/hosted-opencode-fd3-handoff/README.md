# Hosted OpenCode FD3 handoff helper (inactive)

`handoff.py` is an isolated Linux root helper for the already reviewed image
bootstrap. It is not wired into the root supervisor or Owner lane. Its only
effect is one descriptor transfer to an attested bootstrap, followed by
post-exec binary proof. It does not start a container, model, agent, or tool.

## Invocation contract

The root supervisor must pass one **already authenticated, connected,
Owner-bound** AF_UNIX/SOCK_STREAM endpoint as inherited FD 3. The other
endpoint remains with an Owner gate. That gate must be bound to the exact
operation, container ID, handle, and generation and remain **pending**:
it must reject writes, tool effects, and queued tool requests until both the
helper's post-exec proof and the supervisor's independent exact-generation
post-exec/policy proof succeed. The supervisor must first attest the container
image, policy, release lease, network, operation, and Owner channel. The
helper cannot establish or enforce the other endpoint's pending state from a
socket alone. **Do not invoke it** until the root daemon has an enforced
pending gate and a durable one-shot claim for that exact generation.

Invoke the root-owned, non-writable script with exactly these arguments:

```text
handoff.py --container-id <64 lowercase hex> --handle opencode_<32 lowercase hex>
  --generation <32 lowercase hex> --network-id <64 lowercase hex>
  --pid <host PID> --start-ticks <host /proc PID starttime>
  --netns net:[<inode>] --binary-sha256
  513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080
```

The supervisor must supply these values from one exact Docker generation,
not from Owner input. The helper independently inspects Docker twice and
requires the same container ID, name, generation label, host PID, running
state, and only the expected Docker network. It pins the process with a
pidfd and checks start ticks and the network namespace inode around the
transfer. It hashes the pre-transfer executable against the locked bootstrap
digest. It enters **only** that network namespace, discards supplementary
groups and all capabilities, sets no-new-privileges, and verifies the drop.

The helper connects to `\0fd3-<generation>`, checks `SO_PEERCRED` for the
exact host PID and UID 1000, and checks the live `SO_PEERPIDFD`. It sends one
`F` byte with exactly the admitted FD, half-closes, and requires EOF. It then
waits for the pinned PID to exec a different inode whose bytes hash to the
locked official OpenCode v1.18.32 executable. Exit 0 is the post-exec proof;
Any mismatch, race, timeout, missing privilege, or ambiguous state exits nonzero. A possible descriptor transfer exits 2 and requires operator reconciliation.
The stderr token contains no channel data or credentials.

The current bootstrap sends **no positive acknowledgement**. Control EOF is
only a framing check. The exact post-exec digest and stable pinned PID are
the success criterion. Adding an explicit authenticated ACK would require a
separate reviewed bootstrap protocol revision; no ACK is inferred here.

Exit statuses form a safety contract:

- `0`: helper observed the exact post-exec proof. The endpoint remains pending
  until the supervisor independently reattests the same generation and grants
  the already admitted Owner effect lease.
- `1`: helper rejected before entering `sendmsg`. The daemon still revokes the
  pending endpoint and terminates/reconciles the exact owned generation.
- `2`: `sendmsg` was attempted; delivery may have occurred, even if an error
  or timeout followed. The daemon must revoke the pending Owner endpoint and
  terminate/reconcile that exact generation. Closing the helper's local FD
  does **not** revoke a copy already transferred to the bootstrap.
- Missing result, helper death, signal, or daemon crash is **uncertain**, even
  if no `2` was captured. Revoke and terminate/reconcile the exact generation.

The daemon must durably consume the one-shot operation before helper launch.
Never retry the same socket or generation after any nonzero exit, uncertain
send, timeout, death, or lost result. Recovery inspects and stops only its
exact owned container generation; it never enables the pending endpoint based
on a stale success.

## Remaining integration gates

- Root supervisor must expose a one-shot operation binding the exact
  container generation and previously admitted Owner socket to this helper.
  An inherited FD cannot be obtained from the current JSON-only supervisor
  RPC. The parent must explicitly pass it with FD inheritance or SCM_RIGHTS.
- The root daemon and Owner broker must implement the pending generation gate,
  durable consumed claim, revoke path, and exact-generation termination above.
  The helper has no access to Owner's endpoint or the effect queue and cannot
  enforce those controls on its own. Until they exist, this helper stays
  inactive and its exit 0 grants no effect authority.
- The current `startReserved()` calls `processEvidence()` before any FD3
  handoff, but `processEvidence()` requires the official post-exec OpenCode
  digest. Activation needs a separate pre-handoff bootstrap attestation that
  supplies the PID, start ticks, and network namespace, then this helper,
  then the existing post-exec proof.
- The supervisor must record the helper's exit and re-run its own Docker,
  network, policy, and post-exec checks before reporting readiness. An exit 0
  alone must not enable Owner effects.
- The deployment must pin and review this helper's bytes and Python runtime,
  then restrict invocation to the root daemon. No image or application path
  currently invokes it.

Only disposable Linux sandbox processes may be used for inert verification.
Never point this helper or a fixture at a real user project.
