import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrackerClient, resolveBackend, trackerCliName } from "./factory.ts";

describe("createTrackerClient", () => {
	test("creates beads tracker for beads backend", () => {
		const client = createTrackerClient("beads", "/tmp");
		expect(client).toBeDefined();
		expect(client.ready).toBeTypeOf("function");
		expect(client.show).toBeTypeOf("function");
		expect(client.create).toBeTypeOf("function");
		expect(client.claim).toBeTypeOf("function");
		expect(client.close).toBeTypeOf("function");
		expect(client.list).toBeTypeOf("function");
		expect(client.sync).toBeTypeOf("function");
	});

	test("creates seeds tracker for seeds backend", () => {
		const client = createTrackerClient("seeds", "/tmp");
		expect(client).toBeDefined();
		expect(client.ready).toBeTypeOf("function");
		expect(client.show).toBeTypeOf("function");
		expect(client.create).toBeTypeOf("function");
		expect(client.claim).toBeTypeOf("function");
		expect(client.close).toBeTypeOf("function");
		expect(client.list).toBeTypeOf("function");
		expect(client.sync).toBeTypeOf("function");
	});

	test("throws for invalid backend", () => {
		// @ts-expect-error - intentionally testing runtime guard
		expect(() => createTrackerClient("invalid", "/tmp")).toThrow();
	});
});

describe("resolveBackend", () => {
	test("returns beads for beads backend", async () => {
		expect(await resolveBackend("beads", "/tmp")).toBe("beads");
	});
	test("returns seeds for seeds backend", async () => {
		expect(await resolveBackend("seeds", "/tmp")).toBe("seeds");
	});
	test("returns seeds for auto when no tracker dirs exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			expect(await resolveBackend("auto", tempDir)).toBe("seeds");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns seeds for auto when .seeds/ exists", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".seeds"));
			expect(await resolveBackend("auto", tempDir)).toBe("seeds");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns beads for auto when .beads/ exists", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".beads"));
			expect(await resolveBackend("auto", tempDir)).toBe("beads");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns beads for auto when both .seeds/ and .beads/ exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".beads"));
			await mkdir(join(tempDir, ".seeds"));
			expect(await resolveBackend("auto", tempDir)).toBe("beads");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("trackerCliName", () => {
	test("returns bd for beads", () => {
		expect(trackerCliName("beads")).toBe("bd");
	});
	test("returns sd for seeds", () => {
		expect(trackerCliName("seeds")).toBe("sd");
	});
});
