/**
 * Tests for the ecosystem doctor check module.
 *
 * We inject a mock spawner instead of using mock.module() to avoid cross-test
 * leakage (see mulch record mx-56558b on why mock.module() is avoided).
 */

import { describe, expect, test } from "bun:test";
import type { OverstoryConfig } from "../types.ts";
import { makeCheckEcosystem, parseSemver } from "./ecosystem.ts";

// ---------------------------------------------------------------------------
// Minimal config fixture
// ---------------------------------------------------------------------------

const mockConfig: OverstoryConfig = {
	project: {
		name: "test-project",
		root: "/tmp/test",
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: "/tmp/.overstory/agent-manifest.json",
		baseDir: "/tmp/.overstory/agents",
		maxConcurrent: 5,
		staggerDelayMs: 1000,
		maxDepth: 2,
		maxSessionsPerRun: 0,
		maxAgentsPerLead: 5,
	},
	worktrees: {
		baseDir: "/tmp/.overstory/worktrees",
	},
	taskTracker: {
		backend: "auto",
		enabled: false,
	},
	mulch: {
		enabled: false,
		domains: [],
		primeFormat: "markdown",
	},
	merge: {
		aiResolveEnabled: false,
		reimagineEnabled: false,
	},
	providers: {
		anthropic: { type: "native" },
	},
	watchdog: {
		tier0Enabled: false,
		tier0IntervalMs: 30000,
		tier1Enabled: false,
		tier2Enabled: false,
		staleThresholdMs: 300000,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
};

// ---------------------------------------------------------------------------
// Mock spawner helpers
// ---------------------------------------------------------------------------

type SpawnResponse = { exitCode: number; stdout: string; stderr: string };

/**
 * Build a mock spawner that dispatches by binary name (first arg).
 */
function makeMockSpawner(responses: Record<string, SpawnResponse>) {
	return async (args: string[]): Promise<SpawnResponse> => {
		const bin = args[0] ?? "";
		return (
			responses[bin] ?? {
				exitCode: 127,
				stdout: "",
				stderr: `${bin}: command not found`,
			}
		);
	};
}

// ---------------------------------------------------------------------------
// parseSemver unit tests
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
	test("extracts bare semver", () => {
		expect(parseSemver("1.2.3")).toBe("1.2.3");
	});

	test("extracts semver from prefixed output", () => {
		expect(parseSemver("mulch v1.0.0")).toBe("1.0.0");
		expect(parseSemver("seeds version 2.3.4")).toBe("2.3.4");
	});

	test("extracts semver with prerelease", () => {
		expect(parseSemver("1.2.3-alpha.1")).toBe("1.2.3-alpha.1");
	});

	test("extracts semver with build metadata", () => {
		expect(parseSemver("1.2.3+build.42")).toBe("1.2.3+build.42");
	});

	test("returns null for non-semver strings", () => {
		expect(parseSemver("not-a-version")).toBeNull();
		expect(parseSemver("")).toBeNull();
		expect(parseSemver("v2.0")).toBeNull();
	});

	test("extracts first semver when multiple exist", () => {
		expect(parseSemver("tool 1.0.0 requires node 18.0.0")).toBe("1.0.0");
	});
});

// ---------------------------------------------------------------------------
// checkEcosystem integration tests
// ---------------------------------------------------------------------------

describe("checkEcosystem", () => {
	test("returns exactly 3 checks (one per tool)", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			sd: { exitCode: 0, stdout: "2.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "3.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		expect(results).toHaveLength(3);
	});

	test("check names match tool names", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			sd: { exitCode: 0, stdout: "2.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "3.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const names = results.map((r) => r.name);
		expect(names).toContain("mulch semver");
		expect(names).toContain("seeds semver");
		expect(names).toContain("canopy semver");
	});

	test("all checks report category 'ecosystem'", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			sd: { exitCode: 0, stdout: "2.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "3.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		for (const r of results) {
			expect(r.category).toBe("ecosystem");
		}
	});

	test("pass when all tools report valid semver", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "mulch v1.2.3\n", stderr: "" },
			sd: { exitCode: 0, stdout: "seeds 0.5.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "0.1.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		for (const r of results) {
			expect(r.status).toBe("pass");
		}
	});

	test("warn when a tool is not available (non-zero exit code)", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 127, stdout: "", stderr: "ml: command not found" },
			sd: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const mulch = results.find((r) => r.name === "mulch semver");
		expect(mulch?.status).toBe("warn");
		expect(mulch?.fixable).toBe(true);
		expect(typeof mulch?.fix).toBe("function");
	});

	test("warn when version output is not valid semver", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "mulch dev-build\n", stderr: "" },
			sd: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const mulch = results.find((r) => r.name === "mulch semver");
		expect(mulch?.status).toBe("warn");
		expect(mulch?.message).toContain("not parseable semver");
		expect(mulch?.fixable).toBe(true);
	});

	test("passing checks include version in message", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "1.2.3\n", stderr: "" },
			sd: { exitCode: 0, stdout: "1.2.3\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.2.3\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		for (const r of results) {
			expect(r.status).toBe("pass");
			expect(r.message).toContain("1.2.3");
		}
	});

	test("passing checks include raw output in details", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "mulch v1.0.0\n", stderr: "" },
			sd: { exitCode: 0, stdout: "seeds 1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const mulch = results.find((r) => r.name === "mulch semver");
		expect(mulch?.details).toContain("mulch v1.0.0");
	});

	test("unavailable tool details include install hint", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 127, stdout: "", stderr: "not found" },
			sd: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const mulch = results.find((r) => r.name === "mulch semver");
		const hasHint = mulch?.details?.some((d) => d.includes("@os-eco/mulch-cli"));
		expect(hasHint).toBe(true);
	});

	test("all checks have required DoctorCheck fields", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			sd: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		for (const r of results) {
			expect(typeof r.name).toBe("string");
			expect(r.name.length).toBeGreaterThan(0);
			expect(r.category).toBe("ecosystem");
			expect(["pass", "warn", "fail"]).toContain(r.status);
			expect(typeof r.message).toBe("string");
		}
	});

	test("failing checks are marked fixable and have a fix closure", async () => {
		const spawner = makeMockSpawner({}); // all tools unavailable
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		for (const r of results) {
			expect(r.status).toBe("warn");
			expect(r.fixable).toBe(true);
			expect(typeof r.fix).toBe("function");
		}
	});

	test("handles version in stderr when stdout is empty", async () => {
		const spawner = makeMockSpawner({
			ml: { exitCode: 0, stdout: "", stderr: "1.0.0" },
			sd: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
			cn: { exitCode: 0, stdout: "1.0.0\n", stderr: "" },
		});
		const check = makeCheckEcosystem(spawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		const mulch = results.find((r) => r.name === "mulch semver");
		expect(mulch?.status).toBe("pass");
	});

	test("handles spawn exception gracefully", async () => {
		const errorSpawner = async (_args: string[]) => {
			throw new Error("spawn failed");
		};
		const check = makeCheckEcosystem(errorSpawner);
		const results = await check(mockConfig, "/tmp/.overstory");

		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(r.status).toBe("warn");
		}
	});
});
