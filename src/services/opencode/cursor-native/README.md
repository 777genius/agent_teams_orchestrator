# Cursor native request ownership

These macOS assets implement the request-local ownership barrier. They are not wired into provider readiness by their presence alone.

**Current acceptance: owned groups plus scope-marked descendants.** The direct native detached shell scenario passed (heartbeat 3 -> 3 after Stop). The nested `shell -> Node -> spawn({ detached: true }).unref()` writer that previously escaped registration (4 -> 31 while the acknowledgement still claimed `cleanupCompleted: true`) is now contained by a request-unique environment marker sweep, and is kept as a negative regression gate in `fixtures/proof.mjs` (`root-nested`). Earlier reproduction of the escape: `/tmp/cursor-request-owned-nested-i2Rl3C/report.json`.

The supervisor injects `CURSOR_OWNER_SCOPE=<128-bit hex>` into the native root environment. Exec-time environment is inherited by every descendant in every language and survives `setsid`, double forks and reparenting to pid 1, so teardown resolves survivors from `ps -Eww -ax` instead of reconstructing lineage. This is what the earlier bounded feasibility check could not do: libproc preserves a child's original parent unique ID after reparenting, but a fully reaped intermediate is no longer queryable, and Darwin `NOTE_TRACK`, `NOTE_CHILD` and `NOTE_TRACKERR` are unsupported (local kqueue receipt returned `ENOTSUP`, 45). The marker sidesteps lineage entirely because it travels with the process image.

Remaining honest limitation: a descendant that re-execs with a scrubbed environment, or that is started by an intermediate which rewrites its child environment, drops the marker and is not tracked. `cleanupCompleted` therefore means "every owned group and every scope-marked descendant is gone", not "no process this session ever touched can still exist". No universal all-language interception, tracer, or platform expansion was implemented. Every provider in this app has at least this gap; the Cursor path is the only one that sweeps beyond its own process groups.

- Stage `supervisor.mjs`, `preload.cjs`, `group-cleanup.mjs`, `scope-sweep.mjs`, and a compiled `gate` in one immutable managed asset directory.
- Invoke `node supervisor.mjs <native executable> ...args`; preserve the native executable's own arguments and permission configuration.
- `CURSOR_OWNER_REQUEST_ID` is an immutable request correlation ID. `CURSOR_SUPERVISOR_REPORT` is the caller-owned acknowledgement destination; it is stripped from the native child's environment.
- Compile `gate.c` at packaging time for each supported macOS architecture. Do not require runtime compilation on user machines or infer x64/Windows acceptance from arm64 proof.
- The preload wraps detached `spawn` only. The gate starts in the native group, registers its identity over a private authenticated control socket, and only then creates its own group and runs the original executable.
- Gate/control EOF never relinquishes group ownership. Normal command completion retains the sentinel until orphan children have been cleaned. Supervisor death triggers native-parent and gate-control cleanup.
- `cleanupCompleted` covers the root group, registered detached groups and the scope-marked sweep; `scopeSweep.remaining` must be empty for it to be true. The HTTP abort response alone is still not completion evidence. Only pids leave the sweep: descendant environments hold foreign secrets and are never retained, reported or logged.
- Unsupported detached shell/argv0/IPC spawn contracts fail closed. An executable-not-found inside the gate yields exit 127 rather than a Node spawn ENOENT event.

The fixtures use disposable directories and synthetic processes only. Native app acceptance remains a separate test with native permissions intact.
