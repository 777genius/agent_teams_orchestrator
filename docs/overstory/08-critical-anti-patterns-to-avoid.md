# Critical Anti-Patterns To Avoid

## Top anti-patterns

### 1. Substrate-heavy orchestration

`🎯 10   🛡️ 9   🧠 6`

Do not let core correctness depend on:
- tmux pane behavior
- shell startup timing
- path formatting quirks
- container `/tmp` socket assumptions

### 2. Prompts healing architecture

`🎯 10   🛡️ 9   🧠 5`

Do not rely on:
- custom skills
- mulch reminders
- operator prompting tricks

to close baseline orchestration gaps.

### 3. Repo-local coordination truth without explicit federation model

`🎯 9   🛡️ 8   🧠 6`

Issue `#105` is the warning:

If coordination is repo-local by default, then cross-repo orchestration needs an explicit first-class model, not wishful routing.

### 4. Runtime abstraction with uneven capability closure

`🎯 9   🛡️ 8   🧠 5`

Do not advertise runtime symmetry when adapters differ materially in:
- hooks
- transcripts
- readiness
- sandbox
- mail capability
- lifecycle control

### 5. Merge layer that quietly becomes operational janitor

`🎯 9   🛡️ 8   🧠 5`

If merge also:
- auto-commits runtime state
- hides timing windows
- syncs side data

it becomes harder to reason about truth and blame.

### 6. Soft role contracts

`🎯 9   🛡️ 8   🧠 4`

Reviewer, lead, coordinator quality gates cannot remain mostly prompt-social if the system claims trustworthy automation.

### 7. Hook-only security for powerful agents

`🎯 9   🛡️ 8   🧠 5`

Hooks are useful, but they should not be the only serious boundary for many runtimes.

### 8. Aggressive defaults that assume expert operators

`🎯 8   🛡️ 8   🧠 2`

`maxConcurrent: 25` and `shellInitDelayMs: 0` are examples of defaults that create operational debt immediately.

### 9. Closed issues without fully landed capability

`🎯 8   🛡️ 7   🧠 3`

Closed issue `#140` versus current `OpenCodeRuntime` stub is a warning about product/capability drift.

### 10. Runtime state artifacts becoming silent control plane

`🎯 8   🛡️ 7   🧠 4`

When `.mulch`, `.seeds`, `.beads`, `.overstory` churn becomes a normal part of the repo, you risk growing a hidden second control plane around the codebase.
