# Gastown Verdict

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

## Bottom line

Gastown is:

- very strong as a source of orchestration ideas
- mixed as architecture execution
- weak as a substrate reference

The core pattern repeated throughout the code and issues is:

- strong orchestration concepts
- weak or fragmented foundational contracts underneath them

## Independent rating

| Area | Score |
|---|---:|
| Multi-agent orchestration ideas | 9.4 |
| Coding-agent workflow imagination | 9.0 |
| Engine substrate correctness | 5.6 |
| Operational predictability | 6.1 |
| Cross-platform architecture | 4.2 |
| Recoverability mindset | 7.5 |
| Overall architecture quality | 7.2 |

## The most accurate short summary

Gastown's best ideas are real.

Gastown's pain is also real.

The pain is not random polish debt.
It comes from a few generator-level fault lines:

- Beads asked to carry too much runtime truth
- Dolt/routing/metadata identity complexity
- tmux as part of the control plane
- multiple overlapping startup and runtime contracts
- too many compensating planes for health, env, hooks, and recovery

## What I think is most true

### The strongest statement

Gastown is a smart competitor whose architecture is simultaneously impressive
and overburdened.

### The deepest caution

Do not copy Gastown's substrate.

Copy:

- the ideas
- the role model
- the mail protocol
- the recovery mindset
- the worktree isolation model

Do not copy:

- the truth planes
- the tmux coupling
- the CLI-as-RPC pattern
- the startup/env fragmentation
- the compatibility-heavy migrations

## Where the real value is

Gastown is most valuable as a research target for:

- multi-agent role decomposition
- handoff/mailbox semantics
- coding-swarm workflow design
- recovery-oriented orchestration

It is much less valuable as a reference for:

- stable runtime substrate
- configuration contracts
- identity model design
- clean tool abstraction

## Short comparison to safer competitors

Relative to GoClaw:

- Gastown is more original
- GoClaw is more durable
- Gastown is more conceptually daring
- GoClaw is a better architecture reference

If forced into one sentence:

> Learn from Gastown's imagination, not from its substrate.
