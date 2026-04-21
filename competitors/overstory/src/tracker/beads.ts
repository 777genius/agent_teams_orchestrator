/**
 * Beads tracker adapter.
 *
 * Wraps src/beads/client.ts to implement the unified TrackerClient interface.
 */

import { createBeadsClient } from "../beads/client.ts";
import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Create a TrackerClient backed by the beads (bd) CLI.
 *
 * @param cwd - Working directory for bd commands
 */
export function createBeadsTracker(cwd: string): TrackerClient {
	const client = createBeadsClient(cwd);

	return {
		async ready() {
			const issues = await client.ready();
			return issues as TrackerIssue[];
		},

		async show(id) {
			const issue = await client.show(id);
			return issue as TrackerIssue;
		},

		async create(title, options) {
			return client.create(title, options);
		},

		async claim(id) {
			return client.claim(id);
		},

		async close(id, reason) {
			return client.close(id, reason);
		},

		async list(options) {
			const issues = await client.list(options);
			return issues as TrackerIssue[];
		},

		async sync() {
			const proc = Bun.spawn(["bd", "sync"], { cwd, stdout: "pipe", stderr: "pipe" });
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new AgentError(`bd sync failed (exit ${exitCode}): ${stderr.trim()}`);
			}
		},
	};
}
