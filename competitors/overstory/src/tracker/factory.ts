/**
 * Tracker factory — creates the right backend client based on configuration.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskTrackerBackend } from "../types.ts";
import { createBeadsTracker } from "./beads.ts";
import { createSeedsTracker } from "./seeds.ts";
import type { TrackerBackend, TrackerClient } from "./types.ts";

/**
 * Create a tracker client for the specified backend.
 *
 * @param backend - Which backend to use ("beads" or "seeds")
 * @param cwd - Working directory for CLI commands
 */
export function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient {
	switch (backend) {
		case "beads":
			return createBeadsTracker(cwd);
		case "seeds":
			return createSeedsTracker(cwd);
		default: {
			const _exhaustive: never = backend;
			throw new Error(`Unknown tracker backend: ${_exhaustive}`);
		}
	}
}

/**
 * Resolve "auto" to a concrete backend by probing the filesystem.
 * Explicit "beads" or "seeds" values pass through unchanged.
 */
export async function resolveBackend(
	configBackend: TaskTrackerBackend,
	cwd: string,
): Promise<TrackerBackend> {
	if (configBackend === "beads") return "beads";
	if (configBackend === "seeds") return "seeds";
	// "auto" detection: check for .beads/ first (never auto-scaffolded by ov init,
	// so its presence signals explicit user setup), then .seeds/.
	const dirExists = async (path: string): Promise<boolean> => {
		try {
			const s = await stat(path);
			return s.isDirectory();
		} catch {
			return false;
		}
	};
	if (await dirExists(join(cwd, ".beads"))) return "beads";
	if (await dirExists(join(cwd, ".seeds"))) return "seeds";
	// Default fallback — seeds is the preferred tracker
	return "seeds";
}

/**
 * Return the CLI tool name for a resolved backend.
 */
export function trackerCliName(backend: TrackerBackend): string {
	return backend === "seeds" ? "sd" : "bd";
}

// Re-export types for convenience
export type { TrackerBackend, TrackerClient, TrackerIssue } from "./types.ts";
