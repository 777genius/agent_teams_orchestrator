import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { jsonError, jsonOutput } from "./json.ts";

describe("jsonOutput", () => {
	let written: string[] = [];
	let writeSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		written = [];
		writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	test("writes success envelope to stdout", () => {
		jsonOutput("status", { agents: [] });
		expect(written).toEqual(['{"success":true,"command":"status","agents":[]}\n']);
	});

	test("spreads data properties into top-level envelope", () => {
		jsonOutput("agents discover", { count: 3, names: ["a", "b", "c"] });
		const parsed = JSON.parse(written[0] ?? "{}");
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("agents discover");
		expect(parsed.count).toBe(3);
		expect(parsed.names).toEqual(["a", "b", "c"]);
		// Data is NOT nested under a "data" key
		expect(parsed.data).toBeUndefined();
	});

	test("produces single-line JSON (no pretty printing)", () => {
		jsonOutput("status", { agents: [] });
		const line = written[0] ?? "";
		expect(line).not.toContain("\n\t");
		expect(line.trimEnd()).toBe('{"success":true,"command":"status","agents":[]}');
	});
});

describe("jsonError", () => {
	let written: string[] = [];
	let writeSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		written = [];
		writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	test("writes error envelope to stdout", () => {
		jsonError("status", "no config");
		expect(written).toEqual(['{"success":false,"command":"status","error":"no config"}\n']);
	});

	test("writes to stdout not stderr", () => {
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		jsonError("mail send", "connection failed");
		expect(written.length).toBe(1);
		expect(stderrSpy).not.toHaveBeenCalled();
		stderrSpy.mockRestore();
	});
});
