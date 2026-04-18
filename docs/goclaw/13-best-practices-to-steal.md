# GoClaw Best Practices to Steal

## Core principle

Do not copy GoClaw broadly.
Copy the parts where they are boring, explicit, and durable.

## 1. Make task lifecycle a real domain model

This is their strongest practice.

Good properties:

- explicit statuses
- explicit transitions
- explicit store methods
- explicit recovery

Why it matters:

- UI becomes simpler
- retries become safer
- operator reasoning becomes easier
- bugs become classifiable

## 2. Treat recovery as a first-class subsystem

GoClaw does not assume that:

- agents always finish cleanly
- locks always expire cleanly
- blocked tasks always unblock cleanly

They built repair into runtime.

This is the right mindset.

## 3. Use post-turn compensation

This is one of the best ideas in the whole codebase.

Do not trust agent turns to leave state perfectly finalized.
Have runtime reconcile after the turn.

This is especially valuable for:

- auto-complete
- auto-fail
- redispatch
- stale marking
- blocked dependency repair

## 4. Keep the core boring and store-backed

Where GoClaw is strongest, it avoids magic.

Good examples:

- tasks in a real store
- lifecycle methods with named intent
- scheduler as a subsystem
- explicit status fields

This is much better than:

- runtime inference
- prompt-only conventions
- UI-derived state

## 5. Separate scheduler from orchestration policy

Their queue core being its own subsystem is a good practice even where the broader admission shell is weaker.

Lesson:

- scheduling primitives should be independent enough to test and reason about directly

## 6. Make capabilities visible at the agent level

Their orchestration-mode idea is good in principle:

- not every agent should see every inter-agent tool

The implementation is softer than ideal, but the practice is still good.

Steal the idea:

- agent capability profile should shape visible orchestration powers

## 7. Build explicit shared-work coordination surfaces

The team task board is a good pattern.
It gives the system:

- a coordination plane
- a review plane
- a debugging plane
- a UI plane

This is better than hiding all collaboration inside plain chat history.

## 8. Document trap zones explicitly

Their `agent-identity-conventions.md` is a very good engineering habit.

Lesson:

- when a seam is dangerous, document the rule next to the codebase
- do not rely only on tribal memory

## 9. Use issue-driven hardening with regression tests

GoClaw does this imperfectly, but there is still a strong good practice here:

- when a seam hurts in production, add tests directly around the failure class

This is healthier than simply closing the issue and moving on.

## 10. Keep multi-tenant isolation a first-class concern

They clearly think in tenant-aware terms in core runtime and store design.

That discipline is worth stealing, even where individual boundaries are still uneven.

## 11. Prefer staged pipelines over giant loops

The move toward a staged pipeline is directionally right.

Benefits:

- better observability
- easier test slicing
- cleaner hook points
- less monolithic growth pressure

## 12. Design for HITL and autonomy together

The review lifecycle, approval flow, and task states show a good product instinct:

- not everything should be full-autonomy
- the engine should support structured human checkpoints

That is the right direction for real orchestration systems.

## 13. Write docs for trap zones, not only happy paths

One of the most underrated strengths in GoClaw is that some of its hardest seams are documented explicitly.

Good examples:

- architecture overview
- agent identity conventions
- changelog entries that explain the seam, not only the fix

This practice is worth stealing because it lowers future architecture drift inside the team.

## 14. Use issue pressure as architecture feedback

GoClaw is useful to study because the maintainers often leave a readable trail:

- issue
- fix
- test
- changelog note

That feedback loop is healthier than pretending the original design was already complete.

## 15. Keep broad product surfaces anchored in one durable core

GoClaw's strongest product decision is not the dashboard or channels.
It is that teams, review, task board, and UI all at least try to orbit a real task state machine.

That is the correct center of gravity.

## Best distilled practices

If I had to pick the top 5:

1. Store-backed task lifecycle
2. Recovery as runtime, not ops folklore
3. Post-turn compensation
4. Capability-aware orchestration surfaces
5. Explicit shared coordination model instead of prompt soup
