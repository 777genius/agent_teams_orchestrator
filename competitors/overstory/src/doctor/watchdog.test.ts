import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkWatchdog } from "./watchdog.ts";

describe("checkWatchdog", () => {
	let tempDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-watchdog-test-"));
		mockConfig = {
			project: { name: "test", root: tempDir, canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 5,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: true },
			mulch: { enabled: true, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {
				anthropic: { type: "native" },
			},
			watchdog: {
				tier0Enabled: true,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: true },
		};
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("all checks skip when tier0Enabled is false — returns single pass check", async () => {
		mockConfig.watchdog.tier0Enabled = false;
		const checks = await checkWatchdog(mockConfig, tempDir);

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.message).toContain("disabled");
	});

	test("PID file missing — returns warn about daemon not running", async () => {
		const checks = await checkWatchdog(mockConfig, tempDir);

		const pidCheck = checks.find((c) => c.name === "watchdog pid file");
		expect(pidCheck).toBeDefined();
		expect(pidCheck?.status).toBe("warn");
		expect(pidCheck?.message).toContain("PID file not found");
	});

	test("PID file corrupted — returns fail with fixable", async () => {
		writeFileSync(join(tempDir, "watchdog.pid"), "not-a-pid");
		const checks = await checkWatchdog(mockConfig, tempDir);

		const integrityCheck = checks.find((c) => c.name === "watchdog pid integrity");
		expect(integrityCheck).toBeDefined();
		expect(integrityCheck?.status).toBe("fail");
		expect(integrityCheck?.fixable).toBe(true);
		expect(integrityCheck?.details?.some((d) => d.includes("not-a-pid"))).toBe(true);
	});

	test("PID file with valid PID but process not running — returns warn (stale PID)", async () => {
		// PID 999999999 is extremely unlikely to exist
		writeFileSync(join(tempDir, "watchdog.pid"), "999999999");
		const checks = await checkWatchdog(mockConfig, tempDir);

		const processCheck = checks.find((c) => c.name === "watchdog process");
		expect(processCheck).toBeDefined();
		expect(processCheck?.status).toBe("warn");
		expect(processCheck?.message).toContain("stale PID file");
		expect(processCheck?.fixable).toBe(true);
	});

	test("PID file with current process PID — returns pass", async () => {
		writeFileSync(join(tempDir, "watchdog.pid"), String(process.pid));
		const checks = await checkWatchdog(mockConfig, tempDir);

		const processCheck = checks.find((c) => c.name === "watchdog process");
		expect(processCheck).toBeDefined();
		expect(processCheck?.status).toBe("pass");
		expect(processCheck?.message).toContain("running");
	});

	test("PID file older than 24 hours — returns staleness warn", async () => {
		const pidFile = join(tempDir, "watchdog.pid");
		writeFileSync(pidFile, String(process.pid));

		// Set mtime 25 hours ago
		const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await utimes(pidFile, twentyFiveHoursAgo, twentyFiveHoursAgo);

		const checks = await checkWatchdog(mockConfig, tempDir);

		const stalenessCheck = checks.find((c) => c.name === "watchdog pid staleness");
		expect(stalenessCheck).toBeDefined();
		expect(stalenessCheck?.status).toBe("warn");
		expect(stalenessCheck?.message).toContain("older than 24 hours");
		expect(stalenessCheck?.details?.some((d) => d.includes("hours"))).toBe(true);
	});

	test("Tier 2 monitor check skipped when tier2Enabled=false — no monitor check in results", async () => {
		mockConfig.watchdog.tier2Enabled = false;
		writeFileSync(join(tempDir, "watchdog.pid"), String(process.pid));
		const checks = await checkWatchdog(mockConfig, tempDir);

		const monitorCheck = checks.find((c) => c.name === "tier2 monitor");
		expect(monitorCheck).toBeUndefined();
	});

	test("Tier 1 triage check skipped when tier1Enabled=false — no triage check in results", async () => {
		mockConfig.watchdog.tier1Enabled = false;
		writeFileSync(join(tempDir, "watchdog.pid"), String(process.pid));
		const checks = await checkWatchdog(mockConfig, tempDir);

		const triageCheck = checks.find((c) => c.name === "tier1 triage");
		expect(triageCheck).toBeUndefined();
	});

	test("Tier 2 monitor check warns when no monitor session found", async () => {
		mockConfig.watchdog.tier2Enabled = true;
		writeFileSync(join(tempDir, "watchdog.pid"), String(process.pid));
		// No sessions.db or sessions.json — openSessionStore creates empty DB
		const checks = await checkWatchdog(mockConfig, tempDir);

		const monitorCheck = checks.find((c) => c.name === "tier2 monitor");
		expect(monitorCheck).toBeDefined();
		// Either warns about not running or store unavailable — both are acceptable
		expect(monitorCheck?.status).toBe("warn");
	});

	test("Tier 1 triage check does not crash when enabled", async () => {
		mockConfig.watchdog.tier1Enabled = true;
		writeFileSync(join(tempDir, "watchdog.pid"), String(process.pid));
		// getRuntime will succeed (defaults to "claude" which is always registered)
		let checks: Awaited<ReturnType<typeof checkWatchdog>>;
		try {
			checks = await checkWatchdog(mockConfig, tempDir);
		} catch {
			// Should not throw
			expect(false).toBe(true);
			return;
		}

		const triageCheck = checks.find((c) => c.name === "tier1 triage");
		expect(triageCheck).toBeDefined();
		// Either pass or warn — depending on environment; it should not throw
		expect(triageCheck?.status === "pass" || triageCheck?.status === "warn").toBe(true);
	});
});
