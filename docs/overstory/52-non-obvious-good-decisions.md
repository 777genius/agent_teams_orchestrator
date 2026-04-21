# Non-Obvious Good Decisions

Some of `overstory`'s best decisions are not the obvious headline features.

They are quieter engineering choices that make the system meaningfully better.

## 1. Reviewability discipline against oversized architecture PRs

Issue `#56` is a strong positive signal.

The proposed multi-repo workspace PR was strategically aligned with the project direction.
The maintainer still rejected it in its current form because it was:
- too large
- too cross-cutting
- too difficult to merge safely in one shot

That is a good sign.

It shows willingness to protect architectural reviewability even when the idea itself is attractive.

## 2. Honest unsupported-mode handling

Issue `#13` is another quiet good decision.

The maintainer explicitly refused to support running the system as `root` in a way that would only create worse hidden failures later.

That is stronger than adding a "make it configurable" escape hatch.

Good systems sometimes need to say:
- this mode is unsupported
- the correct fix is to change the operating environment
- we will improve the error, not pretend the mode is healthy

## 3. Isolated tmux socket per project

The project moved toward `tmux -L overstory` style socket isolation.

That is not glamorous, but it is exactly the kind of substrate-boundary hardening that matters in a tool like this.

It reduces accidental interference between:
- unrelated tmux sessions
- different projects
- overlapping orchestration runs

## 4. Poll-based readiness replacing blind sleeps

Closed PR `#19` is small but architecturally good.

Replacing fixed sleeps with poll-based readiness is the kind of change that:
- reduces flaky startup timing
- makes the substrate less magical
- improves determinism without pretending the substrate disappeared

## 5. Configuration locality with machine-specific overrides

Merged PR `#9` added `config.local.yaml`.

This is a good pattern because it distinguishes:
- shared project truth
- machine-local operator truth

That separation reduces the temptation to encode local environment quirks into shared config.

## 6. Strong local operational tooling

`doctor`, `consistency`, `watchdog`, and explicit cleanup commands are good not just as features.
They show that the project accepts the real cost of its control plane and gives operators tools to reason about it.

That is honest engineering.

## Best lesson to steal

Steal:
- reviewability discipline
- honest unsupported-mode handling
- substrate-boundary hardening
- config locality
- operator tooling that admits real system cost

Avoid:
- accepting giant cross-cutting PRs just because the idea is strategically appealing
- papering over unhealthy runtime modes with more configurability
