# Plugin Network Boundaries And Defensive Security Taste

## One of the quieter good subsystems

`server/src/services/plugin-host-services.ts` is one of the better security-flavored layers in `paperclip`.

It is not perfect.

But it shows real defensive engineering taste.

## What is genuinely strong

### Plugin HTTP fetch does not trust DNS twice

The fetch path does more than a naive `fetch(url)`:

- parses the URL
- allowlists protocols
- resolves DNS explicitly
- rejects private/reserved IPs
- pins the resolved IP into the outgoing request
- preserves original host via `Host`/TLS `servername`

This is a real DNS rebinding defense.

That is unusually good.

### It does not silently follow redirects

Because the implementation uses low-level `http` / `https` request primitives directly, it does not behave like a browser-style auto-follow client.

That is a quiet but important safety property.

Redirects are a very common way for SSRF rules to get softened later.

### It has bounded request behavior

There are more good quiet details:

- request timeout
- DNS timeout
- body size limit
- protocol allowlist
- log/meta sanitisation

This is not glamorous, but this is the kind of subsystem quality that matters.

## Why this is interesting architecturally

This subsystem is a good contrast with some weaker Paperclip seams.

Here the contract is:

- fairly explicit
- fairly narrow
- implemented with real low-level care

That is exactly why it feels stronger than parts of heartbeat or route auth closure.

## Where it still has tension

### Security taste is local, not universal

The problem is not this subsystem.

The problem is inconsistency across the broader platform.

For example:

- plugin fetch boundary is quite disciplined
- workspace shell execution is much softer
- some adapters still default to dangerous unattended modes

So the platform has islands of strong defensive taste, but not one uniform posture.

### Plugin surface maturity still drifts from route closure

Even with good host-services security, the plugin execution story still has the `#3271` mismatch:

- tools look execution-side
- routes still front-load board access

So security hygiene inside the subsystem is stronger than capability closure around the subsystem.

## Architect takeaway

Steal:

- pinned-IP SSRF defense
- protocol allowlists
- low-level no-redirect request discipline
- bounded log/meta/body handling

Avoid:

- having a few security-strong subsystems next to other power surfaces that still rely on softer defaults
- assuming good local hardening compensates for broader route/auth/capability drift
