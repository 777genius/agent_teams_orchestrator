/**
 * Tests for ov discover command.
 *
 * Tests cover the pure functions and command structure.
 * The coordinator session startup is not tested here (requires tmux and
 * external processes). Use dependency injection via DiscoverDeps to test
 * that discoverCommand() delegates correctly.
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "../errors.ts";
import type { CoordinatorSessionOptions } from "./coordinator.ts";
import {
	buildDiscoveryBeacon,
	buildScoutArgs,
	createDiscoverCommand,
	DISCOVERY_CATEGORIES,
	type DiscoverDeps,
	discoverCommand,
	VALID_CATEGORY_NAMES,
} from "./discover.ts";

describe("DISCOVERY_CATEGORIES", () => {
	test("has exactly 6 categories", () => {
		expect(DISCOVERY_CATEGORIES).toHaveLength(6);
	});

	test("each category has name, subject, and body", () => {
		for (const category of DISCOVERY_CATEGORIES) {
			expect(category.name).toBeTruthy();
			expect(category.subject).toBeTruthy();
			expect(category.body).toBeTruthy();
		}
	});

	test("contains all expected category names", () => {
		const names = DISCOVERY_CATEGORIES.map((c) => c.name);
		expect(names).toContain("architecture");
		expect(names).toContain("dependencies");
		expect(names).toContain("testing");
		expect(names).toContain("apis");
		expect(names).toContain("config");
		expect(names).toContain("implicit");
	});
});

describe("VALID_CATEGORY_NAMES", () => {
	test("contains all 6 category names", () => {
		expect(VALID_CATEGORY_NAMES.size).toBe(6);
		expect(VALID_CATEGORY_NAMES.has("architecture")).toBe(true);
		expect(VALID_CATEGORY_NAMES.has("dependencies")).toBe(true);
		expect(VALID_CATEGORY_NAMES.has("testing")).toBe(true);
		expect(VALID_CATEGORY_NAMES.has("apis")).toBe(true);
		expect(VALID_CATEGORY_NAMES.has("config")).toBe(true);
		expect(VALID_CATEGORY_NAMES.has("implicit")).toBe(true);
	});

	test("does not contain invalid category names", () => {
		expect(VALID_CATEGORY_NAMES.has("unknown")).toBe(false);
		expect(VALID_CATEGORY_NAMES.has("")).toBe(false);
	});
});

describe("buildScoutArgs()", () => {
	test("returns correct args array for a category", () => {
		const category = DISCOVERY_CATEGORIES[0];
		if (!category) throw new Error("DISCOVERY_CATEGORIES is empty");
		const args = buildScoutArgs(category, "task-123", "discover-coordinator");
		expect(args).toContain("ov");
		expect(args).toContain("sling");
		expect(args).toContain("task-123");
		expect(args).toContain("--capability");
		expect(args).toContain("scout");
		expect(args).toContain("--name");
		expect(args).toContain(`discover-${category.name}`);
		expect(args).toContain("--profile");
		expect(args).toContain("ov-discovery");
		expect(args).toContain("--parent");
		expect(args).toContain("discover-coordinator");
		expect(args).toContain("--skip-task-check");
	});
});

describe("buildDiscoveryBeacon()", () => {
	test("includes coordinator name", () => {
		const beacon = buildDiscoveryBeacon(DISCOVERY_CATEGORIES, "discover-coordinator");
		expect(beacon).toContain("discover-coordinator");
	});

	test("includes all active category names", () => {
		const beacon = buildDiscoveryBeacon(DISCOVERY_CATEGORIES, "discover-coordinator");
		for (const cat of DISCOVERY_CATEGORIES) {
			expect(beacon).toContain(cat.name);
		}
	});

	test("includes timestamp marker", () => {
		const beacon = buildDiscoveryBeacon(DISCOVERY_CATEGORIES, "discover-coordinator");
		expect(beacon).toContain("[OVERSTORY]");
	});

	test("excludes skipped categories", () => {
		const active = DISCOVERY_CATEGORIES.filter((c) => c.name !== "testing");
		const beacon = buildDiscoveryBeacon(active, "discover-coordinator");
		// All active categories present
		for (const cat of active) {
			expect(beacon).toContain(cat.name);
		}
		// The skipped category body text should not appear as a standalone discovery target
		// (the name "testing" may appear inside other category descriptions, so check body)
		const testingCat = DISCOVERY_CATEGORIES.find((c) => c.name === "testing");
		if (!testingCat) throw new Error("testing category not found");
		expect(beacon).not.toContain(testingCat.body);
	});

	test("includes startup instructions", () => {
		const beacon = buildDiscoveryBeacon(DISCOVERY_CATEGORIES, "discover-coordinator");
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("spawn one lead per");
	});
});

describe("createDiscoverCommand()", () => {
	test("returns a Command with name 'discover'", () => {
		const cmd = createDiscoverCommand();
		expect(cmd.name()).toBe("discover");
	});

	test("has --skip option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--skip");
		expect(option).toBeDefined();
	});

	test("has --name option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--name");
		expect(option).toBeDefined();
	});

	test("has --task-id option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--task-id");
		expect(option).toBeDefined();
	});

	test("has --json option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--json");
		expect(option).toBeDefined();
	});

	test("has --attach option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--attach");
		expect(option).toBeDefined();
	});

	test("has --watchdog option", () => {
		const cmd = createDiscoverCommand();
		const option = cmd.options.find((o) => o.long === "--watchdog");
		expect(option).toBeDefined();
	});

	test("has a description", () => {
		const cmd = createDiscoverCommand();
		expect(cmd.description()).toBeTruthy();
	});
});

describe("discoverCommand() skip validation", () => {
	test("throws ValidationError for invalid category name", async () => {
		await expect(discoverCommand({ skip: "notacategory" })).rejects.toThrow(ValidationError);
	});

	test("throws ValidationError for mixed valid and invalid categories", async () => {
		await expect(discoverCommand({ skip: "architecture,notacategory" })).rejects.toThrow(
			ValidationError,
		);
	});

	test("throws ValidationError when all categories are skipped", async () => {
		const allCategories = DISCOVERY_CATEGORIES.map((c) => c.name).join(",");
		await expect(discoverCommand({ skip: allCategories })).rejects.toThrow(ValidationError);
	});

	test("throws ValidationError with helpful message for invalid category", async () => {
		let thrownError: unknown;
		try {
			await discoverCommand({ skip: "badcategory" });
		} catch (err) {
			thrownError = err;
		}
		expect(thrownError).toBeInstanceOf(ValidationError);
		const ve = thrownError as ValidationError;
		expect(ve.message).toContain("badcategory");
		expect(ve.message).toContain("Valid categories");
	});
});

describe("discoverCommand() delegation", () => {
	test("calls startCoordinatorSession with ov-discovery profile", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ attach: false }, deps);

		expect(capturedOpts).toBeDefined();
		expect(capturedOpts?.profile).toBe("ov-discovery");
	});

	test("uses default coordinator name 'discover-coordinator'", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ attach: false }, deps);

		expect(capturedOpts?.coordinatorName).toBe("discover-coordinator");
	});

	test("uses custom name when provided", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ name: "my-discover", attach: false }, deps);

		expect(capturedOpts?.coordinatorName).toBe("my-discover");
	});

	test("beacon builder returns string containing active category names", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ skip: "testing,config,implicit", attach: false }, deps);

		expect(capturedOpts?.beaconBuilder).toBeDefined();
		const beacon = capturedOpts?.beaconBuilder?.("bd") ?? "";
		expect(beacon).toContain("architecture");
		expect(beacon).toContain("dependencies");
		expect(beacon).toContain("apis");
		// Skipped categories should not appear as category targets in the beacon
		const testingCat = DISCOVERY_CATEGORIES.find((c) => c.name === "testing");
		if (!testingCat) throw new Error("testing category not found");
		expect(beacon).not.toContain(testingCat.body);
	});

	test("sets monitor: false", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ attach: false }, deps);

		expect(capturedOpts?.monitor).toBe(false);
	});

	test("forwards watchdog option", async () => {
		let capturedOpts: CoordinatorSessionOptions | undefined;
		const deps: DiscoverDeps = {
			_startCoordinatorSession: async (opts) => {
				capturedOpts = opts;
			},
		};

		await discoverCommand({ watchdog: true, attach: false }, deps);

		expect(capturedOpts?.watchdog).toBe(true);
	});
});
