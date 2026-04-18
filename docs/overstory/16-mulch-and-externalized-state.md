# Mulch And Externalized State

## What is interesting

### 1. Externalized knowledge is a first-class primitive

`🎯 9   🛡️ 8   🧠 5`

`ov prime` loads `mulch` expertise.
Overlays tell agents to record learnings back into `mulch`.
Merge resolution can query historical conflict context from `mulch`.

That is not casual enrichment. It is a real memory plane.

### 2. The pattern is genuinely useful

`🎯 9   🛡️ 8   🧠 4`

This gives the system:
- reusable conventions
- past failure knowledge
- merge-history context
- a way to preserve operational learnings outside transient chat

That is much better than pretending every run starts from zero.

### 3. The CLI wrapper is reasonably disciplined

`🎯 8   🛡️ 8   🧠 4`

`src/mulch/client.ts` separates:
- programmatic API for some operations
- CLI spawn wrappers for others
- typed result parsing

This is better than raw shelling out everywhere.

## What is risky

### 1. It can become a hidden second control plane

`🎯 10   🛡️ 8   🧠 5`

Once agents depend on:
- `mulch`
- `seeds`
- `beads`
- emitted prompt artifacts

you no longer have one control plane.

You have:
- code and git history
- plus an externalized workflow memory plane

That can be powerful, but it must stay subordinate to the orchestration core.

### 2. It can normalize healing-via-memory

`🎯 10   🛡️ 8   🧠 4`

Issue `#105` and `#131` both hint at the same smell:
- when runtime gaps are repeatedly healed by better skills, better reminders, and better recorded learnings
- the external memory plane starts compensating for structural weaknesses

That is useful medicine, but it is still medicine.

### 3. Repo churn becomes part of normal life

`🎯 9   🛡️ 8   🧠 4`

The repo's own churn in `.mulch`, `.seeds`, `.beads`, `.overstory` is meaningful.

It shows the project is dogfooding its own externalized state model.

That creates learning, but it can also normalize hidden complexity as "just how the system works".

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal this:
- explicit external memory for reusable expertise
- explicit learn loop from execution back into knowledge

## Anti-pattern to ban

`🎯 10   🛡️ 8   🧠 5`

Ban this:
- letting the knowledge plane become the place where baseline orchestration correctness really lives

## Architect takeaway

**The right lesson from `mulch` is "external memory can be powerful", not "external memory should quietly patch a weak runtime contract".**
