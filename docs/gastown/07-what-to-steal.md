# What Is Worth Stealing From Gastown

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

## Best ideas to steal

### 1. Explicit mailbox and handoff model

Do not reduce inter-agent communication to "shared task list + logs".

Gastown is right that:

- mail
- handoffs
- explicit addressing
- inbox semantics

should be first-class.

### 2. Worktree-first coding workers

For coding swarms, worker isolation should be a native concept, not a later
extension.

### 3. Recovery-minded design

Gastown assumes that workers:

- stall
- crash
- drift
- leave stale state

That mindset is correct and worth preserving.

### 4. Role model with real operational semantics

Not every agent should be the same.
Their instinct that different roles carry different orchestration responsibilities
is strong.

### 5. Coding-workflow imagination

Gastown has unusually good instincts around:

- predecessor/resume
- work continuation
- merge queue mediation
- worker reuse

### 6. Serious attempt to escape old seams

ACP and `factory-worker-api` are good signs:

- the team is trying to move to a healthier runtime boundary

### 7. Mail as durable intent, nudges as cheap realtime signal

The distinction between:

- durable communication
- cheap realtime prompts

is good.

### 8. Recovery loops as explicit architecture

The existence of patrol/recovery loops is not itself a smell.
The smell is when the substrate underneath them is too fragmented.

### 9. Rich agent/task lifecycle thinking

Even where the implementation gets expensive, Gastown still shows strong
thinking about:

- handoff continuity
- task ownership
- active vs idle vs stuck semantics

### 10. Willingness to redesign after pain

A healthy lesson from Gastown is not only what it built, but that the team is
willing to question old assumptions after operational pain.

### 11. Factory Worker API principles

One of the strongest things in Gastown is not current implementation, but the
design principles written down in `factory-worker-api.md`.

Those principles are excellent:

- push, not scrape
- structured, not string-matched
- agent-agnostic runtime boundary
- correlation by design using `run_id`
- fail-closed defaults

This is one of the clearest "steal the principle, not the current code" lessons
in the whole project.

### 12. Proxy-style sandbox boundary

The proxy-server design also contains strong instincts:

- explicit command allowlists
- subcommand allowlists
- mTLS identity
- startup-time path resolution
- server-side branch authorization
- rate limiting and concurrency caps

Even if the rest of the runtime is still expensive, this is good security and
boundary thinking.

### 13. Scoped locking and atomic writes in the places where they already got it right

Gastown is not uniformly weak on integrity mechanics.

Some subsystems already use the correct boring patterns:

- per-worker locking in `crew`
- atomic JSON/state saves in `dog`
- atomic scheduler-state writes

That is worth stealing as a baseline doctrine:

- authority files use atomic write by default
- lock scope should match ownership scope

The lesson here is not "copy their whole substrate".

It is:

- copy the local integrity patterns they already converged on

## How to steal safely

Steal:

- the concept
- the operator intent
- the workflow pattern

Do **not** steal:

- the exact storage model
- the exact tmux coupling
- the exact CLI choreography
- the exact multi-plane truth arrangement
