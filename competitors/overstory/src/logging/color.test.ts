import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// Resolve the project root from this file's location (src/logging/ -> project root)
const projectRoot = join(dirname(import.meta.dir), "..");

describe("color module", () => {
	test("color.red is a function that wraps text", async () => {
		const { color } = await import("./color.ts");
		const result = color.red("hello");
		expect(result).toContain("hello");
		expect(typeof result).toBe("string");
	});

	test("color functions all exist", async () => {
		const { color } = await import("./color.ts");
		const expectedKeys = [
			"bold",
			"dim",
			"red",
			"green",
			"yellow",
			"blue",
			"magenta",
			"cyan",
			"white",
			"gray",
		];
		for (const key of expectedKeys) {
			expect(key in color).toBe(true);
			expect(typeof (color as Record<string, unknown>)[key]).toBe("function");
		}
	});

	test("brand palette functions wrap text", async () => {
		const { brand, accent, muted } = await import("./color.ts");
		const result = brand("Overstory");
		expect(result).toContain("Overstory");
		expect(typeof accent("test")).toBe("string");
		expect(typeof muted("test")).toBe("string");
	});

	test("noColor is an identity function", async () => {
		const { noColor } = await import("./color.ts");
		expect(noColor("hello")).toBe("hello");
		expect(noColor("")).toBe("");
	});

	test("stripAnsi removes escape codes", async () => {
		const { stripAnsi } = await import("./color.ts");
		expect(stripAnsi("\x1b[31mhello\x1b[39m")).toBe("hello");
		expect(stripAnsi("plain")).toBe("plain");
		expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[39m\x1b[22m")).toBe("bold red");
	});

	test("visibleLength excludes ANSI codes", async () => {
		const { visibleLength } = await import("./color.ts");
		expect(visibleLength("\x1b[31mhello\x1b[39m")).toBe(5);
		expect(visibleLength("hello")).toBe(5);
		expect(visibleLength("")).toBe(0);
	});

	test("setQuiet/isQuiet controls quiet mode", async () => {
		const { isQuiet, setQuiet } = await import("./color.ts");
		expect(isQuiet()).toBe(false);
		setQuiet(true);
		expect(isQuiet()).toBe(true);
		setQuiet(false);
		expect(isQuiet()).toBe(false);
	});

	test("NO_COLOR env causes chalk.level to be 0", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import chalk from "chalk"; console.log(JSON.stringify({ level: chalk.level }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.level).toBe(0);
	});

	test("FORCE_COLOR overrides NO_COLOR", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import chalk from "chalk"; console.log(JSON.stringify({ level: chalk.level }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "1" },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.level).toBeGreaterThan(0);
	});

	test("chalk re-export is available", async () => {
		const { chalk } = await import("./color.ts");
		expect(typeof chalk.red).toBe("function");
		expect(chalk.red("test")).toContain("test");
	});

	test("ColorFn type: color functions accept strings and return strings", async () => {
		const { color } = await import("./color.ts");
		// Each color function should accept a string and return a string
		const result = color.bold(color.red("nested"));
		expect(result).toContain("nested");
		expect(typeof result).toBe("string");
	});

	test("printSuccess outputs to stdout with checkmark and message", async () => {
		const { printSuccess, setQuiet } = await import("./color.ts");
		setQuiet(false);
		const logged: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			logged.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			printSuccess("Created issue");
			expect(logged.length).toBe(1);
			expect(logged[0]).toContain("\u2713");
			expect(logged[0]).toContain("Created issue");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("printSuccess includes accent-colored ID when provided", async () => {
		const { printSuccess, setQuiet } = await import("./color.ts");
		setQuiet(false);
		const logged: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			logged.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			printSuccess("Created issue", "seeds-a1b2");
			expect(logged.length).toBe(1);
			expect(logged[0]).toContain("Created issue");
			expect(logged[0]).toContain("seeds-a1b2");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("printWarning outputs to stdout with ! and message and dim hint", async () => {
		const { printWarning, setQuiet } = await import("./color.ts");
		setQuiet(false);
		const logged: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			logged.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			printWarning("3 prompts stale", "run cn emit --all");
			expect(logged.length).toBe(1);
			expect(logged[0]).toContain("!");
			expect(logged[0]).toContain("3 prompts stale");
			expect(logged[0]).toContain("run cn emit --all");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("printError outputs to stderr with cross, message, and dim hint", async () => {
		const { printError } = await import("./color.ts");
		const errored: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			errored.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			printError("Config not found", "run sd init");
			expect(errored.length).toBe(1);
			expect(errored[0]).toContain("\u2717");
			expect(errored[0]).toContain("Config not found");
			expect(errored[0]).toContain("run sd init");
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	test("printHint outputs dim indented text to stdout", async () => {
		const { printHint, setQuiet } = await import("./color.ts");
		setQuiet(false);
		const logged: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			logged.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			printHint("Run without --dry-run");
			expect(logged.length).toBe(1);
			expect(logged[0]).toContain("Run without --dry-run");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("quiet mode suppresses printSuccess, printWarning, printHint but not printError", async () => {
		const { printSuccess, printWarning, printHint, printError, setQuiet } = await import(
			"./color.ts"
		);
		setQuiet(true);
		const logged: string[] = [];
		const errored: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			logged.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			errored.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			printSuccess("suppressed success");
			printWarning("suppressed warning");
			printHint("suppressed hint");
			printError("visible error");
			expect(logged.length).toBe(0);
			expect(errored.length).toBe(1);
			expect(errored[0]).toContain("visible error");
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			setQuiet(false);
		}
	});
});
