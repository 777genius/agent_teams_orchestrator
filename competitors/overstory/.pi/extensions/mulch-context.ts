/**
 * mulch-context.ts
 *
 * Injects `ml prime` output into the system prompt on every agent turn.
 * Cached at session start so it does not add per-turn subprocess overhead.
 *
 * Commands:
 *   /refresh-mulch [file1 file2 ...]   Re-fetch ml prime, optionally scoped to files.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function countRecords(prime: string): number {
	return prime.split("\n").filter((line) => line.trimStart().startsWith("- [")).length;
}

async function loadPrime(pi: ExtensionAPI, files?: string[]): Promise<string | null> {
	const args = ["prime"];
	if (files && files.length > 0) {
		args.push("--files", ...files);
	}
	const result = await pi.exec("ml", args);
	if (result.code !== 0 || !result.stdout.trim()) return null;
	return result.stdout.trim();
}

function updateStatus(ctx: ExtensionContext, cachedPrime: string | null): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	if (cachedPrime) {
		const n = countRecords(cachedPrime);
		ctx.ui.setStatus("mulch-ctx", theme.fg("dim", `mulch  ${n} records`));
	} else {
		ctx.ui.setStatus("mulch-ctx", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	let cachedPrime: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		cachedPrime = await loadPrime(pi);
		updateStatus(ctx, cachedPrime);
	});

	pi.on("before_agent_start", async (event) => {
		if (!cachedPrime) return;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + cachedPrime,
		};
	});

	pi.registerCommand("refresh-mulch", {
		description: "Re-fetch ml prime context. Optionally scope to files: /refresh-mulch src/foo.ts src/bar.ts",
		handler: async (args, ctx) => {
			const files = args?.trim() ? args.trim().split(/\s+/) : undefined;
			const label = files ? `ml prime --files ${files.join(" ")}` : "ml prime";
			ctx.ui.setStatus("mulch-ctx", ctx.ui.theme.fg("dim", "refreshing..."));
			cachedPrime = await loadPrime(pi, files);
			updateStatus(ctx, cachedPrime);
			if (cachedPrime) {
				ctx.ui.notify(`${label} — ${countRecords(cachedPrime)} records loaded`, "info");
			} else {
				ctx.ui.notify(`${label} returned no content`, "warning");
			}
		},
	});
}
