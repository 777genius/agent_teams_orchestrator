# Top Architect Takeaways

## What to copy

- treat orchestration as a concurrent systems problem
- keep graph logic explicit and boring
- give experimental collaboration modes real runtime boundaries
- make recovery and reconciliation first-class
- separate gateway transport, pending results, and provider semantics cleanly
- invest early in runtime observability and operator surface

## What to ban

- using workspace artifacts as permanent primary truth for everything
- subscriber-written event history posing as authoritative log
- poll bridges and file shims quietly becoming core semantics
- letting architectural story outgrow runtime proof
- expanding breadth faster than the truth model hardens

## The sharpest Cortex lesson

Cortex is strongest where it acts like a real runtime.

Cortex is weakest where that runtime is still stitched together by:

- files
- derived projections
- polling
- reconstruction

## Final synthesis

Study Cortex for:

- process architecture
- distributed-mode imagination
- recovery mindset
- subsystem decomposition

Do not copy Cortex as:

- your final truth model
- your final durability model
- your final consistency strategy
