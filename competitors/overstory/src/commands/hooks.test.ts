/**
 * Tests for overstory hooks install/uninstall/status command.
 *
 * Uses real temp directories and real filesystem (no mocks needed).
 * Each test gets an isolated temp directory with minimal .overstory/
 * and .claude/ scaffolding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { hooksCommand, mergeHooksByEventType } from "./hooks.ts";

let tempDir: string;
const originalCwd = process.cwd();

/** Orchestrator hooks content for .overstory/hooks.json. */
const SAMPLE_HOOKS = {
	hooks: {
		SessionStart: [
			{
				matcher: "",
				hooks: [{ type: "command", command: "ov prime --agent orchestrator" }],
			},
		],
		Stop: [
			{
				matcher: "",
				hooks: [{ type: "command", command: "ov log session-end --agent orchestrator" }],
			},
		],
	},
};

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

beforeEach(async () => {
	process.chdir(originalCwd);
	tempDir = await realpath(await createTempGitRepo());

	// Create minimal .overstory/ with config.yaml
	const overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

describe("hooksCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => hooksCommand(["--help"]));
		expect(output).toContain("hooks");
		expect(output).toContain("install");
		expect(output).toContain("uninstall");
		expect(output).toContain("status");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => hooksCommand([]));
		expect(output).toContain("hooks");
	});

	test("unknown subcommand throws ValidationError", async () => {
		await expect(hooksCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});
});

describe("hooks install", () => {
	test("installs hooks from .overstory/hooks.json to .claude/settings.local.json", async () => {
		// Write source hooks
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		// Verify target file was created
		const targetPath = join(tempDir, ".claude", "settings.local.json");
		const content = await Bun.file(targetPath).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeDefined();
		expect(content).toContain("ov prime");
	});

	test("preserves existing non-hooks keys in settings.local.json", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		// Write existing settings.local.json with non-hooks content
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ env: { SOME_VAR: "1" } }, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeDefined();
		expect(parsed.env).toEqual({ SOME_VAR: "1" });
	});

	test("warns when hooks already exist without --force", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { old: "hooks" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["install"]));
		expect(output).toContain("already present");
		expect(output).toContain("--force");

		// Verify hooks were NOT overwritten
		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		expect(content).toContain("old");
	});

	test("--force merges existing hooks (not overwrites)", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		const existingSettings = {
			hooks: {
				UserInput: [
					{
						matcher: "",
						hooks: [{ type: "command", command: "echo user-hook" }],
					},
				],
			},
		};
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify(existingSettings, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install", "--force"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		// Existing user hook is preserved
		expect(content).toContain("user-hook");
		// Overstory hooks are added
		expect(content).toContain("ov prime");
	});

	test("throws when .overstory/hooks.json does not exist", async () => {
		await expect(hooksCommand(["install"])).rejects.toThrow(ValidationError);
	});

	test("writes JSON with trailing newline", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		const content = await Bun.file(join(tempDir, ".claude", "settings.local.json")).text();
		expect(content.endsWith("\n")).toBe(true);
	});
});

describe("hooks uninstall", () => {
	test("removes hooks-only settings.local.json file entirely", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { some: "hooks" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("Removed");

		const exists = await Bun.file(join(claudeDir, "settings.local.json")).exists();
		expect(exists).toBe(false);
	});

	test("preserves non-hooks keys when uninstalling", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { some: "hooks" }, env: { KEY: "val" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("Removed");

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeUndefined();
		expect(parsed.env).toEqual({ KEY: "val" });
	});

	test("handles missing settings.local.json gracefully", async () => {
		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("nothing to uninstall");
	});

	test("handles settings.local.json with no hooks key", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ env: { KEY: "val" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("No hooks found");
	});
});

