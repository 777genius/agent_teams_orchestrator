# Tests History And Maturity

## What is good

Cortex takes testing more seriously than many early competitors.

Signals:

- large `test/` surface
- unit, integration, and e2e layers
- Go and Elixir checks
- separate CI workflows
- explicit `TESTING.md`
- mock and real-Claude paths in CI

This is real engineering effort, not placeholder testing theater.

## What I could verify directly

- `122` files under `test/`
- about `1539` Elixir test blocks by grep
- `21` files under `e2e/`
- CI covers Elixir checks, Go checks, integration, and multiple e2e flows

## What I could not verify directly here

I could not execute `mix test` in this environment because `mix` was not installed.

So the confidence split is:

- high on test surface size and intent
- medium on current runtime pass status

## Churn read

Early git churn hotspots include:

- `lib/cortex/orchestration/runner/executor.ex`
- UI run detail files
- `README.md`
- validator and external-agent paths
- sidecar entrypoint

This suggests:

- orchestration execution and product explanation are still moving fast
- the design is not yet settled

## Repo-age interpretation

The repo is only about a month old from creation to last push seen here.

That means even good code should be interpreted with caution:

- little long-term maintenance evidence
- little user-pressure evidence
- almost no public incident history

## Bottom line

Cortex looks much more serious than a throwaway prototype.

But the maturity proof is still mostly internal:

- tests
- docs
- CI

not:

- public adoption
- public issue pressure
- long-lived operational track record
