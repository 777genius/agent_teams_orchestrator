# Selected local Qwen profile (artifact only)

`owner-local-qwen-config-spec.json` selects exactly `local-llama/qwen3-8b`.
`build-config.py` emits a root-owned, read-only `opencode.json` for that spec
only when given the per-lease root gateway's literal RFC 1918 IPv4 URL ending
in `/v1`. Host-local llama-server remains at `127.0.0.1:18993`; container
loopback cannot reach it. The gateway URL is an input from a separately
attested Docker network claim, not a user-selected provider endpoint.

The model context is the observed 8192 tokens. The tiny canary output cap is
128 tokens, so OpenCode never sends an unbounded `max_tokens` for this profile.
The config selects one provider and one model, loads only the image-pinned FD3
Owner plugin, allows only the five reviewed `hosted_*` tools, disables sharing,
automatic updates, and snapshots, and contains no API key. Its exact bytes and
SHA-256 receipt vary only with the admitted gateway URL.

Official OpenCode v1.18.32 at pinned commit
`545f51d26cc39a907d2867492d498d9607ea5fa4` declares
`@ai-sdk/openai-compatible` version 2.0.41 and imports it through
`BUNDLED_PROVIDERS`. The official executable digest in `artifact-lock.json`
pins those bytes. The config does not request a runtime package download or
use `latest`. The selected profile remains inactive until the root supervisor
attests the gateway, image manifest digest, exact config receipt, and Owner
effect lease. Creating the config alone starts no container or model call.

## Narrow host gateway admission

The Docker bridge remains `Internal: true`, with one root-owned, single-use
network claim and no foreign containers. A root-owned gateway binds only the
claimed bridge's host gateway address on a lease-specific port and forwards
only the required OpenAI-compatible `/v1` paths to `127.0.0.1:18993`. It
starts before container creation and stops before network-claim release. The
supervisor binds the lease to the Docker network ID, container ID, bridge IP,
gateway listener, config SHA, immutable image digest, binary digest, and
generation. A packet filter accepts the listener only from that container IP
on that network and rejects other sandbox egress. No public interface listens.

Network identity, filter state, and gateway lifetime need reattestation at
Start, Observe, Stop, and crash reconciliation. An unknown Docker result or
lost gateway/filter state fails closed. Prove bridge-to-host-gateway reachability
with an inert synthetic HTTP client on a new test sandbox before a model call.
The release gate still requires independent review of gateway code, packet
filter rules, endpoint authentication and response bounds, exact config bytes,
and Owner effect-token integration. This artifact grants none of those effects.
