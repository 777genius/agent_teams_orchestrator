# Hosted approval owner routing and settlement contract

Each orchestrator runtime remains strictly single-team and is partitioned by the immutable tuple
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

Hosted approval is capability-false unless the OpenCode host implements the exact
`agent-teams-hosted-approval-v2` contract. Production composition remains
explicitly unmounted until the accepted upstream artifact is pinned and verified.
All three endpoints use the existing OpenCode Basic Auth; missing server password
keeps them absent. A missing, unauthenticated, malformed, or failed capability
performs zero observations and zero reply POSTs. Ordinary non-hosted permission
fallback behavior is unchanged.

The target upstream contract is:

- Capability: `GET /experimental/agent-teams/hosted-approval-capability`, exact
  `{ schemaVersion: 2, protocol, authentication: "opencode-basic",
  runtimeInstanceId, configGeneration }`.
- Observation: one `GET /experimental/agent-teams/hosted-approval/session/
  {sessionId}/permissions`, exact v2 response, at most 256 permissions and 1 MiB.
  Every entry binds `requestIncarnation`, `permissionDigest`, and `rawPermission`
  to the path session.
- Conditional reply: one `POST /experimental/agent-teams/hosted-approval/session/
  {sessionId}/permission/{requestId}/reply` with the exact v2 body binding runtime,
  config, session, request, request incarnation, digest, and decision. Path/body
  identities must match.
- Runtime/config/request incarnation identifiers have distinct prefixes followed
  by exactly 32 lowercase hexadecimal characters; digests are 64 lowercase hex.
- `409`/`412` is proven `not_started`. Timeout, socket failure, cancellation,
  any `3xx`, `5xx`, parse failure, or malformed success is ambiguous and is never
  retried. Redirect mode is `manual`; no v2-to-v1 fallback exists.

Capability, reply request, and conditional-success bodies are limited to 16 KiB.
All hosted responses use bounded streaming, fatal UTF-8, duplicate-key rejection,
and exact schemas without additional properties. Capability and observation use
one retained host/client acquisition and the same Basic Auth projection.

Canonical provider permission JSON is UTF-8 JSON with no insignificant
whitespace: object keys are sorted by JavaScript UTF-16 code-unit order at every
depth; arrays preserve order; scalars use `JSON.stringify`; unsupported values
are rejected. `permissionDigest` is lowercase SHA-256 of those exact bytes.
Golden vector `{"requestID":"permission_1","sessionID":"session_1","tool":"bash"}`
has digest `bf6bdf3651bc31505a7430699c5b3e55b6c51c787cd1ab27cc2017736fa679b2`.

The product decision worker must bind each product team route to that team's own
owner generation, owner session, socket path and socket identity, and admission artifact,
selected from the record's immutable `partition.teamId`. It must not reuse a team selected
in UI, multiplex teams through one owner/socket, or send a mixed-team batch through one
socket. Within each owner, every ingress record, delivery, and reconciliation payload is
validated against the runtime's one configured team. The schema-v4 outer `authority` has
no process-global `teamId`; the immutable payload partition supplies the team binding.

Schema v4 has exactly five operations: `approval_ingress_claim`, `approval_ingress_ack`,
`approval_ingress_authority_resolve`, `approval_decision_deliver`, and
`approval_decision_reconcile`. Its canonical capability digest is
`sha256:40a6c4a131b4e64c04b87337fbce667c91f274fb85b3879c6cdcac49dbbbd639`.
The cross-repository raw-byte/HMAC fixture is
`docs/hosted-approval-wire-v4-golden.json` and is pinned to product head
`17e51cb5aa442465627ad011183ee3c8855b9c87`. Both repositories consume the exact
fixture bytes with SHA-256
`2594e9816f6116a406fe1b367fbd9c4231a9698c1cb7a395c2967ef2f32f1572`.

The owner response schema must include `operator_required` with the request's stable
`reconciliationRef`. That result means the provider effect began but
its settlement could not be proved. It is durable, must not be auto-retried or
acknowledged as delivered, and requires an explicit operator reconciliation action.
Reconciliation never calls the provider effect: durable `started`/ambiguous evidence maps
to `operator_required`, completed evidence maps to `delivered`, proven terminal
not-started evidence maps to `not_delivered`, and missing, stale, or unreadable evidence
maps to `unavailable`.

The normal admission publisher and product per-team owner resolver are separate
deployment/product integration responsibilities. This orchestrator capability
remains absent until a trusted publisher supplies the exact private admission
file. Product must select the team-specific owner from each record's immutable `teamId`,
propagate `operator_required` without retry, and never implement a same-socket route catalog.

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
