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
- Process startup and retirement checks pass; existing x64 coverage remains.

Status: native CI pending. Provider-backed task/message flows and a published
desktop install have not been qualified by this draft. The desktop lock remains
unchanged until a matching runtime release is verified and published.
