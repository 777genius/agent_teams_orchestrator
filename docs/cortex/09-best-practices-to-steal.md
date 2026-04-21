# Best Practices To Steal

## 1. Treat orchestration as a concurrent systems problem

This is the biggest positive Cortex lesson.

Good ideas:

- explicit runtime modes
- membership lifecycle
- supervisor-driven subsystems
- external-worker gateway path

Do not copy the exact implementation blindly.
Copy the level of seriousness.

## 2. Start from OTP-like subsystem boundaries

Cortex decomposes runtime concerns cleanly:

- agents
- registries
- gateway
- messaging
- orchestration
- providers
- spawn backends

That is good architecture taste.

## 3. Keep DAG logic boring

The DAG tiering is simple, explicit, and understandable.

This is exactly what you want:

- deterministic
- explicit errors
- no magical graph behavior

## 4. Make recovery a first-class story

Cortex deserves credit for:

- resume
- reconcile
- dead coordinator handling
- log-based restart context

Even if the current truth model is weaker than ideal, the mindset is strong.

## 5. Separate external-worker transport from provider semantics

The split between:

- gateway
- pending tasks
- external provider
- worker/sidecar

is clean and worth learning from.

## 6. Give experimental modes their own architecture

Mesh and gossip are distinct runtime paths, not bolted onto the DAG loop.

That is architecturally healthier than stuffing every concept into one flow.

## 7. Write serious internal docs

Cortex has unusually rich phase docs for a young repo.

This is good because:

- design intent is visible
- tradeoffs are easier to recover later
- the project remembers what it was trying to become

## 8. Make UI and telemetry exist early

Even if the core is not yet perfect, building:

- dashboards
- run views
- observability hooks

early helps expose the real engine seams.
