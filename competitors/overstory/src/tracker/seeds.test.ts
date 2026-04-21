/**
 * Seeds tracker adapter tests.
 *
 * Uses Bun.spawn mocks — legitimate exception to "never mock what you can use for real".
 * The `sd` CLI may not be installed in all environments and would modify real tracker
 * state (creating/closing actual issues) if invoked directly in tests.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../errors.ts";
import { createSeedsTracker } from "./seeds.ts";

/**
 * Helper to create a mock Bun.spawn return value.
 *
 * The actual code reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

const TEST_CWD = "/test/repo";

describe("createSeedsTracker — ready()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("parses envelope and returns normalized TrackerIssue[]", async () => {
		const envelope = {
			success: true,
			command: "ready",
			issues: [
				{ id: "sd-1", title: "Fix bug", status: "open", priority: 1, type: "task" },
				{
					id: "sd-2",
					title: "Add feature",
					status: "open",
					priority: 2,
					type: "feature",
					assignee: "alice",
					blocks: ["sd-5"],
				},
			],
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ id: "sd-1", title: "Fix bug", type: "task" });
		expect(issues[1]).toMatchObject({ id: "sd-2", assignee: "alice", blocks: ["sd-5"] });
	});

	test("verifies CLI args: [sd, ready, --json]", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult(JSON.stringify({ success: true, command: "ready", issues: [] }), "", 0),
		);

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.ready();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "ready", "--json"]);
	});

	test("throws AgentError on non-zero exit code", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "sd: command failed", 1));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.ready()).rejects.toThrow(AgentError);
	});

	test("throws AgentError on envelope failure", async () => {
		const envelope = { success: false, command: "ready", error: "no issues available" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.ready()).rejects.toThrow(AgentError);
	});

	test("throws AgentError on empty output", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.ready()).rejects.toThrow(AgentError);
	});
});

describe("createSeedsTracker — show()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns normalized TrackerIssue from envelope", async () => {
		const envelope = {
			success: true,
			command: "show",
			issue: {
				id: "sd-42",
				title: "My issue",
				status: "open",
				priority: 3,
				type: "bug",
				description: "A detailed bug report",
				blockedBy: ["sd-10"],
			},
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const issue = await tracker.show("sd-42");

		expect(issue).toMatchObject({
			id: "sd-42",
			title: "My issue",
			type: "bug",
			description: "A detailed bug report",
			blockedBy: ["sd-10"],
		});
	});

	test("verifies CLI args: [sd, show, <id>, --json]", async () => {
		const envelope = {
			success: true,
			command: "show",
			issue: { id: "sd-1", title: "t", status: "open", priority: 1, type: "task" },
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.show("sd-1");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "show", "sd-1", "--json"]);
	});

	test("throws AgentError on non-zero exit code", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "issue not found", 1));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.show("sd-999")).rejects.toThrow(AgentError);
	});
});

describe("createSeedsTracker — create()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns issue ID from envelope.id", async () => {
		const envelope = { success: true, command: "create", id: "sd-100" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const id = await tracker.create("New issue");

		expect(id).toBe("sd-100");
	});

	test("returns issue ID from envelope.issue.id (alternate format)", async () => {
		const envelope = { success: true, command: "create", issue: { id: "sd-200" } };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const id = await tracker.create("Another issue");

		expect(id).toBe("sd-200");
	});

	test("passes optional --type, --priority, --description args", async () => {
		const envelope = { success: true, command: "create", id: "sd-300" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.create("My task", {
			type: "feature",
			priority: 2,
			description: "A detailed description",
		});

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toContain("--type");
		expect(cmd).toContain("feature");
		expect(cmd).toContain("--priority");
		expect(cmd).toContain("2");
		expect(cmd).toContain("--description");
		expect(cmd).toContain("A detailed description");
	});

	test("throws AgentError when no ID returned in envelope", async () => {
		const envelope = { success: true, command: "create" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.create("No ID")).rejects.toThrow(AgentError);
	});

	test("throws AgentError on envelope failure", async () => {
		const envelope = { success: false, command: "create", error: "validation failed" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.create("Bad issue")).rejects.toThrow(AgentError);
	});
});

describe("createSeedsTracker — claim()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [sd, update, <id>, --status, in_progress]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.claim("sd-5");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "update", "sd-5", "--status", "in_progress"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "issue already claimed", 1));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.claim("sd-5")).rejects.toThrow(AgentError);
	});
});

describe("createSeedsTracker — close()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [sd, close, <id>] without reason", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.close("sd-10");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "close", "sd-10"]);
	});

	test("calls [sd, close, <id>, --reason, ...] with reason", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.close("sd-10", "Done implementing");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "close", "sd-10", "--reason", "Done implementing"]);
	});
});

describe("createSeedsTracker — list()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns normalized issues from envelope", async () => {
		const envelope = {
			success: true,
			command: "list",
			issues: [
				{ id: "sd-1", title: "Issue A", status: "open", priority: 1, type: "task" },
				{ id: "sd-2", title: "Issue B", status: "in_progress", priority: 2, type: "bug" },
			],
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const issues = await tracker.list();

		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ id: "sd-1", status: "open" });
		expect(issues[1]).toMatchObject({ id: "sd-2", status: "in_progress" });
	});

	test("verifies CLI args: [sd, list, --json]", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult(JSON.stringify({ success: true, command: "list", issues: [] }), "", 0),
		);

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.list();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd[0]).toBe("sd");
		expect(cmd[1]).toBe("list");
		expect(cmd).toContain("--json");
	});

	test("passes --status and --limit options", async () => {
		const envelope = { success: true, command: "list", issues: [] };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.list({ status: "open", limit: 10 });

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toContain("--status");
		expect(cmd).toContain("open");
		expect(cmd).toContain("--limit");
		expect(cmd).toContain("10");
	});
});

describe("createSeedsTracker — sync()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [sd, sync]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await tracker.sync();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["sd", "sync"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "sync failed: dirty working tree", 1));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.sync()).rejects.toThrow(AgentError);
	});
});

describe("createSeedsTracker — edge cases", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("strips non-JSON prefix lines before parsing", async () => {
		const envelope = {
			success: true,
			command: "ready",
			issues: [{ id: "sd-1", title: "Test", status: "open", priority: 1, type: "task" }],
		};
		const output = `Syncing with remote...\nDone.\n${JSON.stringify(envelope)}`;
		spawnSpy.mockImplementation(() => mockSpawnResult(output, "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ id: "sd-1" });
	});

	test("throws AgentError on invalid JSON", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("{not: valid json}", "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		await expect(tracker.ready()).rejects.toThrow(AgentError);
	});

	test("handles envelope with missing error field (defaults to 'unknown error')", async () => {
		const envelope = { success: false, command: "ready" }; // No error field
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const tracker = createSeedsTracker(TEST_CWD);
		try {
			await tracker.ready();
			expect(true).toBe(false); // Should have thrown
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("unknown error");
		}
	});

	test("propagates cwd to Bun.spawn", async () => {
		const envelope = { success: true, command: "ready", issues: [] };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(envelope), "", 0));

		const customCwd = "/my/custom/project";
		const tracker = createSeedsTracker(customCwd);
		await tracker.ready();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const opts = callArgs[1] as { cwd: string };
		expect(opts.cwd).toBe(customCwd);
	});
});
