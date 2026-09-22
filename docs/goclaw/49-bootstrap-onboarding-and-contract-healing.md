# GoClaw Bootstrap, Onboarding, and Contract Healing

## Why this file exists

GoClaw's bootstrap and onboarding layer is more interesting than it looks.

It contains:

- some genuinely good first-run contract ideas
- several compensating behaviors that keep the product usable
- early signs of contract drift between code, comments, tests, and operator expectations

This makes it a very useful seam to study.

## 1. BOOTSTRAP.md is treated as an explicit first-run contract

This is a good idea.

Instead of hiding onboarding in UI or magical state, GoClaw models first-run onboarding as a concrete context file:

- `BOOTSTRAP.md`

That file is:

- seeded for the user
- loaded into the system prompt
- cleared when onboarding completes

Architect lesson:

- first-run behavior is safer when represented as explicit state, not hidden flags

## 2. Completion is signaled by an actual state transition

Another good decision:

- writing empty content to `BOOTSTRAP.md` deletes the row and marks onboarding complete

That is much better than relying only on memory, hidden booleans, or "the model probably already did it".

Architect lesson:

- onboarding completion should be a real state transition, not just a conversational impression

## 3. They use healing logic when the first-run ritual is not completed cleanly

This is where the system gets more interesting.

GoClaw adds:

- reminder injection if the model did not finish onboarding
- auto-cleanup after enough turns
- a follow-up nudge if `USER.md` is still effectively blank

This is good compensation.
It accepts that the agent may not behave perfectly and tries to repair the user-facing flow.

Architect lesson:

- when the model is responsible for onboarding actions, the runtime needs repair logic around that ritual

## 4. Channel-aware bootstrap skipping is a strong but path-dependent optimization

For at least one channel path, GoClaw can skip interactive bootstrap and pre-fill `USER.md` from channel-provided identity data.

That is clever:

- fewer tokens
- faster onboarding
- less repetitive user friction

But it also creates path-dependent semantics:

- one ingress path gets a different onboarding contract than another

Architect lesson:

- prefilled onboarding is useful, but ingress-specific shortcuts must remain visible in the system model

## 5. Open-agent bootstrap is enforced more honestly than predefined-agent bootstrap

This is a recurring pattern in GoClaw.

For open agents:

- bootstrap narrows the real tool surface

For predefined agents:

- bootstrap relies more on prompt guidance and softer nudges

That is a valid product decision.
But it means those two onboarding modes have different trust boundaries.

Architect lesson:

- neighboring onboarding paths should be reviewed as different security/correctness classes if one is hard-enforced and the other is prompt-guided

## 6. USER.md completeness detection is intentionally simple

The `isUserFilePopulated()` logic is not a full semantic validator.
It mainly checks whether the name field still looks blank.

That is pragmatic.
But it also means:

- a partially filled profile can count as "good enough"
- deeper completeness is still heuristic

Architect lesson:

- onboarding completeness checks should be as simple as possible, but product claims should not assume they are perfect truth

## 7. Comments and tests already show small contract drift

⚠️ This is one of the most useful warning signs.

In the bootstrap seeding layer, comments and tests still describe older file sets more narrowly than the current runtime behavior.

That does not mean the subsystem is broken.
It means the contract is evolving faster than all of its descriptions.

This is exactly how expensive seams start to drift.

Architect lesson:

- onboarding flows need especially strict contract hygiene because comments, templates, prompt copy, tests, and runtime all move together

## 8. Healing logic is useful, but it can hide deeper contract softness

The runtime now does several good healing moves:

- reminder injection
- auto-cleanup
- USER.md follow-up prompts

Those are good operationally.
But they also reveal a deeper fact:

- onboarding correctness still depends partly on prompt obedience

Architect lesson:

- healing logic is good
- but it should not become a substitute for stronger first-run capability contracts

## 9. Bootstrap is one of their clearer examples of "strong center, soft edges"

This seam fits the wider GoClaw pattern very well.

The center is strong:

- explicit onboarding artifact
- explicit cleanup transition
- explicit repair nudges

The edges are softer:

- mode-dependent enforcement
- ingress-specific shortcuts
- comment/test drift
- heuristic profile completeness

Architect lesson:

- even a well-designed explicit bootstrap ritual can still accumulate soft edges around it

## 10. The real reusable lesson

The best thing to steal here is not the literal file names.

It is the structure:

- explicit first-run artifact
- explicit completion transition
- repair logic around model unreliability
- visible operator-facing contract

And the thing to avoid is equally clear:

- letting the healing layer grow until it quietly becomes the real onboarding system

## The distilled lesson

GoClaw shows that bootstrap/onboarding can be modeled as a real state machine, not just chat glue.

That is worth stealing.

But it also shows the rake:

- if prompt guidance, channel shortcuts, auto-cleanup, comments, and tests drift apart, onboarding becomes another soft contract seam
