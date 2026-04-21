// OpenCode runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `opencode` CLI (SST OpenCode).
//
// Key differences from Claude/Pi adapters:
// - Uses `opencode` CLI for interactive sessions
// - Instruction file: AGENTS.md (unverified — needs confirmation against real OpenCode install)
// - No hooks: OpenCode does not support Claude Code's hook mechanism
// - detectReady is stubbed: real TUI patterns not yet observed
// - parseTranscript returns null: output format not yet verified

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * OpenCode runtime adapter.
 *
 * Implements AgentRuntime for the `opencode` CLI (SST OpenCode coding agent).
 * Key differences from Claude Code:
 * - Uses `--model` flag for model selection
 * - Instruction file lives at `AGENTS.md` (unverified — confirm against real install)
 * - No hooks deployment (OpenCode has no Claude Code hook mechanism)
 * - `detectReady` is a stub — real TUI ready patterns not yet observed in tmux
 * - `parseTranscript` returns null — `opencode` output format not yet verified
 *
 * TODO: Once a real OpenCode installation is available:
 * 1. Verify `instructionPath` — run `opencode` and check which file it reads
 * 2. Fill in `detectReady` — capture tmux pane content and match actual strings
 * 3. Fill in `parseTranscript` — run `opencode run --format json` and inspect output
 * 4. Fill in `getTranscriptDir` — check where OpenCode writes session files
 */
export class OpenCodeRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "opencode";

	/** Stability level. OpenCode adapter is experimental — not fully validated. */
	readonly stability = "experimental" as const;

	/**
	 * Relative path to the instruction file within a worktree.
	 *
	 * @stub Unverified — `AGENTS.md` is a common convention for terminal coding agents
	 * but has not been confirmed against a real OpenCode installation.
	 * Verify with `opencode --help` or OpenCode documentation before relying on this.
	 */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build the shell command string to spawn an interactive OpenCode agent in a tmux pane.
	 *
	 * Maps SpawnOpts to `opencode` CLI flags:
	 * - `model` → `--model <model>`
	 * - `permissionMode`, `appendSystemPrompt`, `appendSystemPromptFile` are IGNORED —
	 *   the `opencode` CLI has no equivalent flags.
	 *
	 * The `cwd` and `env` fields of SpawnOpts are handled by the tmux session
	 * creator, not embedded in the command string.
	 *
	 * @param opts - Spawn options (model used; others ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		// permissionMode, appendSystemPrompt, appendSystemPromptFile are intentionally ignored.
		// OpenCode has no equivalent flags for these options.
		return `opencode --model ${opts.model}`;
	}

	/**
	 * Build the argv array for a headless one-shot OpenCode invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `--prompt` flag passes
	 * the prompt and `--format json` requests structured JSON output.
	 *
	 * Used by merge/resolver.ts and watchdog/triage.ts for AI-assisted operations.
	 *
	 * @stub `--prompt` and `--format json` flags are unverified against real OpenCode CLI.
	 * Run `opencode --help` to confirm flag names before use in production.
	 *
	 * @param prompt - The prompt to pass via `--prompt`
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["opencode", "--prompt", prompt, "--format", "json"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * For OpenCode this writes only the instruction file:
	 * - `AGENTS.md` — the agent's task-specific overlay.
	 *   Skipped when overlay is undefined.
	 *
	 * The `hooks` parameter is unused — OpenCode does not support Claude Code's
	 * hook mechanism, so no settings file is deployed.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as AGENTS.md, or undefined to skip
	 * @param _hooks - Unused for OpenCode runtime
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), overlay.content);
		}

		// No hook deployment for OpenCode — the runtime has no hook mechanism.
	}

	/**
	 * Detect OpenCode TUI readiness from a tmux pane content snapshot.
	 *
	 * @stub This method always returns `{ phase: "loading" }` because the real
	 * TUI startup strings for OpenCode have not been observed in a live tmux session.
	 * To implement: run `opencode` in tmux, capture pane content at startup, and
	 * match strings unique to the ready state (version header, prompt character,
	 * status bar content, etc.).
	 *
	 * @param _paneContent - Captured tmux pane content (unused until patterns are known)
	 * @returns Always `{ phase: "loading" }` until real patterns are observed
	 */
	detectReady(_paneContent: string): ReadyState {
		// STUB: Real OpenCode TUI ready patterns have not been observed.
		// Fill in once someone runs OpenCode in tmux and captures the pane content.
		return { phase: "loading" };
	}

	/**
	 * Parse an OpenCode session transcript into normalized token usage.
	 *
	 * @stub Returns null unconditionally because the `opencode run --format json`
	 * output format has not been verified. Do NOT guess at the format.
	 * To implement: run `opencode run --format json` against a real OpenCode install,
	 * inspect the NDJSON output, then add parsing logic here.
	 *
	 * @param _path - Path to transcript file (unused until format is known)
	 * @returns Always null until transcript format is verified
	 */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		// STUB: OpenCode transcript format not yet verified.
		// Fill in once `opencode run --format json` output is inspected.
		return null;
	}

	/**
	 * Return the transcript directory for OpenCode sessions.
	 *
	 * @stub Returns null because the location of OpenCode session files has not
	 * been verified. Check where OpenCode writes session/history files
	 * (e.g. `~/.opencode/`, `<project>/.opencode/`, or similar).
	 *
	 * @param _projectRoot - Absolute path to the project root (unused until known)
	 * @returns Always null until transcript location is verified
	 */
	getTranscriptDir(_projectRoot: string): string | null {
		// STUB: OpenCode transcript directory location not yet verified.
		return null;
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 *
	 * Returns the provider environment variables from the resolved model, or an
	 * empty object if none are set.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}
}
