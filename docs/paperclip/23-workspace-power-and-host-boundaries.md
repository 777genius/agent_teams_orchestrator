# Workspace Power And Host Boundaries

## The strongest thing here

Paperclip is serious about workspace control.

It has:

- project execution workspace policy
- per-issue execution workspace settings
- runtime services
- cleanup/provision lifecycles
- explicit route auth around runtime-service control

That is much more advanced than a toy "just use cwd" model.

## What is better than it first looked

The deeper pass showed real guarded-power patterns, not only risk.

### Agents are blocked from mutating host-executed commands

`server/src/routes/workspace-command-authz.ts` collects command-bearing paths like:

- `provisionCommand`
- `teardownCommand`
- `cleanupCommand`

and `assertNoAgentHostWorkspaceCommandMutation()` rejects agent callers trying to set them.

There are focused tests for this in:

- `issue-workspace-command-authz.test.ts`
- `workspace-runtime-routes-authz.test.ts`

This is a genuinely good guard.

### Runtime service management is narrower for agents than for board users

`server/src/routes/workspace-runtime-service-authz.ts` is also more disciplined than expected.

Board users go through company access.

Agents must prove something stronger:

- same company
- live issue/workspace linkage
- within their reporting subtree unless they are CEO

That is a good example of guarded power rather than raw capability sprawl.

### Export path omits system-dependent workspace commands

`server/src/services/company-portability.ts` strips `setupCommand` and `cleanupCommand` from export if they contain absolute-path fragments.

That is a subtle but very good lesson:

- portability should not quietly re-export host-specific power surfaces

## The dangerous part

### Board-writable config still reaches host shell execution

The big seam from issue `#883` still looks live.

Project and workspace config can still carry:

- `provisionCommand`
- `teardownCommand`
- `cleanupCommand`

and host runtime code still executes command strings through shell wrappers.

Examples:

- worktree provisioning command through shell `-c`
- runtime service command through shell `-lc`

That means these are not just config fields.

They are host-power surfaces.

### The guard is asymmetric

The important nuance is:

- agents are blocked from mutating host commands
- board-side writers with company access still can

So the current model is not "wide-open RCE for everyone".

The more accurate reading is:

⚠️ host power is intentionally exposed to board-side configuration surfaces, with agent-side mutation blocked.

That is still risky, just more precise than the rough issue language.

### Runtime services deepen the host boundary

`workspace-runtime.ts` does not just run one-off provision commands.

It can also launch detached local runtime services using shell commands and keep them alive with:

- lifecycle rows
- health checks
- reuse keys
- port ownership checks

This is powerful.

But it means the workspace subsystem is partly a local process supervisor.

That is where the control-plane stops being only orchestration and starts being host management.

## Why this matters architecturally

This is one of the most interesting Paperclip lessons.

They did **not** make the naive mistake of exposing power without any guard.

They added:

- route filters
- agent-side mutation denial
- portability omission
- narrower runtime-service auth

But the underlying architectural truth remains:

⚠️ once config fields can execute shell on the host, the workspace layer becomes a security and trust boundary.

That means:

- docs must be honest
- permissions must be very explicit
- operator expectations must be crisp
- shell execution should be minimized or sandboxed when possible

## Architect takeaway

Steal:

- command-path detection as a first-class guard
- separate auth for runtime-service control
- defensive omission of system-dependent power surfaces from export/import

Avoid:

- pretending host-executed config is "just workspace convenience"
- routing shell power through broad board-writable config without much stronger boundaries
- letting runtime-service management quietly become a second host-control platform without naming it as such
