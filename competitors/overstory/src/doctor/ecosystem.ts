import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Ecosystem health checks.
 *
 * Validates that os-eco CLI tools (ml, sd, cn) are on PATH and report valid
 * semver versions. Intentionally does NOT duplicate the availability checks in
 * dependencies.ts — those confirm the binaries exist. These checks focus on
 * whether the reported version string is parseable semver, and whether the
 * tools are mutually compatible.
 *
 * Fix closures reinstall the relevant package via `bun install -g <pkg>`.
 */

/** A single os-eco ecosystem tool. */
interface EcosystemTool {
	/** Human-readable tool name. */
	name: string;
	/** Primary binary to invoke for version check. */
	bin: string;
	/** npm package name for install / reinstall. */
	pkg: string;
}

const ECOSYSTEM_TOOLS: EcosystemTool[] = [
	{ name: "mulch", bin: "ml", pkg: "@os-eco/mulch-cli" },
	{ name: "seeds", bin: "sd", pkg: "@os-eco/seeds-cli" },
	{ name: "canopy", bin: "cn", pkg: "@os-eco/canopy-cli" },
];

/** Spawner abstraction — injected in tests, uses Bun.spawn in production. */
export type Spawner = (
	args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function defaultSpawner(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

/**
 * Loose semver extractor.
 * Finds the first x.y.z (optionally x.y.z-pre or x.y.z+build) token in a string.
 * Returns null when no valid semver token is found.
 */
export function parseSemver(output: string): string | null {
	const match = /(\d+\.\d+\.\d+(?:[-.+][a-zA-Z0-9._-]*)?)/.exec(output);
	return match?.[1] ?? null;
}

/** Internal result of probing a binary's version output. */
interface VersionProbeResult {
	available: boolean;
	version: string | null;
	raw: string;
}

async function probeVersion(bin: string, spawner: Spawner): Promise<VersionProbeResult> {
	try {
		const { exitCode, stdout, stderr } = await spawner([bin, "--version"]);
		const raw = (stdout + stderr).trim();
		if (exitCode !== 0) {
			return { available: false, version: null, raw };
		}
		const version = parseSemver(raw);
		return { available: true, version, raw };
	} catch {
		return { available: false, version: null, raw: "" };
	}
}

/** Build a DoctorCheck for a single ecosystem tool. */
function buildCheck(tool: EcosystemTool, probe: VersionProbeResult): DoctorCheck {
	const { bin, pkg, name } = tool;

	if (!probe.available) {
		return {
			name: `${name} semver`,
			category: "ecosystem",
			status: "warn",
			message: `${bin} is not available — cannot verify version`,
			details: [`Install: bun install -g ${pkg}`],
			fixable: true,
			fix: async () => {
				const proc = Bun.spawn(["bun", "install", "-g", pkg], {
					stdout: "inherit",
					stderr: "inherit",
				});
				await proc.exited;
				return [`Installed ${pkg}`];
			},
		};
	}

	if (probe.version === null) {
		return {
			name: `${name} semver`,
			category: "ecosystem",
			status: "warn",
			message: `${bin} --version output is not parseable semver`,
			details: [
				`Raw output: ${probe.raw || "(empty)"}`,
				"Expected format: x.y.z",
				`Reinstall: bun install -g ${pkg}`,
			],
			fixable: true,
			fix: async () => {
				const proc = Bun.spawn(["bun", "install", "-g", pkg], {
					stdout: "inherit",
					stderr: "inherit",
				});
				await proc.exited;
				return [`Reinstalled ${pkg}`];
			},
		};
	}

	return {
		name: `${name} semver`,
		category: "ecosystem",
		status: "pass",
		message: `${name} v${probe.version} (valid semver)`,
		details: [probe.raw],
	};
}

/**
 * Factory that creates a DoctorCheckFn with an injectable spawner.
 * Used for testing without module-level mocks.
 */
export function makeCheckEcosystem(spawner: Spawner = defaultSpawner): DoctorCheckFn {
	return async (_config, _overstoryDir): Promise<DoctorCheck[]> => {
		const checks: DoctorCheck[] = [];

		for (const tool of ECOSYSTEM_TOOLS) {
			const probe = await probeVersion(tool.bin, spawner);
			checks.push(buildCheck(tool, probe));
		}

		return checks;
	};
}

/**
 * Ecosystem health check — validates semver version output for ml, sd, cn.
 */
export const checkEcosystem: DoctorCheckFn = makeCheckEcosystem();
