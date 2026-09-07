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
agent call them through its `mcptool` CLI, with OpenCode's `bash` permission
rules applying to the call. It never worked here, for three separate reasons.

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

## 7. Still open

- Permissions. The plugin passes `--force` by default and this app does not
  override it, so a user who chose manual tool approval does not get it. Because
  MCP calls now travel through `bash`, OpenCode's permission rules do apply to
  them, which means `CURSOR_ACP_FORCE=false` is the switch that restores
  approvals. That needs its own verification before it is turned on.
- The frontend still writes an app-owned entry into `~/.cursor/mcp.json` on
  Cursor launches. With the bridge working, that path can be retired; it lives in
  the frontend repository and is not part of this change.
- A single live run of the full product chain, App MCP through a launched team
  with a file-changing task and a Stop over it.
