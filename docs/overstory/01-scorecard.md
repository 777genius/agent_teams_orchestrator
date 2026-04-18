# Overstory Scorecard

## Overall ratings

- Architecture: **8.2 / 10**
- Code quality: **7.9 / 10**
- Orchestration engine durability: **7.3 / 10**
- Runtime abstraction quality: **9.0 / 10**
- Operational predictability: **6.3 / 10**
- Maintenance profile: **7.1 / 10**

## By subsystem

| Subsystem | Score | Notes |
|---|---:|---|
| Runtime abstraction | 9.0 | One of the best ideas in the project |
| Local coordination model | 8.1 | Mail, queue, sessions, events are explicit and typed |
| Worktree isolation | 8.6 | Strong default for coding swarms |
| Watchdog / recovery thinking | 8.4 | Mature mindset, though some seams still heuristic |
| Merge model | 7.2 | Explicit queue is good, semantic safety is mixed |
| Prompt / role contract design | 7.0 | Rich, but too much correctness lives in prompts |
| Multi-repo orchestration | 5.8 | Important architectural gaps still visible |
| Runtime parity across adapters | 6.2 | Very uneven maturity across runtimes |
| Security posture | 6.4 | Some good local patterns, but no uniform hard boundary |
| Docs / architectural honesty | 8.8 | `STEELMAN.md` is unusually valuable |

## Relative positioning

| Axis | Overstory | Goclaw | Gastown |
|---|---:|---:|---:|
| Durable orchestration core | 7.3 | 8.9 | 6.4 |
| Runtime abstraction | 9.0 | 6.8 | 6.1 |
| Local coding swarm substrate | 8.5 | 7.2 | 8.0 |
| Operational predictability | 6.3 | 8.2 | 5.8 |
| Architectural imagination | 8.8 | 7.7 | 9.2 |
| Boundary discipline | 6.0 | 5.4 | 5.1 |

## One-line interpretation

**`overstory` is more interesting than its engine maturity alone suggests, because its runtime layer is materially better than most competitors.**
