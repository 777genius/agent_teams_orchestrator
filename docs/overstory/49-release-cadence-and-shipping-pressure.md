# Release Cadence and Shipping Pressure

`overstory` ships fast.

During this research pass, `gh release list --repo jayminwest/overstory --limit 30` showed:
- `v0.5.9` on `2026-02-21`
- `v0.6.0` through `v0.6.11` on `2026-02-24` and `2026-02-25`
- `v0.7.0` through `v0.7.9` on `2026-02-26`, `2026-02-27`, and `2026-03-02`
- `v0.8.0` through `v0.8.7` on `2026-03-03` through `2026-03-10`
- `v0.9.1`, `v0.9.2`, and `v0.9.3` on `2026-03-13` and `2026-03-23`

That is an unusually dense release train.

## What is good

- The project clearly ships fixes and improvements quickly.
- The team is not sitting on long private stabilization branches.
- Release tempo matches the repo's strong dogfooding signal.
- It creates fast feedback loops for painful substrate issues.

## What this implies architecturally

Fast release cadence is not just a product detail.
It changes what kind of architecture is survivable.

In `overstory`, this release tempo is one reason the project can tolerate:
- evolving runtime adapters
- compatibility shadows
- tmux and shell substrate fixes
- prompt and role-contract refinement

The architecture is partly supported by rapid iteration velocity.

## The risk

⚠️ A fast release train can quietly become part of the contract.

If the system needs:
- frequent patch releases
- rapid cleanup of operator pain
- iterative closure of runtime parity gaps

then shipping velocity is doing work that stronger runtime closure should eventually do.

That does not make the project weak.
It means the product is still paying an active stabilization tax.

## Best lesson to steal

Steal:
- short feedback loops
- visible shipping tempo
- willingness to fix awkward operational seams quickly

Avoid:
- relying on release speed as a substitute for closing deep seams
- mistaking frequent patch shipping for full contract maturity
