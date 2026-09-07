# Managed Cursor Stop: containment correction and live E2E

Supersedes the NO-GO recorded in `execution-ledger.md` and `nested-stop-verdict.md` for the
nested-detach gap. Everything below was produced on macOS arm64 against a logged-in
`cursor-agent` (2026.08.25-3e8eec8) using disposable `/tmp` sandbox projects only.

## 1. The pending managed transport test was never broken

`scripts/cursor-plugin/node_modules` was absent. After
`bun install --frozen-lockfile --ignore-scripts` in `scripts/cursor-plugin`,
`managed-transport.test.ts` passed 5/5 standalone runs (~2.3s each) and inside the
full plugin suite. No production change was needed.

## 2. Nested detached escape is contained by an inherited scope marker

The supervisor injects `CURSOR_OWNER_SCOPE=<128-bit hex>` into the native root
environment. Exec-time environment is inherited by every descendant in every language and
survives `setsid`, double forks and reparenting to pid 1, so teardown resolves survivors
from `ps -Eww -ax` instead of reconstructing lineage. This is exactly what the earlier
feasibility check could not do: libproc keeps a child's original parent unique ID after
reparenting, but a reaped intermediate is no longer queryable, and Darwin `NOTE_TRACK`,
`NOTE_CHILD` and `NOTE_TRACKERR` return `ENOTSUP` (45).

- Live check: an escaped grandchild (`PPID 1`, own PGID) was found by marker and killed.
- Negative control: with the sweep neutered, the same fixture fails at the sweep assertion
  and the escapee keeps writing (221 -> 270 heartbeat lines over 2s). The regression gate
  is real, not decorative.
- Regression gate: `fixtures/proof.mjs` scenario `root-nested`, asserted by
  `CursorNativeOwner.test.ts` through `report.nestedDetachContained`.
- Only pids leave the sweep. Descendant environments hold foreign secrets and are never
  retained, reported or logged.

Honest limitation, documented in `src/services/opencode/cursor-native/README.md`: a
descendant that re-execs with a scrubbed environment drops the marker.
`cleanupCompleted` now means "every owned group and every scope-marked descendant is
gone", and `scopeSweep.remaining` is part of that condition.

## 3. Gated product integration

Managed Cursor turns on only when staged assets verify against their manifests
(`resolveOpenCodeCursorManagedAssets`), the platform is macOS arm64/x64, and an
interpreter exists. Staging is explicit through `AGENT_TEAMS_CURSOR_MANAGED_ASSETS`;
there is deliberately no in-repo default, so behaviour never depends on whether a
developer happened to stage locally. Anything unavailable keeps the upstream
`@rama_nigg/open-cursor@2.5.2` plugin and today's launch path.

Stage with `bun run scripts/cursor-plugin/stage.ts <asset-root>`.

## 4. Live E2E result

`src/services/opencode/OpenCodeCursorManagedStop.live-e2e.test.ts`, opt-in via
`CURSOR_MANAGED_STOP_LIVE_E2E=1`. Green on two consecutive runs of the scenario script and
again on the codified test after the retained-port fix, all with real Cursor model calls
through the product stack:

| Check | Result |
| --- | --- |
| Managed plugin artifact loaded instead of the npm package | yes |
| Real turn through managed transport + supervisor | yes |
| Follow-up after a completed turn (no premature seal) | yes |
| Supervised Cursor processes alive during the turn | 1 |
| Stop accepted | yes |
| Supervised tree terminated after Stop | yes, 0 survivors |
| No late assistant output after Stop | yes |
| Repeated Stop still accepted | yes |
| Sibling session works after Stop, no replay of sealed prompt | yes |
| Scope-marked processes left behind | 0 |
| Provider endpoint equals the profile's own retained port | yes |

## 5. Findings that change scope

