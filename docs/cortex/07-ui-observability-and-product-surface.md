# UI Observability And Product Surface

## Good news

Cortex does not ignore product surface.

It has:

- Phoenix LiveView UI
- workflows pages
- runs and overview pages
- mesh and gossip panels
- run detail views
- telemetry and Prometheus integration

For such a young repo, that is notable.

## What is valuable here

The UI is not the core innovation, but it proves:

- the team thinks in operator workflows, not only library APIs
- there is a concept of live runs, teams, activity, and dashboards
- observability matters in the architecture story

## Event model

The event model is PubSub-first:

- `Cortex.Events` broadcasts ephemeral events
- `Store.EventSink` subscribes and persists them

This is useful for UI and analytics, but it creates a familiar risk:

- the persisted event log is derived from the event stream
- it is not the atomic source of truth

So UI and logs can still lag or diverge from the actual workspace truth.

## Surface maturity

The LiveView/dashboard layer is more substantial than a demo, but not yet the strongest part of the system.

Why:

- the central truth is not unified
- several operator stories still depend on reconstructed or synced state
- the engine underneath is still file-heavy

So the UI can only be as clean as the underlying truth model allows.

## Bottom line

Cortex already has a respectable operator surface for such a young repo.

But its UI and observability should be read as:

- evidence of strong ambition

not yet as:

- proof of a perfectly coherent realtime control plane
