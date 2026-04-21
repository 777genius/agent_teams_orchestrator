# Reference Subsystems Vs Soft Subsystems

## Reference subsystems

These are the parts of `overstory` I would treat as genuine reference material.

### Runtime adapter seam

`🎯 10   🛡️ 9   🧠 5`

One of the strongest architectural ideas in the repo.

### Watchdog observable-truth model

`🎯 10   🛡️ 9   🧠 4`

Strong systems thinking, especially around health authority.

### Worktree-first worker isolation

`🎯 9   🛡️ 8   🧠 4`

Still one of the better containment choices in this competitor set.

### Local durable store plane

`🎯 9   🛡️ 8   🧠 4`

Mail, sessions, events, merge queue, metrics are all real subsystems.

### Cleanup and repair surfaces

`🎯 8   🛡️ 8   🧠 4`

Increasingly mature and operationally useful.

## Soft subsystems

These are the parts where the repo is interesting, but not yet reference-grade.

### Role contracts

`🎯 10   🛡️ 9   🧠 5`

Well-described, not fully sealed.

### Cross-repo orchestration

`🎯 10   🛡️ 9   🧠 6`

Important ambition, not yet closed.

### Runtime parity

`🎯 9   🛡️ 8   🧠 5`

Strong seam, uneven implementations.

### Dashboard freshness model

`🎯 9   🛡️ 8   🧠 4`

Useful and pragmatic, but layered and soft.

### Ecosystem-state merge semantics

`🎯 9   🛡️ 8   🧠 5`

Handled thoughtfully, but still a sign of architectural strain.

## Architect takeaway

**The right way to study `overstory` is to separate its reference subsystems from its soft subsystems. Its best value is not “copy everything”, but “copy the hard center and treat the softer layers as active warnings”.**
