# Selected local Qwen profile (design only)

The one selected sandbox model is `local-llama/qwen3-8b`, served by the
host-local OpenAI-compatible endpoint `127.0.0.1:18993/v1`. This profile is
**inactive**: no Qwen config artifact is emitted and no model call is allowed
by this recipe. The inert and FD3 Owner plugin configs contain no model or
provider; neither activates the selected Qwen profile.

The later profile must be a separate root-built, canonical, SHA-256-attested
`opencode.json`, mounted read-only at `/sandbox/config` under the same
one-file/0555-directory/0444-file contract as the inert and Owner plugin
configs. Its provider ID and model ID must be fixed to `local-llama` and
`qwen3-8b`; its `baseURL`
must be a literal address of a per-lease root-owned gateway on the Docker
bridge, ending in `/v1`. It must keep only the locked FD3 Owner plugin,
`share: disabled`, and the exact five reviewed tool permissions. It
must contain no user API keys, inherited environment, or public endpoint.
The existing test-only provider shape uses `npm: '@ai-sdk/openai-compatible'`
and `tool_call: true`. Official OpenCode v1.18.32 pins that adapter at
2.0.41; its published integrity is
`sha512-kNAGINk71AlOXx10Dq/PXw4t/9XjdK8uxfpVElRwtSFMdeSiLVt58p9TPx4/FJD+hxZuVhvxYj9r42osxWq79g==`.
Before activating the profile, verify the exact adapter is already packaged
in the pinned official executable or package it in a separately pinned,
reviewed image layer. Runtime package download, implicit `latest`, and a
mutable package cache are prohibited. Context and output limits remain
unresolved until measured from the selected local model service; the builder
must reject their absence rather than guess values.

## Narrow host gateway proposal

The Docker bridge remains `Internal: true`, with one root-owned, single-use
network claim and no foreign containers. The sandbox cannot use host
`127.0.0.1` directly. For a future test, a root-owned gateway would bind
only the claimed bridge's host gateway address on a lease-specific port and
forward only the required OpenAI-compatible `/v1` HTTP paths to host
`127.0.0.1:18993`. It would start before container creation and stop before
the network claim is released. The supervisor would bind its lease to the
exact Docker network ID, container ID, container bridge IP, gateway listener,
config SHA, image digest, binary digest, and generation. A root-owned packet
filter would accept this listener only from that exact container IP on that
network and reject all other sandbox egress. No public interface listens.

Network identity, filter state, and gateway lifetime must be reattested at
Start, Observe, Stop, and crash reconciliation. An unknown Docker result or
lost gateway/filter state fails closed. Prove bridge-to-host-gateway reachability
with an inert synthetic HTTP client on a new sandbox before any model call;
Docker's internal bridge behavior and host firewall policy are deployment
dependent. The release gate then requires an independent review of gateway
code, packet-filter rules, endpoint authentication/response bounds, adapter
pin, exact config bytes, and Owner effect-token integration. This document
does not open network access or enable model/agent effects.
