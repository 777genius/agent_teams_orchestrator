import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import { createMergeQueue } from "./queue.ts";

describe("createMergeQueue", () => {
	let tempDir: string;
	let queuePath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-merge-queue-test-"));
		// The database file should NOT exist initially — createMergeQueue handles this
		queuePath = join(tempDir, "merge-queue.db");
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	function makeInput(
		overrides?: Partial<{
			branchName: string;
			taskId: string;
			agentName: string;
			filesModified: string[];
		}>,
	) {
		return {
			branchName: overrides?.branchName ?? "overstory/test-agent/bead-123",
			taskId: overrides?.taskId ?? "bead-123",
			agentName: overrides?.agentName ?? "test-agent",
			filesModified: overrides?.filesModified ?? ["src/test.ts"],
		};
	}

	describe("enqueue", () => {
		test("adds entry with pending status and null resolvedTier", () => {
			const queue = createMergeQueue(queuePath);
			const entry = queue.enqueue(makeInput());

			expect(entry.status).toBe("pending");
			expect(entry.resolvedTier).toBeNull();
		});

		test("returns the created entry with enqueuedAt timestamp", () => {
			const queue = createMergeQueue(queuePath);
			const before = new Date().toISOString();
			const entry = queue.enqueue(makeInput());
			const after = new Date().toISOString();

			expect(entry.branchName).toBe("overstory/test-agent/bead-123");
			expect(entry.taskId).toBe("bead-123");
			expect(entry.agentName).toBe("test-agent");
			expect(entry.filesModified).toEqual(["src/test.ts"]);
			expect(entry.enqueuedAt).toBeDefined();
			// enqueuedAt should be between before and after
			expect(entry.enqueuedAt >= before).toBe(true);
			expect(entry.enqueuedAt <= after).toBe(true);
		});

		test("preserves all input fields on the returned entry", () => {
			const queue = createMergeQueue(queuePath);
			const input = makeInput({
				branchName: "overstory/builder-1/bead-xyz",
				taskId: "bead-xyz",
				agentName: "builder-1",
				filesModified: ["src/a.ts", "src/b.ts"],
			});

			const entry = queue.enqueue(input);

			expect(entry.branchName).toBe("overstory/builder-1/bead-xyz");
			expect(entry.taskId).toBe("bead-xyz");
			expect(entry.agentName).toBe("builder-1");
			expect(entry.filesModified).toEqual(["src/a.ts", "src/b.ts"]);
		});
	});

	describe("dequeue", () => {
		test("returns first pending entry (FIFO)", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a", taskId: "bead-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b", taskId: "bead-b" }));

			const dequeued = queue.dequeue();

			expect(dequeued).not.toBeNull();
			expect(dequeued?.branchName).toBe("branch-a");
		});

		test("removes the entry from the queue", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));

			queue.dequeue();
			const all = queue.list();

			expect(all).toHaveLength(1);
			expect(all[0]?.branchName).toBe("branch-b");
		});

		test("returns null on empty queue", () => {
			const queue = createMergeQueue(queuePath);
			const result = queue.dequeue();

			expect(result).toBeNull();
		});

		test("skips non-pending entries", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));

			// Mark the first entry as "merging" so it's no longer pending
			queue.updateStatus("branch-a", "merging");

			const dequeued = queue.dequeue();

			expect(dequeued).not.toBeNull();
			expect(dequeued?.branchName).toBe("branch-b");
		});

		test("returns null when all entries are non-pending", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.updateStatus("branch-a", "merged", "clean-merge");

			const result = queue.dequeue();

			expect(result).toBeNull();
		});
	});

	describe("peek", () => {
		test("returns first pending entry without removing it", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));

			const peeked = queue.peek();

			expect(peeked).not.toBeNull();
			expect(peeked?.branchName).toBe("branch-a");

			// Entry should still be in the queue
			const all = queue.list();
			expect(all).toHaveLength(2);
		});

		test("returns null on empty queue", () => {
			const queue = createMergeQueue(queuePath);
			const result = queue.peek();

			expect(result).toBeNull();
		});

		test("skips non-pending entries", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));
			queue.updateStatus("branch-a", "merged", "clean-merge");

			const peeked = queue.peek();

			expect(peeked).not.toBeNull();
			expect(peeked?.branchName).toBe("branch-b");
		});
	});

	describe("list", () => {
		test("returns all entries when called without arguments", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));
			queue.updateStatus("branch-a", "merged", "clean-merge");

			const all = queue.list();

			expect(all).toHaveLength(2);
		});

		test("returns empty array on empty queue", () => {
			const queue = createMergeQueue(queuePath);
			const all = queue.list();

			expect(all).toEqual([]);
		});

		test("filters by status when status argument is provided", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));
			queue.enqueue(makeInput({ branchName: "branch-b" }));
			queue.enqueue(makeInput({ branchName: "branch-c" }));
			queue.updateStatus("branch-a", "merged", "clean-merge");
			queue.updateStatus("branch-b", "failed");

			const pending = queue.list("pending");
			expect(pending).toHaveLength(1);
			expect(pending[0]?.branchName).toBe("branch-c");

			const merged = queue.list("merged");
			expect(merged).toHaveLength(1);
			expect(merged[0]?.branchName).toBe("branch-a");

			const failed = queue.list("failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]?.branchName).toBe("branch-b");
		});
	});

	describe("updateStatus", () => {
		test("changes status of an existing entry", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));

			queue.updateStatus("branch-a", "merging");

			const all = queue.list();
			expect(all[0]?.status).toBe("merging");
			expect(all[0]?.resolvedTier).toBeNull();
		});

		test("changes status and tier when tier is provided", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));

			queue.updateStatus("branch-a", "merged", "auto-resolve");

			const all = queue.list();
			expect(all[0]?.status).toBe("merged");
			expect(all[0]?.resolvedTier).toBe("auto-resolve");
		});

		test("throws MergeError for unknown branch", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));

			expect(() => queue.updateStatus("nonexistent-branch", "merging")).toThrow(MergeError);
		});

		test("MergeError includes the unknown branch name in message", () => {
			const queue = createMergeQueue(queuePath);

			try {
				queue.updateStatus("nonexistent-branch", "merging");
				// Should not reach here
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("nonexistent-branch");
			}
		});
	});

	describe("FIFO ordering", () => {
		test("multiple enqueue/dequeue preserves FIFO order", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "first" }));
			queue.enqueue(makeInput({ branchName: "second" }));
			queue.enqueue(makeInput({ branchName: "third" }));

			const d1 = queue.dequeue();
			const d2 = queue.dequeue();
			const d3 = queue.dequeue();
			const d4 = queue.dequeue();

			expect(d1?.branchName).toBe("first");
			expect(d2?.branchName).toBe("second");
			expect(d3?.branchName).toBe("third");
			expect(d4).toBeNull();
		});

		test("interleaved enqueue and dequeue preserves order", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "first" }));
			queue.enqueue(makeInput({ branchName: "second" }));

			const d1 = queue.dequeue();
			expect(d1?.branchName).toBe("first");

			queue.enqueue(makeInput({ branchName: "third" }));

			const d2 = queue.dequeue();
			expect(d2?.branchName).toBe("second");

			const d3 = queue.dequeue();
			expect(d3?.branchName).toBe("third");
		});
	});

	describe("persistence", () => {
		test("queue survives across separate createMergeQueue calls", () => {
			const queue1 = createMergeQueue(queuePath);
			queue1.enqueue(makeInput({ branchName: "branch-a" }));
			queue1.enqueue(makeInput({ branchName: "branch-b" }));

			// Create a new queue instance pointing at the same file
			const queue2 = createMergeQueue(queuePath);
			const all = queue2.list();

			expect(all).toHaveLength(2);
			expect(all[0]?.branchName).toBe("branch-a");
			expect(all[1]?.branchName).toBe("branch-b");
		});

		test("dequeue from one instance is visible from another", () => {
			const queue1 = createMergeQueue(queuePath);
			queue1.enqueue(makeInput({ branchName: "branch-a" }));
			queue1.enqueue(makeInput({ branchName: "branch-b" }));

			const queue2 = createMergeQueue(queuePath);
			queue2.dequeue();

			const all = queue1.list();
			expect(all).toHaveLength(1);
			expect(all[0]?.branchName).toBe("branch-b");
		});

		test("updateStatus from one instance is visible from another", () => {
			const queue1 = createMergeQueue(queuePath);
			queue1.enqueue(makeInput({ branchName: "branch-a" }));

			const queue2 = createMergeQueue(queuePath);
			queue2.updateStatus("branch-a", "merged", "clean-merge");

			const all = queue1.list();
			expect(all[0]?.status).toBe("merged");
			expect(all[0]?.resolvedTier).toBe("clean-merge");
		});
	});

	describe("bead_id → task_id migration", () => {
		test("renames bead_id column to task_id on existing databases", () => {
			// Create a database with the old bead_id schema
			const db = new Database(queuePath);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec(`
				CREATE TABLE merge_queue (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					branch_name TEXT NOT NULL,
					bead_id TEXT NOT NULL,
					agent_name TEXT NOT NULL,
					files_modified TEXT NOT NULL DEFAULT '[]',
					enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('pending','merging','merged','conflict','failed')),
					resolved_tier TEXT
						CHECK(resolved_tier IS NULL OR resolved_tier IN ('clean-merge','auto-resolve','ai-resolve','reimagine'))
				)
			`);
			db.exec(
				"INSERT INTO merge_queue (branch_name, bead_id, agent_name, files_modified, status, enqueued_at) VALUES ('overstory/test/bead-1', 'bead-1', 'test', '[\"src/a.ts\"]', 'pending', '2026-01-01T00:00:00.000')",
			);
			db.close();

			// Opening with createMergeQueue should migrate and work
			const queue = createMergeQueue(queuePath);
			const entries = queue.list();

			expect(entries).toHaveLength(1);
			expect(entries[0]?.taskId).toBe("bead-1");
			expect(entries[0]?.branchName).toBe("overstory/test/bead-1");

			// New inserts should also work
			const newEntry = queue.enqueue({
				branchName: "overstory/test/bead-2",
				taskId: "bead-2",
				agentName: "test",
				filesModified: ["src/b.ts"],
			});
			expect(newEntry.taskId).toBe("bead-2");

			queue.close();
		});

		test("no-op when task_id column already exists", () => {
			// Create with current schema (has task_id)
			const queue1 = createMergeQueue(queuePath);
			queue1.enqueue({
				branchName: "overstory/test/bead-1",
				taskId: "bead-1",
				agentName: "test",
				filesModified: [],
			});
			queue1.close();

			// Re-opening should not error
			const queue2 = createMergeQueue(queuePath);
			const entries = queue2.list();

			expect(entries).toHaveLength(1);
			expect(entries[0]?.taskId).toBe("bead-1");
			queue2.close();
		});
	});

	describe("close", () => {
		test("closes the database connection", () => {
			const queue = createMergeQueue(queuePath);
			queue.enqueue(makeInput({ branchName: "branch-a" }));

			// Should not throw
			expect(() => queue.close()).not.toThrow();
		});

		test("database can be reopened after close", () => {
			const queue1 = createMergeQueue(queuePath);
			queue1.enqueue(makeInput({ branchName: "branch-a" }));
			queue1.close();

			// Create a new queue instance after closing the first one
			const queue2 = createMergeQueue(queuePath);
			const all = queue2.list();

			expect(all).toHaveLength(1);
			expect(all[0]?.branchName).toBe("branch-a");
			queue2.close();
		});
	});
});
