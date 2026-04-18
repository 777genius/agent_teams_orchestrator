import { afterEach, describe, expect, test } from "bun:test";
import { getConnection, removeConnection, setConnection } from "./connections.ts";
import type { ConnectionState, RuntimeConnection } from "./types.ts";

/** Minimal RuntimeConnection stub for testing the registry. */
function makeConn(onClose?: () => void): RuntimeConnection {
	return {
		sendPrompt: async (_text: string) => {},
		followUp: async (_text: string) => {},
		abort: async () => {},
		getState: async (): Promise<ConnectionState> => ({ status: "idle" }),
		close: () => {
			if (onClose) onClose();
		},
	};
}

describe("connection registry", () => {
	// Reset registry between tests by removing any entries set during each test.
	// We track names used so we can clean up without affecting other entries.
	const usedNames: string[] = [];

	afterEach(() => {
		for (const name of usedNames.splice(0)) {
			const conn = getConnection(name);
			if (conn) {
				removeConnection(name);
			}
		}
	});

	test("set and get returns the registered connection", () => {
		const conn = makeConn();
		usedNames.push("agent-alpha");
		setConnection("agent-alpha", conn);
		expect(getConnection("agent-alpha")).toBe(conn);
	});

	test("get unknown returns undefined", () => {
		expect(getConnection("does-not-exist-xyz")).toBeUndefined();
	});

	test("removeConnection calls close() on the connection", () => {
		let closed = false;
		const conn = makeConn(() => {
			closed = true;
		});
		usedNames.push("agent-beta");
		setConnection("agent-beta", conn);
		removeConnection("agent-beta");
		expect(closed).toBe(true);
	});

	test("removeConnection deletes the entry (get returns undefined after)", () => {
		const conn = makeConn();
		usedNames.push("agent-gamma");
		setConnection("agent-gamma", conn);
		removeConnection("agent-gamma");
		expect(getConnection("agent-gamma")).toBeUndefined();
	});

	test("removeConnection on unknown name is a no-op (does not throw)", () => {
		expect(() => removeConnection("never-registered-xyz")).not.toThrow();
	});

	test("setConnection overwrites an existing entry", () => {
		const conn1 = makeConn();
		const conn2 = makeConn();
		usedNames.push("agent-delta");
		setConnection("agent-delta", conn1);
		setConnection("agent-delta", conn2);
		expect(getConnection("agent-delta")).toBe(conn2);
	});
});
