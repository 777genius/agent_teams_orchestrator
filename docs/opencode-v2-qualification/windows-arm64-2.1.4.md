# Windows ARM64 OpenCode V2 2.1.4 candidate qualification

This draft branch enables a candidate `win32-arm64` record so the existing
packager and native CI can exercise the real platform delivery. It is not a
published support claim. Do not release this candidate until the native checks
below have passed and their exact run and commit are recorded here.

## Native delivery

- Official native CLI: `@opencode/cli-windows-arm64@2.1.4`.
- Shipped runtime: Bun 1.4.3, `bun-windows-aarch64.zip`, with the existing pinned
  archive checksum in `scripts/runtime-bun-pins.json`.
- PTY: the existing pinned `bun-pty` ARM64 DLL; the packaged PTY smoke verifies
  the DLL's architecture and checksum before exercising a terminal.
- Candidate base and support ZIP are built from the same source commit. No x64
  substitution or emulation fallback is used.

## Required evidence

- `windows-11-arm` reports native ARM64 in the build and shipped Bun processes.
- The selected CLI is an ARM64 PE image and reports version 2.1.4.
- The packaged support archive, descriptor and manifest agree on platform,
  source commit, runtime version and exact engine roster.
- The graph-free base contains no embedded V2 helpers or dependency graph.
- The real staged V2 server starts, serves its provider route and closes.
- Native grammar and PTY dependencies load, execute and clean up.
- Execution receipt validation accepts matching native binaries and rejects
  malformed images and binaries for the other Windows architecture.
- A real source RunOwner starts an execution member under the exact shipped Bun,
  validates the genuine CLI and Node receipts, connects an SDK MCP schema peer,
  and stops through the public control API. Both owned leader PIDs must be gone.
- The launch probe uses an isolated TEST profile and a local rejecting provider
  endpoint. It submits no model input and requires zero provider requests.
- Existing x64 coverage remains.

## Evidence boundary

The initial native packaged delivery passed on source
`24782f50de4cf923d359f88c57b2a82e83ece523`,
[CI run 40873105748, job 123445050636](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40873105748/job/123445050636).
It verified the official ARM64 CLI, the extracted 2.1.4 server (ready in 7,894 ms,
exit 0), and the native packaged PTY. That run predates the source-owner probe.

Native run results and exact source heads are attached to
[runtime PR #188](https://github.com/777genius/agent_teams_orchestrator/pull/188).
The source-owner probe and extracted packaged server/PTY proofs are separate:
the former does not claim a packaged teammate or actual desktop MCP controller.
Windows descendant retirement remains best effort; the independent PID checks
prove disappearance of the owned run owner and execution process.

Status: draft compatibility candidate. Provider-backed task/message flows and a
published desktop install have not been qualified by this draft. The desktop
lock remains unchanged until a matching runtime release is verified and
published.
