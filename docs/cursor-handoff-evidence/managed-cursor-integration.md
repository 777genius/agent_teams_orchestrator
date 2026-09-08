# Managed Cursor integration: what it does, and what it deliberately does not

This supersedes `managed-stop-live-e2e.md` and the process-ownership sections of
`execution-ledger.md` and `nested-stop-verdict.md`. Those describe a native
ownership barrier that is no longer part of this work; the reasoning that removed
it is in section 5.

## 1. The integration in one paragraph

The Cursor provider runs through the pinned upstream OpenCode plugin. This app
builds that plugin into a verified artifact with a small reviewed patch, gives
each managed profile its own proxy port, materializes the managed config where
the plugin can read it, ships the plugin's own MCP CLI so an agent can reach the
app's MCP servers, and binds readiness to a live native account identity. Stop is
the ordinary OpenCode transport abort. Nothing is enabled unless staged assets
verify; otherwise the upstream plugin and today's launch path are used unchanged.

## 2. The three defects that kept Agent Teams tools away from Cursor agents

The plugin ships an MCP bridge that discovers OpenCode MCP servers and lets an
agent call them through its `mcptool` CLI. It never worked here, for three
separate reasons. (The plugin's README says OpenCode's `bash` permission rules
apply to such a call. Measured here, they do not: see section 7.)

**The config did not exist as a file.** The bridge reads servers from
`$OPENCODE_CONFIG` or `$XDG_CONFIG_HOME/opencode/opencode.json`. This app passes
configuration only through `OPENCODE_CONFIG_CONTENT` and explicitly deletes
`OPENCODE_CONFIG`. A profile's config directory held only `node_modules` and
`package.json`, so `readMcpConfigs()` always returned an empty list.

**`mcptool` was never published to the agent.** It is a package bin that a global
`npm install` provides. A bundled artifact does not, and the agent said so
outright: `mcptool isn't on PATH`.

**The bridge cleared the environment the CLI needed.** It exports the host PATH
and unsets `XDG_*`, so even once found, `mcptool` would have resolved the user's
own OpenCode config rather than the profile's.

Because none of this worked, the frontend grew a parallel path that writes an
app-owned entry into the user's global `~/.cursor/mcp.json`. That path is no
longer required.

Two traps found while fixing it, both kept as comments in the code: the profile
bin directory must be appended to the bridge PATH rather than prepended, because
it also holds a wrapper named `cursor-agent` and prepending makes the wrapper
exec itself; and the CLI must be bundled for node with the MCP SDK pulled into
its module graph, because it loads the SDK through a dynamic import that a
standalone bundle cannot resolve, and it runs from the agent shell where node is
far likelier than bun.

Verified live against the real CLI in
`OpenCodeCursorAppMcp.live-e2e.test.ts`: a Cursor agent called an App MCP tool
through this path and returned the server-generated receipt, with the user's
`~/.cursor/mcp.json` asserted byte-identical before and after.

## 3. One proxy port per profile

The curated catalog pinned the Cursor provider endpoint to the upstream plugin's
single well-known port, 32124. Any stale or foreign holder silently received
another profile's traffic and rejected it, surfacing in OpenCode only as
`AI_APICallError: Internal Server Error`. A leaked test proxy on that port is
what made it reproducible, and it is the likely cause of an earlier
"managed transport timed out" report.

Each managed profile now retains its own port. The provider endpoint and the
plugin's bind target move together, and the plugin fails loudly rather than
falling back to a port nothing will dial. Verified against a hostile squatter
holding 32124 and answering 500: the managed profile bound its own port and the
turn completed.

## 4. Readiness is an identity, not a marker

The previous scheme wrote a `cursor-agent` marker credential with a 30-minute
TTL. Readiness now binds the hashed account reported by `cursor-agent status`,
the hashed real binary, the staged asset digest, the profile scope, the managed
config fingerprint and the retained port, published as
`AGENT_TEAMS_CURSOR_READINESS`.

The account is probed on every reconciliation. An earlier version of this code
reused its record for the TTL, which meant a sign-out or an account switch inside
that window stayed invisible; a reviewer reproduced exactly that, and the tests
had hidden it by changing the binary or advancing the clock instead. The only
remaining reuse is a five second burst dedupe inside a single launch sequence.

