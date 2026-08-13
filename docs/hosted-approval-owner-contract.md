# Hosted approval owner routing and settlement contract

The orchestrator owner is partitioned by the immutable tuple
`deploymentId + bootId + workspaceId + teamId + restoreGeneration + mountGeneration + declaredRootHash`. Trusted
provisioning may publish `hosted-approval-runtime-admission.v1.json` as a canonical
private `0600` file. Until that producer is available, absence keeps approval
capability disabled without blocking normal hosted-control startup; a present
malformed file remains a startup error. A route is authoritative only while its exact raw-file
digest and admission generation remain current. Each route binds the exact run,
plan generation, lane, provider, credential generation and ID, session, runtime
instance, member, delivery owner, scope, and explicit `ActorId -> MemberId` map.
The route also binds a SHA-256 fingerprint of the stable live OpenCode session
projection: team/lane/run/member/session plus project path, host key, profile root, project
behavior, managed config, source-auth, and managed-auth fingerprints. The owner
also binds the session record creation time and runtime PID. After the bridge has
finished `prepareProfile` and `ensureHost`, a final in-bridge fence binds actual
host PID, process start identity, project/profile/host keys, behavior/config/auth
fingerprints, and rechecks admission immediately before the provider POST. The owner
must refetch and match that projection at the final effect edge; same run/session
with a rotated host, runtime, credential, plan, owner, or auth identity performs
zero provider effects.

Only a persisted `manual` OpenCode session is admissible. The manual approval
mode is part of both the provisioning binding and session fingerprint. At the
provider edge the bridge consumes one-use tokens for the exact persisted session,
host process/configuration, raw permission incarnation, admission inode/digest,
owner WAL inode/bytes, and writer-fence generation with no asynchronous boundary
between final token consumption and POST invocation.

## Atomic OpenCode capability gate

Hosted approval is capability-false unless the OpenCode host implements
`agent-teams-hosted-approval-v1`. Current upstream OpenCode does not implement
this contract. The orchestrator probes
`GET /experimental/agent-teams/hosted-approval-capability` before reading the
raw pending permission; absence, transport failure, or a malformed response
performs neither the raw permission read nor a reply POST and is `unavailable`.
This restriction applies only to hosted approvals; normal OpenCode flows remain
available.

The target upstream contract is:

- Capability response: exact object `{ schemaVersion: 1, protocol:
  "agent-teams-hosted-approval-v1", configGeneration }` where every config
  mutation advances `configGeneration` before it becomes observable.
- `configGeneration` uses the exact grammar
  `config_generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}`. Valid golden vectors are
  `config_generation_1` and `config_generation_release-2026.08`; invalid vectors
  include `config_generation_`, `generation_1`, whitespace, slashes, and strings
  longer than 242 bytes including the fixed prefix.
- Conditional reply: one `POST
  /experimental/agent-teams/permission/{requestId}/reply` with
  `conditionalReplyVersion: 1`, `expectedConfigGeneration`,
  `expectedPermissionDigest`, and the reply decision.
- The server compares the config generation and the canonical raw permission
  digest and applies the reply in one exclusive transaction. It must perform
  no provider effect on mismatch and return `409` or `412`. Applied success is
  the exact object `{ schemaVersion: 1, protocol:
  "agent-teams-hosted-approval-v1", status: "applied", configGeneration,
  permissionDigest }`, echoing the values consumed by the transaction.
- `409`/`412` is proven `not_started`; timeout, socket failure, cancellation,
  any `3xx`, `5xx`, parse failure, or malformed success is ambiguous and requires
  the operator. Status classification uses the numeric HTTP response status, never
  response text. The conditional mutation uses redirect mode `manual`; the client
  never follows a redirect, falls back, or sends a second reply POST.

Hosted capability and conditional-success bodies are limited to 16 KiB, decoded
as fatal UTF-8, checked for duplicate object keys before `JSON.parse`, and then
validated as exact schemas with no additional properties. The capability proof
and raw `/permission` read use one retained host and one client acquisition;
missing or malformed capability, transport failure, or a host-acquisition change
therefore performs zero raw permission reads.

Canonical provider permission JSON is UTF-8 JSON with no insignificant
whitespace: object keys are sorted by JavaScript UTF-16 code-unit order at every
depth; arrays preserve order; strings, booleans, numbers, and null use
`JSON.stringify`; unsupported values are rejected. `permissionDigest` is the
lowercase hexadecimal SHA-256 of those exact bytes. Golden vector:
`{"requestID":"permission_1","sessionID":"session_1","tool":"bash"}` has
digest `bf6bdf3651bc31505a7430699c5b3e55b6c51c787cd1ab27cc2017736fa679b2`.

The product decision worker must route every approval record to the owner selected
from that record's immutable `partition.teamId`; it must not reuse a team selected
in UI or route one mixed-team batch through one socket. The owner response schema
must include `operator_required`. That result means the provider effect began but
its settlement could not be proved. It is durable, must not be auto-retried or
acknowledged as delivered, and requires an explicit operator reconciliation action.
The orchestrator patch exposes this result on the wire; product database/schema,
cross-team owner lookup, and the operator reconciliation UI/job belong in the
separate product repository patch.

The normal admission publisher and product per-team owner resolver are separate
deployment/product integration responsibilities. This orchestrator capability
remains absent until a trusted publisher supplies the exact private admission
file. Product must select the owner from each record's immutable `teamId`,
propagate `operator_required` without retry, and never route a mixed-team batch
through one fixed socket.

Startup recovery is state-only and performs no provider calls. Live permission
observation begins only after hosted-control readiness. A failed permission probe
is `unavailable`, never an empty list. A rotated or removed route is revoked at
recovery; only ingress needed to bind an existing durable settlement is retained
as non-claimable historical state.

All owner mutations share one dedicated private `writer-lock` inode held with an
exclusive non-blocking POSIX `flock`. The owner never opens or closes another
descriptor for that lock inode during the critical section. The kernel lock
releases on process death and has no wall-clock stale reclaim. The immutable
writer-fence identity is initialized as a fully written and `fsync`ed temporary
file, published without replacement by a same-directory hard link, and followed
by directory `fsync` barriers; interrupted initialization is either absent or a
complete decodable identity and is safe for the next owner to recover.
The exact parent directory file descriptor remains open for the full locked
lifetime; fence, WAL, publication, and final effect-token lookups remain relative
to that pinned namespace. Each writer compare-and-swaps the freshly reloaded WAL image before atomic publication. Delivery dedupe is a single
immutable domain over provider delivery ID, delivery reference, outbox ID, effect
reference, canonical raw provider permission incarnation, and payload fingerprint.
An alternate ID, an ambiguous started effect, or a reused request ID with a new
raw provider permission cannot invoke a second provider answer.
