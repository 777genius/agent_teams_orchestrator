/**
 * CLI command: ov replay [--run <id>] [--agent <name>...] [--json]
 *              [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows an interleaved chronological replay of events across multiple agents.
 * Like reading a combined log — all agents' events merged by timestamp.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import {
	buildAgentColorMap,
	buildEventDetail,
	formatAbsoluteTime,
	formatDate,
	formatRelativeTime,
} from "../logging/format.ts";
import { eventLabel, renderHeader } from "../logging/theme.ts";
import type { StoredEvent } from "../types.ts";

/**
 * Print events as an interleaved timeline with ANSI colors and agent labels.
 */
function printReplay(events: StoredEvent[], useAbsoluteTime: boolean): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Replay")}\n`);

	if (events.length === 0) {
		w(`${color.dim("No events found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} event${events.length === 1 ? "" : "s"}`)}\n\n`);

	const colorMap = buildAgentColorMap(events);
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

		const agentColorFn = colorMap.get(event.agentName) ?? color.gray;
		const agentLabel = ` ${agentColorFn(`[${event.agentName}]`)}`;

		w(
			`${color.dim(timeStr.padStart(10))} ` +
				`${applyLevel(label.color(color.bold(label.full)))}` +
				`${agentLabel}${detailSuffix}\n`,
		);
	}
}

interface ReplayOpts {
	run?: string;
	agent: string[]; // repeatable
	since?: string;
	until?: string;
	limit?: string;
	json?: boolean;
}

async function executeReplay(opts: ReplayOpts): Promise<void> {
	const json = opts.json ?? false;
	const runId = opts.run;
	const agentNames = opts.agent;
	const sinceStr = opts.since;
	const untilStr = opts.until;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 200;

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
			jsonOutput("replay", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		let events: StoredEvent[];
		const queryOpts = { since: sinceStr, until: untilStr, limit };

		if (runId) {
			// Query by run ID
			events = eventStore.getByRun(runId, queryOpts);
		} else if (agentNames.length > 0) {
			// Query each agent and merge
			const allEvents: StoredEvent[] = [];
			for (const name of agentNames) {
				const agentEvents = eventStore.getByAgent(name, {
					since: sinceStr,
					until: untilStr,
				});
				allEvents.push(...agentEvents);
			}
			// Sort by createdAt chronologically
			allEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			// Apply limit after merge
			events = allEvents.slice(0, limit);
		} else {
			// Default: try current-run.txt, then fall back to 24h timeline
			const currentRunPath = join(overstoryDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const currentRunId = (await currentRunFile.text()).trim();
				if (currentRunId) {
					events = eventStore.getByRun(currentRunId, queryOpts);
				} else {
					// Empty file, fall back to timeline
					const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
					events = eventStore.getTimeline({
						since: since24h,
						until: untilStr,
						limit,
					});
				}
			} else {
				// No current run file, fall back to 24h timeline
				const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
				events = eventStore.getTimeline({
					since: since24h,
					until: untilStr,
					limit,
				});
			}
		}

		if (json) {
			jsonOutput("replay", { events });
			return;
		}

		// Use absolute time if --since is specified, relative otherwise
		const useAbsoluteTime = sinceStr !== undefined;
		printReplay(events, useAbsoluteTime);
	} finally {
		eventStore.close();
	}
}

export function createReplayCommand(): Command {
	return new Command("replay")
		.description("Interleaved chronological replay across agents")
		.option("--run <id>", "Filter events by run ID")
		.option(
			"--agent <name>",
			"Filter by agent name (can appear multiple times)",
			(val: string, prev: string[]) => [...prev, val],
			[] as string[],
		)
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max events to show (default: 200)")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.action(async (opts: ReplayOpts) => {
			await executeReplay(opts);
		});
}

export async function replayCommand(args: string[]): Promise<void> {
	const cmd = createReplayCommand();
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
