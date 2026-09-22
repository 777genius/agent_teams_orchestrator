# Subtle Risks and Anti-Patterns

The most dangerous risks in `overstory` are not the obvious ones.

The obvious risks are:
- tmux tax
- shell timing
- role softness

The subtler ones are more useful to study because they can slip into a new orchestrator quietly.

## 1. Closure by momentum

The project ships quickly and closes pain points fast.

That is good.
It also creates a subtle risk:
- release velocity can start acting as a hidden stabilizer for unresolved seams

If a system survives partly because painful corners get patched quickly, that is different from those corners being cheap and closed.

## 2. Reference subsystem halo

`overstory` has several genuinely strong subsystems:
- watchdog
- doctor
- `SaplingRuntime`

That creates a risk of overgeneralization.

A reader may subconsciously assume:
- all runtimes are that mature
- all lifecycle seams are that well closed
- all product promises are backed by the same runtime discipline

They are not.

## 3. Repo-local durability mistaken for orchestration completeness

The local stores are strong.

That can make the architecture feel more complete than it is for:
- cross-repo work
- mixed-runtime federation
- graph-level durable continuation

Local durability is real.
Global orchestration closure is still softer.

## 4. Prompt elegance masking contract softness

The prompt and role library is well designed.

That is a strength.
It also makes it easier to miss that:
- review contracts
- coordinator trust
- runtime parity assumptions

are not always equally enforced below the prompt layer.

## 5. Cleanup tooling masking cleanup cost

`ov clean`, `ov stop --clean-worktree`, `doctor`, and session hygiene improvements are real wins.

The subtle risk is that better cleanup tooling can normalize a system that still generates more coordination debris than ideal.

Good cleanup is valuable.
It should not become an excuse for a control plane that leaks too much state.

## Best lesson to steal

Steal:
- awareness of these subtle failure modes
- explicit distinction between local strength and global closure

Avoid:
- assuming strong local observability means strong global orchestration
- letting elegant prompts or good tooling create a false sense of contract maturity