describe("hooks install merge behavior", () => {
	test("--force merges overstory hooks into existing user hooks", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		const existingSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Write",
						hooks: [{ type: "command", command: "echo user-write-hook" }],
					},
				],
			},
		};
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify(existingSettings, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install", "--force"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as { hooks: Record<string, unknown[]> };
		// User's PreToolUse hook preserved
		expect(content).toContain("user-write-hook");
		// Overstory's SessionStart hook added
		expect(content).toContain("ov prime");
		// Both event types present
		expect(parsed.hooks.PreToolUse).toBeDefined();
		expect(parsed.hooks.SessionStart).toBeDefined();
	});

	test("--force deduplicates identical entries", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });

		// First install
		await captureStdout(() => hooksCommand(["install"]));

		// Second install with --force (same hooks again)
		await captureStdout(() => hooksCommand(["install", "--force"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as { hooks: Record<string, unknown[]> };

		// SessionStart should have exactly 1 entry (no duplicate)
		expect(parsed.hooks.SessionStart?.length).toBe(1);
		// Stop should have exactly 1 entry (no duplicate)
		expect(parsed.hooks.Stop?.length).toBe(1);
	});

	test("--force preserves existing event types not in source", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		const existingSettings = {
			hooks: {
				Notification: [
					{
						matcher: "",
						hooks: [{ type: "command", command: "echo notification-hook" }],
					},
				],
			},
		};
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify(existingSettings, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install", "--force"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as { hooks: Record<string, unknown[]> };
		// Custom event type preserved
		expect(parsed.hooks.Notification).toBeDefined();
		expect(content).toContain("notification-hook");
		// Overstory hooks also present
		expect(parsed.hooks.SessionStart).toBeDefined();
		expect(parsed.hooks.Stop).toBeDefined();
	});

	test("first install without existing hooks works unchanged", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		const content = await Bun.file(join(tempDir, ".claude", "settings.local.json")).text();
		const parsed = JSON.parse(content) as { hooks: Record<string, unknown[]> };
		expect(parsed.hooks.SessionStart).toBeDefined();
		expect(parsed.hooks.Stop).toBeDefined();
		expect(content).toContain("ov prime");
	});

	describe("mergeHooksByEventType unit tests", () => {
		test("copies existing event types not in incoming", () => {
			const existing = {
				UserInput: [{ matcher: "", hooks: [{ type: "command", command: "echo a" }] }],
			};
			const incoming = {
				SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo b" }] }],
			};
			const result = mergeHooksByEventType(existing, incoming);
			expect(result.UserInput).toBeDefined();
			expect(result.SessionStart).toBeDefined();
		});

		test("appends non-duplicate incoming entries to existing event type", () => {
			const existing = {
				PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo read" }] }],
			};
			const incoming = {
				PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo write" }] }],
			};
			const result = mergeHooksByEventType(existing, incoming);
			expect(result.PreToolUse?.length).toBe(2);
		});

		test("does not add duplicate entries (same matcher + same commands)", () => {
			const entry = { matcher: "", hooks: [{ type: "command", command: "echo dupe" }] };
			const existing = { PreToolUse: [entry] };
			const incoming = { PreToolUse: [entry] };
			const result = mergeHooksByEventType(existing, incoming);
			expect(result.PreToolUse?.length).toBe(1);
		});

		test("adds entry with same matcher but different commands", () => {
			const existing = {
				PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo a" }] }],
			};
			const incoming = {
				PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo b" }] }],
			};
			const result = mergeHooksByEventType(existing, incoming);
			expect(result.PreToolUse?.length).toBe(2);
		});
	});
});

describe("hooks status", () => {
	test("reports source missing when .overstory/hooks.json does not exist", async () => {
		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("missing");
	});

	test("reports installed:false when no hooks in .claude/", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("present");
		expect(output).toContain("no");
		expect(output).toContain("ov hooks install");
	});

	test("reports installed:true when hooks present in .claude/", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: {} }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("yes");
	});

	test("--json outputs correct fields", async () => {
		await Bun.write(
			join(tempDir, ".overstory", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.sourceExists).toBe(true);
		expect(parsed.installed).toBe(false);
	});
});
