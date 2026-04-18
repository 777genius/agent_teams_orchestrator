# Agent Definitions And Prompt Contracts

## There is real depth here

The prompt system is not random text files.

Important parts:
- `agents/*.md`
- `docs/canopy-prompt-architecture.md`
- `STEELMAN.md`

This shows `overstory` thinks of prompts as an architectural subsystem.

## Strong decisions

### 1. Canopy prompt inheritance

The inheritance tree is explicit:
- base agent
- worker / coordinator layers
- role-specific prompts
- separate delivery profiles

This is much more disciplined than prompt sprawl.

### 2. Role specialization is explicit

They clearly distinguish:
- scout
- builder
- reviewer
- lead
- coordinator
- orchestrator
- merger
- monitor

That makes their system easier to reason about than many "everyone does everything" swarms.

### 3. STEELMAN is unusually good

`STEELMAN.md` is one of the most valuable documents in the repo.

It openly describes the real failure modes of agent swarms:
- compounding integration errors
- premature decomposition
- merge-time semantic conflicts
- cost amplification
- context fragmentation
- operational risk

That is rare architectural honesty.

## Where the prompt contract is still too soft

### 1. Reviewer / lead / coordinator quality loop is not hard enough

Issue `#131` is the clearest signal:
- reviewer did syntax-level review, not functional review
- lead accepted it
- coordinator merged it

That means role descriptions are not enough. Important policy is still socially enforced by prompts.

### 2. The project sometimes heals architecture with skills and rituals

Issue `#105` is especially revealing:
- `/loop` workaround
- `/dispatch` skill workaround
- mulch learnings to compensate repeat failures

This is clever, but it is also a warning.

When skills and remembered lessons become necessary for baseline correctness, the runtime contract is too weak.

### 3. Mixed-runtime awareness is still incomplete

Issue `#134` points directly at this:
- reviewer identity unclear
- builder timing contract weak
- merger preservation rules incomplete
- lead not fully aware of mixed runtime communication differences

That means the role graph is richer than the currently closed protocol.

## Architect takeaway

**The prompt architecture is a real strength. The mistake would be to mistake it for a sufficient enforcement layer.**
