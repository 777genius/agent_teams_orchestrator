/**
 * Runtime-agnostic pricing and cost estimation for AI models.
 *
 * Extracted from transcript.ts so any runtime can use cost estimation
 * without pulling in Claude Code-specific JSONL parsing logic.
 *
 * To add support for a new provider model, add an entry to MODEL_PRICING
 * using a lowercase substring that uniquely identifies the model tier
 * (e.g. "opus", "sonnet", "haiku").
 */

/** Canonical token usage representation shared across all runtimes. */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	modelUsed: string | null;
}

/** Pricing per million tokens (USD). */
export interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok: number;
	cacheCreationPerMTok: number;
}

/** Pricing for known AI models across providers. */
const MODEL_PRICING: Record<string, ModelPricing> = {
	// --- Claude ---
	opus: {
		inputPerMTok: 15,
		outputPerMTok: 75,
		cacheReadPerMTok: 1.5, // 10% of input
		cacheCreationPerMTok: 3.75, // 25% of input
	},
	sonnet: {
		inputPerMTok: 3,
		outputPerMTok: 15,
		cacheReadPerMTok: 0.3, // 10% of input
		cacheCreationPerMTok: 0.75, // 25% of input
	},
	haiku: {
		inputPerMTok: 0.8,
		outputPerMTok: 4,
		cacheReadPerMTok: 0.08, // 10% of input
		cacheCreationPerMTok: 0.2, // 25% of input
	},
	// --- OpenAI GPT ---
	"gpt-4o-mini": {
		inputPerMTok: 0.15,
		outputPerMTok: 0.6,
		cacheReadPerMTok: 0.075, // 50% of input
		cacheCreationPerMTok: 0.15,
	},
	"gpt-4o": {
		inputPerMTok: 2.5,
		outputPerMTok: 10,
		cacheReadPerMTok: 1.25,
		cacheCreationPerMTok: 2.5,
	},
	"gpt-5": {
		inputPerMTok: 10,
		outputPerMTok: 40,
		cacheReadPerMTok: 5,
		cacheCreationPerMTok: 10,
	},
	o1: {
		inputPerMTok: 15,
		outputPerMTok: 60,
		cacheReadPerMTok: 7.5,
		cacheCreationPerMTok: 15,
	},
	o3: {
		inputPerMTok: 10,
		outputPerMTok: 40,
		cacheReadPerMTok: 5,
		cacheCreationPerMTok: 10,
	},
	// --- Google Gemini ---
	"gemini-flash": {
		inputPerMTok: 0.1,
		outputPerMTok: 0.4,
		cacheReadPerMTok: 0.025,
		cacheCreationPerMTok: 0.1,
	},
	"gemini-pro": {
		inputPerMTok: 1.25,
		outputPerMTok: 5,
		cacheReadPerMTok: 0.3125,
		cacheCreationPerMTok: 1.25,
	},
};

/**
 * Determine the pricing tier for a given model string.
 * Matches on substring in priority order to avoid ambiguous overlaps.
 * Returns null if unrecognized.
 */
export function getPricingForModel(model: string): ModelPricing | null {
	const lower = model.toLowerCase();
	// --- Claude ---
	if (lower.includes("opus")) return MODEL_PRICING.opus ?? null;
	if (lower.includes("sonnet")) return MODEL_PRICING.sonnet ?? null;
	if (lower.includes("haiku")) return MODEL_PRICING.haiku ?? null;
	// --- OpenAI GPT --- (gpt-4o-mini before gpt-4o; o3 before o1)
	if (lower.includes("gpt-4o-mini")) return MODEL_PRICING["gpt-4o-mini"] ?? null;
	if (lower.includes("gpt-4o")) return MODEL_PRICING["gpt-4o"] ?? null;
	if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"] ?? null;
	if (lower.includes("o3")) return MODEL_PRICING.o3 ?? null;
	if (lower.includes("o1")) return MODEL_PRICING.o1 ?? null;
	// --- Google Gemini --- (flash before generic gemini+pro check)
	if (lower.includes("flash")) return MODEL_PRICING["gemini-flash"] ?? null;
	if (lower.includes("gemini") && lower.includes("pro")) return MODEL_PRICING["gemini-pro"] ?? null;
	return null;
}

/**
 * Calculate the estimated cost in USD for a given usage and model.
 * Returns null if the model is unrecognized.
 */
export function estimateCost(usage: TokenUsage): number | null {
	if (usage.modelUsed === null) return null;

	const pricing = getPricingForModel(usage.modelUsed);
	if (pricing === null) return null;

	const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMTok;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
	const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok;
	const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMTok;

	return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
