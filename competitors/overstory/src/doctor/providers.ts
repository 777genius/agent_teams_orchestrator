import type { OverstoryConfig, ProviderConfig } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/** Roles that rely heavily on tool-use (function calling). */
const TOOL_HEAVY_ROLES = new Set(["builder", "scout", "merger"]);

/**
 * Provider and multi-runtime configuration checks.
 *
 * Validates gateway provider reachability, auth tokens, model-provider references,
 * and tool-use compatibility across configured runtimes.
 */
export const checkProviders: DoctorCheckFn = async (
	config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Base check: at least one provider configured
	checks.push(buildProvidersConfigured(config));

	// Identify gateway providers
	const gatewayEntries = Object.entries(config.providers).filter(([, p]) => p.type === "gateway");

	// Check 1: provider-reachable-{name} — one per gateway provider with baseUrl
	for (const [name, provider] of gatewayEntries) {
		if (provider.baseUrl) {
			checks.push(await checkProviderReachable(name, provider));
		}
	}

	// Check 2: provider-auth-token-{name} — one per gateway provider with authTokenEnv
	for (const [name, provider] of gatewayEntries) {
		if (provider.authTokenEnv) {
			checks.push(buildProviderAuthToken(name, provider));
		}
	}

	// Check 3: tool-use-compat — one warn per tool-heavy role using a provider-prefixed model
	checks.push(...buildToolUseCompat(config));

	// Check 4: model-provider-ref(s) — one per provider-prefixed model, or single pass
	checks.push(...buildModelProviderRefs(config));

	// Check 5: gateway-api-key-reminder — only when gateway providers exist
	if (gatewayEntries.length > 0) {
		checks.push(buildGatewayApiKeyReminder());
	}

	return checks;
};

/**
 * Base check: verifies at least one provider is configured.
 */
function buildProvidersConfigured(config: OverstoryConfig): DoctorCheck {
	const entries = Object.entries(config.providers);

	if (entries.length > 0) {
		return {
			name: "providers-configured",
			category: "providers",
			status: "pass",
			message: `${entries.length} provider${entries.length === 1 ? "" : "s"} configured`,
			details: entries.map(([name, p]) => `${name} (${p.type})`),
		};
	}

	return {
		name: "providers-configured",
		category: "providers",
		status: "warn",
		message: "No providers configured — add providers to config.yaml",
		details: ["At least one native or gateway provider should be configured."],
	};
}

/**
 * Check 1: HTTP reachability of a gateway provider's baseUrl.
 *
 * Uses fetch() with a 5-second timeout. Any HTTP response (any status code)
 * counts as reachable — only network errors or timeouts produce a warn.
 */
async function checkProviderReachable(
	name: string,
	provider: ProviderConfig,
): Promise<DoctorCheck> {
	const baseUrl = provider.baseUrl as string; // caller guards baseUrl is defined

	try {
		await fetch(baseUrl, {
			method: "HEAD",
			signal: AbortSignal.timeout(5000),
		});

		return {
			name: `provider-reachable-${name}`,
			category: "providers",
			status: "pass",
			message: `Gateway provider '${name}' is reachable`,
			details: [baseUrl],
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			name: `provider-reachable-${name}`,
			category: "providers",
			status: "warn",
			message: `Gateway provider '${name}' is unreachable`,
			details: [baseUrl, errorMsg],
		};
	}
}

/**
 * Check 2: Validate that the auth token env var for a gateway provider is set.
 *
 * Reports the env var NAME in details — never the value.
 */
function buildProviderAuthToken(name: string, provider: ProviderConfig): DoctorCheck {
	const envVar = provider.authTokenEnv as string; // caller guards authTokenEnv is defined
	const value = process.env[envVar];

	if (value && value.length > 0) {
		return {
			name: `provider-auth-token-${name}`,
			category: "providers",
			status: "pass",
			message: `Auth token for provider '${name}' is set`,
			details: [`Env var: ${envVar}`],
		};
	}

	return {
		name: `provider-auth-token-${name}`,
		category: "providers",
		status: "warn",
		message: `Auth token for provider '${name}' is missing`,
		details: [`Env var: ${envVar}`, `Set ${envVar} to authenticate with this provider.`],
	};
}

/**
 * Check 3: Tool-use compatibility for tool-heavy roles using non-Anthropic models.
 *
 * Tool-heavy roles (builder, scout, merger) rely on structured tool-use (function
 * calling). Non-Anthropic models accessed via gateway providers may have different
 * tool-use behavior. Emits one warn per affected role, or a single pass if none.
 */
function buildToolUseCompat(config: OverstoryConfig): DoctorCheck[] {
	const checks: DoctorCheck[] = [];

	for (const [role, model] of Object.entries(config.models)) {
		if (!TOOL_HEAVY_ROLES.has(role)) continue;
		if (model === undefined) continue;
		if (!model.includes("/")) continue;

		checks.push({
			name: "tool-use-compat",
			category: "providers",
			status: "warn",
			message: `models.${role} uses non-Anthropic model — tool-use compatibility not guaranteed`,
			details: [
				`Model: ${model}`,
				"Tool use (function calling) behavior varies across providers.",
				"Test agent behavior thoroughly before using in production.",
			],
		});
	}

	if (checks.length === 0) {
		checks.push({
			name: "tool-use-compat",
			category: "providers",
			status: "pass",
			message: "No tool-heavy roles use non-Anthropic models",
		});
	}

	return checks;
}

/**
 * Check 4: Validate that provider-prefixed model references point to configured providers.
 *
 * For each config.models entry containing '/' (provider-qualified), extracts the
 * provider name and verifies it exists in config.providers. Emits one check per
 * provider-prefixed model, or a single pass if no such models exist.
 */
function buildModelProviderRefs(config: OverstoryConfig): DoctorCheck[] {
	const checks: DoctorCheck[] = [];

	for (const [role, model] of Object.entries(config.models)) {
		if (model === undefined) continue;
		if (!model.includes("/")) continue;

		const providerName = model.split("/")[0];
		if (!providerName) continue;

		if (config.providers[providerName]) {
			checks.push({
				name: "model-provider-ref",
				category: "providers",
				status: "pass",
				message: `models.${role} references defined provider '${providerName}'`,
				details: [`Model: ${model}`],
			});
		} else {
			checks.push({
				name: "model-provider-ref",
				category: "providers",
				status: "fail",
				message: `models.${role} references undefined provider '${providerName}'`,
				details: [
					`Model: ${model}`,
					`Provider '${providerName}' is not defined in config.yaml providers section.`,
					`Add it: providers:\n  ${providerName}:\n    type: gateway\n    baseUrl: https://...`,
				],
			});
		}
	}

	if (checks.length === 0) {
		checks.push({
			name: "model-provider-refs",
			category: "providers",
			status: "pass",
			message: "No provider-prefixed model references",
		});
	}

	return checks;
}

/**
 * Check 5: Reminder about ANTHROPIC_API_KEY when gateway providers are configured.
 *
 * Agents spawned via gateway routes receive ANTHROPIC_API_KEY="" so they use the
 * gateway instead of Anthropic directly. Any direct Anthropic API calls (e.g.,
 * from merge/resolver.ts) require a separate key.
 */
function buildGatewayApiKeyReminder(): DoctorCheck {
	return {
		name: "gateway-api-key-reminder",
		category: "providers",
		status: "warn",
		message:
			"Gateway providers configured — agents using gateway routes will have ANTHROPIC_API_KEY set to empty string. Direct Anthropic API calls require a separate key.",
	};
}