Two probe defects fixed here: `"Not logged in"` also matches `/\blogged in\b/i`,
so a signed-out CLI was recorded as authenticated, in the existing probe and not
only in the new one; and identity was hashing the generated bridge wrapper, which
is rewritten on every preparation and therefore churned readiness and spent a
subprocess on every launch.

## 5. Why the native ownership barrier was removed

An earlier iteration added a macOS supervisor, a compiled C gate, a private
control socket, a seal/acknowledgement protocol and a descendant sweep, so that a
terminal Stop could prove it had ended every process. Three findings retired all
of it.

**It was solving a problem this configuration does not have.** With
`TOOL_LOOP_MODE=opencode`, OpenCode executes tools and cursor-agent only runs
model turns. Measured directly: while an agent-requested shell command was
running, zero processes carried the ownership marker, because the command was
OpenCode's, not the agent's.

**The central claim was false on macOS.** The sweep resolved survivors from
`ps -Eww`, which SIP hides for platform binaries. Measured on this host with SIP
enabled: the marker was invisible for `/bin/sh`, `/bin/bash` and `/bin/zsh`, and
visible only for non-platform binaries such as homebrew's node. The negative
control that "proved" containment escaped through node, the one case that
happens to work.

**The ordinary abort already does the job.** A plain
`client.abortSession()` was measured ending the cursor-agent child, with no late
output: the plugin cancels the request on the transport abort signal and the
child goes with it. The seal, the acknowledgement, the descriptor files and the
supervisor were all machinery around something that already worked.

What is deliberately out of scope, and stated rather than hidden: a descendant
that deliberately detaches itself from the agent is not hunted down. No provider
in this app does that, macOS offers no guarantee for it without root or an
EndpointSecurity entitlement, and if the product ever needs it, it belongs once
at the app level for all runtimes rather than inside one provider.

## 6. Verification

- `OpenCodeCursorManagedStop.fake-e2e.test.ts` needs no Cursor account and no
  flag. It drives the managed path against a fake native CLI that speaks the same
  stream-json contract and resolves MCP the way the real one does, covering a
  managed turn, an MCP tool call inside it, a follow-up that does not seal, Stop
  of an active turn with the agent process observed dead and no late output,
  a repeated Stop, and an unaffected sibling session.
- `OpenCodeCursorAppMcp.live-e2e.test.ts`, behind `CURSOR_APP_MCP_LIVE_E2E=1`,
  proves the same MCP path against the real CLI and asserts the user's Cursor
  configuration is untouched.

## 7. Permissions: measured, and refused rather than faked

The plugin passes `--force` by default and this app never overrode it, so a user
who chose manual tool approval silently did not get it. The obvious fix was
`CURSOR_ACP_FORCE=false`. It does not work, and the reason matters.

Measured in a sandbox with `toolApprovalMode: 'manual'` and force off, over three
turns (shell rejected, shell allowed, MCP allowed): **no permission request was
raised at all**, and the effect happened anyway. The turn whose approval was
rejected still wrote its marker file. The tool in the transcript is named
`shell`, not `bash`.

That name is the explanation. `shell` is cursor-agent's own tool: cursor-agent
executes it itself, so the call never reaches OpenCode, and OpenCode's permission
rules -- which key on `bash` -- never see it.

The agent is not consistent about which one it reaches for. A later live run of
the same App MCP task used OpenCode's `bash` three times and never touched
`shell`, so those calls did run through OpenCode. That is the actual finding, and
it is worse than a flat "approvals do not work": **the agent chooses its own
executor per call**, and one of the two choices silently bypasses approval. A
mode that holds only when the model happens to pick the right tool is not a
permission guarantee, and presenting it as one would be a lie to the user.

One real defect was found and fixed on the way: with force off the plugin passed
neither `--force` nor `--trust`, and every turn died on
`⚠ Workspace Trust Required`. `--force` conflates trusting the workspace with
approving every tool call; the patch now passes `--trust` when force is off, so
the switch at least produces working turns. It still does not produce approvals.

So the app now **refuses** the combination instead of pretending: selecting
manual tool approval with the Cursor provider fails the launch with a stated
reason, at the entry of `prepareProfile`, before any staging or snapshot work.
Automatic approval is unaffected, and other providers keep manual approval.
Covered by `OpenCodeCursorManagedLaunch.test.ts`; with the refusal removed the
test fails.

