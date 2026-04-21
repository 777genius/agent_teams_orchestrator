import { describe, expect, test } from "bun:test";
import { INTERACTIVE_TOOLS, NATIVE_TEAM_TOOLS } from "../agents/guard-rules.ts";
import { PiRuntime } from "./pi.ts";
import { generatePiGuardExtension } from "./pi-guards.ts";
import type { HooksDef } from "./types.ts";

const WORKTREE = "/project/.overstory/worktrees/test-agent";

function builderHooks(name = "test-builder"): HooksDef {
	return { agentName: name, capability: "builder", worktreePath: WORKTREE };
}

function scoutHooks(name = "test-scout"): HooksDef {
	return { agentName: name, capability: "scout", worktreePath: WORKTREE };
}

function coordinatorHooks(name = "test-coordinator"): HooksDef {
	return { agentName: name, capability: "coordinator", worktreePath: WORKTREE };
}

describe("generatePiGuardExtension", () => {
	describe("header and identity", () => {
		test("embeds agent name in generated code", () => {
			const generated = generatePiGuardExtension(builderHooks("my-builder"));
			expect(generated).toContain('const AGENT_NAME = "my-builder";');
		});

		test("embeds worktree path in generated code", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(`const WORKTREE_PATH = "${WORKTREE}";`);
		});

		test("embeds capability in file header comment", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("Capability: builder");
		});

		test("imports Pi Extension type", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
			);
		});

		test("exports a default Pi Extension factory", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("export default function (pi: ExtensionAPI) {");
			expect(generated).toContain('pi.on("tool_call", async (event) => {');
		});
	});

	describe("TEAM_BLOCKED / INTERACTIVE_BLOCKED — separate sets per category (all capabilities)", () => {
		test("all NATIVE_TEAM_TOOLS appear in TEAM_BLOCKED for builder", () => {
			const generated = generatePiGuardExtension(builderHooks());
			const teamSection = extractTeamBlockedSection(generated);
			for (const tool of NATIVE_TEAM_TOOLS) {
				expect(teamSection).toContain(`"${tool}"`);
			}
		});

		test("all INTERACTIVE_TOOLS appear in INTERACTIVE_BLOCKED for builder", () => {
			const generated = generatePiGuardExtension(builderHooks());
			const interactiveSection = extractInteractiveBlockedSection(generated);
			for (const tool of INTERACTIVE_TOOLS) {
				expect(interactiveSection).toContain(`"${tool}"`);
			}
		});

		test("TEAM_BLOCKED and INTERACTIVE_BLOCKED checks use has() for efficiency", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("TEAM_BLOCKED.has(event.toolName)");
			expect(generated).toContain("INTERACTIVE_BLOCKED.has(event.toolName)");
		});

		test("team tools use delegation block reason", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("Overstory agents must use 'ov sling' for delegation");
		});

		test("interactive tools use human-interaction block reason", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				"requires human interaction — use ov mail (--type question) to escalate",
			);
		});
	});

	describe("Builder — implementation capability", () => {
		test("write tools are NOT in TEAM_BLOCKED or INTERACTIVE_BLOCKED for builder", () => {
			const generated = generatePiGuardExtension(builderHooks());
			const teamSection = extractTeamBlockedSection(generated);
			const interactiveSection = extractInteractiveBlockedSection(generated);
			expect(teamSection).not.toContain('"Write"');
			expect(teamSection).not.toContain('"Edit"');
			expect(teamSection).not.toContain('"NotebookEdit"');
			expect(interactiveSection).not.toContain('"Write"');
			expect(interactiveSection).not.toContain('"Edit"');
			expect(interactiveSection).not.toContain('"NotebookEdit"');
		});

		test("WRITE_BLOCKED constant is absent for builder", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).not.toContain("const WRITE_BLOCKED =");
		});

		test("has FILE_MODIFYING_PATTERNS section", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("FILE_MODIFYING_PATTERNS.some");
		});

		test("has SAFE_PREFIXES array", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("const SAFE_PREFIXES =");
		});

		test("does NOT have DANGEROUS_PATTERNS blocklist guard", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).not.toContain("DANGEROUS_PATTERNS.some");
		});

		test("Bash path boundary check for file-modifying commands", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("FILE_MODIFYING_PATTERNS.some((re) => re.test(cmd))");
			expect(generated).toContain("Bash path boundary violation");
		});

		test("builder Bash path boundary uses + '/' and exact match", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('!p.startsWith(WORKTREE_PATH + "/")');
			expect(generated).toContain("p !== WORKTREE_PATH");
		});

		test("builder does NOT use cmd.trimStart() (no safe prefix check)", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).not.toContain("cmd.trimStart()");
		});
	});

	describe("Scout — non-implementation capability", () => {
		test("write tools ARE in WRITE_BLOCKED for scout", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			const writeSection = extractWriteBlockedSection(generated);
			expect(writeSection).toContain('"Write"');
			expect(writeSection).toContain('"Edit"');
			expect(writeSection).toContain('"NotebookEdit"');
		});

		test("WRITE_BLOCKED uses capability-specific block reason", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("scout agents cannot modify files");
		});

		test("has whitelist+blocklist pattern (SAFE_PREFIXES then DANGEROUS_PATTERNS)", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("SAFE_PREFIXES.some((p) => trimmed.startsWith(p))");
			expect(generated).toContain("DANGEROUS_PATTERNS.some((re) => re.test(cmd))");
		});

		test("safe prefix check uses cmd.trimStart() for leading whitespace tolerance", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("const trimmed = cmd.trimStart();");
			expect(generated).toContain("trimmed.startsWith(p)");
		});

		test("SAFE_PREFIXES check comes before DANGEROUS_PATTERNS check", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			const safeIdx = generated.indexOf("SAFE_PREFIXES.some");
			const dangerIdx = generated.indexOf("DANGEROUS_PATTERNS.some");
			expect(safeIdx).toBeGreaterThan(-1);
			expect(dangerIdx).toBeGreaterThan(-1);
			expect(safeIdx).toBeLessThan(dangerIdx);
		});

		test("does NOT have FILE_MODIFYING_PATTERNS guard", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).not.toContain("FILE_MODIFYING_PATTERNS.some");
		});

		test("block reason references capability name", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("scout agents cannot modify files");
		});
	});

	describe("Coordinator — coordination capability", () => {
		test("safe prefixes include git add and git commit", () => {
			const generated = generatePiGuardExtension(coordinatorHooks());
			const safePrefixesSection = extractSafePrefixesSection(generated);
			expect(safePrefixesSection).toContain('"git add"');
			expect(safePrefixesSection).toContain('"git commit"');
		});

		test("write tools are in WRITE_BLOCKED (coordination is non-implementation)", () => {
			const generated = generatePiGuardExtension(coordinatorHooks());
			const writeSection = extractWriteBlockedSection(generated);
			expect(writeSection).toContain('"Write"');
		});

		test("builder does NOT have git add/commit in safe prefixes", () => {
			const generated = generatePiGuardExtension(builderHooks());
			const safePrefixesSection = extractSafePrefixesSection(generated);
			expect(safePrefixesSection).not.toContain('"git add"');
			expect(safePrefixesSection).not.toContain('"git commit"');
		});
	});

	describe("path boundary guards (all capabilities)", () => {
		test("WRITE_SCOPE_TOOLS constant is always present", () => {
			for (const hooks of [builderHooks(), scoutHooks(), coordinatorHooks()]) {
				const generated = generatePiGuardExtension(hooks);
				expect(generated).toContain(
					'const WRITE_SCOPE_TOOLS = new Set<string>(["write", "edit", "Write", "Edit", "NotebookEdit"]);',
				);
			}
		});

		test("path boundary check uses WORKTREE_PATH + '/' for subpath safety", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('filePath.startsWith(WORKTREE_PATH + "/")');
		});

		test("path boundary allows exact worktree path match", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("filePath !== WORKTREE_PATH");
		});

		test("path boundary checks file_path and notebook_path fields", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("file_path");
			expect(generated).toContain("notebook_path");
		});

		test("path boundary block reason is clear", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				"Path boundary violation: file is outside your assigned worktree",
			);
		});
	});

	describe("universal Bash danger guards (all capabilities)", () => {
		test("blocks git push for builder", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("git push is blocked");
		});

		test("blocks git push for scout", () => {
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("git push is blocked");
		});

		test("blocks git reset --hard", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("git reset --hard is not allowed");
		});

		test("enforces branch naming convention using AGENT_NAME", () => {
			const generated = generatePiGuardExtension(builderHooks("my-agent"));
			// These strings intentionally contain literal ${...} — they appear in the generated code
			// as template literal expressions, not as interpolations in this test file.
			expect(generated).toContain("overstory/$" + "{AGENT_NAME}/");
			expect(generated).toContain(
				"Branch must follow overstory/$" + "{AGENT_NAME}/{task-id} convention",
			);
		});

		test("bash guard matches both Bash and bash tool names", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('event.toolName === "Bash"');
			expect(generated).toContain('event.toolName === "bash"');
		});
	});

	describe("quality gate prefixes", () => {
		test("custom quality gate commands appear in SAFE_PREFIXES", () => {
			const hooks: HooksDef = {
				agentName: "test-reviewer",
				capability: "reviewer",
				worktreePath: WORKTREE,
				qualityGates: [
					{ name: "Tests", command: "bun test", description: "all tests must pass" },
					{ name: "Lint", command: "bun run lint", description: "lint clean" },
				],
			};
			const generated = generatePiGuardExtension(hooks);
			const safePrefixesSection = extractSafePrefixesSection(generated);
			expect(safePrefixesSection).toContain('"bun test"');
			expect(safePrefixesSection).toContain('"bun run lint"');
		});

		test("default quality gates provide SAFE_PREFIXES entries", () => {
			// Without custom gates, DEFAULT_QUALITY_GATES are used
			const generated = generatePiGuardExtension(scoutHooks());
			expect(generated).toContain("const SAFE_PREFIXES =");
			// bun test is the default quality gate command
			const safePrefixesSection = extractSafePrefixesSection(generated);
			expect(safePrefixesSection).toContain('"bun test"');
		});
	});

	describe("generated code is self-contained", () => {
		test("output is non-empty TypeScript string", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(typeof generated).toBe("string");
			expect(generated.length).toBeGreaterThan(500);
		});

		test("output ends with newline", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated.endsWith("\n")).toBe(true);
		});

		test("DANGEROUS_PATTERNS constant is always present", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("const DANGEROUS_PATTERNS =");
		});

		test("FILE_MODIFYING_PATTERNS constant is always present", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("const FILE_MODIFYING_PATTERNS =");
		});

		test("returns { type: 'allow' } as default", () => {
			const generated = generatePiGuardExtension(builderHooks());
			// Pi's ExtensionAPI uses implicit undefined return for allow (no explicit { type: "allow" } needed).
			// The generated code uses a comment marker "// Default: allow." instead.
			expect(generated).toContain("// Default: allow.");
		});

		test("uses String() for safe property access on event.input", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain("String(");
			expect(generated).toContain("event.input as Record<string, unknown>");
		});

		test("deterministic output for same inputs", () => {
			const hooks = builderHooks("consistent-builder");
			const g1 = generatePiGuardExtension(hooks);
			const g2 = generatePiGuardExtension(hooks);
			expect(g1).toBe(g2);
		});
	});

	describe("activity tracking events", () => {
		test('generated code contains pi.on("tool_call", ...)', () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('pi.on("tool_call",');
		});

		test("generated code contains pi.exec ov log tool-start in tool_call handler", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'pi.exec("ov", ["log", "tool-start", "--agent", AGENT_NAME, "--tool-name", event.toolName])',
			);
		});

		test('generated code contains pi.on("tool_execution_end", ...)', () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('pi.on("tool_execution_end",');
		});

		test("generated code contains pi.exec ov log tool-end in tool_execution_end handler", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'pi.exec("ov", ["log", "tool-end", "--agent", AGENT_NAME, "--tool-name", event.toolName])',
			);
		});

		test('generated code contains pi.on("session_shutdown", ...)', () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('pi.on("session_shutdown",');
		});

		test("generated code awaits pi.exec ov log session-end in session_shutdown handler", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'await pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME])',
			);
		});

		test("tool_call handler passes --tool-name event.toolName to tool-start", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'pi.exec("ov", ["log", "tool-start", "--agent", AGENT_NAME, "--tool-name", event.toolName])',
			);
		});

		test("tool_execution_end handler passes --tool-name event.toolName to tool-end", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain(
				'pi.exec("ov", ["log", "tool-end", "--agent", AGENT_NAME, "--tool-name", event.toolName])',
			);
		});

		test("tool_execution_end handler uses named event parameter (not _event)", () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('pi.on("tool_execution_end", async (event) => {');
			expect(generated).not.toContain('pi.on("tool_execution_end", async (_event) => {');
		});

		test('generated code contains pi.on("agent_end", ...)', () => {
			const generated = generatePiGuardExtension(builderHooks());
			expect(generated).toContain('pi.on("agent_end",');
		});

		test("generated code awaits pi.exec ov log session-end in agent_end handler", () => {
			const generated = generatePiGuardExtension(builderHooks());
			// agent_end handler must await (not fire-and-forget) so it completes
			// before Pi moves on, ensuring the SessionStore is updated.
			const agentEndIdx = generated.indexOf('pi.on("agent_end"');
			const sessionShutdownIdx = generated.indexOf('pi.on("session_shutdown"');
			expect(agentEndIdx).toBeGreaterThan(-1);
			expect(sessionShutdownIdx).toBeGreaterThan(-1);
			// agent_end must come before session_shutdown
			expect(agentEndIdx).toBeLessThan(sessionShutdownIdx);
			// Extract the agent_end handler body
			const handlerBody = generated.slice(agentEndIdx, sessionShutdownIdx);
			expect(handlerBody).toContain(
				'await pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME])',
			);
		});

		test("agent_end handler is present for all capabilities", () => {
			for (const hooks of [builderHooks(), scoutHooks(), coordinatorHooks()]) {
				const generated = generatePiGuardExtension(hooks);
				expect(generated).toContain('pi.on("agent_end",');
			}
		});
	});

	describe("PiRuntime integration", () => {
		test("PiRuntime.requiresBeaconVerification() returns false", () => {
			const runtime = new PiRuntime();
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});
});

