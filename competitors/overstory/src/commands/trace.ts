/**
 * CLI command: ov trace <target> [--json] [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows a chronological timeline of events for an agent or task.
 * Target can be an agent name or a task ID (resolved to agent name via SessionStore).
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import {
	buildEventDetail,
	formatAbsoluteTime,
	formatDate,
	formatRelativeTime,
} from "../logging/format.ts";
import { eventLabel, renderHeader } from "../logging/theme.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { StoredEvent } from "../types.ts";

/**
 * Detect whether a target string looks like a task ID.
 * Task IDs follow the pattern: word-alphanumeric (e.g., "overstory-rj1k", "myproject-abc1").
 */
function looksLikeTaskId(target: string): boolean {
	return /^[a-z][a-z0-9]*-[a-z0-9]{3,}$/i.test(target);
}

/**
 * Print events as a formatted timeline with ANSI colors.
 */
function printTimeline(events: StoredEvent[], agentName: string, useAbsoluteTime: boolean): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader(`Timeline for ${accent(agentName)}`)}\n`);

	if (events.length === 0) {
		w(`${color.dim("No events found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} event${events.length === 1 ? "" : "s"}`)}\n\n`);

	let lastDate = "";

	for (const event of events) {
		// Print date separator when the date changes
		const date = formatDate(event.createdAt);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim(`--- ${date} ---`)}\n`);
			lastDate = date;
		}

		const timeStr = useAbsoluteTime
			? formatAbsoluteTime(event.createdAt)
			: formatRelativeTime(event.createdAt);

		const label = eventLabel(event.eventType);

		const levelColorFn =
			event.level === "error" ? color.red : event.level === "warn" ? color.yellow : null;
		const applyLevel = (text: string) => (levelColorFn ? levelColorFn(text) : text);

		const detail = buildEventDetail(event);
		const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

		const agentLabel = event.agentName !== agentName ? ` ${color.dim(`[${event.agentName}]`)}` : "";

		w(
			`${color.dim(timeStr.padStart(10))} ` +
				`${applyLevel(label.color(color.bold(label.full)))}` +
				`${agentLabel}${detailSuffix}\n`,
		);
	}
}

interface TraceOpts {
	json?: boolean;
	since?: string;
	until?: string;
	limit?: string;
}

async function executeTrace(target: string, opts: TraceOpts): Promise<void> {
	const json = opts.json ?? false;
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

	// Resolve target to agent name
	let agentName = target;

	if (looksLikeTaskId(target)) {
		// Try to resolve task ID to agent name via SessionStore
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			const allSessions = sessionStore.getAll();
			const matchingSession = allSessions.find((s) => s.taskId === target);
			if (matchingSession) {
				agentName = matchingSession.agentName;
			} else {
				// No session found for this task ID; treat it as an agent name anyway
				// (the event query will return empty results if no events match)
				agentName = target;
			}
		} finally {
			sessionStore.close();
		}
	}

	// Open event store and query events
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			jsonOutput("trace", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		const events = eventStore.getByAgent(agentName, {
			since: sinceStr,
			until: untilStr,
			limit,
		});

		if (json) {
			jsonOutput("trace", { events });
			return;
		}

		// Use absolute time if --since is specified, relative otherwise
		const useAbsoluteTime = sinceStr !== undefined;
		printTimeline(events, agentName, useAbsoluteTime);
	} finally {
		eventStore.close();
	}
}

export function createTraceCommand(): Command {
	return new Command("trace")
		.description("Chronological event timeline for agent or task")
		.argument("<target>", "Agent name or task ID")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max events to show (default: 100)")
		.action(async (target: string, opts: TraceOpts) => {
			await executeTrace(target, opts);
		});
}

export async function traceCommand(args: string[]): Promise<void> {
	const cmd = createTraceCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}