Restoring real approvals for Cursor would mean denying cursor-agent its native
tools so every call is forced back through OpenCode. That is a change to the
plugin's tool exposure, not a flag, and it is out of scope here.

## 8. Delivery

The plugin bridge publishes every App MCP tool to OpenCode as a first-class tool,
so an agent reaches Agent Teams by calling `mcp__agent_teams__<tool>` and needs no
`~/.cursor` registration at all. Asserted deterministically in the fake E2E
against OpenCode's own tool list; with the config materialization removed, that
assertion fails.

`mcptool` stays, and the live run is why. Told only to "call the tool that
returns the Agent Teams receipt", with no command and no tool named for it, the
real agent reached the server through a shell three times and produced the
server-generated receipt -- exactly one MCP call, with the user's
`~/.cursor/mcp.json` byte-identical afterwards. Both routes are real, the agent
picks between them, so shipping only one of them would be a guess.

Readiness is now part of host reuse. It was published into the profile
environment and read by nothing, so a persistent host outlived the account that
started it; it is now a segment of the host identity, and a sign-out, an account
switch, a re-staged asset or a new port all retire the running host.

The build stages the reviewed assets beside the runtime (`dist/cursor-managed`),
and an unset `AGENT_TEAMS_CURSOR_MANAGED_ASSETS` falls back to that location next
to the executable -- but only when the directory belongs to this user and is not
group or world writable, because it decides which plugin code OpenCode loads.
Everything else still fails closed to the upstream plugin.

## 9. What the product run found

Everything above was proven against tests. Running the real desktop app against a
throwaway sandbox project found four things no test had, and each is fixed here.

**The materialized config loaded the plugin twice.** OpenCode merges that file
with `OPENCODE_CONFIG_CONTENT`; objects merge by key but arrays append, so the
`plugin` array carried the entry twice and the readiness authority refused the
host with `selected_config_match:plugin`. Only the sections the bridge reads are
written now, and the fake E2E fails if `plugin` reappears there.

**Three launch gates disagreed.** Cursor was allowed through readiness but still
refused by the launch handshake and by `launch_runtime`, so a launch passed one
check and died at the next with a different message. All three now ask the same
question through `isManagedCursorLaunchSupported`.

**App MCP could not connect at all.** The product registers Agent Teams over
HTTP, and the plugin's shared MCP manager implemented stdio only:
`Remote MCP transport not yet implemented for agent-teams`. The patch adds the
streamable HTTP transport, which fixes the bridge and `mcptool` together. The
same log line now reads `MCP server connected {"server":"agent-teams","tools":48}`,
and the fake E2E drives the HTTP transport rather than a stdio stand-in.

**`mcptool` reported failure as success.** A failed connection is logged and
swallowed, `callTool` then returns the string `Error: ... not connected`, and the
CLI printed it and exited 0. It exits non-zero now.

With those in place the chain runs: launch reaches `ready`, a user message is
accepted by the runtime (`acceptedAt` set, where before it was `failed_terminal`
with three failed attempts), the agent edits the file it was asked to edit and
replies.

Two diagnostics were added because both failures above cost an hour of guessing
from an opaque hash pair: a stale session now names the config sections that
moved (`managed_config_changed:mcp,provider:...`) and what an auth change
actually was (`managed_auth_changed:profile_root`, `selected_identity`,
`source_store` or `managed_store_bytes`).

## 10. Still open

- The second message in a session is not delivered: after the first turn the
  session goes stale with `managed_auth_changed`, and the follow-up never reaches
  the runtime. The new detail lands in the ledger, but reading it needs another
  live run and the Cursor account hit its usage limit first.
- Stop has not been proven on the product path, and it must be proven against
  cursor-agent's own `shell` tool rather than only OpenCode's `bash`, because the
  agent chooses its executor per call.
- Exactly-one accounting for a real MCP call, and an unaffected sibling session,
  are covered deterministically but not yet on the product path.
- `OpenCodeCursorManagedStop.fake-e2e.test.ts` passes on its own in about fifty
  seconds and times out when the whole `src/services/opencode` suite runs
  together; it starts real OpenCode hosts and loses the race for resources.