// --- Helpers ---

/**
 * Extract the TEAM_BLOCKED Set literal section from generated code.
 * Returns the text between "TEAM_BLOCKED = new Set" and the first "]);"
 * after that point.
 */
function extractTeamBlockedSection(generated: string): string {
	const start = generated.indexOf("TEAM_BLOCKED = new Set");
	const end = generated.indexOf("]);", start);
	if (start === -1 || end === -1) return "";
	return generated.slice(start, end + 3);
}

/**
 * Extract the INTERACTIVE_BLOCKED Set literal section from generated code.
 * Returns the text between "INTERACTIVE_BLOCKED = new Set" and the first "]);"
 * after that point.
 */
function extractInteractiveBlockedSection(generated: string): string {
	const start = generated.indexOf("INTERACTIVE_BLOCKED = new Set");
	const end = generated.indexOf("]);", start);
	if (start === -1 || end === -1) return "";
	return generated.slice(start, end + 3);
}

/**
 * Extract the WRITE_BLOCKED Set literal section from generated code.
 * Returns the text between "WRITE_BLOCKED = new Set" and the first "]);"
 * after that point.
 */
function extractWriteBlockedSection(generated: string): string {
	const start = generated.indexOf("WRITE_BLOCKED = new Set");
	const end = generated.indexOf("]);", start);
	if (start === -1 || end === -1) return "";
	return generated.slice(start, end + 3);
}

/**
 * Extract the SAFE_PREFIXES array literal section from generated code.
 * Returns the text between "SAFE_PREFIXES =" and the next "];"
 */
function extractSafePrefixesSection(generated: string): string {
	const start = generated.indexOf("const SAFE_PREFIXES =");
	const end = generated.indexOf("];", start);
	if (start === -1 || end === -1) return "";
	return generated.slice(start, end + 2);
}
