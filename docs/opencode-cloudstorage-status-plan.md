# OpenCode status from macOS File Provider projects — implementation plan

Date: 2026-11-06. Research evidence, not a claim of reproducing the customer's failure.

## Observed failure and root-cause hypothesis

- Agent Teams v2.18.6 launches `claude-multimodel runtime status --json --provider opencode` with `cwd` inside Google Drive's `~/Library/CloudStorage`.
- Packaged runtime delegates this to a Bun 1.4.2 sidecar, preserving `cwd`.
- Bun issue [oven-sh/bun#44606](https://github.com/oven-sh/bun/issues/44606) confirms that `realpath` in this version fails on macOS File Provider directories even when `stat` succeeds. This is a strong hypothesis, not user-machine proof.
- Separate local-model `config-invalid` is already classified more accurately by Agent Teams PR #1114; true macOS privacy denials must remain blocking.

## Decision: explicit project identity, independent of process working directory

1. Extend only `runtime status` with optional `--project-path <absolute-path>`.
2. Validate absolute/non-root project path before reading; never infer project from a launch helper or from `HOME` if explicitly supplied.
3. Pass that path to the existing OpenCode inventory probe and the retained model/auth/readiness check. Keep existing behavior when omitted.
4. Electron invokes the new command for OpenCode preflight from a known-accessible user home (on macOS) while preserving the exact selected project via the argument. Do **not** change other providers' working directories, actual launches, or read permissions.
5. Create regression tests for project selection versus `cwd`, invalid paths, default/backward compatibility, and readiness fail-closed; validate on macOS CI where possible.
6. Release the changed orchestrator as a new pinned bundled runtime, then update `agent-teams-ai/runtime.lock.json` and test Electron packaging. No silent fallback to the old binary.

## Two critical reviews before implementation

**Reliability critic (round 1).** A naïve `cwd = HOME` would silently load the wrong provider/model; rejected. An explicit project parameter must reach `OpenCodeInventoryService.probe` through the existing command and registry. The current `--summary` must remain passive, not proof of readiness.

**Security/compatibility critic (round 2).** Never copy or rewrite customer configuration, relax path permissions, or mark failed status ready. Use argv, not shell-string interpolation; validate absolute/non-root paths and support spaces. Additive CLI flag preserves external callers, and only the OpenCode status path changes behavior.

## Scope estimate and gates

- Runtime CLI/registry: ~15–45 production LOC; focused tests ~40–100 LOC.
- Electron bridge and tests: ~20–45 production LOC and ~50–110 test LOC, in a separate dependent PR.
- Reliability expectation 8/10 after packaged macOS regression, 6/10 without user File Provider machine. A permission-grant prompt still requires macOS/user action.
- Required: own diff review, independent Codex/CodeRabbit review, current-HEAD CI, verified release artifacts and SHA, app lock update, packaged smoke, and guarded PR merges. No bypass of required checks.
