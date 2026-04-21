# What Gastown Does Very Well

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

## Best ideas

### 1. Real multi-agent role model

Gastown has a serious role system, not just "main agent plus helpers".

The model around:

- Mayor
- Deacon
- Witness
- Refinery
- Polecats
- Crew
- Dogs

is one of the richest role decompositions in this product class.

### 2. Mail is a real protocol

Mail is not decorative.
It is treated as first-class inter-agent infrastructure:

- addressing
- inbox/inbox consumption
- handoff semantics
- task continuity
- explicit agent-to-agent communication

This is one of Gastown's cleanest ideas.

### 3. Worktree-first worker isolation

For coding work, Gastown's instinct is correct:

- worker identity should map to a real isolated workspace
- coding agents should not casually share one mutable checkout

This is one of the strongest practical ideas in the whole repo.

### 4. Scheduler state separation

The idea of separating transient scheduler state from durable work truth is
good and worth keeping in mind even if Gastown's implementation is expensive.

### 5. Recovery mindset is real

Gastown is not pretending agents are reliable.
It assumes:

- crashes
- stalls
- stale work
- orphan state
- partial startup
- broken transport

That is healthier than most competitors.

### 6. The team is self-aware

A very positive sign:

- maintainers clearly see many of the weak seams
- ACP and `factory-worker-api` are real attempts to improve the runtime model
- design docs often acknowledge the current shape honestly

### 7. Mail is still one of the cleanest subsystems

Even after going very deep, mail still looks better than most neighboring
subsystems:

- explicit enough
- conceptually coherent
- easier to reason about than convoy, wisps, or liveness recovery

### 8. Strong coding-workflow imagination

Gastown understands real coding-agent pain:

- handoff continuity
- worktree isolation
- predecessor/resume thinking
- merge/review/rework loops
- persistent worker identity

That is why it remains such a valuable competitor to study.

## Best architectural instincts worth respecting

- explicit handoff model
- explicit inter-agent messaging
- worktree-per-worker thinking
- recovery as a designed concern
- not hiding failure
- trying to move away from tmux-only transport

## What these strengths mean

Gastown is not "bad but popular".

It is:

- thoughtful
- ambitious
- full of genuinely strong ideas

Its problem is not lack of intelligence.
Its problem is that several of its smartest ideas were built on a substrate
too expensive to carry them cleanly.
