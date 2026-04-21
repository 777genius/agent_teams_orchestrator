import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import type { SpawnOpts } from "./types.ts";

describe("OpenCodeRuntime", () => {
	const runtime = new OpenCodeRuntime();

	describe("id and instructionPath", () => {
		test("id is 'opencode'", () => {
			expect(runtime.id).toBe("opencode");
		});

		test("instructionPath is AGENTS.md", () => {
			expect(runtime.instructionPath).toBe("AGENTS.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("includes --model flag", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
		});

		test("permissionMode is ignored (opencode has no permission flag)", () => {
			const bypass: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
			};
			const ask: SpawnOpts = { ...bypass, permissionMode: "ask" };
			expect(runtime.buildSpawnCommand(bypass)).toBe("opencode --model opus");
			expect(runtime.buildSpawnCommand(ask)).toBe("opencode --model opus");
		});

		test("appendSystemPrompt is ignored (opencode has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
			expect(cmd).not.toContain("append-system-prompt");
			expect(cmd).not.toContain("You are a builder agent");
		});

		test("appendSystemPromptFile is ignored (opencode has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/specs/task.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model opus");
			expect(cmd).not.toContain("task.md");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { OPENAI_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("OPENAI_API_KEY");
		});

		test("all model names pass through unchanged", () => {
			for (const model of ["sonnet", "opus", "haiku", "gpt-4o", "openrouter/gpt-5"]) {
				const opts: SpawnOpts = {
					model,
					permissionMode: "bypass",
					cwd: "/tmp",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).toContain(`--model ${model}`);
			}
		});

		test("produces identical output for same inputs (deterministic)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			expect(runtime.buildSpawnCommand(opts)).toBe(runtime.buildSpawnCommand(opts));
		});
	});

	describe("buildPrintCommand", () => {
		test("basic command without model includes --prompt and --format json", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["opencode", "--prompt", "Summarize this diff", "--format", "json"]);
		});

		test("command with model override appends --model flag", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual([
				"opencode",
				"--prompt",
				"Classify this error",
				"--format",
				"json",
				"--model",
				"haiku",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
			expect(argv).toContain("--format");
			expect(argv).toContain("json");
		});

		test("prompt is passed verbatim as a single argv element", () => {
			const prompt = "Fix the bug in src/foo.ts line 42";
			const argv = runtime.buildPrintCommand(prompt);
			const promptIdx = argv.indexOf("--prompt");
			expect(promptIdx).toBeGreaterThan(-1);
			expect(argv[promptIdx + 1]).toBe(prompt);
		});
	});

	describe("detectReady (stub)", () => {
		test("returns loading for empty pane", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "loading" });
		});

		test("returns loading for any content (stub always returns loading)", () => {
			expect(runtime.detectReady("OpenCode v1.0\n> ")).toEqual({ phase: "loading" });
			expect(runtime.detectReady("ready")).toEqual({ phase: "loading" });
			expect(runtime.detectReady("opencode started")).toEqual({ phase: "loading" });
		});

		test("never returns dialog phase", () => {
			const state = runtime.detectReady("trust this folder?");
			expect(state.phase).not.toBe("dialog");
		});
	});

	describe("parseTranscript (stub)", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-opencode-transcript-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("returns null for existing file (format not yet verified)", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			await Bun.write(transcriptPath, `${JSON.stringify({ type: "result", tokens: 100 })}\n`);
			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).toBeNull();
		});

		test("returns null for empty file", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");
			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).toBeNull();
		});
	});

	describe("getTranscriptDir (stub)", () => {
		test("returns null (location not yet verified)", () => {
			expect(runtime.getTranscriptDir("/some/project")).toBeNull();
		});

		test("returns null regardless of project root", () => {
			expect(runtime.getTranscriptDir("/home/user/project")).toBeNull();
			expect(runtime.getTranscriptDir("/tmp/test")).toBeNull();
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "gpt-4o",
				env: { OPENAI_API_KEY: "sk-test-123", OPENCODE_API_URL: "https://api.openai.com" },
			};
			expect(runtime.buildEnv(model)).toEqual({
				OPENAI_API_KEY: "sk-test-123",
				OPENCODE_API_URL: "https://api.openai.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("env is safe to spread into session env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			const env = runtime.buildEnv(model);
			const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
			expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-opencode-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to AGENTS.md when provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Instructions\nYou are a builder." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("# Agent Instructions\nYou are a builder.");
		});

		test("creates worktree directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "new-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(true);
		});

		test("skips overlay write when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(false);
		});

		test("does not write settings.local.json (no hook deployment)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const settingsExists = await Bun.file(
				join(worktreePath, ".claude", "settings.local.json"),
			).exists();
			expect(settingsExists).toBe(false);
		});

		test("overwrites existing AGENTS.md", async () => {
			const worktreePath = join(tempDir, "worktree");
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), "old content");

			await runtime.deployConfig(
				worktreePath,
				{ content: "new content" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("new content");
		});
	});
});

describe("OpenCodeRuntime integration: registry resolves 'opencode'", () => {
	test("getRuntime('opencode') returns OpenCodeRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("opencode");
		expect(rt).toBeInstanceOf(OpenCodeRuntime);
		expect(rt.id).toBe("opencode");
		expect(rt.instructionPath).toBe("AGENTS.md");
	});
});
