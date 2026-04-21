# Prompt Library And Role Contract Honesty

## What is strong

### 1. Prompt architecture is explicit, not ad hoc

`🎯 9   🛡️ 8   🧠 4`

`docs/canopy-prompt-architecture.md` is a strong signal of architectural maturity:
- inheritance tree is documented
- shared sections are explicit
- override map is explicit
- prompt variables are part of the contract

That is much stronger than repos where agent roles are just a few drifting markdown files.

### 2. Base roles and delivery profiles are separated

`🎯 8   🛡️ 8   🧠 3`

The split between:
- agent roles
- delivery / research / architecture profiles

is a good architect move.

It distinguishes:
- who the agent is
- how the session should behave

### 3. Shared failure vocabulary is a real design tool

`🎯 8   🛡️ 8   🧠 3`

Having shared failure-mode language in the prompt stack is useful.
It creates a common language for:
- path boundary violations
- silent failure
- bad completion behavior

That helps keep agent behavior more legible.

## What is weak

### 1. Role closure is softer than the prompt architecture suggests

`🎯 10   🛡️ 9   🧠 5`

The prompt system is more explicit than the runtime contract.

The big warning signs:
- issue `#131` - reviewer functionally under-reviews, lead accepts, coordinator merges
- issue `#134` - reviewer identity, builder timing, mixed-runtime awareness still need refinement
- `agents/reviewer.md` still shares a lot of overall shape with `agents/scout.md`

So the role system is well-described, but not fully sealed.

### 2. Prompt structure can disguise soft enforcement

`🎯 9   🛡️ 8   🧠 4`

When the prompt tree is this clean, it is easy to assume the system has harder behavioral guarantees than it really does.

But many critical behaviors still depend on:
- agent discipline
- lead judgment
- coordinator skepticism

That is not the same thing as runtime enforcement.

### 3. Profiles can become a second control surface

`🎯 8   🛡️ 7   🧠 4`

Profiles are useful, but if they start carrying too much behavioral weight, they can become a soft second control plane around the runtime.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- explicit prompt inheritance map
- shared sections and override table
- separate role prompts from workflow profiles

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban:
- letting clean prompt architecture create the illusion that role contracts are harder than the runtime really enforces

## Architect takeaway

**`overstory` shows that prompt architecture can be explicit and valuable, but role honesty still depends on whether the runtime closes the contract, not how elegant the prompt tree looks.**
