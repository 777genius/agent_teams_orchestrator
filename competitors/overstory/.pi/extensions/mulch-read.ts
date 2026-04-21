/**
 * mulch-read.ts
 *
 * Augments read tool results with relevant ml prime records for the file being read.
 * Uses ml prime --files <path> --budget 800 to get a focused, file-scoped subset.
 * Results are cached per path for the session — use /clear-mulch-read-cache to invalidate.
 *
 * Complements mulch-context.ts (global system prompt injection) by surfacing the most
 * relevant records inline, right when the LLM is looking at a specific file.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BUDGET = "800";

/**
 * Strip CLAUDE.md boilerplate appended by ml prime (Quick Reference, session protocol,
 * truncation notice). Returns just the domain record sections, or null if empty.
 */
function extractRecords(prime: string): string | null {
	const lines = prime.split("\n");
	const kept: string[] = [];
	let inRecords = false;

	for (const line of lines) {
		if (
			line.startsWith("## Quick Reference") ||
			line.startsWith("# \u{1F6A8}") || // # 🚨
			line.startsWith("... and ")
		) {
			break;
		}
		if (line.startsWith("# Project Expertise")) {
			inRecords = true;
		}
		if (inRecords) {
			kept.push(line);
		}
	}

	const hasRecords = kept.some((l) => l.trimStart().startsWith("- ["));
	if (!hasRecords) return null;
	return kept.join("\n").trim();
}

export default function (pi: ExtensionAPI) {
	// path -> extracted records (null = no records for this file)
	const cache = new Map<string, string | null>();

	pi.on("session_switch", () => {
		cache.clear();
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read" || event.isError) return;

		const path = String((event.input as Record<string, unknown>)?.path ?? "");
		if (!path) return;

		let records: string | null;

		if (cache.has(path)) {
			records = cache.get(path) ?? null;
		} else {
			const result = await pi.exec("ml", ["prime", "--files", path, "--budget", BUDGET]);
			records =
				result.code === 0 && result.stdout.trim()
					? extractRecords(result.stdout)
					: null;
			cache.set(path, records);
		}

		if (!records) return;

		return {
			content: [
				...event.content,
				{ type: "text" as const, text: "\n\n" + records },
			],
		};
	});

	pi.registerCommand("clear-mulch-read-cache", {
		description: "Clear the per-file mulch context cache (re-fetches on next read)",
		handler: async (_args, ctx) => {
			const size = cache.size;
			cache.clear();
			ctx.ui.notify(`Cleared ${size} cached file entries`, "info");
		},
	});
}
