# Gastown Execution Planes and Minimal Participation Protocols

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file focuses on two unusually strong ideas inside Gastown:

- separating execution planes cleanly
- allowing participation in a larger system without requiring the full runtime

These are some of the best strategic architecture lessons in the repo.

## 1. Execution-plane separation is one of Gastown's strongest ideas

The sandboxed polecat execution design contains a very strong decomposition:

| Plane | What happens there |
|------|---------------------|
| Agent work plane | LLM inference, file edits, code execution, git work |
| Control plane | `gt prime`, `gt done`, mail, events, orchestration state |

This is extremely valuable.

Why it matters:

- sandboxing becomes much easier to reason about
- transport boundaries become explicit
- host authority stays separate from worker execution
- headless and remote workers become more feasible

Architect rating: `🎯 9.7   🛡️ 9.2   🧠 6`

## 2. Sandboxed execution as a backend, not a special mode

The `sandboxed-polecat-execution.md` proposal is strong because it frames
sandboxing as:

- a backend choice
- a wrapper choice
- a transport and authority problem

not just:

- a prompt trick
- or a one-off special case

This is the right long-term shape.

Architect rating: `🎯 9.4   🛡️ 9.0   🧠 6`

## 3. Proxy mediation is a strong boundary pattern

The proxy approach is one of Gastown's best system-boundary ideas:

- container does work
- host retains control-plane authority
- worker talks to host through explicit, authenticated channels

Why this is good:

- host credentials stay on the host
- authority is centralized
- worker environment can be tightly restricted
- remote backends stop being a giant trust leap

Architect rating: `🎯 9.3   🛡️ 9.1   🧠 6`

## 4. Minimum Viable Gas Town is a very strong ecosystem idea

The `mvgt-integration.md` guide is more important than it looks.

It says:

- you should be able to participate in the larger work ecosystem
- without running the full Gastown runtime
- as long as you can speak the shared durable protocol

That is a very mature systems idea.

Why it is strong:

- reduces lock-in
- encourages protocol thinking over runtime monopoly
- lets other orchestrators or CI systems participate
- separates ecosystem contract from implementation choice

Architect rating: `🎯 9.5   🛡️ 9.1   🧠 7`

## 5. Shared schema as a participation contract is a strong instinct

The Wasteland / MVGT material shows a good strategic instinct:

- ecosystems should have a shared language
- not every participant must run the same orchestrator

That is a surprisingly strong lesson.

It means:

- internal runtime can change
- external interoperability can remain stable

Architect rating: `🎯 9.2   🛡️ 8.9   🧠 7`

## 6. Where this vision is better than the current runtime

These execution-plane and protocol ideas are stronger than several parts of the
shipped Gastown runtime.

That matters.

It means the maintainers understand a healthier future shape than what the
current implementation fully delivers.

Good sign:

- the architectural direction here is genuinely ahead of the substrate

## 7. What to take from this

### Best practices worth stealing

- separate worker execution plane from orchestration authority plane
- make sandboxing a backend concern, not a prompt convention
- use authenticated proxies or adapters at trust boundaries
- design shared participation protocols that do not require one blessed runtime
- treat shared durable schema as an interoperability surface

## 8. What to avoid even here

Even these strong ideas can go wrong if:

- the shared protocol is too coupled to one storage engine
- the minimal protocol becomes too large and heavy
- the proxy path becomes another fragmented truth plane
- ecosystem ambition grows faster than local substrate quality

So the lesson is:

- keep the boundary explicit
- keep the protocol minimal
- keep authority centralized
- do not let the transport layer become another source of semantic drift

## Final takeaway

One of Gastown's most impressive architectural instincts is this:

> the orchestrator does not have to be the whole world.

That is a very strong principle.

It suggests a healthier future where:

- the runtime is one implementation
- the protocol is the durable contract
- workers can be local, remote, sandboxed, or headless
- the ecosystem remains interoperable
