import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "../types.ts";
import { stripAnsi } from "./color.ts";
import { formatEventLine, numericPriorityColor } from "./format.ts";

// Minimal StoredEvent fixture for testing formatEventLine
const BASE_EVENT: StoredEvent = {
	id: 1,
	runId: "run-001",
	agentName: "agent1",
	sessionId: null,
	eventType: "tool_start",
	level: "info",
	toolName: "bash",
	toolArgs: null,
	toolDurationMs: null,
	data: null,
	createdAt: "2024-01-15T10:30:45.000Z",
};

describe("numericPriorityColor", () => {
	test("returns a function for priority 1", () => {
		const fn = numericPriorityColor(1);
		expect(typeof fn).toBe("function");
		// Function must accept a string and return a string
		expect(typeof fn("x")).toBe("string");
	});

	test("returns a function for priority 2", () => {
		const fn = numericPriorityColor(2);
		expect(typeof fn).toBe("function");
		expect(typeof fn("x")).toBe("string");
	});

	test("priority 3 is identity (returns input unchanged)", () => {
		const fn = numericPriorityColor(3);
		// Priority 3 = normal = (text) => text, always identity regardless of chalk level
		expect(fn("x")).toBe("x");
		expect(fn("hello world")).toBe("hello world");
	});

	test("returns a function for priority 4", () => {
		const fn = numericPriorityColor(4);
		expect(typeof fn).toBe("function");
		expect(typeof fn("x")).toBe("string");
	});

	test("unknown priority returns identity function", () => {
		const fn = numericPriorityColor(99);
		expect(typeof fn).toBe("function");
		expect(fn("x")).toBe("x");
	});

	test("all priority functions preserve input text (visible content after strip)", () => {
		for (const p of [1, 2, 3, 4]) {
			const fn = numericPriorityColor(p);
			expect(stripAnsi(fn("hello"))).toBe("hello");
		}
	});
});

describe("formatEventLine", () => {
	test("returns a non-empty string", () => {
		const colorMap = new Map<string, (t: string) => string>();
		const result = formatEventLine(BASE_EVENT, colorMap);
		expect(result.length).toBeGreaterThan(0);
	});

	test("includes agent name in the result", () => {
		const colorMap = new Map<string, (t: string) => string>();
		const result = formatEventLine(BASE_EVENT, colorMap);
		// Strip ANSI so we can do plain text comparison
		expect(stripAnsi(result)).toContain("agent1");
	});

	test("includes time portion (10:30:45) in the result", () => {
		const colorMap = new Map<string, (t: string) => string>();
		const result = formatEventLine(BASE_EVENT, colorMap);
		expect(stripAnsi(result)).toContain("10:30:45");
	});

	test("result does NOT end with a newline", () => {
		const colorMap = new Map<string, (t: string) => string>();
		const result = formatEventLine(BASE_EVENT, colorMap);
		expect(result.endsWith("\n")).toBe(false);
	});

	test("error level result is a non-empty string", () => {
		const colorMap = new Map<string, (t: string) => string>();
		const errorEvent: StoredEvent = { ...BASE_EVENT, level: "error" };
		const result = formatEventLine(errorEvent, colorMap);
		expect(result.length).toBeGreaterThan(0);
		expect(result.endsWith("\n")).toBe(false);
	});

	test("uses color from colorMap when agent is registered", () => {
		const blueColor = (t: string) => `\x1b[34m${t}\x1b[39m`;
		const colorMap = new Map<string, (t: string) => string>([["agent1", blueColor]]);
		const result = formatEventLine(BASE_EVENT, colorMap);
		// The colored agent name should appear in the output
		expect(result).toContain("\x1b[34m");
	});

	test("falls back to gray when agent is not in colorMap", () => {
		const colorMap = new Map<string, (t: string) => string>();
		// Should not throw — gray fallback is used
		const result = formatEventLine(BASE_EVENT, colorMap);
		expect(result.length).toBeGreaterThan(0);
	});
});
