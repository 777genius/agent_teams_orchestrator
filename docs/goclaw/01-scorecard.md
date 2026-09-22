# GoClaw Scorecard

## Deep scorecard

| Subsystem | Score / 10 | Verdict |
|---|---:|---|
| Team task lifecycle engine | 9.4 | Very strong |
| Recovery and stale handling | 9.3 | Very strong |
| Scheduler and queue semantics | 9.1 | Strong |
| Pipeline decomposition | 8.7 | Strong |
| Team-task persistence model | 9.0 | Strong |
| Post-turn compensating runtime | 8.8 | Strong |
| Subagent runtime model | 7.2 | Feature-rich but materially less durable |
| Workspace model concept | 8.0 | Good concept |
| Workspace implementation on edge cases | 6.2 | Fragile |
| Policy and permissions power | 8.4 | Powerful |
| Policy clarity and explainability | 5.9 | Weak |
| Gateway auth / RBAC posture | 6.2 | Improved, but still permissive in key defaults |
| Context propagation model | 5.6 | Weak |
| Prompt/runtime contract discipline | 7.4 | Thoughtful, but partly prompt-mediated |
| Event topology / WS delivery model | 5.8 | Split and bridge-heavy |
| Realtime/UI event dataflow | 6.1 | Weak |
| Package coupling / bounded contexts | 6.4 | Mixed |
| Provider stream error surfacing | 5.7 | Fragile adapters |
| Product consistency and docs coherence | 6.0 | Mixed to weak |
| Core test confidence | 8.3 | Strong in core, uneven overall |

## Read this scorecard correctly

The most important split is:

- **inner engine**: mostly good
- **outer seam discipline**: noticeably weaker

If you average everything together, you hide the real shape of the system.

## Better mental grouping

### Strong

- task engine
- recovery
- scheduler core
- persistence model
- staged pipeline

### Mixed

- subagents
- workspace
- package boundaries
- prompt/runtime discipline
- docs/product coherence

### Weak

- context propagation
- auth/policy clarity
- event topology
- UI/realtime synchronization
- provider run-truth boundary