**OpenCode owns tool execution.** With `TOOL_LOOP_MODE=opencode` the model emits a tool
call, the cursor-agent request completes, and OpenCode runs the tool. During tool
execution there is no cursor-agent process at all (`scoped: 0` measured while a long
shell command was running). The ownership barrier therefore covers what cursor-agent
itself spawns - which the bridge probe confirmed is real: three detached commands were
registered before release under `ppid = cursor-agent`. Processes started by OpenCode's own
tools are provider-independent and are not, and were never, in this barrier's scope.

**The shared proxy port was the real defect, and it is now fixed.**
`OpenCodeCuratedSubscriptionCatalog.ts` pinned the Cursor provider endpoint to
`http://127.0.0.1:32124/v1`, and the upstream plugin binds that same well-known port for
every profile on the machine. A pid-instrumented probe settled the process model: the
OpenCode host process binds the port, resolves the endpoint in `chat.params` and serves
the request itself, while short-lived cold-install and probe processes bind and release
the same port around it. So the whole path depended on one machine-global port being free
and owned by the right process.

A managed profile now retains its own port (`reserveCursorManagedProxyPort`), the managed
config points the provider at it (`applyCursorManagedProxyEndpoint`), and the patched
plugin binds exactly that port with no silent fallback. Proof: with a hostile squatter
holding 32124 and answering 500, a managed profile bound 62272, accepted the request and
the model replied. The same scenario previously broke Cursor completely with only
`AI_APICallError: Internal Server Error` to go on.

Binding the managed proxy to an ephemeral port was tried first and reverted: the provider
endpoint still pointed at the catalog default, so every turn failed with
`Cannot connect to API`. That is why the fix has to move both sides together.

**A leaked fixture proxy poisons Cursor machine-wide.** `managed-transport.test.ts` left a
`bun.exe` listening on the shared Cursor proxy port 32124 with `PPID 1` after its sandbox
was deleted. Every later Cursor launch reached that stale proxy, whose control token
differs, and got `500 Cursor managed request authentication failed`, surfacing in OpenCode
only as `AI_APICallError: Internal Server Error`. This is the most likely cause of the
"managed transport timed out at 30s" entry in the earlier ledger. The fixture cleanup now
escalates to SIGKILL, and the patched plugin logs the rejection reason and the resolved
managed endpoint. This leak is what made the shared port dangerous in practice; managed
profiles are no longer exposed to it.

## 6. Native App MCP through Cursor: already shipped, and verified

The frontend already registers the app's MCP server for Cursor launches:
`CursorMcpConfigWriter.ensureCursorAgentTeamsMcpConfig`, called from
`OpenCodeReadinessBridge.registerAgentTeamsMcpServer` when the selected model starts with
`cursor-acp/`. It is in `origin/main` (`da019bb5d`, `76cacc465`, `64a885cf0`) and merges
ownership-aware into `~/.cursor/mcp.json` without adopting or overwriting user entries.
The earlier handoff listed this as missing; that was wrong, and the earlier live run only
failed to see the tool because it registered the server in OpenCode's own config, which
Cursor never reads.

Spike results on the real CLI (2026.08.25-3e8eec8), each adding exactly one uniquely named
entry and removing exactly it, with the user's `~/.cursor/mcp.json` md5 verified unchanged:

| Registration | Extra args | Tool visible to the agent |
| --- | --- | --- |
| `~/.cursor/mcp.json` (what the app writes) | `--force` only, as the plugin passes today | yes, called once, receipt echoed |
| `~/.cursor/mcp.json` | `--force --approve-mcps` | yes |
| `<project>/.cursor/mcp.json` | `--force` only | **no** - agent reported the tool unavailable |
| `<project>/.cursor/mcp.json` | `--force --approve-mcps` | yes |

So server *approval* and tool *permission* are different gates. A home-registered server
needs no approval step, and `--force` covers the tool call: this host has
`approvalMode: allowlist` with zero `Mcp()` allow entries and the call still succeeded. No
product change is required, and `cursor-agent mcp enable` is not needed on the shipped
path. Project-scoped registration would need `--approve-mcps`, which is worth knowing
before anyone moves the registration out of the home directory.

## 7. Native auth authority and readiness fingerprint

