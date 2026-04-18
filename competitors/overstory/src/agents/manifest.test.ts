import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";
import {
	createManifestLoader,
	expandAliasFromEnv,
	resolveModel,
	resolveProviderEnv,
} from "./manifest.ts";

const VALID_MANIFEST = {
	version: "1.0",
	agents: {
		scout: {
			file: "scout.md",
			model: "sonnet",
			tools: ["Read", "Grep", "Glob"],
			capabilities: ["explore", "review"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Bash"],
			capabilities: ["implement", "refactor"],
			canSpawn: false,
			constraints: [],
		},
	},
};

describe("createManifestLoader", () => {
	let tempDir: string;
	let manifestPath: string;
	let agentBaseDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-manifest-test-"));
		manifestPath = join(tempDir, "agent-manifest.json");
		agentBaseDir = join(tempDir, "agents");
		await mkdir(agentBaseDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	/** Write the manifest JSON and create matching .md files. */
	async function writeManifest(
		data: Record<string, unknown>,
		options?: { skipMdFiles?: boolean; mdFilesToSkip?: string[] },
	): Promise<void> {
		await Bun.write(manifestPath, JSON.stringify(data));
		if (options?.skipMdFiles) return;

		const agents = data.agents;
		if (agents && typeof agents === "object" && !Array.isArray(agents)) {
			for (const [, def] of Object.entries(agents as Record<string, Record<string, unknown>>)) {
				const file = def.file;
				if (
					typeof file === "string" &&
					file.length > 0 &&
					!options?.mdFilesToSkip?.includes(file)
				) {
					await Bun.write(join(agentBaseDir, file), `# ${file}\n`);
				}
			}
		}
	}

	describe("load", () => {
		test("reads manifest, validates structure, verifies .md files, builds capability index", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.version).toBe("1.0");
			expect(Object.keys(manifest.agents)).toHaveLength(2);
			expect(manifest.agents.scout).toBeDefined();
			expect(manifest.agents.builder).toBeDefined();
			expect(manifest.capabilityIndex).toBeDefined();
		});

		test("builds capability index mapping capabilities to agent names", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.capabilityIndex.explore).toEqual(["scout"]);
			expect(manifest.capabilityIndex.review).toEqual(["scout"]);
			expect(manifest.capabilityIndex.implement).toEqual(["builder"]);
			expect(manifest.capabilityIndex.refactor).toEqual(["builder"]);
		});

		test("capability index includes multiple agents for shared capabilities", async () => {
			const data = {
				version: "1.0",
				agents: {
					scout: {
						file: "scout.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
					reviewer: {
						file: "reviewer.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.capabilityIndex.review).toEqual(["scout", "reviewer"]);
		});
	});

	describe("getAgent", () => {
		test("returns undefined before load is called", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			expect(loader.getAgent("scout")).toBeUndefined();
		});

		test("returns agent definition after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const scout = loader.getAgent("scout");
			expect(scout).toBeDefined();
			expect(scout?.model).toBe("sonnet");
			expect(scout?.tools).toEqual(["Read", "Grep", "Glob"]);
			expect(scout?.capabilities).toEqual(["explore", "review"]);
			expect(scout?.canSpawn).toBe(false);
			expect(scout?.constraints).toEqual(["read-only"]);
		});

		test("returns undefined for non-existent agent after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			expect(loader.getAgent("nonexistent")).toBeUndefined();
		});
	});

	describe("findByCapability", () => {
		test("returns empty array before load is called", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			expect(loader.findByCapability("explore")).toEqual([]);
		});

		test("returns matching agents after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const explorers = loader.findByCapability("explore");
			expect(explorers).toHaveLength(1);
			expect(explorers[0]?.file).toBe("scout.md");
		});

		test("returns empty array for non-existent capability", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			expect(loader.findByCapability("nonexistent")).toEqual([]);
		});

		test("returns multiple agents sharing a capability", async () => {
			const data = {
				version: "1.0",
				agents: {
					scout: {
						file: "scout.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
					reviewer: {
						file: "reviewer.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const reviewers = loader.findByCapability("review");
			expect(reviewers).toHaveLength(2);
		});
	});

	describe("validate", () => {
		test("returns error message if not loaded", () => {
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const errors = loader.validate();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("not loaded");
		});

		test("returns empty array for valid manifest", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const errors = loader.validate();
			expect(errors).toEqual([]);
		});
	});

	describe("error handling", () => {
		test("throws AgentError for missing manifest file", async () => {
			const loader = createManifestLoader(join(tempDir, "nonexistent.json"), agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("not found");
		});

		test("throws AgentError for invalid JSON", async () => {
			await Bun.write(manifestPath, "not valid json {{{");
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("Failed to parse");
		});

		test("throws AgentError for missing version field", async () => {
			await Bun.write(manifestPath, JSON.stringify({ agents: {} }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("version");
		});

		test("throws AgentError for empty version string", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "", agents: {} }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("version");
		});

		test("throws AgentError when agents field is missing", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "1.0" }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("agents");
		});

		test("throws AgentError when agents field is an array", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "1.0", agents: [] }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("agents");
		});

		test("throws AgentError for empty model string", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("model");
		});

		test("throws AgentError for missing tools array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("tools");
		});

		test("throws AgentError for missing capabilities array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("capabilities");
		});

		test("throws AgentError when canSpawn is not boolean", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: "yes",
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("canSpawn");
		});

		test("throws AgentError when constraints is not an array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: "read-only",
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("constraints");
		});

		test("throws AgentError when agent definition is not an object", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: "not an object",
				},
			};
			await Bun.write(manifestPath, JSON.stringify(data));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("definition must be an object");
		});

		test("throws AgentError when referenced .md file does not exist", async () => {
			await writeManifest(VALID_MANIFEST, { mdFilesToSkip: ["scout.md"] });
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("does not exist");
		});

		test("throws AgentError when file field is empty string", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("file");
		});

		test("aggregates multiple validation errors", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "",
						model: "",
						tools: "not-array",
						capabilities: "not-array",
						canSpawn: "not-bool",
						constraints: "not-array",
					},
				},
			};
			await Bun.write(manifestPath, JSON.stringify(data));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			try {
				await loader.load();
				expect(true).toBe(false); // Should not reach here
			} catch (err) {
				expect(err).toBeInstanceOf(AgentError);
				const message = (err as AgentError).message;
				expect(message).toContain("file");
				expect(message).toContain("model");
				expect(message).toContain("tools");
				expect(message).toContain("capabilities");
				expect(message).toContain("canSpawn");
				expect(message).toContain("constraints");
			}
		});
	});

	describe("agent with all valid models", () => {
		for (const model of ["sonnet", "opus", "haiku"] as const) {
			test(`accepts model "${model}"`, async () => {
				const data = {
					version: "1.0",
					agents: {
						agent: {
							file: "agent.md",
							model,
							tools: ["Read"],
							capabilities: ["test"],
							canSpawn: false,
							constraints: [],
						},
					},
				};
				await writeManifest(data);
				const loader = createManifestLoader(manifestPath, agentBaseDir);

				const manifest = await loader.load();
				expect(manifest.agents.agent).toBeDefined();
				expect(manifest.agents.agent?.model).toBe(model);
			});
		}
	});
});

