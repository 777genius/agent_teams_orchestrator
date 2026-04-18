# GoClaw Strong Decisions

## What is genuinely worth stealing

### 1. Store-backed task lifecycle

This is the single best architectural decision in the project.

### 2. Runtime recovery as a first-class subsystem

Recovery is designed, not improvised.

### 3. Scheduler as an explicit subsystem

Good separation from the rest of runtime.

### 4. Post-turn compensation

Very strong idea.
The engine repairs and finalizes after the agent turn instead of trusting the turn to leave perfect state.

### 5. Rich task model

The status and workflow model is useful and practical.

### 6. Explicit orchestration capability pattern

The idea behind orchestration modes is good even though the execution contract is too soft.

### 7. Willingness to document trap zones

The codebase often names its own danger points in docs and comments.
That is a healthy engineering signal.

### 8. Real fixes, not hand-waving

Many bugs are followed by code and tests, not just issue closure.

### 9. WS edge filtering is more disciplined than average

The outer websocket boundary is not the weakest part.

### 10. Staged pipeline structure

The move toward staged processing is directionally right.

## The right way to steal from GoClaw

Steal:

- lifecycle rigor
- recovery rigor
- scheduler discipline
- post-turn compensation
- boring store-backed truth

Do not steal:

- the context sprawl
- the soft mode semantics
- the split truth between backend and UI
