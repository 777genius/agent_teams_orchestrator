# Operator Ritual Tax And Setup Honesty

## What is strong

### 1. The project is unusually honest about tradeoffs

`🎯 9   🛡️ 8   🧠 3`

`STEELMAN.md` and issue `#84` are strong cultural signals.

The maintainers do not pretend the system is effortless.

### 2. Dedicated tmux server isolation is a good defensive pattern

`🎯 9   🛡️ 8   🧠 3`

Issue `#84` and PR / issue follow-ups make clear that:
- isolated tmux socket
- predictable shell
- lower personal-config interference

is the right operational direction.

## What is weak

### 1. The system still asks the operator to know too much

`🎯 10   🛡️ 9   🧠 5`

Issue `#84` is one of the most valuable competitor artifacts because it shows the real operator experience:
- shell mismatch
- personal tmux config interference
- bypass dialog false positive
- ecosystem files blocking merge
- manual cleanup gaps

This is classic ritual tax.

### 2. Workarounds accumulate into folklore

`🎯 9   🛡️ 8   🧠 4`

Pre-accept the bypass dialog.
Use a dedicated tmux server.
Commit the scaffold first.
Remember cleanup commands.

Each workaround is understandable.
Together they become insider knowledge.

### 3. Product story is cleaner than operator reality

`🎯 9   🛡️ 8   🧠 4`

The system architecture is coherent.
The setup and first-run reality is still rougher than the product story implies.

## Best practice to steal

`🎯 8   🛡️ 8   🧠 3`

Steal:
- brutally honest operator narratives as architecture input

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban:
- letting repeated operator rituals become the unofficial contract of the system

## Architect takeaway

**`overstory` is strong enough that operator reports expose real edge mechanics, not toy bugs. The lesson is to eliminate ritual tax before it becomes encoded as normal usage.**
