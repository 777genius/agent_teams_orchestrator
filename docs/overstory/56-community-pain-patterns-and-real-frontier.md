# Community Pain Patterns and Real Frontier

One of the best ways to understand `overstory` is to look at what kinds of pain are still open.

The open issue list is unusually coherent.
It does not look random.
It points at the real frontier of the project.

## 1. Substrate portability

Open issues:
- `#141` Windows path boundary mismatch
- `#142` tmux coordinator PID retrieval in containerized environments

These are not cosmetic platform bugs.
They are direct expressions of substrate tax:
- path normalization
- tmux assumptions
- shell / environment / container variance

## 2. Role closure and coordination honesty

Open issues:
- `#131` reviewer does not do functional review, lead accepts it, coordinator merges it
- `#134` agent definition refinements around reviewer identity, builder timing, merger mulch, mixed-runtime awareness

This is the clearest open pain cluster.
It confirms that role elegance in prompts and docs is ahead of hard runtime closure.

## 3. Runtime parity and headless future

Open issues:
- `#85` headless spawning transition
- `#138` Cursor hooks
- `#67` graceful degradation and model fallback

These issues show that the runtime seam is strong, but runtime maturity is still uneven.
The frontier is not "do we need an adapter interface?"
The frontier is:
- can all serious runtimes reach headless parity?
- can they degrade safely?
- can capability promises stay honest?

## 4. Cleanup and lifecycle hygiene

Open issue:
- `#132` MCP server processes not terminated on agent session end

This is important because it shows the remaining lifecycle pain has moved into second-order resource cleanup.

That is a good sign in one sense:
- the project is no longer mostly fighting basic "spawn doesn't work" problems

It is also a warning:
- the control plane is rich enough that leaked side-processes are now part of the architectural burden

## 5. Federation and project-root closure

Open / historically important issues:
- `#105` coordinator and sub-agents across parent / subdirectory boundaries

This is the strongest signal that repo-local truth is still the dominant model.
The product can gesture toward broader coordination, but the cleanest stable shape is still local-first.

## 6. Security and sandbox reality

Open issue:
- `#3` sandbox strategy for spawned agents

This is architecturally important because it confirms the repo still treats OS-level isolation as future work, not solved baseline.

## 7. Operator-facing sharp edges

Open issue:
- `#135` `ov init --json` emits human-readable output before JSON payload

This looks small, but it is actually useful.
It shows the project is now mature enough that some open pain is about contract cleanliness at the CLI surface, not just raw orchestration.

## Architect takeaway

The backlog shape says:
- the project has already climbed past "toy swarm" problems
- the remaining pain is concentrated in real architectural seams

That makes `overstory` a serious competitor study.

The real frontier is:
- substrate portability
- role closure
- runtime parity
- cleanup hygiene
- federation honesty
- sandbox reality
