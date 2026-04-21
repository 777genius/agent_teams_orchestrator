/**
 * Seeds tracker adapter.
 *
 * Implements the unified TrackerClient interface by calling the `sd` CLI directly
 * via Bun.spawn. Seeds uses a { success, command, ...data } JSON envelope.
 */

import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Run an sd command and return its output.
 */
async function runSd(
	args: string[],
	cwd: string,
	context: string,
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sd", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new AgentError(`sd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return { stdout, stderr };
}

/**
 * Parse JSON from sd output, stripping any non-JSON prefix lines.
 */
function parseSdJson<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from sd ${context}`);
	}
	// Seeds may emit non-JSON lines before the JSON object; find the first '{' or '['
	const jsonStart = trimmed.search(/[{[]/);
	const jsonStr = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
	try {
		return JSON.parse(jsonStr) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from sd ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/** Base envelope shape shared by all sd JSON responses. */
interface SdEnvelopeBase {
	success: boolean;
	command: string;
	error?: string;
}

/** Seeds JSON envelope for list-style responses. */
interface SdListEnvelope extends SdEnvelopeBase {
	issues: SdRawIssue[];
}

/** Seeds JSON envelope for single-issue responses. */
interface SdShowEnvelope extends SdEnvelopeBase {
	issue: SdRawIssue;
}

/** Seeds JSON envelope for create responses. */
interface SdCreateEnvelope extends SdEnvelopeBase {
	id?: string;
	issue?: { id: string };
}

/**
 * Validate that an sd envelope indicates success.
 * Throws AgentError if the envelope reports failure.
 */
function assertEnvelopeSuccess(envelope: SdEnvelopeBase, context: string): void {
	if (envelope.success === false) {
		const detail = envelope.error ?? "unknown error";
		throw new AgentError(`sd ${context} returned failure: ${detail}`);
	}
}

/** Raw issue shape from the sd CLI. Seeds uses `type` directly (no issue_type mapping). */
interface SdRawIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
}

function normalizeIssue(raw: SdRawIssue): TrackerIssue {
	return {
		id: raw.id,
		title: raw.title,
		status: raw.status,
		priority: raw.priority,
		type: raw.type ?? "unknown",
		assignee: raw.assignee,
		description: raw.description,
		blocks: raw.blocks,
		blockedBy: raw.blockedBy,
	};
}

/**
 * Create a TrackerClient backed by the seeds (sd) CLI.
 *
 * @param cwd - Working directory for sd commands
 */
export function createSeedsTracker(cwd: string): TrackerClient {
	return {
		async ready() {
			const { stdout } = await runSd(["ready", "--json"], cwd, "ready");
			const envelope = parseSdJson<SdListEnvelope>(stdout, "ready");
			assertEnvelopeSuccess(envelope, "ready");
			return envelope.issues.map(normalizeIssue);
		},

		async show(id) {
			const { stdout } = await runSd(["show", id, "--json"], cwd, `show ${id}`);
			const envelope = parseSdJson<SdShowEnvelope>(stdout, `show ${id}`);
			assertEnvelopeSuccess(envelope, `show ${id}`);
			return normalizeIssue(envelope.issue);
		},

		async create(title, options) {
			const args = ["create", "--title", title, "--json"];
			if (options?.type) {
				args.push("--type", options.type);
			}
			if (options?.priority !== undefined) {
				args.push("--priority", String(options.priority));
			}
			if (options?.description) {
				args.push("--description", options.description);
			}
			const { stdout } = await runSd(args, cwd, "create");
			const envelope = parseSdJson<SdCreateEnvelope>(stdout, "create");
			assertEnvelopeSuccess(envelope, "create");
			const id = envelope.id ?? envelope.issue?.id;
			if (!id) {
				throw new AgentError("sd create did not return an issue ID");
			}
			return id;
		},

		async claim(id) {
			await runSd(["update", id, "--status", "in_progress"], cwd, `claim ${id}`);
		},

		async close(id, reason) {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runSd(args, cwd, `close ${id}`);
		},

		async list(options) {
			const args = ["list", "--json"];
			if (options?.status) {
				args.push("--status", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			const { stdout } = await runSd(args, cwd, "list");
			const envelope = parseSdJson<SdListEnvelope>(stdout, "list");
			assertEnvelopeSuccess(envelope, "list");
			return envelope.issues.map(normalizeIssue);
		},

		async sync() {
			await runSd(["sync"], cwd, "sync");
		},
	};
}