describe("resolveModel", () => {
	const baseManifest: AgentManifest = {
		version: "1.0",
		agents: {
			coordinator: {
				file: "coordinator.md",
				model: "opus",
				tools: ["Read", "Bash"],
				capabilities: ["coordinate"],
				canSpawn: true,
				constraints: [],
			},
			monitor: {
				file: "monitor.md",
				model: "sonnet",
				tools: ["Read", "Bash"],
				capabilities: ["monitor"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: { coordinate: ["coordinator"], monitor: ["monitor"] },
	};

	function makeConfig(
		models: OverstoryConfig["models"] = {},
		providers: OverstoryConfig["providers"] = { anthropic: { type: "native" } },
	): OverstoryConfig {
		return {
			project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 5,
				staggerDelayMs: 1000,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 5,
			},
			worktrees: { baseDir: ".overstory/worktrees" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers,
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models,
			logging: { verbose: false, redactSecrets: true },
		};
	}

	test("returns manifest model when no config override", () => {
		const config = makeConfig();
		expect(resolveModel(config, baseManifest, "coordinator", "haiku")).toEqual({
			model: "opus",
			isExplicitOverride: false,
		});
	});

	test("config override takes precedence over manifest", () => {
		const config = makeConfig({ coordinator: "sonnet" });
		expect(resolveModel(config, baseManifest, "coordinator", "haiku")).toEqual({
			model: "sonnet",
			isExplicitOverride: true,
		});
	});

	test("falls back to default when role is not in manifest or config", () => {
		const config = makeConfig();
		expect(resolveModel(config, baseManifest, "unknown-role", "haiku")).toEqual({
			model: "haiku",
			isExplicitOverride: false,
		});
	});

	test("config override works for roles not in manifest", () => {
		const config = makeConfig({ supervisor: "opus" });
		expect(resolveModel(config, baseManifest, "supervisor", "sonnet")).toEqual({
			model: "opus",
			isExplicitOverride: true,
		});
	});

	test("returns gateway env for provider-prefixed model", () => {
		const config = makeConfig(
			{ coordinator: "openrouter/openai/gpt-5.3" },
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
		);
		const result = resolveModel(config, baseManifest, "coordinator", "opus");
		expect(result).toEqual({
			model: "sonnet",
			env: {
				ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
			},
			isExplicitOverride: true,
		});
	});

	test("includes auth token in env when env var is set", () => {
		const config = makeConfig(
			{ coordinator: "openrouter/openai/gpt-5.3" },
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
		);
		const savedEnv = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-token-123";
		try {
			const result = resolveModel(config, baseManifest, "coordinator", "opus");
			expect(result).toEqual({
				model: "sonnet",
				env: {
					ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
					ANTHROPIC_API_KEY: "",
					ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
					ANTHROPIC_AUTH_TOKEN: "test-token-123",
				},
				isExplicitOverride: true,
			});
		} finally {
			if (savedEnv === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = savedEnv;
			}
		}
	});

	test("unknown provider falls through to model as-is", () => {
		const config = makeConfig({ coordinator: "unknown-provider/some-model" });
		const result = resolveModel(config, baseManifest, "coordinator", "opus");
		expect(result).toEqual({ model: "unknown-provider/some-model", isExplicitOverride: true });
	});

	test("native provider returns model string without env", () => {
		const config = makeConfig(
			{ coordinator: "native-gw/claude-3-5-sonnet" },
			{ "native-gw": { type: "native" } },
		);
		const result = resolveModel(config, baseManifest, "coordinator", "opus");
		expect(result).toEqual({ model: "native-gw/claude-3-5-sonnet", isExplicitOverride: true });
	});

	test("handles deeply nested model ID (slashes in model name)", () => {
		const config = makeConfig(
			{ coordinator: "openrouter/openai/gpt-5.3" },
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
		);
		const result = resolveModel(config, baseManifest, "coordinator", "opus");
		// First "/" splits provider "openrouter" from model ID "openai/gpt-5.3"
		expect(result.model).toBe("sonnet");
		expect(result.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("openai/gpt-5.3");
	});

	test("handles model ID with multiple slashes after provider", () => {
		const config = makeConfig(
			{ coordinator: "mygateway/org/model/version" },
			{
				mygateway: {
					type: "gateway",
					baseUrl: "https://mygateway.example.com",
					authTokenEnv: "MYGATEWAY_KEY",
				},
			},
		);
		const result = resolveModel(config, baseManifest, "coordinator", "opus");
		// Provider is "mygateway", model ID is everything after the first "/"
		expect(result.model).toBe("sonnet");
		expect(result.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("org/model/version");
	});

	test("resolveModel sets isExplicitOverride true when config.models has override", () => {
		const config = makeConfig({ builder: "opus" });
		const result = resolveModel(config, baseManifest, "builder", "haiku");
		expect(result.isExplicitOverride).toBe(true);
	});

	test("resolveModel sets isExplicitOverride false when using manifest default", () => {
		const config = makeConfig();
		const result = resolveModel(config, baseManifest, "coordinator", "haiku");
		expect(result.isExplicitOverride).toBe(false);
	});
});

describe("expandAliasFromEnv", () => {
	test("returns expanded model ID when env var is set", () => {
		expect(
			expandAliasFromEnv("haiku", {
				ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
			}),
		).toBe("us.anthropic.claude-3-5-haiku-20241022-v1:0");
	});

	test("returns alias unchanged when env var is unset", () => {
		expect(expandAliasFromEnv("haiku", {})).toBe("haiku");
	});

	test("expands all three aliases via their env vars", () => {
		const env = {
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "bedrock-haiku-id",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "bedrock-sonnet-id",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "bedrock-opus-id",
		};
		expect(expandAliasFromEnv("haiku", env)).toBe("bedrock-haiku-id");
		expect(expandAliasFromEnv("sonnet", env)).toBe("bedrock-sonnet-id");
		expect(expandAliasFromEnv("opus", env)).toBe("bedrock-opus-id");
	});

	test("trims whitespace from env var value", () => {
		expect(
			expandAliasFromEnv("sonnet", {
				ANTHROPIC_DEFAULT_SONNET_MODEL: "  bedrock-sonnet-id  ",
			}),
		).toBe("bedrock-sonnet-id");
	});

	test("returns alias when env var is empty string", () => {
		expect(expandAliasFromEnv("sonnet", { ANTHROPIC_DEFAULT_SONNET_MODEL: "" })).toBe("sonnet");
	});

	test("returns alias when env var is whitespace only", () => {
		expect(expandAliasFromEnv("sonnet", { ANTHROPIC_DEFAULT_SONNET_MODEL: "   " })).toBe("sonnet");
	});

	test("returns unknown alias unchanged", () => {
		expect(expandAliasFromEnv("gpt-4", {})).toBe("gpt-4");
	});
});

describe("resolveModel env var expansion", () => {
	const baseManifest: AgentManifest = {
		version: "1.0",
		agents: {
			scout: {
				file: "scout.md",
				model: "haiku",
				tools: ["Read"],
				capabilities: ["explore"],
				canSpawn: false,
				constraints: [],
			},
			builder: {
				file: "builder.md",
				model: "sonnet",
				tools: ["Read", "Write"],
				capabilities: ["implement"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: { explore: ["scout"], implement: ["builder"] },
	};

	function makeConfig(models: OverstoryConfig["models"] = {}): OverstoryConfig {
		return {
			project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 5,
				staggerDelayMs: 1000,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 5,
			},
			worktrees: { baseDir: ".overstory/worktrees" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: { anthropic: { type: "native" } },
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models,
			logging: { verbose: false, redactSecrets: true },
		};
	}

	test("expands alias when env var is set", () => {
		const saved = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
		try {
			const result = resolveModel(makeConfig(), baseManifest, "scout", "sonnet");
			expect(result).toEqual({
				model: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
				isExplicitOverride: false,
			});
		} finally {
			if (saved === undefined) {
				delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
			} else {
				process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = saved;
			}
		}
	});

	test("passes alias through when env var is unset", () => {
		const saved = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		try {
			const result = resolveModel(makeConfig(), baseManifest, "scout", "sonnet");
			expect(result).toEqual({ model: "haiku", isExplicitOverride: false });
		} finally {
			if (saved !== undefined) {
				process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = saved;
			}
		}
	});

	test("config override to full model ID is not affected by env vars", () => {
		const saved = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "bedrock-sonnet";
		try {
			// Config overrides to a direct model string (not an alias)
			const config = makeConfig({ builder: "claude-3-5-sonnet-20241022" });
			const result = resolveModel(config, baseManifest, "builder", "haiku");
			expect(result).toEqual({ model: "claude-3-5-sonnet-20241022", isExplicitOverride: true });
		} finally {
			if (saved === undefined) {
				delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
			} else {
				process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = saved;
			}
		}
	});

	test("config override to alias also expands via env var", () => {
		const saved = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
		process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "bedrock-opus-id";
		try {
			const config = makeConfig({ scout: "opus" });
			const result = resolveModel(config, baseManifest, "scout", "haiku");
			expect(result).toEqual({ model: "bedrock-opus-id", isExplicitOverride: true });
		} finally {
			if (saved === undefined) {
				delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
			} else {
				process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = saved;
			}
		}
	});
});

describe("resolveProviderEnv", () => {
	test("returns null for unknown provider", () => {
		const result = resolveProviderEnv("unknown", "some/model", {});
		expect(result).toBeNull();
	});

	test("returns null for native provider type", () => {
		const result = resolveProviderEnv("anthropic", "some/model", {
			anthropic: { type: "native" },
		});
		expect(result).toBeNull();
	});

	test("returns null for gateway without baseUrl", () => {
		const result = resolveProviderEnv("gw", "some/model", {
			gw: { type: "gateway" },
		});
		expect(result).toBeNull();
	});

	test("returns env dict for gateway with baseUrl", () => {
		const result = resolveProviderEnv("openrouter", "openai/gpt-5.3", {
			openrouter: { type: "gateway", baseUrl: "https://openrouter.ai/api/v1" },
		});
		expect(result).toEqual({
			ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
		});
	});

	test("includes auth token when env var is present", () => {
		const result = resolveProviderEnv(
			"openrouter",
			"openai/gpt-5.3",
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "MY_TOKEN",
				},
			},
			{ MY_TOKEN: "secret-token" },
		);
		expect(result).toEqual({
			ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "openai/gpt-5.3",
			ANTHROPIC_AUTH_TOKEN: "secret-token",
		});
	});

	test("omits auth token when env var is not set", () => {
		const result = resolveProviderEnv(
			"openrouter",
			"openai/gpt-5.3",
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "MISSING_TOKEN",
				},
			},
			{},
		);
		expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
	});

	test("env always sets ANTHROPIC_API_KEY to empty string", () => {
		const result = resolveProviderEnv(
			"openrouter",
			"openai/gpt-5.3",
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
			{ OPENROUTER_API_KEY: "my-token" },
		);
		expect(result).not.toBeNull();
		expect(result?.ANTHROPIC_API_KEY).toBe("");
	});

	test("handles authTokenEnv pointing to undefined env var", () => {
		const result = resolveProviderEnv(
			"openrouter",
			"openai/gpt-5.3",
			{
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "MISSING_VAR",
				},
			},
			{},
		);
		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
	});

	test("handles authTokenEnv field being undefined", () => {
		const result = resolveProviderEnv(
			"mygw",
			"some-model",
			{
				mygw: {
					type: "gateway",
					baseUrl: "https://mygw.example.com",
				},
			},
			{},
		);
		expect(result).not.toBeNull();
		expect(result?.ANTHROPIC_BASE_URL).toBe("https://mygw.example.com");
		expect(result?.ANTHROPIC_API_KEY).toBe("");
		expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
	});
});

describe("manifest validation accepts arbitrary model strings", () => {
	let tempDir: string;
	let manifestPath: string;
	let agentBaseDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-model-test-"));
		manifestPath = join(tempDir, "agent-manifest.json");
		agentBaseDir = join(tempDir, "agents");
		await mkdir(agentBaseDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("accepts provider-prefixed model string", async () => {
		const data = {
			version: "1.0",
			agents: {
				agent: {
					file: "agent.md",
					model: "openrouter/openai/gpt-5.3",
					tools: ["Read"],
					capabilities: ["test"],
					canSpawn: false,
					constraints: [],
				},
			},
		};
		await Bun.write(manifestPath, JSON.stringify(data));
		await Bun.write(join(agentBaseDir, "agent.md"), "# Agent\n");
		const loader = createManifestLoader(manifestPath, agentBaseDir);

		const manifest = await loader.load();
		expect(manifest.agents.agent?.model).toBe("openrouter/openai/gpt-5.3");
	});
});