`OpenCodeCursorNativeAuthority.ts` replaces "there is a fresh 30-minute marker" with an
identity the app can actually check:

- `accountHash` - sha256 of the account `cursor-agent status` reports. The account is
  never stored or logged in the clear; the retained record is asserted to contain no `@`.
- `executableHash` - sha256 of the resolved real binary plus size and mtime, cheap enough
  to run on every preparation so a replaced or updated CLI is noticed without a subprocess.
- A changed account or binary invalidates readiness immediately and drops the managed auth
  marker, instead of letting a switched account keep running for up to the TTL.
- `buildCursorReadinessFingerprint` binds account, binary, staged asset digest, profile
  scope, managed config fingerprint (which already covers model, provider options and App
  MCP config) and the retained proxy port. It is published as
  `AGENT_TEAMS_CURSOR_READINESS`.

Verified offline against a fake `cursor-agent`, so this costs no Cursor usage: the
fingerprint is stable across repeated preparations, changes when the account behind the
same path changes, and is absent entirely when the CLI reports signed out.

Three real defects were found by writing those tests, and fixed:

1. `probeCursorAgentAuth` matched `/\blogged in\b/i`, which **"Not logged in" also
   satisfies**. A signed-out CLI was therefore recorded as authenticated. The same trap was
   in the new probe. Both now reject `not logged in` and `"authenticated": false`.
2. The first wiring hashed `cursorAgentExecutablePath`, which is the generated bridge
   script rewritten on every preparation. That churned readiness, spent a `status`
   subprocess every time, and wiped the auth marker on each launch. Identity now hashes the
   unwrapped `cursorAgentHostCommand`; the probe still runs through the bridge so the CLI
   sees its own home.
3. The managed asset cache was keyed by nothing, so within its 30s window it could answer
   with another profile's staging, or keep denying after staging appeared. It is now keyed
   by staging root, platform and architecture.

## 8. Subscription-free E2E

`OpenCodeCursorManagedStop.fake-e2e.test.ts` runs the same managed path against a fake
native CLI that speaks the stream-json contract the plugin parses and resolves MCP the way
the native CLI does: from the workspace registration file, over HTTP JSON-RPC against a
real in-test MCP server. It needs no Cursor account and no opt-in flag, so the guarantees
stay checkable when an account is rate limited or on a machine without a subscription.
Green on three consecutive runs, ~32s each, covering:

- managed artifact loaded instead of the npm package
- own retained proxy port, with the provider endpoint pointing at it and never at 32124
- readiness fingerprint published
- bridge supervising managed requests only
- a managed turn
- **an MCP tool call inside a managed turn**: the CLI reads the registration, calls the
  tool exactly once with the expected challenge, and the server-generated receipt comes
  back through the managed turn into the OpenCode session
- a follow-up that does not seal the session
- Stop of an active turn with zero surviving supervised processes and no late output
- repeated Stop
- a sibling session that still works without replaying the sealed prompt

Between this and the live spikes in section 6, the combined scenario is covered from both
ends: the spikes prove the real CLI and a real model discover and call a registered MCP
tool, and this proves the same registration is consumed inside a managed, supervised,
stoppable turn. What no test yet covers is both halves in a single live turn, which is
blocked only by the account limit below.

The live test remains the proof that the real CLI behaves this way; the fake test is what
keeps that behaviour from regressing between live runs.

## 9. Not done

- The live E2E step that exercises a Cursor-native MCP tool *inside* an OpenCode-driven
  managed turn is written but not yet green: the Cursor account hit its usage limit
  (`ActionRequiredError: You've hit your usage limit`), which a direct `cursor-agent` call
  reproduces independently of this code. The test now fails fast with that reason instead
  of an unexplained timeout. The MCP mechanism itself is already proven by the spikes in
  section 6, and everything around it by the fake E2E; what remains unproven is only the
  two together in one live turn. Re-run once usage resets.
- Native auth authority and readiness fingerprint binding.
- Electron/DevMCP UI run and packaged verification. Asset delivery for the compiled
  `gate` inside the single-file runtime is deliberately deferred.
