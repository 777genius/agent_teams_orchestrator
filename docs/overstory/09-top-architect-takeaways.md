# Top Architect Takeaways

## The big lesson

`overstory` proves that **runtime abstraction can be a first-class orchestration concern**.

It also proves that this does not automatically make the system durable.

## What to emulate

- Treat runtimes as replaceable execution backends
- Keep local coordination durable and inspectable
- Prefer worktree isolation for implementation agents
- Build headless / RPC paths early, not as a late rewrite
- Write architecture docs that openly describe failure modes

## What to ban

- Any correctness path that depends on tmux quirks
- Any role guarantee enforced only by role prompt prose
- Any cross-repo orchestration that lacks explicit root-routing semantics
- Any claim of runtime parity without hard capability matrix closure
- Any security story that assumes prompt guards are enough

## The most useful one-line synthesis

**Take `overstory`'s runtime seam and watchdog taste. Do not take its substrate tax and prompt-mediated correctness.**
