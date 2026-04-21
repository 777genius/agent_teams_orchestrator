/**
 * dev-status.ts
 *
 * Widget above the editor showing open seeds issues and mulch domain health.
 * Refreshes on session start, after each agent run, and on /refresh-status.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

async function fetchSeedsCount(pi: ExtensionAPI): Promise<number | null> {
	const result = await pi.exec("sd", ["ready", "--json"]);
	if (result.code !== 0) return null;
	try {
		const data = JSON.parse(result.stdout) as { count?: number };
		return data.count ?? null;
	} catch {
		return null;
	}
}

interface MulchWarning {
	domain: string;
	level: "over" | "approaching";
}

async function fetchMulchWarnings(pi: ExtensionAPI): Promise<MulchWarning[] | null> {
	const result = await pi.exec("ml", ["status"]);
	if (result.code !== 0) return null;
	const warnings: MulchWarning[] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		const domain = trimmed.split(":")[0]?.trim();
		if (!domain) continue;
		if (trimmed.includes("OVER HARD LIMIT")) {
			warnings.push({ domain, level: "over" });
		} else if (trimmed.includes("approaching limit")) {
			warnings.push({ domain, level: "approaching" });
		}
	}
	return warnings;
}

async function refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;

	const [seedsCount, mulchWarnings] = await Promise.all([
		fetchSeedsCount(pi),
		fetchMulchWarnings(pi),
	]);

	const lines: string[] = [];

	// Seeds line
	const seedsLabel = theme.fg("dim", "seeds  ");
	let seedsValue: string;
	if (seedsCount === null) {
		seedsValue = theme.fg("warning", "unavailable");
	} else {
		seedsValue = theme.fg("muted", `${seedsCount} open`);
	}
	lines.push(seedsLabel + seedsValue);

	// Mulch line
	const mulchLabel = theme.fg("dim", "mulch  ");
	let mulchValue: string;
	if (mulchWarnings === null) {
		mulchValue = theme.fg("warning", "unavailable");
	} else if (mulchWarnings.length === 0) {
		mulchValue = theme.fg("success", "ok");
	} else {
		const parts = mulchWarnings.map((w) => {
			const suffix = w.level === "over" ? " over limit" : " approaching";
			return theme.fg("warning", w.domain + suffix);
		});
		mulchValue = parts.join(theme.fg("dim", ", "));
	}
	lines.push(mulchLabel + mulchValue);

	ctx.ui.setWidget("dev-status", lines);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await refresh(pi, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refresh(pi, ctx);
	});

	pi.registerCommand("refresh-status", {
		description: "Refresh seeds/mulch status widget",
		handler: async (_args, ctx) => {
			await refresh(pi, ctx);
		},
	});
}
