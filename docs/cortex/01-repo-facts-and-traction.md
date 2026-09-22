# Repo Facts And Traction

## Verified repo facts

- Repo: `https://github.com/itsHabib/cortex`
- Default branch: `main`
- Studied revision: `38d505069113dc558654025e4fff91b08b35b34f`
- Created: `2026-03-16`
- Last push seen: `2026-03-30`
- Stars: `34`
- Forks: `2`
- License: `MIT`
- Releases: `0`
- Open issues found: `0`
- Open PRs found: `0`
- Git shortlog currently shows `1` contributor

## What this means

Cortex has very low public traction right now.

That does not mean it is weak technically. It means:

- most of the evaluation has to be code-based, not community-based
- there is little public evidence of production pressure
- there is almost no public issue history showing how the design behaves under real user pain

## Test and doc surface

Signals that look stronger than a toy:

- `122` files under `test/`
- about `1539` Elixir `test "..."` blocks by grep
- `21` files under `e2e/`
- dedicated `ci.yml` and `full-suite.yml`
- substantial internal docs and phase summaries

Important caution:

- `docs/09-11-final/SUMMARY.md` says `511 tests, 0 failures`
- local Elixir toolchain was not installed in this environment, so I could not independently execute `mix test`
- the test surface is clearly non-trivial, but exact pass status here remains unverified

## Maturity read

The repo feels like:

- early in public adoption
- surprisingly broad in internal scope
- architecturally serious
- still much closer to research-grade than market-proven

## Confidence note

High confidence in the repository facts.

Medium confidence in maturity interpretation because the public signal is sparse and runtime verification here was partially blocked by missing `mix`.
