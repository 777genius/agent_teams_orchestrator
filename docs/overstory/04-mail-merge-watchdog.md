# Mail, Merge, Watchdog

## Mail

The mail system is one of the better local-coordination implementations in the competitor set.

Good signals:
- typed protocol messages
- SQLite durability
- WAL mode
- human-readable injection path
- clean `MailClient` wrapper

This is much better than ad hoc string passing through prompts only.

## Merge

The merge layer is explicit:
- FIFO queue in `src/merge/queue.ts`
- tiered resolver in `src/merge/resolver.ts`

That is a strong product idea.

### But there is a catch

The resolver also auto-commits runtime state files and performs timing-sensitive state sync. Open issue `#103` exposes the hidden complexity here:
- state files committed separately
- tracked files stashed
- untracked overlap rules
- timing window for state file updates

This is useful, but it makes merge semantics harder to explain honestly.

### Important risk

When runtime-state sync and branch merge are coupled, the merge subsystem stops being just merge logic. It becomes part source merge, part operational janitor.

That is powerful and dangerous.

## Watchdog

Watchdog design is a strong area.

Good decisions:
- Tier 0 mechanical daemon
- Tier 1 AI triage
- Tier 2 monitor layer
- strong health state model
- observable state principle in `watchdog/health.ts`

This is one of the better reliability mindsets across competitors.

## Where this layer breaks

### 1. Process-level observability does not equal semantic observability

Issue `#67` is important. It shows that PID and tmux liveness do not capture:
- rate limits
- degraded runtime behavior
- starvation cascades
- blocked-but-alive sessions

The maintainers themselves acknowledge this gap.

### 2. Cross-repo routing is not solved

Issue `#105` is the biggest architectural warning in the entire project.

The bug is simple to state:
- parent coordinator
- sub-repo lead
- different `.overstory/mail.db`
- wrong root polled
- `merge_ready` never seen

That is not a small bug. It reveals repo-local mail truth as a real boundary.

### 3. Cleanup is incomplete

Issue `#132` shows orphaned MCP child processes surviving session end. This means lifecycle truth is not fully enforced at the process tree level.

## Architect takeaway

This layer is impressive, but it also proves something important:

**local durable coordination works well until topology changes, then hidden routing assumptions become architecture problems.**
