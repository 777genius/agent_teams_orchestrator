# Ecosystem Files And Merge Pollution

## What is strong

### 1. The project recognizes os-eco state as a real category

`🎯 9   🛡️ 8   🧠 4`

Issue and resolver history show that the team treats:
- `.overstory`
- `.seeds`
- `.mulch`
- `.canopy`
- related state files

as a special class of runtime artifacts.

That is the right instinct.

### 2. The team responded with concrete fixes

`🎯 9   🛡️ 8   🧠 4`

Important improvements already landed:
- `#91` - init scaffold commit
- `#90` - per-agent cleanup
- `#89` - auto-resolve no longer silently drops non-conflicting content

That matters because it shows the maintainers are willing to close real workflow scars.

## What is weak

### 1. Runtime state is close enough to code to pollute merge semantics

`🎯 10   🛡️ 9   🧠 5`

This is one of the deepest lessons in `overstory`.

When runtime/ecosystem files live near normal repo content, several things happen:
- init scaffolds can block first merges
- merge resolver has to special-case state files
- canonical vs sub-repo ignore rules can diverge
- state sync becomes part of operational merge semantics

### 2. Split-brain repos amplify pollution

`🎯 9   🛡️ 8   🧠 5`

Issue `#97` comments and issue `#105` are especially revealing:
- root repo and sub-repo may treat `.overstory` / `.seeds` differently
- then state files become neither fully tracked nor fully ignored in a coherent way

That is a strong warning about multi-root orchestration.

### 3. The resolver becomes the janitor partly because of this layer

`🎯 9   🛡️ 8   🧠 4`

Some of the resolver's overload comes from the need to manage ecosystem-file side effects.

## Best practice to steal

`🎯 8   🛡️ 8   🧠 4`

Steal:
- explicit naming and handling of runtime/ecosystem artifacts as a separate category

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban:
- letting orchestration runtime state sit close enough to code that merge semantics have to absorb it as special pollution

## Architect takeaway

**`overstory` teaches a strong negative lesson here: if runtime artifacts live too close to repo truth, merge and cleanup layers eventually become responsible for semantics they should not own.**
