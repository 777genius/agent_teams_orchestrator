/**
 * Beads tracker adapter tests.
 *
 * Uses Bun.spawn mocks — legitimate exception to "never mock what you can use for real".
 * The `bd` CLI may not be installed in all environments and would modify real tracker
 * state (creating/closing actual beads) if invoked directly in tests.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../errors.ts";
import { createBeadsTracker } from "./beads.ts";

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

describe("createBeadsTracker — ready()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns normalized TrackerIssue[] with issue_type → type mapping", async () => {
		const raw = [
			{
				id: "bd-1",
				title: "Fix login",
				status: "open",
				priority: 1,
				issue_type: "bug",
			},
			{
				id: "bd-2",
				title: "Add auth",
				status: "open",
				priority: 2,
				issue_type: "feature",
				assignee: "bob",
			},
		];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ id: "bd-1", title: "Fix login", type: "bug" });
		expect(issues[1]).toMatchObject({ id: "bd-2", type: "feature", assignee: "bob" });
	});

	test("verifies CLI args: [bd, ready, --json]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("[]", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.ready();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "ready", "--json"]);
	});

	test("throws AgentError on non-zero exit code", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "bd: command not found", 1));

		const tracker = createBeadsTracker(TEST_CWD);
		await expect(tracker.ready()).rejects.toThrow(AgentError);
	});
});

describe("createBeadsTracker — show()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns normalized TrackerIssue from bd array response", async () => {
		// bd show --json returns an array with a single element
		const raw = [
			{
				id: "bd-42",
				title: "Critical bug",
				status: "open",
				priority: 1,
				issue_type: "bug",
				description: "Crashes on startup",
				blocks: ["bd-50"],
			},
		];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issue = await tracker.show("bd-42");

		expect(issue).toMatchObject({
			id: "bd-42",
			title: "Critical bug",
			type: "bug",
			description: "Crashes on startup",
			blocks: ["bd-50"],
		});
	});

	test("throws AgentError when bd returns empty array", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("[]", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await expect(tracker.show("bd-99")).rejects.toThrow(AgentError);
	});

	test("verifies CLI args: [bd, show, <id>, --json]", async () => {
		const raw = [{ id: "bd-1", title: "t", status: "open", priority: 1, issue_type: "task" }];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.show("bd-1");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "show", "bd-1", "--json"]);
	});
});

describe("createBeadsTracker — create()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns new issue ID from { id: '...' } response", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify({ id: "bd-101" }), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const id = await tracker.create("New feature");

		expect(id).toBe("bd-101");
	});

	test("verifies CLI args: [bd, create, <title>, --json]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify({ id: "bd-1" }), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.create("My Issue");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd[0]).toBe("bd");
		expect(cmd[1]).toBe("create");
		expect(cmd[2]).toBe("My Issue");
		expect(cmd).toContain("--json");
	});

	test("passes optional --type, --priority, --description args", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify({ id: "bd-200" }), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
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
});

describe("createBeadsTracker — claim()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [bd, update, <id>, --status, in_progress]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.claim("bd-7");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "update", "bd-7", "--status", "in_progress"]);
	});
});

describe("createBeadsTracker — close()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [bd, close, <id>] without reason", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.close("bd-10");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "close", "bd-10"]);
	});

	test("calls [bd, close, <id>, --reason, ...] with reason", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.close("bd-10", "Completed implementation");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "close", "bd-10", "--reason", "Completed implementation"]);
	});
});

describe("createBeadsTracker — list()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns normalized issues from bd array response", async () => {
		const raw = [
			{ id: "bd-1", title: "Task A", status: "open", priority: 1, issue_type: "task" },
			{
				id: "bd-2",
				title: "Bug B",
				status: "in_progress",
				priority: 2,
				issue_type: "bug",
			},
		];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.list();

		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ id: "bd-1", type: "task" });
		expect(issues[1]).toMatchObject({ id: "bd-2", type: "bug", status: "in_progress" });
	});

	test("verifies CLI args: [bd, list, --json]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("[]", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.list();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd[0]).toBe("bd");
		expect(cmd[1]).toBe("list");
		expect(cmd).toContain("--json");
	});

	test("passes --status and --limit options", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("[]", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.list({ status: "open", limit: 5 });

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toContain("--status");
		expect(cmd).toContain("open");
		expect(cmd).toContain("--limit");
		expect(cmd).toContain("5");
	});
});

describe("createBeadsTracker — sync()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [bd, sync] directly (not via beads client)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		await tracker.sync();

		// sync() calls Bun.spawn directly in beads.ts, not via the beads client
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["bd", "sync"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "bd sync failed", 1));

		const tracker = createBeadsTracker(TEST_CWD);
		await expect(tracker.sync()).rejects.toThrow(AgentError);
	});
});

describe("createBeadsTracker — issue_type normalization", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("maps issue_type to type field", async () => {
		const raw = [{ id: "bd-1", title: "t", status: "open", priority: 1, issue_type: "bug" }];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues[0]?.type).toBe("bug");
	});

	test("falls back to type when issue_type absent", async () => {
		const raw = [{ id: "bd-1", title: "t", status: "open", priority: 1, type: "feature" }];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues[0]?.type).toBe("feature");
	});

	test("defaults to 'unknown' when neither issue_type nor type present", async () => {
		const raw = [{ id: "bd-1", title: "t", status: "open", priority: 1 }];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues[0]?.type).toBe("unknown");
	});

	test("prefers issue_type over type when both present", async () => {
		const raw = [
			{
				id: "bd-1",
				title: "t",
				status: "open",
				priority: 1,
				issue_type: "bug",
				type: "feature",
			},
		];
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(raw), "", 0));

		const tracker = createBeadsTracker(TEST_CWD);
		const issues = await tracker.ready();

		expect(issues[0]?.type).toBe("bug");
	});
});

describe("createBeadsTracker — cwd propagation", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("propagates cwd to Bun.spawn for ready()", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("[]", "", 0));

		const customCwd = "/my/project/root";
		const tracker = createBeadsTracker(customCwd);
		await tracker.ready();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const opts = callArgs[1] as { cwd: string };
		expect(opts.cwd).toBe(customCwd);
	});

	test("propagates cwd to Bun.spawn for sync()", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const customCwd = "/my/project/root";
		const tracker = createBeadsTracker(customCwd);
		await tracker.sync();

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const opts = callArgs[1] as { cwd: string };
		expect(opts.cwd).toBe(customCwd);
	});
});
