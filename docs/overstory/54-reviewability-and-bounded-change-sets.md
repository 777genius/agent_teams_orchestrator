# Reviewability and Bounded Change Sets

One of the more valuable architectural signals in `overstory` comes from how the maintainer reacts to changes that are too broad.

Issue / PR `#56` is the clearest example.

The proposed multi-repo workspace contribution was directionally correct.
The maintainer still rejected the one-shot merge path because the change was:
- too large
- too cross-cutting
- too difficult to review safely

The suggested response was not:
- abandon the feature

It was:
- break it into smaller stacked units
- land the data model
- then land context resolution
- then command routing
- then orchestration surfaces
- then observability and polish

## Why this matters architecturally

Large PR discipline is not just a process preference.
It shapes what kind of architecture remains comprehensible over time.

When a system already spans:
- runtime adapters
- worktrees
- local stores
- dashboard
- coordination roles

then oversized changes can blur:
- real boundaries
- review confidence
- rollback confidence
- ownership of regressions

## What is good here

- The maintainer recognized a good strategic direction.
- The maintainer still protected bounded reviewability.
- The decomposition proposed in the reply maps cleanly to architecture seams.

That is strong architectural taste.

## The deeper lesson

Reviewability is a design property.

If the only way to add a big feature is an 8000-line cross-cutting patch, the architecture is already telling you something:
- either the feature crosses too many seams
- or the seams are not modular enough yet

## Best lesson to steal

Steal:
- explicit stacked landing plans for cross-cutting features
- treating reviewability as part of architecture health

Avoid:
- accepting giant "strategically correct" changes that erase seam visibility
- confusing feature ambition with merge readiness
