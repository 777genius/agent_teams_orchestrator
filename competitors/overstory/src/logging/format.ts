/**
 * Shared formatting utilities for overstory CLI output.
 *
 * Duration, timestamp, event detail, agent color mapping, and status color
 * helpers used across all observability commands.
 */

import type { StoredEvent } from "../types.ts";
import type { ColorFn } from "./color.ts";
import { color, noColor } from "./color.ts";
import { AGENT_COLORS, eventLabel } from "./theme.ts";

// === Duration ===

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Examples: "0s", "12s", "3m 45s", "2h 15m"
 */
export function formatDuration(ms: number): string {
	if (ms === 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	return `${seconds}s`;
}

// === Timestamps ===

/**
 * Extracts "HH:MM:SS" from an ISO 8601 timestamp string.
 * Returns the raw substring if the timestamp is well-formed.
 */
export function formatAbsoluteTime(timestamp: string): string {
	// ISO format: "YYYY-MM-DDTHH:MM:SS..." or "YYYY-MM-DD HH:MM:SS..."
	const match = timestamp.match(/T?(\d{2}:\d{2}:\d{2})/);
	return match?.[1] ?? timestamp;
}

/**
 * Extracts "YYYY-MM-DD" from an ISO 8601 timestamp string.
 */
export function formatDate(timestamp: string): string {
	const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
	return match?.[1] ?? timestamp;
}

/**
 * Formats a timestamp as a human-readable relative time string.
 * Examples: "12s ago", "3m ago", "2h ago", "5d ago"
 */
export function formatRelativeTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	const diffMs = now - then;
	if (diffMs < 0) return "just now";
	const diffSeconds = Math.floor(diffMs / 1000);
	const diffMinutes = Math.floor(diffSeconds / 60);
	const diffHours = Math.floor(diffMinutes / 60);
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays > 0) return `${diffDays}d ago`;
	if (diffHours > 0) return `${diffHours}h ago`;
	if (diffMinutes > 0) return `${diffMinutes}m ago`;
	return `${diffSeconds}s ago`;
}

// === Event Details ===

/**
 * Builds a compact "key=value" detail string from a StoredEvent's fields.
 * Values are truncated to maxValueLen (default 80) characters.
 */
export function buildEventDetail(event: StoredEvent, maxValueLen = 80): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}
	if (event.toolArgs) {
		const truncated =
			event.toolArgs.length > maxValueLen
				? `${event.toolArgs.slice(0, maxValueLen)}…`
				: event.toolArgs;
		parts.push(`args=${truncated}`);
	}
	if (event.toolDurationMs !== null && event.toolDurationMs !== undefined) {
		parts.push(`dur=${event.toolDurationMs}ms`);
	}
	if (event.data) {
		const truncated =
			event.data.length > maxValueLen ? `${event.data.slice(0, maxValueLen)}…` : event.data;
		parts.push(`data=${truncated}`);
	}

	return parts.join(" ");
}

// === Agent Color Mapping ===

/**
 * Builds a stable color map for agents by first-appearance order in events.
 * Agents are assigned colors from AGENT_COLORS cycling as needed.
 */
export function buildAgentColorMap(events: StoredEvent[]): Map<string, ColorFn> {
	const colorMap = new Map<string, ColorFn>();
	let idx = 0;
	for (const event of events) {
		if (!colorMap.has(event.agentName)) {
			const colorFn = AGENT_COLORS[idx % AGENT_COLORS.length] ?? noColor;
			colorMap.set(event.agentName, colorFn);
			idx++;
		}
	}
	return colorMap;
}

/**
 * Extends an existing agent color map with new agents from the given events.
 * Used in follow mode to add agents discovered in incremental event batches.
 */
export function extendAgentColorMap(colorMap: Map<string, ColorFn>, events: StoredEvent[]): void {
	let idx = colorMap.size;
	for (const event of events) {
		if (!colorMap.has(event.agentName)) {
			const colorFn = AGENT_COLORS[idx % AGENT_COLORS.length] ?? noColor;
			colorMap.set(event.agentName, colorFn);
			idx++;
		}
	}
}

// === Status Colors ===

/**
 * Returns a color function for a merge status string.
 * pending=yellow, merging=blue, conflict=red, merged=green
 */
export function mergeStatusColor(status: string): ColorFn {
	switch (status) {
		case "pending":
			return color.yellow;
		case "merging":
			return color.blue;
		case "conflict":
			return color.red;
		case "merged":
			return color.green;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a color function for a priority string.
 * urgent=red, high=yellow, normal=identity, low=dim
 */
export function priorityColor(priority: string): ColorFn {
	switch (priority) {
		case "urgent":
			return color.red;
		case "high":
			return color.yellow;
		case "normal":
			return (text: string) => text;
		case "low":
			return color.dim;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a color function for a numeric tracker priority.
 * 1=urgent (red), 2=high (yellow), 3=normal (identity), 4=low (dim)
 */
export function numericPriorityColor(priority: number): ColorFn {
	switch (priority) {
		case 1:
			return color.red;
		case 2:
			return color.yellow;
		case 3:
			return (text: string) => text;
		case 4:
			return color.dim;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a color function for a log level string.
 * debug=gray, info=blue, warn=yellow, error=red
 */
export function logLevelColor(level: string): ColorFn {
	switch (level) {
		case "debug":
			return color.gray;
		case "info":
			return color.blue;
		case "warn":
			return color.yellow;
		case "error":
			return color.red;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a 3-character label for a log level string.
 * debug="DBG", info="INF", warn="WRN", error="ERR"
 */
export function logLevelLabel(level: string): string {
	switch (level) {
		case "debug":
			return "DBG";
		case "info":
			return "INF";
		case "warn":
			return "WRN";
		case "error":
			return "ERR";
		default:
			return level.slice(0, 3).toUpperCase();
	}
}

/**
 * Format a single event as a compact feed line.
 * Returns the formatted string WITHOUT a trailing newline.
 * Used by both ov feed and the dashboard Feed panel.
 */
export function formatEventLine(event: StoredEvent, colorMap: Map<string, ColorFn>): string {
	const timeStr = formatAbsoluteTime(event.createdAt);
	const label = eventLabel(event.eventType);
	const levelColorFn =
		event.level === "error" ? color.red : event.level === "warn" ? color.yellow : null;
	const applyLevel = (text: string) => (levelColorFn ? levelColorFn(text) : text);
	const detail = buildEventDetail(event, 60);
	const detailSuffix = detail ? ` ${color.dim(detail)}` : "";
	const agentColorFn = colorMap.get(event.agentName) ?? color.gray;
	const agentLabel = ` ${agentColorFn(event.agentName.padEnd(15))}`;
	return (
		`${color.dim(timeStr)} ` +
		`${applyLevel(label.color(color.bold(label.compact)))}` +
		`${agentLabel}${detailSuffix}`
	);
}
