/**
 * CLI command: ov errors [--agent <name>] [--run <id>] [--json] [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows aggregated error-level events across all agents.
 * Errors can be filtered by agent name, run ID, or time range.
 * Human output groups errors by agent; JSON output returns a flat array.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import { buildEventDetail, formatAbsoluteTime, formatDate } from "../logging/format.ts";
import { separator } from "../logging/theme.ts";
import type { StoredEvent } from "../types.ts";

/**
 * Group errors by agent name, preserving insertion order.
 */
function groupByAgent(events: StoredEvent[]): Map<string, StoredEvent[]> {
	const groups = new Map<string, StoredEvent[]>();
	for (const event of events) {
		const existing = groups.get(event.agentName);
		if (existing) {
			existing.push(event);
		} else {
			groups.set(event.agentName, [event]);
		}
	}
	return groups;
}

/**
 * Print errors grouped by agent with ANSI colors.
 */
function printErrors(events: StoredEvent[]): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold(color.red("Errors"))}\n${separator()}\n`);

	if (events.length === 0) {
		w(`${color.dim("No errors found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} error${events.length === 1 ? "" : "s"}`)}\n\n`);

	const grouped = groupByAgent(events);

	let firstGroup = true;
	for (const [agentName, agentEvents] of grouped) {
		if (!firstGroup) {
			w("\n");
		}
		firstGroup = false;

		w(
			`${accent(agentName)} ${color.dim(`(${agentEvents.length} error${agentEvents.length === 1 ? "" : "s"})`)}\n`,
		);

		for (const event of agentEvents) {
			const date = formatDate(event.createdAt);
			const time = formatAbsoluteTime(event.createdAt);
			const timestamp = date ? `${date} ${time}` : time;

			const detail = buildEventDetail(event);
			const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

			w(`  ${color.dim(timestamp)} ${color.red(color.bold("ERROR"))}${detailSuffix}\n`);
		}
	}
}

interface ErrorsOpts {
	agent?: string;
	run?: string;
	since?: string;
	until?: string;
	limit?: string;
	json?: boolean;
}

async function executeErrors(opts: ErrorsOpts): Promise<void> {
	const json = opts.json ?? false;
	const agentName = opts.agent;
	const runId = opts.run;
	const sinceStr = opts.since;
	const untilStr = opts.until;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	// Validate timestamps if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}
	if (untilStr !== undefined && Number.isNaN(new Date(untilStr).getTime())) {
		throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
			field: "until",
			value: untilStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Open event store
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			jsonOutput("errors", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		const queryOpts = {
			since: sinceStr,
			until: untilStr,
			limit,
		};

		let events: StoredEvent[];

		if (agentName !== undefined) {
			// Filter by agent: use getByAgent with level filter
			events = eventStore.getByAgent(agentName, { ...queryOpts, level: "error" });
		} else if (runId !== undefined) {
			// Filter by run: use getByRun with level filter
			events = eventStore.getByRun(runId, { ...queryOpts, level: "error" });
		} else {
			// Global errors: use getErrors (already filters level='error')
			events = eventStore.getErrors(queryOpts);
		}

		if (json) {
			jsonOutput("errors", { events });
			return;
		}

		printErrors(events);
	} finally {
		eventStore.close();
	}
}

export function createErrorsCommand(): Command {
	return new Command("errors")
		.description("Aggregated error view across agents")
		.option("--agent <name>", "Filter errors by agent name")
		.option("--run <id>", "Filter errors by run ID")
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max errors to show (default: 100)")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.action(async (opts: ErrorsOpts) => {
			await executeErrors(opts);
		});
}

export async function errorsCommand(args: string[]): Promise<void> {
	const cmd = createErrorsCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code.startsWith("commander.")) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "args" });
			}
		}
		throw err;
	}
}
