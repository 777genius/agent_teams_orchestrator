# Windows ARM64 OpenCode V2 2.1.4 candidate qualification

Native Windows ARM64 delivery and source-owner execution passed for runtime
0.0.147 candidate source `14483a99517a87aa3c88f8493d88911ed02f5e5d`.
This report records completed prepublication candidate evidence. Final model-backed
team/task outcomes, exact release-archive verification and published desktop
installation remain release gates.

## Native delivery

- Official CLI: `@opencode/cli-windows-arm64@2.1.4`, reporting `opencode v2.1.4`.
- CLI PE machine: `0xaa64` (ARM64).
- CLI executable SHA256:
  `4255cf5d2703c064c4ecd90b9d9c385fb3c592c11b65a4b1d91eb738c54a5b95`.
- Shipped runtime: native Bun 1.4.3 from `bun-windows-aarch64.zip`, checked against
  the existing pin in `scripts/runtime-bun-pins.json`.
- Qualified support engine: 2.1.4. Base and support descriptor/manifest identities
  agree on platform, runtime version, source commit, Bun version and engine roster.
- The extracted base contains physical JS and Bun sidecars with their recorded
  hashes and carries no embedded V2 helper graph. The support archive is separate.

## Completed native runtime checks

[Runtime CI run 40896361191](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40896361191)
completed successfully. Its [ARM64 job 123526884986](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40896361191/job/123526884986)
passed on `windows-11-arm`. Node and the build Bun process reported native ARM64;
the extracted runtime checks executed the shipped native Bun 1.4.3.

| Check | Observed result |
| --- | --- |
| Native CLI | Official 2.1.4 package identity, version and ARM64 PE image verified |
| Receipt admission | Matching Windows CLI/controller images accepted; malformed, DLL and foreign-architecture images rejected |
| Extracted V2 server | Real `@opencode/server-v2.1.4` ready in 7,815 ms; authenticated identity/provider routes passed; close acknowledged and exit 0 |
| Native grammar | The staged core's bash grammar loaded |
| Native PTY | ARM64 DLL verified; command exited naturally with code 0; original PID absent; TEST fixture removed |
| Source owner | Genuine CLI and copied Node receipts accepted under the exact shipped Bun; original member reached `accepted` with verified silent bootstrap |
| MCP readiness | SDK schema peer connected as `agent-teams`; `message_send` schema read back through the selected controller contract |
| Public stop | `stopped`, `ownerRetired: true`, closed member scope and retired execution process; both owned leader PIDs independently absent |
| Isolation | Zero provider requests, zero session messages and removed TEST fixture |

The native PTY DLL machine was `0xaa64`, with SHA256
`80c44d8cb5123b95494fdb785fe7e2716a5c1f9a57c5d890e469ffc046bddb98`.
Windows descendant retirement remains best effort: the source-owner receipt
records `descendantsRetired: false`. The independent PID checks establish
disappearance of the owned run owner and execution process.

The source-owner probe used an isolated profile, a local rejecting provider
endpoint and a synthetic SDK schema peer. It submitted no model input.
Its `sourceHead` is `14483a99517a87aa3c88f8493d88911ed02f5e5d`, and its shipped
artifact `COMMIT_SHA` was required to match that exact head.

The paired [x64 job 123526884970](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40896361191/job/123526884970)
also passed native delivery, receipt admission, extracted server/PTY, source-owner
readiness and physical stop. Its extracted 2.1.4 server was ready in 9,205 ms and
exited with code 0.

## Identity regression and provenance

[Windows identity run 40896361302](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40896361302)
passed on ARM64 and x64, including the existing idle/CPU-contention catalog
scenarios and staged native PTY proof. That catalog lane selects CLI 1.19.2;
the separate native delivery/source-owner jobs above select CLI 2.1.4.

The candidate PTY JSON from run 40896361191 records the event's synthetic merge
SHA `f8ea112f750842a57397ec857ca693333d53dda5` in `sourceHead` and `checkoutSha`
because it inherited the `GITHUB_SHA` fallback. Its extracted base/support
identities and the source-owner receipt bind the actual candidate source
`14483a99517a87aa3c88f8493d88911ed02f5e5d`. The workflow now supplies the explicit
PR head to the extracted server/PTY step; `checkoutSha` remains event context.
The release workflow separately supplies its resolved immutable source commit.

## Integrated app and publication gates

The separate [full native ARM64 app candidate run 40896435354](https://github.com/777genius/agent-teams-ai/actions/runs/40896435354)
uses app source `438ac755d67095347f2c66637546ecebbc057703` and SDK/runtime source
`14483a99517a87aa3c88f8493d88911ed02f5e5d`, with the selected model
`openrouter/openai/gpt-4.1-mini`. Its actual desktop controller preflight,
candidate packaging and packaged byte-provenance checks passed.
Final model-backed task/message and lifecycle outcomes are tracked in that run,
[runtime PR #188](https://github.com/777genius/agent_teams_orchestrator/pull/188)
and [app PR #1049](https://github.com/777genius/agent-teams-ai/pull/1049).

Publication requires exact source-tag and release identities, complete download
and inventory verification of all five base archives and five support ZIPs, and
native final-release archive proofs. The exact verified draft must be promoted
without rebuilding. The published app gate then covers a fresh V2 installation,
two warm starts, support-only repair and restart through the packaged app's
public installer/status routes.

Status: prepublication candidate. Final integrated outcomes and publication
identities are retained in the linked PRs/runs; a docs-only follow-up records the
completed published-install qualification and removes this candidate-only status.
